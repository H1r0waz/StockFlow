import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';
interface Event {
  id: string;
  organizationId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  correlationKey: string | null;
  metadata: unknown;
  actor?: { id: string; displayName: string };
}
interface Order {
  id: string;
  lines: { id: string }[];
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

describe.skipIf(!url)('Phase 8 real PostgreSQL operations', () => {
  let db: PrismaClient, app: ReturnType<typeof createApp>;
  let org: string,
    user: string,
    cookie: string,
    csrf: string,
    product: string,
    warehouse: string,
    supplier: string;
  beforeAll(() => {
    guard();
    db = createDatabase(url!);
  });
  async function removeFailureTrigger() {
    await db.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS phase8_test_fail ON "AuditEvent"',
    );
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS phase8_test_fail()');
  }
  beforeEach(async () => {
    guard();
    await removeFailureTrigger();
    await db.$executeRaw`TRUNCATE "ImportJob", "AuditEvent", "InventoryThreshold", "InventoryMovement", "InventoryBalance", "InventoryCommand", "PurchaseOrderLine", "PurchaseOrder", "PurchasingCommand", "Supplier" CASCADE`;
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
        password: 'Strong-operations-password-42',
        displayName: 'Operations Actor',
        organizationName: 'Operations Org',
      });
    expect(r.status).toBe(201);
    org = r.body.organization.id as string;
    user = r.body.user.id as string;
    csrf = r.body.csrfToken as string;
    cookie = (r.headers['set-cookie'] as unknown as string[])[0]!.split(
      ';',
    )[0]!;
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
    supplier = (
      await db.supplier.create({
        data: { organizationId: org, name: 'Supplier' },
      })
    ).id;
  });
  afterAll(async () => {
    if (db) {
      await removeFailureTrigger();
      await db.$disconnect();
    }
  });
  function auth(t: request.Test) {
    return t
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf);
  }
  function base(path: string, organization = org) {
    return `/api/organizations/${organization}${path}`;
  }
  function get(path: string, query: Record<string, unknown> = {}) {
    return auth(request(app).get(base(path))).query(query);
  }
  function threshold(
    minimumQuantity: unknown = '2',
    extras: Record<string, unknown> = {},
  ) {
    return auth(request(app).put(base('/inventory/thresholds'))).send({
      productId: product,
      warehouseId: warehouse,
      minimumQuantity,
      ...extras,
    });
  }
  function movement(
    quantity = '3',
    kind = 'receipts',
    extras: Record<string, unknown> = {},
    key = randomUUID(),
  ) {
    return auth(request(app).post(base(`/inventory/${kind}`)))
      .set('Idempotency-Key', key)
      .send({
        productId: product,
        warehouseId: warehouse,
        quantity,
        ...extras,
      });
  }
  async function events(query: Record<string, unknown> = {}): Promise<Event[]> {
    const r = await get('/audit', query);
    expect(r.status).toBe(200);
    return r.body.events as Event[];
  }
  async function order(sent = false): Promise<Order> {
    const r = await auth(request(app).post(base('/purchase-orders')))
      .set('Idempotency-Key', randomUUID())
      .send({
        supplierId: supplier,
        lines: [{ productId: product, orderedQuantity: '10' }],
      });
    expect(r.status).toBe(201);
    const o = r.body.purchaseOrder as Order;
    if (sent)
      expect(
        (
          await auth(request(app).post(base(`/purchase-orders/${o.id}/send`)))
            .set('Idempotency-Key', randomUUID())
            .send({})
        ).status,
      ).toBe(200);
    return o;
  }
  function receive(o: Order, quantity = '3', key = randomUUID()) {
    return auth(request(app).post(base(`/purchase-orders/${o.id}/receipts`)))
      .set('Idempotency-Key', key)
      .send({
        warehouseId: warehouse,
        lines: [{ purchaseOrderLineId: o.lines[0]!.id, quantity }],
      });
  }
  async function alien() {
    const organization = await db.organization.create({
      data: { name: 'Alien' },
    });
    const p = await db.product.create({
      data: {
        organizationId: organization.id,
        name: 'Alien',
        sku: 'ALIEN',
        unitOfMeasure: 'UNIT',
        quantityScale: 0,
      },
    });
    const w = await db.warehouse.create({
      data: { organizationId: organization.id, name: 'Alien', code: 'ALIEN' },
    });
    return { org: organization.id, product: p.id, warehouse: w.id };
  }

  it('computes dashboard active metrics, missing stock and tenant boundaries', async () => {
    await alien();
    const inactive = await db.product.create({
      data: {
        organizationId: org,
        name: 'Inactive',
        sku: 'INACTIVE',
        active: false,
        unitOfMeasure: 'UNIT',
        quantityScale: 0,
      },
    });
    expect(inactive.active).toBe(false);
    const r = await get('/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.dashboard).toMatchObject({
      activeProducts: 1,
      activeWarehouses: 1,
      lowStockProducts: 0,
      outOfStockProducts: 1,
      purchaseOrders: {
        DRAFT: 0,
        SENT: 0,
        PARTIALLY_RECEIVED: 0,
        recentReceived: 0,
      },
      recentMovements: [],
      recentReceipts: [],
    });
  });
  it('counts each purchase state and real recent receipt/movement', async () => {
    await order();
    await order(true);
    const partial = await order(true);
    const complete = await order(true);
    expect((await receive(partial)).status).toBe(201);
    expect((await receive(complete, '10')).status).toBe(201);
    const r = await get('/dashboard');
    expect(r.body.dashboard.purchaseOrders).toMatchObject({
      DRAFT: 1,
      SENT: 1,
      PARTIALLY_RECEIVED: 1,
      recentReceived: 1,
    });
    expect(r.body.dashboard.recentMovements).toHaveLength(2);
    expect(r.body.dashboard.recentReceipts).toHaveLength(2);
    expect(r.body.dashboard.outOfStockProducts).toBe(0);
  });
  it.each([
    ['3', '2', 'OK'],
    ['2', '2', 'OK'],
    ['1.999', '2', 'LOW'],
    ['0', '2', 'OUT_OF_STOCK'],
    ['0', '0', 'OUT_OF_STOCK'],
    ['0.001', '0', 'OK'],
  ])(
    'classifies exact quantity %s against minimum %s as %s',
    async (quantity, minimum, status) => {
      expect((await threshold(minimum)).status).toBe(200);
      if (quantity !== '0') expect((await movement(quantity)).status).toBe(201);
      const r = await get('/inventory/alerts');
      expect(r.status).toBe(200);
      expect(r.body.alerts).toHaveLength(1);
      expect(r.body.alerts[0]).toMatchObject({
        productId: product,
        warehouseId: warehouse,
        quantity: `${quantity.split('.')[0]}.${(quantity.split('.')[1] ?? '').padEnd(6, '0')}`,
        status,
      });
    },
  );
  it('deduplicates low products across warehouses and treats unconfigured pairs separately', async () => {
    const w = await db.warehouse.create({
      data: { organizationId: org, name: 'Other', code: 'OTHER' },
    });
    await threshold('5');
    await threshold('5', { warehouseId: w.id });
    await movement('1');
    await movement('1', 'receipts', { warehouseId: w.id });
    const r = await get('/dashboard');
    expect(r.body.dashboard.lowStockProducts).toBe(1);
    expect(r.body.dashboard.outOfStockProducts).toBe(0);
    expect((await get('/inventory/alerts')).body.alerts).toHaveLength(2);
  });
  it.each(['product', 'warehouse'])(
    'excludes inactive %s from alerts and active stock metrics',
    async (kind) => {
      await threshold();
      if (kind === 'product')
        await db.product.update({
          where: { id: product },
          data: { active: false },
        });
      else
        await db.warehouse.update({
          where: { id: warehouse },
          data: { active: false },
        });
      expect((await get('/inventory/alerts')).body.alerts).toEqual([]);
      const d = (await get('/dashboard')).body.dashboard;
      expect(kind === 'product' ? d.activeProducts : d.activeWarehouses).toBe(
        0,
      );
    },
  );
  it.each([
    '-1',
    '1e3',
    '1.0001',
    '0.000001',
    '100000000000000',
    'NaN',
    1,
    null,
  ])('rejects malformed or scale-invalid threshold %s', async (value) => {
    expect((await threshold(value)).status).toBe(400);
    expect((await get('/inventory/alerts')).body.alerts).toEqual([]);
  });
  it('upserts one threshold and rejects mass assignment and missing CSRF', async () => {
    await threshold('1');
    await threshold('2');
    expect((await get('/inventory/alerts')).body.alerts).toHaveLength(1);
    expect((await threshold('2', { organizationId: org })).status).toBe(400);
    expect(
      (
        await request(app)
          .put(base('/inventory/thresholds'))
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({
            productId: product,
            warehouseId: warehouse,
            minimumQuantity: '2',
          })
      ).status,
    ).toBe(403);
  });
  it('rejects foreign parents and safely scopes filters and organization paths', async () => {
    const foreign = await alien();
    await threshold();
    expect((await threshold('2', { productId: foreign.product })).status).toBe(
      404,
    );
    expect(
      (await threshold('2', { warehouseId: foreign.warehouse })).status,
    ).toBe(404);
    for (const path of ['/dashboard', '/inventory/alerts', '/audit'])
      expect(
        (await auth(request(app).get(base(path, foreign.org)))).status,
      ).toBe(404);
    for (const query of [
      { productId: foreign.product },
      { warehouseId: foreign.warehouse },
    ]) {
      const r = await get('/inventory/alerts', query);
      expect([200, 404]).toContain(r.status);
      if (r.status === 200) expect(r.body.alerts).toEqual([]);
    }
    expect(await events({ entityId: foreign.product })).toEqual([]);
  });
  it('enforces MEMBER reads and audit/threshold restrictions, ADMIN audit access', async () => {
    await db.membership.updateMany({
      where: { userId: user, organizationId: org },
      data: { role: 'MEMBER' },
    });
    expect((await get('/dashboard')).status).toBe(200);
    expect((await get('/inventory/alerts')).status).toBe(200);
    expect((await get('/audit')).status).toBe(403);
    expect((await threshold()).status).toBe(403);
    await db.membership.updateMany({
      where: { userId: user, organizationId: org },
      data: { role: 'ADMIN' },
    });
    expect((await get('/audit')).status).toBe(200);
  });
  it('audits catalog actor, entity and tenant with safe metadata', async () => {
    const secret = 'PRIVATE_DESCRIPTION_908';
    const r = await auth(request(app).post(base('/products'))).send({
      name: 'New Product',
      sku: 'NEW',
      unitOfMeasure: 'UNIT',
      quantityScale: 0,
      description: secret,
    });
    expect(r.status).toBe(201);
    const rows = await events({
      entityType: 'Product',
      entityId: r.body.product.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: org,
      actorId: user,
      entityType: 'Product',
      entityId: r.body.product.id,
    });
    expect(rows[0]!.actor).toMatchObject({
      id: user,
      displayName: 'Operations Actor',
    });
    const serialized = JSON.stringify(rows);
    for (const forbidden of [
      'passwordHash',
      'csrfToken',
      'sessionToken',
      secret,
      'Strong-operations-password-42',
    ])
      expect(serialized).not.toContain(forbidden);
  });
  it.each(['categories', 'warehouses', 'suppliers'])(
    'audits creation, update and deactivation of %s',
    async (resource) => {
      const r = await auth(request(app).post(base(`/${resource}`))).send({
        name: 'Created',
        ...(resource === 'warehouses' ? { code: 'CREATED' } : {}),
        ...(resource === 'suppliers'
          ? { email: 'private-contact@example.test', taxId: 'PRIVATE-TAX' }
          : {}),
      });
      expect(r.status).toBe(201);
      const entity = r.body[
        resource === 'categories'
          ? 'category'
          : resource === 'warehouses'
            ? 'warehouse'
            : 'supplier'
      ] as { id: string };
      expect(
        (
          await auth(
            request(app).patch(base(`/${resource}/${entity.id}`)),
          ).send({ name: 'Updated' })
        ).status,
      ).toBe(200);
      expect(
        (
          await auth(
            request(app).patch(base(`/${resource}/${entity.id}`)),
          ).send({ active: false })
        ).status,
      ).toBe(200);
      const rows = await events({ entityId: entity.id });
      expect(rows).toHaveLength(3);
      expect(
        rows.every((e) => e.actorId === user && e.organizationId === org),
      ).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(
        'private-contact@example.test',
      );
      expect(JSON.stringify(rows)).not.toContain('PRIVATE-TAX');
    },
  );
  it('records one correlated manual movement event on replay and none on rejected intent', async () => {
    const key = randomUUID();
    const r = await movement('3', 'receipts', {}, key);
    expect(r.status).toBe(201);
    expect((await movement('3.000', 'receipts', {}, key)).body).toEqual(r.body);
    expect((await movement('4', 'receipts', {}, key)).status).toBe(409);
    const rows = await events({ action: 'RECEIPT' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: user,
      organizationId: org,
      entityType: 'InventoryMovement',
      entityId: r.body.movement.id,
    });
    expect(rows[0]!.correlationKey).toBeTruthy();
  });
  it('records issue and both adjustment directions without duplicate ledger audit', async () => {
    await movement('5');
    expect((await movement('1', 'issues')).status).toBe(201);
    for (const direction of ['IN', 'OUT'])
      expect(
        (
          await movement('1', 'adjustments', {
            direction,
            reason: 'Stock count',
          })
        ).status,
      ).toBe(201);
    for (const action of [
      'RECEIPT',
      'ISSUE',
      'ADJUSTMENT_IN',
      'ADJUSTMENT_OUT',
    ])
      expect(await events({ action })).toHaveLength(1);
  });
  it('audits a transfer once, with transfer correlation and two intact ledger legs', async () => {
    await movement('5');
    const w = await db.warehouse.create({
      data: { organizationId: org, name: 'Other', code: 'OTHER' },
    });
    const key = randomUUID();
    const send = () =>
      auth(request(app).post(base('/inventory/transfers')))
        .set('Idempotency-Key', key)
        .send({
          productId: product,
          sourceWarehouseId: warehouse,
          destinationWarehouseId: w.id,
          quantity: '1',
        });
    const r = await send();
    expect(r.status).toBe(201);
    expect((await send()).body).toEqual(r.body);
    const rows = await events({ action: 'TRANSFER' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityType).toBe('InventoryTransfer');
    expect(rows[0]!.correlationKey).toBeTruthy();
    expect(await events({ action: 'TRANSFER_IN' })).toEqual([]);
    expect(await events({ action: 'TRANSFER_OUT' })).toEqual([]);
    expect(
      await db.inventoryMovement.count({
        where: { type: { in: ['TRANSFER_IN', 'TRANSFER_OUT'] } },
      }),
    ).toBe(2);
  });
  it('audits purchase lifecycle and one receipt rather than its stock legs', async () => {
    const o = await order(true);
    const key = randomUUID();
    const r = await receive(o, '3', key);
    expect(r.status).toBe(201);
    expect((await receive(o, '3', key)).body).toEqual(r.body);
    const rows = await events({ action: 'PURCHASE_RECEIPT' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityType).toBe('PurchaseReceipt');
    expect(rows[0]!.correlationKey).toBeTruthy();
    expect(await events({ action: 'RECEIPT' })).toEqual([]);
    const orderEvents = await events({
      entityType: 'PurchaseOrder',
      entityId: o.id,
    });
    expect(orderEvents.length).toBeGreaterThanOrEqual(2);
    expect(
      (
        await auth(request(app).post(base(`/purchase-orders/${o.id}/cancel`)))
          .set('Idempotency-Key', randomUUID())
          .send({ reason: 'Close remainder' })
      ).status,
    ).toBe(200);
    expect(
      (await events({ entityType: 'PurchaseOrder', entityId: o.id })).length,
    ).toBeGreaterThan(orderEvents.length);
  });
  it('rejects SQL audit mutation and exposes no normal edit/delete endpoint', async () => {
    await movement();
    const e = (await events({ action: 'RECEIPT' }))[0]!;
    await expect(
      db.$executeRaw`UPDATE "AuditEvent" SET "action" = 'TAMPERED' WHERE "id" = ${e.id}::uuid`,
    ).rejects.toBeDefined();
    await expect(
      db.$executeRaw`DELETE FROM "AuditEvent" WHERE "id" = ${e.id}::uuid`,
    ).rejects.toBeDefined();
    expect(
      (
        await auth(request(app).patch(base(`/audit/${e.id}`))).send({
          action: 'TAMPERED',
        })
      ).status,
    ).toBe(404);
    expect(
      (await auth(request(app).delete(base(`/audit/${e.id}`)))).status,
    ).toBe(404);
  });
  it('rolls back business write, ledger and command if atomic audit insertion fails', async () => {
    await db.$executeRawUnsafe(
      `CREATE FUNCTION phase8_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END $$`,
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER phase8_test_fail BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION phase8_test_fail()',
    );
    try {
      expect((await movement()).status).toBe(500);
      expect(await db.inventoryBalance.count()).toBe(0);
      expect(await db.inventoryMovement.count()).toBe(0);
      expect(await db.inventoryCommand.count()).toBe(0);
    } finally {
      await removeFailureTrigger();
    }
    expect((await movement()).status).toBe(201);
  });
  it.each([
    '/audit',
    '/inventory/alerts',
    '/inventory/movements',
    '/purchase-orders',
    '/suppliers',
    '/products',
  ])('bounds pagination abuse on %s', async (path) => {
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { limit: '1.5' },
      { offset: '-1' },
      { offset: '1e10' },
    ])
      expect((await get(path, query)).status).toBe(400);
  });
  it('paginates audit stably with combined actor/entity/date/action filters', async () => {
    for (let i = 0; i < 5; i++) expect((await movement('1')).status).toBe(201);
    const all = await events({
      action: 'RECEIPT',
      actorId: user,
      entityType: 'InventoryMovement',
      from: '2020-01-01T00:00:00.000Z',
      to: '2099-01-01T00:00:00.000Z',
    });
    expect(all).toHaveLength(5);
    const ids: string[] = [];
    let offset = 0;
    for (let page = 0; page < 3; page++) {
      const r = await get('/audit', {
        limit: 2,
        offset,
        action: 'RECEIPT',
        actorId: user,
        entityType: 'InventoryMovement',
        from: '2020-01-01T00:00:00.000Z',
        to: '2099-01-01T00:00:00.000Z',
      });
      expect(r.status).toBe(200);
      ids.push(...(r.body.events as Event[]).map((e) => e.id));
      expect(r.body.hasMore).toBe(page < 2);
      if (page < 2) {
        expect(r.body.nextOffset).toBe(offset + 2);
        offset = r.body.nextOffset as number;
      }
    }
    expect(ids).toEqual(all.map((e) => e.id));
    expect(new Set(ids).size).toBe(5);
    expect(
      (
        await get('/audit', { limit: 2, offset: 0, action: 'RECEIPT' })
      ).body.events.map((e: Event) => e.id),
    ).toEqual(ids.slice(0, 2));
  });
  it('paginates products, suppliers, movements, orders and receipts without omissions', async () => {
    const receiptOrder = await order(true);
    for (let i = 0; i < 4; i++) {
      await db.product.create({
        data: {
          organizationId: org,
          name: 'Same name',
          sku: `P-${i}`,
          unitOfMeasure: 'UNIT',
          quantityScale: 0,
        },
      });
      await db.supplier.create({
        data: { organizationId: org, name: 'Same name' },
      });
      await movement();
      const o = await order(true);
      await receive(o, '1');
    }
    for (let i = 0; i < 4; i++)
      expect((await receive(receiptOrder, '1')).status).toBe(201);
    for (const [path, field] of [
      ['/products', 'products'],
      ['/suppliers', 'suppliers'],
      ['/inventory/movements', 'movements'],
      ['/purchase-orders', 'purchaseOrders'],
      [`/purchase-orders/${receiptOrder.id}/receipts`, 'receipts'],
    ]) {
      const collected: string[] = [];
      let offset = 0;
      for (let page = 0; page < 10; page++) {
        const r = await get(path!, { limit: 2, offset });
        expect(r.status, path).toBe(200);
        const rows = r.body[field!] as { id: string }[];
        expect(rows.length).toBeLessThanOrEqual(2);
        collected.push(...rows.map((x) => x.id));
        if (!r.body.hasMore) break;
        expect(r.body.nextOffset).toBe(offset + 2);
        offset = r.body.nextOffset as number;
      }
      expect(new Set(collected).size, path).toBe(collected.length);
      expect(collected.length, path).toBeGreaterThanOrEqual(4);
    }
  });
  it('audits membership role changes without storing account secrets', async () => {
    const target = await db.user.create({
      data: {
        email: 'member@example.test',
        displayName: 'Member',
        passwordHash: 'PRIVATE-HASH',
      },
    });
    const r = await auth(request(app).post(base('/memberships'))).send({
      email: target.email,
      role: 'MEMBER',
    });
    expect(r.status).toBe(201);
    expect(
      (
        await auth(
          request(app).patch(base(`/memberships/${r.body.membership.id}`)),
        ).send({ role: 'ADMIN' })
      ).status,
    ).toBe(200);
    const rows = await events({
      entityType: 'Membership',
      entityId: r.body.membership.id,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((e) => e.actorId === user)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE-HASH');
    expect(JSON.stringify(rows)).not.toContain(target.email);
  });
  it('bounds recent activity and excludes received orders older than thirty days', async () => {
    const o = await order(true);
    expect((await receive(o, '10')).status).toBe(201);
    for (let i = 0; i < 6; i++) await movement('1');
    const future = new Date(Date.now() + 31 * 86_400_000);
    await db.session.updateMany({
      where: { userId: user, organizationId: org },
      data: { expiresAt: new Date(future.getTime() + 7 * 86_400_000) },
    });
    app = createApp({
      prisma: db,
      now: () => future,
      rateLimit: { max: 1000 },
    });
    const r = await get('/dashboard');
    expect(r.body.dashboard.recentMovements).toHaveLength(5);
    expect(r.body.dashboard.purchaseOrders.recentReceived).toBe(0);
  });
  it('filters alerts by status, product and warehouse together', async () => {
    await threshold('5');
    await movement('1');
    const r = await get('/inventory/alerts', {
      status: 'LOW',
      productId: product,
      warehouseId: warehouse,
      limit: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.alerts).toHaveLength(1);
    expect(r.body.hasMore).toBe(false);
    expect(
      (await get('/inventory/alerts', { status: 'OK' })).body.alerts,
    ).toEqual([]);
  });
  it.each(['product', 'warehouse'])(
    'rejects threshold writes on inactive %s',
    async (kind) => {
      if (kind === 'product')
        await db.product.update({
          where: { id: product },
          data: { active: false },
        });
      else
        await db.warehouse.update({
          where: { id: warehouse },
          data: { active: false },
        });
      expect((await threshold()).status).toBe(409);
    },
  );
  it('rolls back purchase receipt counters and stock when audit insertion fails', async () => {
    const o = await order(true);
    const before = await db.auditEvent.count();
    await db.$executeRawUnsafe(
      `CREATE FUNCTION phase8_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END $$`,
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER phase8_test_fail BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION phase8_test_fail()',
    );
    try {
      expect((await receive(o)).status).toBe(500);
      expect(await db.purchaseReceipt.count()).toBe(0);
      expect(await db.inventoryBalance.count()).toBe(0);
      expect(await db.inventoryMovement.count()).toBe(0);
      expect(await db.auditEvent.count()).toBe(before);
      const current = await db.purchaseOrder.findUniqueOrThrow({
        where: { id: o.id },
        include: { lines: true },
      });
      expect(current.status).toBe('SENT');
      expect(current.lines[0]!.receivedQuantity.toFixed(6)).toBe('0.000000');
    } finally {
      await removeFailureTrigger();
    }
  });
  it('rejects invalid filters and returns no foreign actor events', async () => {
    for (const query of [
      { actorId: 'bad' },
      { entityId: 'bad' },
      { from: 'yesterday' },
      { to: '2026-99-99' },
      { from: '2027-01-01', to: '2020-01-01' },
    ])
      expect((await get('/audit', query)).status).toBe(400);
    expect(await events({ actorId: randomUUID() })).toEqual([]);
    expect((await get('/inventory/alerts', { status: 'HACK' })).status).toBe(
      400,
    );
  });
});
