import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';
function guard() {
  const u = new URL(url!);
  if (
    u.hostname !== '127.0.0.1' ||
    u.port !== '55434' ||
    u.pathname !== '/stockflow_test' ||
    u.username !== 'stockflow'
  )
    throw Error('Unsafe test database');
}
function fixed(n: bigint) {
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')}`;
}
function units(n: { toFixed: (scale: number) => string }) {
  return BigInt(n.toFixed(6).replace('.', ''));
}

describe.skipIf(!url)('Phase 5 real PostgreSQL transfers', () => {
  let db: PrismaClient, other: PrismaClient, app: ReturnType<typeof createApp>;
  let cookie: string,
    csrf: string,
    org: string,
    user: string,
    product: string,
    source: string,
    destination: string;
  beforeAll(() => {
    guard();
    db = createDatabase(url!);
    other = createDatabase(url!);
  });
  beforeEach(async () => {
    guard();
    await db.$executeRaw`TRUNCATE "InventoryMovement", "InventoryBalance", "InventoryCommand", "PurchaseOrderLine", "PurchaseOrder", "Supplier", "PurchasingCommand", "ImportJob", "AuditEvent", "InventoryThreshold" CASCADE`;
    await db.$transaction([
      db.product.deleteMany(),
      db.warehouse.deleteMany(),
      db.category.deleteMany(),
      db.session.deleteMany(),
      db.membership.deleteMany(),
      db.user.deleteMany(),
      db.organization.deleteMany(),
    ]);
    app = createApp({ prisma: db, rateLimit: { max: 1000 } });
    const r = await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({
        email: `${randomUUID()}@example.test`,
        password: 'Strong-transfer-password-42',
        displayName: 'Transfer Actor',
        organizationName: 'Transfer Org',
      });
    expect(r.status).toBe(201);
    cookie = (r.headers['set-cookie'] as unknown as string[])[0]!.split(
      ';',
    )[0]!;
    csrf = r.body.csrfToken as string;
    org = r.body.organization.id as string;
    user = r.body.user.id as string;
    product = (
      await db.product.create({
        data: {
          organizationId: org,
          name: 'Flour',
          sku: 'FLOUR',
          unitOfMeasure: 'KG',
          quantityScale: 3,
        },
      })
    ).id;
    source = (
      await db.warehouse.create({
        data: { organizationId: org, name: 'Source', code: 'SOURCE' },
      })
    ).id;
    destination = (
      await db.warehouse.create({
        data: { organizationId: org, name: 'Destination', code: 'DEST' },
      })
    ).id;
  });
  afterAll(async () => {
    await db?.$disconnect();
    await other?.$disconnect();
  });
  function auth(t: request.Test) {
    return t
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf);
  }
  function transfer(
    quantity: unknown = '2',
    key = randomUUID(),
    extra: Record<string, unknown> = {},
    target = app,
  ) {
    return auth(
      request(target).post(`/api/organizations/${org}/inventory/transfers`),
    )
      .set('Idempotency-Key', key)
      .send({
        productId: product,
        sourceWarehouseId: source,
        destinationWarehouseId: destination,
        quantity,
        ...extra,
      });
  }
  async function receipt(quantity = '10', warehouseId = source) {
    const r = await auth(
      request(app).post(`/api/organizations/${org}/inventory/receipts`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({ productId: product, warehouseId, quantity });
    expect(r.status).toBe(201);
  }
  function balance(warehouseId: string) {
    return db.inventoryBalance.findUnique({
      where: {
        organizationId_productId_warehouseId: {
          organizationId: org,
          productId: product,
          warehouseId,
        },
      },
    });
  }
  async function assertChain(warehouseId: string) {
    const rows = await db.inventoryMovement.findMany({
      where: { organizationId: org, productId: product, warehouseId },
      orderBy: { balanceVersion: 'asc' },
    });
    let current = 0n;
    for (const [i, movement] of rows.entries()) {
      expect(movement.balanceVersion).toBe(BigInt(i + 1));
      expect(movement.previousBalance.toFixed(6)).toBe(fixed(current));
      current += ['RECEIPT', 'ADJUSTMENT_IN', 'TRANSFER_IN'].includes(
        movement.type,
      )
        ? units(movement.quantity)
        : -units(movement.quantity);
      expect(current >= 0n).toBe(true);
      expect(movement.resultingBalance.toFixed(6)).toBe(fixed(current));
    }
    const b = await balance(warehouseId);
    expect(b?.quantity.toFixed(6) ?? '0.000000').toBe(fixed(current));
    if (b) expect(b.version).toBe(BigInt(rows.length));
    return rows;
  }
  async function assertConservation(expected: string) {
    const rows = await db.inventoryBalance.findMany({
      where: { organizationId: org, productId: product },
    });
    expect(
      fixed(rows.reduce((sum, row) => sum + units(row.quantity), 0n)),
    ).toBe(expected);
    for (const row of rows) await assertChain(row.warehouseId);
  }
  async function assertEmptyTransfers() {
    expect(await db.inventoryTransfer.count()).toBe(0);
    expect(
      await db.inventoryMovement.count({
        where: { type: { in: ['TRANSFER_IN', 'TRANSFER_OUT'] } },
      }),
    ).toBe(0);
    expect(
      await db.inventoryCommand.count({ where: { type: 'TRANSFER' } }),
    ).toBe(0);
  }
  function barrier() {
    let count = 0;
    let release!: () => void;
    const ready = new Promise<void>((r) => {
      release = r;
    });
    return async () => {
      if (++count === 2) release();
      await ready;
    };
  }
  function race(
    first: [string, Record<string, unknown>],
    second: [string, Record<string, unknown>],
  ) {
    const beforeTransferBalance = barrier();
    const a = createApp({
      prisma: db,
      inventoryHooks: { beforeTransferBalance },
    });
    const b = createApp({
      prisma: other,
      inventoryHooks: { beforeTransferBalance },
    });
    return Promise.all([
      transfer(first[0], randomUUID(), first[1], a),
      transfer(second[0], randomUUID(), second[1], b),
    ]);
  }
  it('transfers exact stock with one entity, two correlated movements and audited actor', async () => {
    await receipt('5.250');
    const r = await transfer('2.125');
    expect(r.status).toBe(201);
    expect(r.body.sourceBalance.quantity).toBe('3.125000');
    expect(r.body.destinationBalance.quantity).toBe('2.125000');
    expect(r.body.transfer.quantity).toBe('2.125000');
    expect(r.body.movements).toHaveLength(2);
    expect(
      r.body.movements.map((m: { type: string }) => m.type).sort(),
    ).toEqual(['TRANSFER_IN', 'TRANSFER_OUT']);
    const entity = await db.inventoryTransfer.findFirstOrThrow();
    const movements = await db.inventoryMovement.findMany({
      where: { transferId: entity.id },
    });
    expect(movements).toHaveLength(2);
    for (const m of movements) {
      expect(m.actorId).toBe(user);
      expect(m.correlationKey).toBe(entity.id);
      expect(m.commandId).toBe(entity.commandId);
      expect(m.quantity.toFixed(6)).toBe('2.125000');
    }
    await assertConservation('5.250000');
  });
  it('rejects absent or insufficient source without destination artifacts', async () => {
    expect((await transfer()).status).toBe(409);
    expect(await db.inventoryBalance.count()).toBe(0);
    await receipt('1');
    expect((await transfer()).status).toBe(409);
    expect(await balance(destination)).toBeNull();
    await assertEmptyTransfers();
    await assertConservation('1.000000');
  });
  it.each([
    '0',
    '-1',
    '1.0001',
    '1.0000001',
    '100000000000000',
    '1e2',
    ' 1',
    1,
    null,
  ])(
    'rejects invalid transfer quantity %j with no effects',
    async (quantity) => {
      await receipt();
      expect((await transfer(quantity)).status).toBe(400);
      await assertEmptyTransfers();
      expect(await balance(destination)).toBeNull();
      await assertConservation('10.000000');
    },
  );
  it('preserves large quantities exactly beyond Number safe integer', async () => {
    await receipt('99999999999999.999');
    const r = await transfer('99999999999999.998');
    expect(r.status).toBe(201);
    expect(r.body.sourceBalance.quantity).toBe('0.001000');
    expect(r.body.destinationBalance.quantity).toBe('99999999999999.998000');
    await assertConservation('99999999999999.999000');
  });
  it('destination overflow rolls back both sides and transfer artifacts', async () => {
    await receipt('1');
    await receipt('99999999999999.999', destination);
    expect((await transfer('0.001')).status).toBe(409);
    await assertEmptyTransfers();
    expect((await balance(source))?.quantity.toFixed(6)).toBe('1.000000');
    expect((await balance(destination))?.quantity.toFixed(6)).toBe(
      '99999999999999.999000',
    );
  });
  it('UNIT zero scale rejects fractional transfers', async () => {
    await db.product.update({
      where: { id: product },
      data: { unitOfMeasure: 'UNIT', quantityScale: 0 },
    });
    await receipt();
    expect((await transfer('0.1')).status).toBe(400);
    expect((await transfer('1')).status).toBe(201);
    await assertConservation('10.000000');
  });
  it('same source and destination is rejected without effects', async () => {
    await receipt();
    expect(
      (await transfer('2', randomUUID(), { destinationWarehouseId: source }))
        .status,
    ).toBe(400);
    await assertEmptyTransfers();
    await assertConservation('10.000000');
  });
  it('replays canonical payload and rejects changed quantity or reversed intent', async () => {
    await receipt();
    const key = randomUUID();
    const first = await transfer('1.25', key);
    const replay = await transfer('1.250', key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect((await transfer('2', key)).status).toBe(409);
    expect(
      (
        await transfer('1.25', key, {
          sourceWarehouseId: destination,
          destinationWarehouseId: source,
        })
      ).status,
    ).toBe(409);
    expect(await db.inventoryTransfer.count()).toBe(1);
    await assertConservation('10.000000');
  });
  it('A: competing transfers cannot overdraw their common source', async () => {
    await receipt('5');
    const results = await race(['4', {}], ['3', {}]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.inventoryTransfer.count()).toBe(1);
    expect(['1.000000', '2.000000']).toContain(
      (await balance(source))?.quantity.toFixed(6),
    );
    expect(['3.000000', '4.000000']).toContain(
      (await balance(destination))?.quantity.toFixed(6),
    );
    await assertConservation('5.000000');
  });
  it('B: concurrent credits into existing destination add both without lost updates', async () => {
    await receipt();
    await receipt('1', destination);
    const results = await race(['2', {}], ['3', {}]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect((await balance(source))?.quantity.toFixed(6)).toBe('5.000000');
    expect((await balance(destination))?.quantity.toFixed(6)).toBe('6.000000');
    await assertConservation('11.000000');
  });
  it('C: inverse simultaneous transfers complete with deterministic locking', async () => {
    await receipt('10');
    await receipt('10', destination);
    const results = await race(
      ['2', {}],
      ['3', { sourceWarehouseId: destination, destinationWarehouseId: source }],
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect((await balance(source))?.quantity.toFixed(6)).toBe('11.000000');
    expect((await balance(destination))?.quantity.toFixed(6)).toBe('9.000000');
    await assertConservation('20.000000');
  });
  it('D: first-use shared destination has one balance and both contributions', async () => {
    const secondSource = (
      await db.warehouse.create({
        data: { organizationId: org, name: 'Other source', code: 'OTHER' },
      })
    ).id;
    await receipt('5');
    await receipt('7', secondSource);
    expect(await balance(destination)).toBeNull();
    const results = await race(
      ['2', {}],
      ['3', { sourceWarehouseId: secondSource }],
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(
      await db.inventoryBalance.count({
        where: {
          organizationId: org,
          productId: product,
          warehouseId: destination,
        },
      }),
    ).toBe(1);
    expect((await balance(destination))?.quantity.toFixed(6)).toBe('5.000000');
    await assertConservation('12.000000');
  });
  it('E: concurrent same-key retries yield one transfer and two movements', async () => {
    await receipt();
    const key = randomUUID();
    const results = await Promise.all([
      transfer('2', key),
      transfer('2', key, {}, createApp({ prisma: other })),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(await db.inventoryTransfer.count()).toBe(1);
    expect(
      await db.inventoryMovement.count({
        where: { type: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } },
      }),
    ).toBe(2);
    await assertConservation('10.000000');
  });
  it.each([false, true])(
    'failure after debit fully rolls back (existing destination=%s)',
    async (existing) => {
      await receipt('5');
      if (existing) await receipt('1', destination);
      const beforeSource = await balance(source),
        beforeDestination = await balance(destination);
      const failing = createApp({
        prisma: db,
        inventoryHooks: {
          afterTransferDebit: async () => {
            throw Error('Injected transfer failure after debit');
          },
        },
      });
      expect((await transfer('2', randomUUID(), {}, failing)).status).toBe(500);
      expect(await balance(source)).toEqual(beforeSource);
      expect(await balance(destination)).toEqual(beforeDestination);
      await assertEmptyTransfers();
      await assertConservation(existing ? '6.000000' : '5.000000');
    },
  );
  it('rejects foreign product, source, destination and mixed tenant IDs', async () => {
    await receipt();
    const foreignOrg = await db.organization.create({
      data: { name: 'Alien' },
    });
    const foreignProduct = await db.product.create({
      data: {
        organizationId: foreignOrg.id,
        name: 'Alien',
        sku: 'ALIEN',
        unitOfMeasure: 'KG',
        quantityScale: 3,
      },
    });
    const foreignWarehouse = await db.warehouse.create({
      data: { organizationId: foreignOrg.id, name: 'Alien', code: 'ALIEN' },
    });
    for (const extra of [
      { productId: foreignProduct.id },
      { sourceWarehouseId: foreignWarehouse.id },
      { destinationWarehouseId: foreignWarehouse.id },
      { productId: foreignProduct.id, sourceWarehouseId: foreignWarehouse.id },
    ])
      expect((await transfer('2', randomUUID(), extra)).status).toBe(404);
    expect(
      (
        await auth(
          request(app).post(
            `/api/organizations/${foreignOrg.id}/inventory/transfers`,
          ),
        )
          .set('Idempotency-Key', randomUUID())
          .send({
            productId: product,
            sourceWarehouseId: source,
            destinationWarehouseId: destination,
            quantity: '2',
          })
      ).status,
    ).toBe(404);
    await assertEmptyTransfers();
    await assertConservation('10.000000');
  });
  it('MEMBER can read correlated history but only ADMIN/OWNER can transfer', async () => {
    await receipt();
    await db.membership.updateMany({
      where: { userId: user },
      data: { role: 'MEMBER' },
    });
    expect((await transfer()).status).toBe(403);
    expect(
      (
        await auth(
          request(app).get(`/api/organizations/${org}/inventory/balances`),
        )
      ).status,
    ).toBe(200);
    await db.membership.updateMany({
      where: { userId: user },
      data: { role: 'ADMIN' },
    });
    expect((await transfer()).status).toBe(201);
    const history = await auth(
      request(app).get(
        `/api/organizations/${org}/inventory/movements?type=TRANSFER_OUT`,
      ),
    );
    expect(history.status).toBe(200);
    expect(history.body.movements).toHaveLength(1);
    expect(history.body.movements[0].transferId).toBeTruthy();
    expect(history.body.movements[0].actor.displayName).toBe('Transfer Actor');
  });
  it('rechecks current membership before replaying a completed transfer', async () => {
    await receipt();
    const key = randomUUID();
    expect((await transfer('2', key)).status).toBe(201);
    await db.membership.updateMany({
      where: { userId: user },
      data: { role: 'MEMBER' },
    });
    expect((await transfer('2', key)).status).toBe(403);
    expect(await db.inventoryTransfer.count()).toBe(1);
  });
  it.each(['product', 'source', 'destination'])(
    'rejects inactive %s for new transfer',
    async (parent) => {
      await receipt();
      if (parent === 'product')
        await db.product.update({
          where: { id: product },
          data: { active: false },
        });
      else
        await db.warehouse.update({
          where: { id: parent === 'source' ? source : destination },
          data: { active: false },
        });
      expect((await transfer()).status).toBe(409);
      await assertEmptyTransfers();
      await assertConservation('10.000000');
    },
  );
  it('rejects mass assignment, missing key, missing CSRF and separate leg endpoints', async () => {
    await receipt();
    for (const extra of [
      { actorId: user },
      { organizationId: org },
      { type: 'TRANSFER_IN' },
      { resultingBalance: '900' },
      { status: 'COMPLETED' },
    ])
      expect((await transfer('2', randomUUID(), extra)).status).toBe(400);
    const path = `/api/organizations/${org}/inventory/transfers`;
    const body = {
      productId: product,
      sourceWarehouseId: source,
      destinationWarehouseId: destination,
      quantity: '2',
    };
    expect((await auth(request(app).post(path)).send(body)).status).toBe(400);
    expect(
      (
        await request(app)
          .post(path)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .set('Idempotency-Key', randomUUID())
          .send(body)
      ).status,
    ).toBe(403);
    for (const leg of ['transfer-in', 'transfer-out'])
      expect(
        (
          await auth(
            request(app).post(`/api/organizations/${org}/inventory/${leg}`),
          ).send(body)
        ).status,
      ).toBe(404);
    await assertEmptyTransfers();
  });
  it('transfer entity, command and both ledger legs reject SQL tampering', async () => {
    await receipt();
    expect((await transfer()).status).toBe(201);
    await expect(
      db.$executeRaw`UPDATE "InventoryTransfer" SET quantity=3`,
    ).rejects.toBeDefined();
    await expect(
      db.$executeRaw`DELETE FROM "InventoryTransfer"`,
    ).rejects.toBeDefined();
    await expect(
      db.$executeRaw`UPDATE "InventoryMovement" SET "transferId"=NULL WHERE type='TRANSFER_OUT'`,
    ).rejects.toBeDefined();
    await expect(
      db.$executeRaw`DELETE FROM "InventoryMovement" WHERE type='TRANSFER_IN'`,
    ).rejects.toBeDefined();
    await expect(
      db.$executeRaw`UPDATE "InventoryCommand" SET response='{}'::jsonb WHERE type='TRANSFER'`,
    ).rejects.toBeDefined();
    expect(await db.inventoryTransfer.count()).toBe(1);
    await assertConservation('10.000000');
  });
  it('SQL rejects a transfer command completed without its transfer and pair', async () => {
    await expect(
      db.inventoryCommand.create({
        data: {
          organizationId: org,
          type: 'TRANSFER',
          key: randomUUID(),
          payloadHash: '0'.repeat(64),
          actorId: user,
          response: {},
        },
      }),
    ).rejects.toBeDefined();
    await assertEmptyTransfers();
  });
  it('SQL rejects a transfer entity with no ledger pair even inside an otherwise completed transaction', async () => {
    await expect(
      db.$transaction(async (tx) => {
        const commandId = randomUUID();
        await tx.inventoryCommand.create({
          data: {
            id: commandId,
            organizationId: org,
            type: 'TRANSFER',
            key: commandId,
            payloadHash: '0'.repeat(64),
            actorId: user,
          },
        });
        const entity = await tx.inventoryTransfer.create({
          data: {
            organizationId: org,
            productId: product,
            sourceWarehouseId: source,
            destinationWarehouseId: destination,
            quantity: '1',
            actorId: user,
            commandId,
            idempotencyKey: commandId,
          },
        });
        await tx.inventoryCommand.update({
          where: { id: commandId },
          data: { response: { transfer: { id: entity.id } } },
        });
      }),
    ).rejects.toBeDefined();
    await assertEmptyTransfers();
    expect(await db.inventoryBalance.count()).toBe(0);
  });
  it('same key from a different authorized actor is a conflicting intent', async () => {
    await receipt();
    const key = randomUUID();
    expect((await transfer('2', key)).status).toBe(201);
    const r = await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({
        email: `${randomUUID()}@example.test`,
        password: 'Strong-other-actor-password-42',
        displayName: 'Second Actor',
        organizationName: 'Other Org',
      });
    expect(r.status).toBe(201);
    await db.membership.create({
      data: {
        userId: r.body.user.id as string,
        organizationId: org,
        role: 'ADMIN',
      },
    });
    const login = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({
        email: r.body.user.email,
        password: 'Strong-other-actor-password-42',
        organizationId: org,
      });
    expect(login.status).toBe(200);
    const otherCookie = (
      login.headers['set-cookie'] as unknown as string[]
    )[0]!.split(';')[0]!;
    const replay = await request(app)
      .post(`/api/organizations/${org}/inventory/transfers`)
      .set('Cookie', otherCookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', login.body.csrfToken as string)
      .set('Idempotency-Key', key)
      .send({
        productId: product,
        sourceWarehouseId: source,
        destinationWarehouseId: destination,
        quantity: '2',
      });
    expect(replay.status).toBe(409);
    expect(await db.inventoryTransfer.count()).toBe(1);
    await assertConservation('10.000000');
  });
});
