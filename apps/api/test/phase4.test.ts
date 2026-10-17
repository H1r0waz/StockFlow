import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createApp } from '../src/app.js';
import type { InventoryHooks } from '../src/modules/inventory/routes.js';
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
describe.skipIf(!url)('Phase 4 real PostgreSQL inventory', () => {
  let db: PrismaClient, other: PrismaClient, app: ReturnType<typeof createApp>;
  let cookie: string,
    csrf: string,
    org: string,
    user: string,
    product: string,
    warehouse: string;
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
        password: 'Strong-inventory-password-42',
        displayName: 'Stock Actor',
        organizationName: 'Stock Org',
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
    warehouse = (
      await db.warehouse.create({
        data: { organizationId: org, name: 'Main', code: 'MAIN' },
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
  function command(
    path = 'receipts',
    q: unknown = '5',
    key = randomUUID(),
    extra: Record<string, unknown> = {},
    target = app,
  ) {
    return auth(
      request(target).post(`/api/organizations/${org}/inventory/${path}`),
    )
      .set('Idempotency-Key', key)
      .send({
        productId: product,
        warehouseId: warehouse,
        quantity: q,
        ...extra,
      });
  }
  async function balance() {
    return db.inventoryBalance.findUnique({
      where: {
        organizationId_productId_warehouseId: {
          organizationId: org,
          productId: product,
          warehouseId: warehouse,
        },
      },
    });
  }
  async function chain() {
    const rows = await db.inventoryMovement.findMany({
      orderBy: { balanceVersion: 'asc' },
    });
    let current = 0n;
    for (const [i, m] of rows.entries()) {
      expect(m.balanceVersion).toBe(BigInt(i + 1));
      expect(m.previousBalance.toFixed(6)).toBe(fixed(current));
      const amount = BigInt(m.quantity.toFixed(6).replace('.', ''));
      current += ['RECEIPT', 'ADJUSTMENT_IN'].includes(m.type)
        ? amount
        : -amount;
      expect(m.resultingBalance.toFixed(6)).toBe(fixed(current));
    }
    expect((await balance())?.quantity.toFixed(6)).toBe(fixed(current));
    return rows;
  }
  function fixed(n: bigint) {
    return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')}`;
  }
  it('receipts create and increment one balance with exact ledger transitions', async () => {
    expect((await command()).status).toBe(201);
    expect((await command('receipts', '1.250')).status).toBe(201);
    expect((await balance())?.quantity.toFixed(6)).toBe('6.250000');
    expect(await chain()).toHaveLength(2);
  });
  it('issue on absent balance fails without persisting claim or balance', async () => {
    expect((await command('issues', '1')).status).toBe(409);
    expect(await balance()).toBeNull();
    expect(await db.inventoryCommand.count()).toBe(0);
  });
  it('debits safely and rejects insufficient stock', async () => {
    await command();
    expect((await command('issues', '4')).status).toBe(201);
    expect((await command('issues', '2')).status).toBe(409);
    expect(await chain()).toHaveLength(2);
  });
  it('requires a reason for adjustments and supports both directions', async () => {
    expect(
      (await command('adjustments', '1', randomUUID(), { direction: 'IN' }))
        .status,
    ).toBe(400);
    expect(
      (
        await command('adjustments', '4', randomUUID(), {
          direction: 'IN',
          reason: 'Opening correction',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await command('adjustments', '1.5', randomUUID(), {
          direction: 'OUT',
          reason: 'Damage',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await command('adjustments', '3', randomUUID(), {
          direction: 'OUT',
          reason: 'Damage',
        })
      ).status,
    ).toBe(409);
    expect(await chain()).toHaveLength(2);
  });
  it.each([
    '0',
    '-1',
    '1e2',
    '1.0001',
    '100000000000000',
    '1.0000001',
    ' 1',
    'NaN',
    1,
    null,
  ])('rejects invalid quantity %j without effects', async (q) => {
    expect((await command('receipts', q)).status).toBe(400);
    expect(await db.inventoryMovement.count()).toBe(0);
    expect(await db.inventoryCommand.count()).toBe(0);
  });
  it('supports quantities beyond Number safe integer using decimal strings', async () => {
    expect((await command('receipts', '99999999999999.999')).status).toBe(201);
    expect((await balance())?.quantity.toFixed(6)).toBe(
      '99999999999999.999000',
    );
    expect((await command('receipts', '0.001')).status).toBe(409);
    await chain();
  });
  it('enforces UNIT zero scale', async () => {
    await db.product.update({
      where: { id: product },
      data: { unitOfMeasure: 'UNIT', quantityScale: 0 },
    });
    expect((await command('receipts', '1.2')).status).toBe(400);
    expect((await command('receipts', '1')).status).toBe(201);
  });
  it('replays canonical payload and rejects changed intent', async () => {
    const k = randomUUID();
    const a = await command('receipts', '1.25', k);
    const b = await command('receipts', '1.250', k);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect((await command('receipts', '2', k)).status).toBe(409);
    expect(await db.inventoryMovement.count()).toBe(1);
  });
  it('concurrent same-key requests commit only once', async () => {
    const k = randomUUID();
    const [a, b] = await Promise.all([
      command('receipts', '2', k),
      command('receipts', '2', k, {}, createApp({ prisma: other })),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body).toEqual(b.body);
    expect(await chain()).toHaveLength(1);
  });
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
  async function race(
    first: [string, string, Record<string, unknown>],
    second: [string, string, Record<string, unknown>],
  ) {
    const beforeBalance = barrier();
    const a = createApp({ prisma: db, inventoryHooks: { beforeBalance } }),
      b = createApp({ prisma: other, inventoryHooks: { beforeBalance } });
    return Promise.all([
      command(first[0], first[1], randomUUID(), first[2], a),
      command(second[0], second[1], randomUUID(), second[2], b),
    ]);
  }
  it('A: stock5 simultaneous ISSUE4/3 has one winner and no negative balance', async () => {
    await command();
    const results = await race(['issues', '4', {}], ['issues', '3', {}]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(['1.000000', '2.000000']).toContain(
      (await balance())?.quantity.toFixed(6),
    );
    expect(await chain()).toHaveLength(2);
  });
  it('B: first-use concurrent receipts create one balance and sum both', async () => {
    const results = await race(['receipts', '2', {}], ['receipts', '3', {}]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await db.inventoryBalance.count()).toBe(1);
    expect((await balance())?.quantity.toFixed(6)).toBe('5.000000');
    expect(await chain()).toHaveLength(2);
  });
  it('C: concurrent valid debits preserve transitions without lost updates', async () => {
    await command('receipts', '10');
    const results = await race(['issues', '2', {}], ['issues', '3', {}]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect((await balance())?.quantity.toFixed(6)).toBe('5.000000');
    expect(await chain()).toHaveLength(3);
  });
  it('D: concurrent adjustment-out and issue cannot overdraw', async () => {
    await command();
    const results = await race(
      ['adjustments', '4', { direction: 'OUT', reason: 'Count' }],
      ['issues', '3', {}],
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await chain()).toHaveLength(2);
  });
  it('failure after balance change rolls back balance, ledger and command', async () => {
    const hooks: InventoryHooks = {
      afterBalance: async () => {
        throw Error('Injected failure');
      },
    };
    expect(
      (
        await command(
          'receipts',
          '2',
          randomUUID(),
          {},
          createApp({ prisma: db, inventoryHooks: hooks }),
        )
      ).status,
    ).toBe(500);
    expect(await balance()).toBeNull();
    expect(await db.inventoryCommand.count()).toBe(0);
    expect(await db.inventoryMovement.count()).toBe(0);
  });
  it('tenant, mass assignment, missing key and CSRF boundaries reject writes', async () => {
    const otherOrg = await db.organization.create({ data: { name: 'Other' } });
    const alien = await db.product.create({
      data: {
        organizationId: otherOrg.id,
        name: 'Other',
        sku: 'OTHER',
        unitOfMeasure: 'UNIT',
      },
    });
    expect(
      (await command('receipts', '1', randomUUID(), { productId: alien.id }))
        .status,
    ).toBe(404);
    expect(
      (
        await command('receipts', '1', randomUUID(), {
          organizationId: otherOrg.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await auth(
          request(app).post(`/api/organizations/${org}/inventory/receipts`),
        ).send({ productId: product, warehouseId: warehouse, quantity: '1' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/organizations/${org}/inventory/receipts`)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .set('Idempotency-Key', randomUUID())
          .send({ productId: product, warehouseId: warehouse, quantity: '1' })
      ).status,
    ).toBe(403);
    expect(
      (
        await auth(
          request(app).get(
            `/api/organizations/${otherOrg.id}/inventory/balances`,
          ),
        )
      ).status,
    ).toBe(404);
  });
  it('MEMBER reads but cannot write; ADMIN can write', async () => {
    await db.membership.updateMany({
      where: { userId: user },
      data: { role: 'MEMBER' },
    });
    expect((await command()).status).toBe(403);
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
    expect((await command()).status).toBe(201);
  });
  it('history prevents unit changes, and positive balances prevent archival', async () => {
    await command();
    for (const payload of [
      { unitOfMeasure: 'UNIT' },
      { quantityScale: 2 },
      { active: false },
    ])
      expect(
        (
          await auth(
            request(app).patch(`/api/organizations/${org}/products/${product}`),
          ).send(payload)
        ).status,
      ).toBe(409);
    expect(
      (
        await auth(
          request(app).patch(
            `/api/organizations/${org}/warehouses/${warehouse}`,
          ),
        ).send({ active: false })
      ).status,
    ).toBe(409);
  });
  it('inactive parents reject new stock commands', async () => {
    await db.product.update({
      where: { id: product },
      data: { active: false },
    });
    expect((await command()).status).toBe(409);
  });
  it('warehouse tenant escape and actor-changed replay are rejected', async () => {
    const alienOrg = await db.organization.create({ data: { name: 'Alien' } });
    const alienWarehouse = await db.warehouse.create({
      data: { organizationId: alienOrg.id, name: 'Alien', code: 'ALIEN' },
    });
    expect(
      (
        await command('receipts', '1', randomUUID(), {
          warehouseId: alienWarehouse.id,
        })
      ).status,
    ).toBe(404);
    const k = randomUUID();
    await command('receipts', '1', k);
    const r = await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({
        email: `${randomUUID()}@example.test`,
        password: 'Strong-test-another-user-42',
        displayName: 'Other actor',
        organizationName: 'Other',
      });
    const secondId = r.body.user.id as string;
    await db.membership.create({
      data: { userId: secondId, organizationId: org, role: 'ADMIN' },
    });
    const login = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({
        email: r.body.user.email,
        password: 'Strong-test-another-user-42',
        organizationId: org,
      });
    const c = (login.headers['set-cookie'] as unknown as string[])[0]!.split(
      ';',
    )[0]!;
    const replay = await request(app)
      .post(`/api/organizations/${org}/inventory/receipts`)
      .set('Cookie', c)
      .set('Origin', origin)
      .set('X-CSRF-Token', login.body.csrfToken as string)
      .set('Idempotency-Key', k)
      .send({ productId: product, warehouseId: warehouse, quantity: '1' });
    expect(replay.status).toBe(409);
    expect(await db.inventoryMovement.count()).toBe(1);
  });
  it('SQL rejects incomplete commands and malformed movement structure', async () => {
    const incomplete = () =>
      db.inventoryCommand.create({
        data: {
          organizationId: org,
          type: 'RECEIPT',
          key: randomUUID(),
          payloadHash: '0'.repeat(64),
          actorId: user,
        },
      });
    await expect(incomplete()).rejects.toBeDefined();
    expect(await db.inventoryCommand.count()).toBe(0);
    await command();
    const existing = await db.inventoryMovement.findFirstOrThrow();
    await expect(
      db.$transaction(async (tx) => {
        const commandId = randomUUID();
        await tx.inventoryCommand.create({
          data: {
            id: commandId,
            organizationId: org,
            type: 'RECEIPT',
            key: commandId,
            payloadHash: '0'.repeat(64),
            actorId: user,
          },
        });
        await tx.inventoryMovement.create({
          data: {
            organizationId: org,
            productId: product,
            warehouseId: warehouse,
            type: 'RECEIPT',
            quantity: '0',
            previousBalance: '5',
            resultingBalance: '5',
            balanceVersion: 2n,
            actorId: user,
            commandId,
            idempotencyKey: commandId,
            correlationKey: commandId,
          },
        });
      }),
    ).rejects.toBeDefined();
    await expect(
      db.inventoryCommand.update({
        where: { id: existing.commandId },
        data: { response: { tampered: true } },
      }),
    ).rejects.toBeDefined();
    expect(await db.inventoryMovement.count()).toBe(1);
  });
  it('ledger update/delete and unaccompanied balance changes are rejected by SQL', async () => {
    await command();
    await expect(
      db.$executeRaw`UPDATE "InventoryMovement" SET reason='tampered'`,
    ).rejects.toBeDefined();
    await expect(
      db.$executeRaw`DELETE FROM "InventoryMovement"`,
    ).rejects.toBeDefined();
    await expect(
      db.$executeRaw`UPDATE "InventoryBalance" SET quantity=-1`,
    ).rejects.toBeDefined();
    await expect(
      db.$executeRaw`UPDATE "InventoryBalance" SET quantity=6`,
    ).rejects.toBeDefined();
    expect((await balance())?.quantity.toFixed(6)).toBe('5.000000');
  });
  it('history and stock filters are tenant-scoped and use exact strings', async () => {
    await command();
    const prefix = `/api/organizations/${org}/inventory`;
    const b = await auth(
      request(app).get(`${prefix}/balances?warehouseId=${warehouse}`),
    );
    expect(b.body.balances[0].quantity).toBe('5.000000');
    const m = await auth(
      request(app).get(`${prefix}/movements?productId=${product}&type=RECEIPT`),
    );
    expect(m.body.movements).toHaveLength(1);
    expect(m.body.movements[0].actor.displayName).toBe('Stock Actor');
    expect(
      (
        await auth(
          request(app)
            .patch(`${prefix}/movements/${m.body.movements[0].id}`)
            .send({ quantity: '9' }),
        )
      ).status,
    ).toBe(404);
  });
});
