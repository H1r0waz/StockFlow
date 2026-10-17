import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';
type App = ReturnType<typeof createApp>;
interface Order {
  id: string;
  status: string;
  lines: {
    id: string;
    productId: string;
    orderedQuantity: string;
    receivedQuantity: string;
    pendingQuantity: string;
    cancelledQuantity: string;
  }[];
}
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
function millionths(value: string) {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

describe.skipIf(!url)('Phase 7 real PostgreSQL receiving', () => {
  let db: PrismaClient, other: PrismaClient, app: App;
  let cookie: string,
    csrf: string,
    org: string,
    user: string,
    product: string,
    supplier: string,
    warehouse: string;
  beforeAll(() => {
    guard();
    db = createDatabase(url!);
    other = createDatabase(url!);
  });
  beforeEach(async () => {
    guard();
    await db.$executeRaw`TRUNCATE "InventoryMovement", "InventoryBalance", "InventoryCommand", "PurchaseOrderLine", "PurchaseOrder", "PurchasingCommand", "Supplier", "ImportJob", "AuditEvent", "InventoryThreshold" CASCADE`;
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
        password: 'Strong-receiving-password-42',
        displayName: 'Receiving Actor',
        organizationName: 'Receiving Org',
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
    supplier = (
      await db.supplier.create({
        data: { organizationId: org, name: 'Supplier' },
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
  function path(id: string, organization = org) {
    return `/api/organizations/${organization}/purchase-orders/${id}`;
  }
  async function order(
    lines = [{ productId: product, orderedQuantity: '10' }],
    sent = true,
  ): Promise<Order> {
    const r = await auth(
      request(app).post(`/api/organizations/${org}/purchase-orders`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({ supplierId: supplier, lines });
    expect(r.status).toBe(201);
    const result = r.body.purchaseOrder as Order;
    if (sent) {
      const s = await auth(request(app).post(`${path(result.id)}/send`))
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(s.status).toBe(200);
      return s.body.purchaseOrder as Order;
    }
    return result;
  }
  function payload(o: Order, quantity = '4', target = warehouse) {
    return {
      warehouseId: target,
      lines: [{ purchaseOrderLineId: o.lines[0]!.id, quantity }],
    };
  }
  function receive(
    o: Order,
    body: Record<string, unknown> = payload(o),
    key: string = randomUUID(),
    target = app,
  ) {
    return auth(request(target).post(`${path(o.id)}/receipts`))
      .set('Idempotency-Key', key)
      .send(body);
  }
  function cancel(o: Order, target = app) {
    return auth(request(target).post(`${path(o.id)}/cancel`))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Cancel remaining quantities' });
  }
  async function current(o: Order) {
    const r = await auth(request(app).get(path(o.id)));
    expect(r.status).toBe(200);
    return r.body.purchaseOrder as Order;
  }
  function raceApps() {
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeWrite = async () => {
      if (++arrivals === 2) release();
      await ready;
    };
    return [
      createApp({ prisma: db, purchasingHooks: { beforeWrite } }),
      createApp({ prisma: other, purchasingHooks: { beforeWrite } }),
    ] as const;
  }
  async function secondProduct() {
    return (
      await db.product.create({
        data: {
          organizationId: org,
          name: 'Rice',
          sku: 'RICE',
          unitOfMeasure: 'KG',
          quantityScale: 3,
        },
      })
    ).id;
  }
  async function alien() {
    const a = await db.organization.create({ data: { name: 'Alien tenant' } });
    const p = await db.product.create({
      data: {
        organizationId: a.id,
        name: 'Alien',
        sku: 'ALIEN',
        unitOfMeasure: 'KG',
        quantityScale: 3,
      },
    });
    const w = await db.warehouse.create({
      data: { organizationId: a.id, name: 'Alien', code: 'ALIEN' },
    });
    const s = await db.supplier.create({
      data: { organizationId: a.id, name: 'Alien' },
    });
    const po = await db.purchaseOrder.create({
      data: {
        organizationId: a.id,
        supplierId: s.id,
        creatorId: user,
        lines: {
          create: {
            productId: p.id,
            orderedQuantity: '10',
          },
        },
      },
      include: { lines: true },
    });
    return {
      org: a.id,
      product: p.id,
      warehouse: w.id,
      order: po.id,
      line: po.lines[0]!.id,
    };
  }
  async function conserved() {
    const balances = await db.inventoryBalance.findMany();
    const movements = await db.inventoryMovement.findMany({
      orderBy: { balanceVersion: 'asc' },
    });
    const receipts = await db.purchaseReceipt.findMany({
      include: { lines: true },
    });
    const orderLines = await db.purchaseOrderLine.findMany();
    expect(movements).toHaveLength(receipts.flatMap((r) => r.lines).length);
    for (const balance of balances) {
      let sum = 0n,
        version = 0n;
      for (const movement of movements.filter(
        (m) =>
          m.productId === balance.productId &&
          m.warehouseId === balance.warehouseId,
      )) {
        expect(movement.type).toBe('RECEIPT');
        expect(movement.actorId).toBe(user);
        expect(movement.previousBalance.toFixed(6)).toBe(
          `${sum / 1_000_000n}.${(sum % 1_000_000n).toString().padStart(6, '0')}`,
        );
        sum += millionths(movement.quantity.toFixed(6));
        expect(millionths(movement.resultingBalance.toFixed(6))).toBe(sum);
        expect(movement.balanceVersion).toBe(++version);
      }
      expect(millionths(balance.quantity.toFixed(6))).toBe(sum);
      expect(balance.version).toBe(version);
    }
    for (const line of orderLines) {
      const sum = receipts
        .flatMap((r) => r.lines)
        .filter((l) => l.purchaseOrderLineId === line.id)
        .reduce(
          (total, l) => total + millionths(l.receivedQuantity.toFixed(6)),
          0n,
        );
      expect(millionths(line.receivedQuantity.toFixed(6))).toBe(sum);
      expect(sum <= millionths(line.orderedQuantity.toFixed(6))).toBe(true);
    }
  }
  async function noReceipts() {
    expect(await db.purchaseReceipt.count()).toBe(0);
    expect(await db.purchaseReceiptLine.count()).toBe(0);
    expect(await db.inventoryBalance.count()).toBe(0);
    expect(await db.inventoryMovement.count()).toBe(0);
    expect(await db.inventoryCommand.count()).toBe(0);
    expect(
      await db.purchasingCommand.count({ where: { type: 'RECEIVE' } }),
    ).toBe(0);
  }

  it('receives exact partial quantities repeatedly and completes all lines with stock and immutable receipt history', async () => {
    const p2 = await secondProduct();
    const o = await order([
      { productId: product, orderedQuantity: '10.125' },
      { productId: p2, orderedQuantity: '2' },
    ]);
    const flour = o.lines.find((l) => l.productId === product)!;
    const rice = o.lines.find((l) => l.productId === p2)!;
    const r = await receive(o, {
      warehouseId: warehouse,
      lines: [{ purchaseOrderLineId: flour.id, quantity: '4.125' }],
    });
    expect(r.status).toBe(201);
    expect(r.body.purchaseOrder.status).toBe('PARTIALLY_RECEIVED');
    expect(
      r.body.purchaseOrder.lines.find((l: { id: string }) => l.id === flour.id),
    ).toMatchObject({
      orderedQuantity: '10.125000',
      receivedQuantity: '4.125000',
      pendingQuantity: '6.000000',
    });
    expect(r.body.receipt).toMatchObject({
      purchaseOrderId: o.id,
      warehouseId: warehouse,
      actorId: user,
    });
    expect(r.body.receipt.lines[0]).toMatchObject({
      purchaseOrderLineId: flour.id,
      productId: product,
      receivedQuantity: '4.125000',
    });
    const movement = await db.inventoryMovement.findUniqueOrThrow({
      where: { id: r.body.receipt.lines[0].inventoryMovementId as string },
    });
    expect(movement).toMatchObject({
      type: 'RECEIPT',
      productId: product,
      warehouseId: warehouse,
      actorId: user,
    });
    expect(movement.referenceId).toBeTruthy();
    expect(movement.referenceType).toBeTruthy();
    const full = await receive(o, {
      warehouseId: warehouse,
      lines: [
        { purchaseOrderLineId: flour.id, quantity: '6' },
        { purchaseOrderLineId: rice.id, quantity: '2' },
      ],
    });
    expect(full.status).toBe(201);
    expect(full.body.purchaseOrder.status).toBe('RECEIVED');
    for (const line of full.body.purchaseOrder.lines as Order['lines'])
      expect(line.pendingQuantity).toBe('0.000000');
    const listing = await auth(request(app).get(`${path(o.id)}/receipts`));
    expect(listing.status).toBe(200);
    expect(listing.body.receipts).toHaveLength(2);
    const detail = await auth(
      request(app).get(`${path(o.id)}/receipts/${r.body.receipt.id as string}`),
    );
    expect(detail.status).toBe(200);
    expect(detail.body.receipt).toEqual(r.body.receipt);
    expect((await current(o)).status).toBe('RECEIVED');
    await conserved();
  });

  it('completes SENT directly and rejects further receipt or cancellation', async () => {
    const o = await order();
    const r = await receive(o, payload(o, '10'));
    expect(r.status).toBe(201);
    expect(r.body.purchaseOrder.status).toBe('RECEIVED');
    expect((await receive(o, payload(o, '0.001'))).status).toBe(409);
    expect((await cancel(o)).status).toBe(409);
    await conserved();
  });

  it('rejects DRAFT and CANCELLED without stock effects', async () => {
    const o = await order(undefined, false);
    expect((await receive(o)).status).toBe(409);
    expect((await cancel(o)).status).toBe(200);
    expect((await receive(o)).status).toBe(409);
    await noReceipts();
  });

  it('cancels only remaining quantities after a partial receipt and preserves physical stock', async () => {
    const o = await order();
    expect((await receive(o)).status).toBe(201);
    const r = await cancel(o);
    expect(r.status).toBe(200);
    expect(r.body.purchaseOrder.status).toBe('CANCELLED');
    expect(r.body.purchaseOrder.lines[0]).toMatchObject({
      receivedQuantity: '4.000000',
      pendingQuantity: '0.000000',
      cancelledQuantity: '6.000000',
    });
    expect((await receive(o)).status).toBe(409);
    expect(
      (await db.inventoryBalance.findFirstOrThrow()).quantity.toFixed(6),
    ).toBe('4.000000');
    await conserved();
  });

  it('rejects over-receipt against current committed pending quantity', async () => {
    const o = await order();
    expect((await receive(o, payload(o, '6'))).status).toBe(201);
    expect((await receive(o, payload(o, '5'))).status).toBe(409);
    expect((await current(o)).lines[0]!.receivedQuantity).toBe('6.000000');
    expect(await db.purchaseReceipt.count()).toBe(1);
    await conserved();
  });

  it.each([
    '0',
    '-1',
    '1e2',
    '01',
    '0.0000001',
    '100000000000000',
    '',
    null,
    1,
  ])('rejects invalid receiving quantity %s', async (invalid) => {
    const o = await order();
    expect(
      (
        await receive(o, {
          warehouseId: warehouse,
          lines: [{ purchaseOrderLineId: o.lines[0]!.id, quantity: invalid }],
        })
      ).status,
    ).toBe(400);
    await noReceipts();
  });

  it('enforces product scale while canonicalizing equivalent trailing zero decimals', async () => {
    const o = await order();
    expect((await receive(o, payload(o, '1.0001'))).status).toBe(400);
    expect((await receive(o, payload(o, '1.250000'))).status).toBe(201);
    expect((await current(o)).lines[0]!.receivedQuantity).toBe('1.250000');
    await conserved();
  });

  it('preserves very large exact quantities and rolls back balance overflow', async () => {
    await db.product.update({
      where: { id: product },
      data: { quantityScale: 6 },
    });
    const o = await order([
      { productId: product, orderedQuantity: '99999999999999.999999' },
    ]);
    expect((await receive(o, payload(o, '99999999999999.999999'))).status).toBe(
      201,
    );
    expect(
      (await db.inventoryBalance.findFirstOrThrow()).quantity.toFixed(6),
    ).toBe('99999999999999.999999');
    const o2 = await order([
      { productId: product, orderedQuantity: '0.000001' },
    ]);
    expect((await receive(o2, payload(o2, '0.000001'))).status).toBe(409);
    expect((await current(o2)).status).toBe('SENT');
    expect((await current(o2)).lines[0]!.receivedQuantity).toBe('0.000000');
    expect(await db.purchaseReceipt.count()).toBe(1);
    await conserved();
  });

  it('rejects empty, duplicate, oversized and mass-assigned receipt lines or state', async () => {
    const o = await order();
    const line = { purchaseOrderLineId: o.lines[0]!.id, quantity: '1' };
    for (const body of [
      { ...payload(o), status: 'RECEIVED' },
      { ...payload(o), organizationId: org },
      { ...payload(o), receivedQuantity: '10' },
      { ...payload(o), actorId: user },
      { warehouseId: warehouse, lines: [] },
      { warehouseId: warehouse, lines: [line, line] },
      {
        warehouseId: warehouse,
        lines: Array.from({ length: 101 }, () => line),
      },
      { warehouseId: warehouse, lines: [{ ...line, productId: product }] },
      { warehouseId: warehouse, lines: [{ ...line, receivedQuantity: '1' }] },
    ])
      expect((await receive(o, body)).status).toBe(400);
    await noReceipts();
  });

  it('scopes warehouse, lines, receipt detail and PO IDs to the tenant and owning order', async () => {
    const o = await order();
    const o2 = await order();
    const a = await alien();
    expect((await receive(o, payload(o, '1', a.warehouse))).status).toBe(404);
    for (const line of [a.line, o2.lines[0]!.id, randomUUID()]) {
      expect(
        (
          await receive(o, {
            warehouseId: warehouse,
            lines: [{ purchaseOrderLineId: line, quantity: '1' }],
          })
        ).status,
      ).toBe(404);
    }
    for (const endpoint of [
      path(a.order),
      `${path(a.order)}/receipts`,
      `${path(o.id)}/receipts/${randomUUID()}`,
    ]) {
      expect((await auth(request(app).get(endpoint))).status).toBe(404);
    }
    expect(
      (
        await auth(request(app).post(`${path(o.id, a.org)}/receipts`))
          .set('Idempotency-Key', randomUUID())
          .send(payload(o))
      ).status,
    ).toBe(404);
    await noReceipts();
    const received = await receive(o);
    expect(received.status).toBe(201);
    expect(
      (
        await auth(
          request(app).get(
            `${path(o2.id)}/receipts/${received.body.receipt.id as string}`,
          ),
        )
      ).status,
    ).toBe(404);
  });

  it('requires an active warehouse and prevents archiving products on open orders', async () => {
    const o = await order();
    await db.warehouse.update({
      where: { id: warehouse },
      data: { active: false },
    });
    expect((await receive(o)).status).toBe(409);
    await db.warehouse.update({
      where: { id: warehouse },
      data: { active: true },
    });
    await expect(
      db.product.update({
        where: { id: product },
        data: { active: false },
      }),
    ).rejects.toThrow();
    expect(
      (
        await auth(
          request(app).patch(`/api/organizations/${org}/products/${product}`),
        ).send({ active: false })
      ).status,
    ).toBe(409);
    await noReceipts();
    expect((await receive(o)).status).toBe(201);
    await conserved();
  });

  it('requires CSRF and an explicit valid idempotency key', async () => {
    const o = await order();
    expect(
      (await auth(request(app).post(`${path(o.id)}/receipts`)).send(payload(o)))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`${path(o.id)}/receipts`)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .set('Idempotency-Key', randomUUID())
          .send(payload(o))
      ).status,
    ).toBe(403);
    expect((await receive(o, payload(o), 'invalid key')).status).toBe(400);
    await noReceipts();
  });

  it('MEMBER reads history but cannot receive or replay, while ADMIN can receive', async () => {
    const o = await order();
    const key = randomUUID();
    const r = await receive(o, payload(o), key);
    expect(r.status).toBe(201);
    await db.membership.updateMany({
      where: { userId: user },
      data: { role: 'MEMBER' },
    });
    expect((await receive(o)).status).toBe(403);
    expect((await receive(o, payload(o), key)).status).toBe(403);
    for (const endpoint of [
      path(o.id),
      `${path(o.id)}/receipts`,
      `${path(o.id)}/receipts/${r.body.receipt.id as string}`,
    ])
      expect((await auth(request(app).get(endpoint))).status).toBe(200);
    await db.membership.updateMany({
      where: { userId: user },
      data: { role: 'ADMIN' },
    });
    expect((await receive(o, payload(o, '6'))).status).toBe(201);
    await conserved();
  });

  it('replays canonical payloads after completion and conflicts with changed payload or actor', async () => {
    const o = await order();
    const key = randomUUID();
    const r = await receive(o, payload(o, '10.000'), key);
    expect(r.status).toBe(201);
    const replay = await receive(o, payload(o, '10'), key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(r.body);
    expect((await receive(o, payload(o, '9'), key)).status).toBe(409);
    const alternate = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        passwordHash: 'not-used',
        displayName: 'Another actor',
      },
    });
    await db.membership.create({
      data: { organizationId: org, userId: alternate.id, role: 'ADMIN' },
    });
    await db.session.updateMany({
      where: { userId: user },
      data: { userId: alternate.id },
    });
    expect((await receive(o, payload(o, '10'), key)).status).toBe(409);
    expect(await db.purchaseReceipt.count()).toBe(1);
  });

  it('replays an earlier partial receipt after cancellation without another stock effect', async () => {
    const o = await order();
    const key = randomUUID();
    const r = await receive(o, payload(o), key);
    expect(r.status).toBe(201);
    expect((await cancel(o)).status).toBe(200);
    const replay = await receive(o, payload(o, '4.000000'), key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(r.body);
    expect((await current(o)).status).toBe('CANCELLED');
    await conserved();
  });

  it('rolls back receipt, all lines, counters, stock, ledger and command after the first stock line, then retries the same key', async () => {
    const p2 = await secondProduct();
    const o = await order([
      { productId: product, orderedQuantity: '10' },
      { productId: p2, orderedQuantity: '2' },
    ]);
    const body = {
      warehouseId: warehouse,
      lines: o.lines.map((l) => ({ purchaseOrderLineId: l.id, quantity: '1' })),
    };
    const key = randomUUID();
    const broken = createApp({
      prisma: db,
      purchasingHooks: {
        afterReceiptStock: async () => {
          throw Error('Injected receiving failure after stock');
        },
      },
    });
    expect((await receive(o, body, key, broken)).status).toBe(500);
    await noReceipts();
    expect((await current(o)).status).toBe('SENT');
    for (const line of (await current(o)).lines)
      expect(line.receivedQuantity).toBe('0.000000');
    expect((await receive(o, body, key)).status).toBe(201);
    expect(await db.purchaseReceiptLine.count()).toBe(2);
    await conserved();
  });

  it('race A: independent connections receive 6 + 6 on 10 with exactly one winner', async () => {
    const o = await order();
    const [a, b] = raceApps();
    const results = await Promise.all([
      receive(o, payload(o, '6'), randomUUID(), a),
      receive(o, payload(o, '6'), randomUUID(), b),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await current(o)).status).toBe('PARTIALLY_RECEIVED');
    expect((await current(o)).lines[0]!.receivedQuantity).toBe('6.000000');
    await conserved();
  });

  it('race B: independent connections receive 4 + 6 and complete exactly 10', async () => {
    const o = await order();
    const [a, b] = raceApps();
    const results = await Promise.all([
      receive(o, payload(o, '4'), randomUUID(), a),
      receive(o, payload(o, '6'), randomUUID(), b),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect((await current(o)).status).toBe('RECEIVED');
    expect((await current(o)).lines[0]!.receivedQuantity).toBe('10.000000');
    expect(await db.purchaseReceipt.count()).toBe(2);
    await conserved();
  });

  it('race C: different lines both progress and aggregate to RECEIVED', async () => {
    const p2 = await secondProduct();
    const o = await order([
      { productId: product, orderedQuantity: '10' },
      { productId: p2, orderedQuantity: '10' },
    ]);
    const [a, b] = raceApps();
    const results = await Promise.all(
      o.lines.map((line, i) =>
        receive(
          o,
          {
            warehouseId: warehouse,
            lines: [{ purchaseOrderLineId: line.id, quantity: '10' }],
          },
          randomUUID(),
          i === 0 ? a : b,
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect((await current(o)).status).toBe('RECEIVED');
    await conserved();
  });

  it.each(['4', '10'])(
    'race D: receipt %s against cancellation yields only a valid serial outcome',
    async (amount) => {
      const o = await order();
      const [a, b] = raceApps();
      const [received, cancelled] = await Promise.all([
        receive(o, payload(o, amount), randomUUID(), a),
        cancel(o, b),
      ]);
      const final = await current(o);
      if (received.status === 201 && amount === '10') {
        expect(cancelled.status).toBe(409);
        expect(final.status).toBe('RECEIVED');
      } else {
        expect(cancelled.status).toBe(200);
        expect([201, 409]).toContain(received.status);
        expect(final.status).toBe('CANCELLED');
        expect(final.lines[0]!.pendingQuantity).toBe('0.000000');
      }
      expect(final.lines[0]!.receivedQuantity).toBe(
        received.status === 201 ? `${amount}.000000` : '0.000000',
      );
      await conserved();
    },
  );

  it('race E: simultaneous identical keys produce one logical receipt and identical responses', async () => {
    const o = await order();
    const [a, b] = raceApps();
    const key = randomUUID();
    const results = await Promise.all([
      receive(o, payload(o), key, a),
      receive(o, payload(o, '4.000'), key, b),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(await db.purchaseReceipt.count()).toBe(1);
    expect(
      await db.purchasingCommand.count({ where: { type: 'RECEIVE' } }),
    ).toBe(1);
    await conserved();
  });

  it('race F: different purchase orders safely create one previously missing shared balance', async () => {
    const o1 = await order(),
      o2 = await order();
    const [a, b] = raceApps();
    const results = await Promise.all([
      receive(o1, payload(o1, '4'), randomUUID(), a),
      receive(o2, payload(o2, '6'), randomUUID(), b),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await db.inventoryBalance.count()).toBe(1);
    expect(
      (await db.inventoryBalance.findFirstOrThrow()).quantity.toFixed(6),
    ).toBe('10.000000');
    expect((await current(o1)).status).toBe('PARTIALLY_RECEIVED');
    expect((await current(o2)).status).toBe('PARTIALLY_RECEIVED');
    await conserved();
  });

  it('PostgreSQL rejects counter tampering, receipt mutation and deleting or altering receipt lines', async () => {
    const o = await order();
    const r = await receive(o);
    expect(r.status).toBe(201);
    const receiptId = r.body.receipt.id as string;
    const receiptLineId = r.body.receipt.lines[0].id as string;
    await expect(
      db.$executeRaw`UPDATE "PurchaseOrderLine" SET "receivedQuantity" = 5 WHERE id = ${o.lines[0]!.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "PurchaseOrderLine" SET "receivedQuantity" = -1 WHERE id = ${o.lines[0]!.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "PurchaseReceipt" SET "warehouseId" = ${randomUUID()}::uuid WHERE id = ${receiptId}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM "PurchaseReceipt" WHERE id = ${receiptId}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "PurchaseReceiptLine" SET "receivedQuantity" = 5 WHERE id = ${receiptLineId}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM "PurchaseReceiptLine" WHERE id = ${receiptLineId}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "PurchaseOrder" SET status = 'RECEIVED' WHERE id = ${o.id}::uuid`,
    ).rejects.toThrow();
    await conserved();
  });

  it('PostgreSQL rejects a receipt and counters committed without its stock ledger', async () => {
    const o = await order();
    const receiptId = randomUUID(),
      commandId = randomUUID(),
      key = randomUUID();
    await expect(
      db.$transaction(async (tx) => {
        await tx.purchasingCommand.create({
          data: {
            id: commandId,
            organizationId: org,
            type: 'RECEIVE',
            key,
            actorId: user,
            payloadHash: '0'.repeat(64),
            response: {
              receipt: { id: receiptId },
              purchaseOrder: { id: o.id },
            },
          },
        });
        await tx.purchaseReceipt.create({
          data: {
            id: receiptId,
            organizationId: org,
            purchaseOrderId: o.id,
            warehouseId: warehouse,
            actorId: user,
            commandId,
            idempotencyKey: key,
          },
        });
        await tx.purchaseReceiptLine.create({
          data: {
            organizationId: org,
            receiptId,
            purchaseOrderLineId: o.lines[0]!.id,
            productId: product,
            receivedQuantity: '1',
          },
        });
        await tx.purchaseOrderLine.update({
          where: { id: o.lines[0]!.id },
          data: { receivedQuantity: '1' },
        });
        await tx.purchaseOrder.update({
          where: { id: o.id },
          data: { status: 'PARTIALLY_RECEIVED', version: { increment: 1 } },
        });
      }),
    ).rejects.toThrow();
    await noReceipts();
    expect((await current(o)).status).toBe('SENT');
    expect((await current(o)).lines[0]!.receivedQuantity).toBe('0.000000');
  });
});
