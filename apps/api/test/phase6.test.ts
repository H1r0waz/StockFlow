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

describe.skipIf(!url)('Phase 6 real PostgreSQL purchasing', () => {
  let db: PrismaClient, other: PrismaClient, app: ReturnType<typeof createApp>;
  let cookie: string,
    csrf: string,
    org: string,
    user: string,
    product: string,
    supplier: string;
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
        password: 'Strong-purchasing-password-42',
        displayName: 'Purchasing Actor',
        organizationName: 'Purchasing Org',
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
    const s = await supplierWrite({
      name: 'Supplier One',
      email: 'supplier@example.test',
      taxId: 'TAX-1',
    });
    expect(s.status).toBe(201);
    supplier = s.body.supplier.id as string;
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
  function supplierWrite(body: Record<string, unknown>, id?: string) {
    const path = `/api/organizations/${org}/suppliers${id ? `/${id}` : ''}`;
    return auth(id ? request(app).patch(path) : request(app).post(path)).send(
      body,
    );
  }
  function draftBody(extra: Record<string, unknown> = {}) {
    return {
      supplierId: supplier,
      lines: [{ productId: product, orderedQuantity: '2.125' }],
      ...extra,
    };
  }
  function create(body = draftBody(), key = randomUUID(), target = app) {
    return auth(
      request(target).post(`/api/organizations/${org}/purchase-orders`),
    )
      .set('Idempotency-Key', key)
      .send(body);
  }
  function edit(id: string, body = draftBody(), target = app) {
    return auth(
      request(target).patch(`/api/organizations/${org}/purchase-orders/${id}`),
    ).send(body);
  }
  function transition(
    id: string,
    action: 'send' | 'cancel',
    key = randomUUID(),
    target = app,
    body?: Record<string, unknown>,
  ) {
    return auth(
      request(target).post(
        `/api/organizations/${org}/purchase-orders/${id}/${action}`,
      ),
    )
      .set('Idempotency-Key', key)
      .send(
        body ?? (action === 'cancel' ? { reason: 'No longer needed' } : {}),
      );
  }
  async function draft(extra: Record<string, unknown> = {}) {
    const r = await create(draftBody(extra));
    expect(r.status).toBe(201);
    return r.body.purchaseOrder.id as string;
  }
  function get(id: string) {
    return auth(
      request(app).get(`/api/organizations/${org}/purchase-orders/${id}`),
    );
  }
  function barrier() {
    let count = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    return async () => {
      if (++count === 2) release();
      await ready;
    };
  }
  function raceApps() {
    const beforeWrite = barrier();
    return [
      createApp({ prisma: db, purchasingHooks: { beforeWrite } }),
      createApp({ prisma: other, purchasingHooks: { beforeWrite } }),
    ] as const;
  }
  async function noStock() {
    expect(await db.inventoryBalance.count()).toBe(0);
    expect(await db.inventoryMovement.count()).toBe(0);
    expect(await db.inventoryTransfer.count()).toBe(0);
    expect(await db.inventoryCommand.count()).toBe(0);
  }
  async function alien() {
    const organization = await db.organization.create({
      data: { name: 'Alien' },
    });
    const p = await db.product.create({
      data: {
        organizationId: organization.id,
        name: 'Alien Flour',
        sku: 'ALIEN',
        unitOfMeasure: 'KG',
        quantityScale: 3,
      },
    });
    const s = await db.supplier.create({
      data: { organizationId: organization.id, name: 'Supplier One' },
    });
    return { org: organization.id, product: p.id, supplier: s.id };
  }

  it('creates, reads, edits, archives and reactivates suppliers without hard delete', async () => {
    const r = await supplierWrite(
      {
        name: 'Renamed',
        legalName: 'Legal Limited',
        taxId: 'TAX-2',
        email: 'orders@example.test',
        phone: '+54 123',
        notes: 'Call first',
      },
      supplier,
    );
    expect(r.status).toBe(200);
    expect(r.body.supplier).toMatchObject({
      id: supplier,
      name: 'Renamed',
      legalName: 'Legal Limited',
      taxId: 'TAX-2',
      active: true,
    });
    expect(
      (
        await auth(
          request(app).get(`/api/organizations/${org}/suppliers/${supplier}`),
        )
      ).body.supplier.id,
    ).toBe(supplier);
    expect(
      (await auth(request(app).get(`/api/organizations/${org}/suppliers`))).body
        .suppliers,
    ).toHaveLength(1);
    expect((await supplierWrite({ active: false }, supplier)).status).toBe(200);
    expect((await create()).status).toBe(409);
    expect((await supplierWrite({ active: true }, supplier)).status).toBe(200);
    expect(await db.supplier.count()).toBe(1);
    expect(
      (
        await auth(
          request(app).delete(
            `/api/organizations/${org}/suppliers/${supplier}`,
          ),
        )
      ).status,
    ).toBe(404);
  });
  it('accepts the same supplier name in another tenant but scopes tax IDs to one organization', async () => {
    const a = await alien();
    expect(a.supplier).toBeTruthy();
    expect(
      (await supplierWrite({ name: 'Second', taxId: 'TAX-1' })).status,
    ).toBe(409);
    expect(
      (
        await db.supplier.create({
          data: { organizationId: a.org, name: 'Other', taxId: 'TAX-1' },
        })
      ).taxId,
    ).toBe('TAX-1');
  });
  it('rejects supplier mass assignment, invalid email and empty names', async () => {
    for (const payload of [
      { name: '' },
      { name: 'Bad', email: 'invalid' },
      { name: 'Bad', organizationId: randomUUID() },
      { name: 'Bad', id: randomUUID() },
    ]) {
      expect((await supplierWrite(payload)).status).toBe(400);
    }
    expect(
      (await supplierWrite({ organizationId: randomUUID() }, supplier)).status,
    ).toBe(400);
  });
  it('creates an exact draft, lists and reads its lines and creator without touching stock', async () => {
    const id = await draft({ notes: 'First order' });
    const r = await get(id);
    expect(r.status).toBe(200);
    expect(r.body.purchaseOrder).toMatchObject({
      id,
      status: 'DRAFT',
      notes: 'First order',
      supplier: { id: supplier },
      creator: { id: user },
    });
    expect(r.body.purchaseOrder.lines).toHaveLength(1);
    expect(r.body.purchaseOrder.lines[0]).toMatchObject({
      productId: product,
      orderedQuantity: '2.125000',
      product: { sku: 'FLOUR' },
    });
    expect(
      (
        await auth(
          request(app).get(`/api/organizations/${org}/purchase-orders`),
        )
      ).body.purchaseOrders,
    ).toHaveLength(1);
    await noStock();
  });
  it('edits a draft by replacing its lines, including add, change and remove', async () => {
    const id = await draft();
    const second = await db.product.create({
      data: {
        organizationId: org,
        name: 'Bag',
        sku: 'BAG',
        unitOfMeasure: 'UNIT',
        quantityScale: 0,
      },
    });
    const lines = [
      { productId: product, orderedQuantity: '3.5' },
      { productId: second.id, orderedQuantity: '4' },
    ];
    expect((await edit(id, draftBody({ notes: 'Edited', lines }))).status).toBe(
      200,
    );
    expect((await get(id)).body.purchaseOrder.lines).toHaveLength(2);
    expect((await edit(id, draftBody({ lines: [lines[1]] }))).status).toBe(200);
    const order = (await get(id)).body.purchaseOrder;
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].orderedQuantity).toBe('4.000000');
    await noStock();
  });
  it.each([
    '0',
    '-1',
    '1.0001',
    '1e2',
    'NaN',
    '100000000000000',
    '1.1234567',
    2,
    null,
  ])(
    'rejects invalid ordered quantity %s atomically',
    async (orderedQuantity) => {
      expect(
        (
          await create(
            draftBody({ lines: [{ productId: product, orderedQuantity }] }),
          )
        ).status,
      ).toBe(400);
      expect(await db.purchaseOrder.count()).toBe(0);
      expect(await db.purchaseOrderLine.count()).toBe(0);
      expect(await db.purchasingCommand.count()).toBe(0);
    },
  );
  it('rejects empty, duplicate and over-limit lines and fractional UNIT quantities', async () => {
    const unit = await db.product.create({
      data: {
        organizationId: org,
        name: 'Bag',
        sku: 'BAG',
        unitOfMeasure: 'UNIT',
        quantityScale: 0,
      },
    });
    for (const lines of [
      [],
      [
        { productId: product, orderedQuantity: '1' },
        { productId: product, orderedQuantity: '2' },
      ],
      Array.from({ length: 101 }, () => ({
        productId: product,
        orderedQuantity: '1',
      })),
      [{ productId: unit.id, orderedQuantity: '0.5' }],
    ]) {
      expect((await create(draftBody({ lines }))).status).toBe(400);
    }
    expect(await db.purchaseOrder.count()).toBe(0);
  });
  it('rejects arbitrary state, tenant, cost and line identifier assignment', async () => {
    const id = await draft();
    for (const extra of [
      { status: 'SENT' },
      { organizationId: randomUUID() },
      { createdById: randomUUID() },
      { unitCost: '10.50' },
    ]) {
      expect((await create(draftBody(extra))).status).toBe(400);
      expect((await edit(id, draftBody(extra))).status).toBe(400);
    }
    expect(
      (
        await edit(
          id,
          draftBody({
            lines: [
              { id: randomUUID(), productId: product, orderedQuantity: '1' },
            ],
          }),
        )
      ).status,
    ).toBe(400);
    expect((await get(id)).body.purchaseOrder.status).toBe('DRAFT');
  });
  it('rejects cross-tenant suppliers, products, order lookup and modifications', async () => {
    const a = await alien();
    expect((await create(draftBody({ supplierId: a.supplier }))).status).toBe(
      404,
    );
    expect(
      (
        await create(
          draftBody({
            lines: [{ productId: a.product, orderedQuantity: '1' }],
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await auth(
          request(app).get(`/api/organizations/${org}/suppliers/${a.supplier}`),
        )
      ).status,
    ).toBe(404);
    expect((await supplierWrite({ name: 'Escape' }, a.supplier)).status).toBe(
      404,
    );
    const id = await draft();
    for (const method of ['get', 'patch'] as const) {
      expect(
        (
          await auth(
            request(app)[method](
              `/api/organizations/${a.org}/purchase-orders/${id}`,
            ),
          ).send(draftBody())
        ).status,
      ).toBe(404);
    }
    expect((await edit(randomUUID())).status).toBe(404);
    expect((await transition(randomUUID(), 'send')).status).toBe(404);
  });
  it('MEMBER reads all purchasing resources but cannot mutate; ADMIN can write', async () => {
    const id = await draft();
    await db.membership.updateMany({
      where: { userId: user },
      data: { role: 'MEMBER' },
    });
    for (const suffix of [
      'suppliers',
      `suppliers/${supplier}`,
      'purchase-orders',
      `purchase-orders/${id}`,
    ]) {
      expect(
        (await auth(request(app).get(`/api/organizations/${org}/${suffix}`)))
          .status,
      ).toBe(200);
    }
    expect((await supplierWrite({ name: 'Forbidden' })).status).toBe(403);
    expect((await supplierWrite({ active: false }, supplier)).status).toBe(403);
    expect((await create()).status).toBe(403);
    expect((await edit(id)).status).toBe(403);
    expect((await transition(id, 'send')).status).toBe(403);
    expect((await transition(id, 'cancel')).status).toBe(403);
    await db.membership.updateMany({
      where: { userId: user },
      data: { role: 'ADMIN' },
    });
    expect((await supplierWrite({ name: 'Admin Supplier' })).status).toBe(201);
    expect((await transition(id, 'send')).status).toBe(200);
  });
  it('requires CSRF and explicit idempotency keys', async () => {
    expect(
      (
        await auth(
          request(app).post(`/api/organizations/${org}/purchase-orders`),
        ).send(draftBody())
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/organizations/${org}/purchase-orders`)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .set('Idempotency-Key', randomUUID())
          .send(draftBody())
      ).status,
    ).toBe(403);
    const id = await draft();
    for (const action of ['send', 'cancel']) {
      expect(
        (
          await auth(
            request(app).post(
              `/api/organizations/${org}/purchase-orders/${id}/${action}`,
            ),
          ).send(action === 'cancel' ? { reason: 'Stop' } : {})
        ).status,
      ).toBe(400);
    }
  });
  it('sends and cancels through explicit transitions and freezes SENT and CANCELLED lines', async () => {
    const id = await draft();
    const sent = await transition(id, 'send');
    expect(sent.status).toBe(200);
    expect(sent.body.purchaseOrder.status).toBe('SENT');
    expect((await edit(id)).status).toBe(409);
    expect((await transition(id, 'send')).status).toBe(409);
    const cancelled = await transition(id, 'cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.purchaseOrder.status).toBe('CANCELLED');
    expect((await edit(id)).status).toBe(409);
    expect((await transition(id, 'send')).status).toBe(409);
    expect((await transition(id, 'cancel')).status).toBe(409);
    await noStock();
  });
  it('cancels a DRAFT and requires a cancellation reason', async () => {
    const id = await draft();
    expect((await transition(id, 'cancel', randomUUID(), app, {})).status).toBe(
      400,
    );
    expect(
      (await transition(id, 'cancel', randomUUID(), app, { reason: '   ' }))
        .status,
    ).toBe(400);
    expect((await transition(id, 'cancel')).status).toBe(200);
    expect((await get(id)).body.purchaseOrder.status).toBe('CANCELLED');
  });
  it('protects suppliers referenced by live orders and allows archival after cancellation', async () => {
    const id = await draft();
    expect((await supplierWrite({ active: false }, supplier)).status).toBe(409);
    expect((await transition(id, 'send')).status).toBe(200);
    expect((await supplierWrite({ active: false }, supplier)).status).toBe(409);
    expect((await transition(id, 'cancel')).status).toBe(200);
    expect((await supplierWrite({ active: false }, supplier)).status).toBe(200);
    expect((await get(id)).body.purchaseOrder.supplier.active).toBe(false);
  });
  it('rejects inactive products when creating a new draft', async () => {
    await db.product.update({
      where: { id: product },
      data: { active: false },
    });
    expect((await create()).status).toBe(409);
    expect(await db.purchaseOrder.count()).toBe(0);
  });
  it('freezes product unit and precision after order history and blocks archival while orders are open', async () => {
    const id = await draft();
    const patchProduct = (payload: Record<string, unknown>) =>
      auth(
        request(app).patch(`/api/organizations/${org}/products/${product}`),
      ).send(payload);
    expect((await patchProduct({ unitOfMeasure: 'G' })).status).toBe(409);
    expect((await patchProduct({ quantityScale: 2 })).status).toBe(409);
    expect((await patchProduct({ active: false })).status).toBe(409);
    expect((await transition(id, 'send')).status).toBe(200);
    expect((await patchProduct({ active: false })).status).toBe(409);
    expect((await transition(id, 'cancel')).status).toBe(200);
    expect((await patchProduct({ active: false })).status).toBe(200);
    expect((await patchProduct({ quantityScale: 2 })).status).toBe(409);
    expect((await patchProduct({ unitOfMeasure: 'G' })).status).toBe(409);
    await noStock();
  });
  it('normalizes trailing zeros to fixed six decimals while still enforcing product scale', async () => {
    const id = await draft({
      lines: [{ productId: product, orderedQuantity: '1.2500' }],
    });
    expect((await get(id)).body.purchaseOrder.lines[0].orderedQuantity).toBe(
      '1.250000',
    );
    expect(
      (
        await edit(
          id,
          draftBody({
            lines: [{ productId: product, orderedQuantity: '0.0001' }],
          }),
        )
      ).status,
    ).toBe(400);
    expect((await get(id)).body.purchaseOrder.lines[0].orderedQuantity).toBe(
      '1.250000',
    );
  });
  it('replays CREATE canonically, rejects changed payload and does not duplicate orders', async () => {
    const key = randomUUID();
    const first = await create(draftBody({ notes: 'Note' }), key);
    const replay = await create(
      draftBody({
        notes: 'Note',
        lines: [{ productId: product, orderedQuantity: '2.125000' }],
      }),
      key,
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect((await create(draftBody({ notes: 'Different' }), key)).status).toBe(
      409,
    );
    expect(await db.purchaseOrder.count()).toBe(1);
    expect(await db.purchasingCommand.count()).toBe(1);
  });
  it('replays SEND and CANCEL after later state changes while rejecting reason conflicts', async () => {
    const id = await draft();
    const sendKey = randomUUID(),
      cancelKey = randomUUID();
    const sent = await transition(id, 'send', sendKey);
    const cancelled = await transition(id, 'cancel', cancelKey);
    expect((await transition(id, 'send', sendKey)).body).toEqual(sent.body);
    expect((await transition(id, 'cancel', cancelKey)).body).toEqual(
      cancelled.body,
    );
    expect(
      (await transition(id, 'cancel', cancelKey, app, { reason: 'Different' }))
        .status,
    ).toBe(409);
    expect((await get(id)).body.purchaseOrder.status).toBe('CANCELLED');
    expect(await db.purchasingCommand.count()).toBe(3);
  });
  it('does not allow a different actor to replay an existing command', async () => {
    const key = randomUUID();
    expect((await create(draftBody(), key)).status).toBe(201);
    const r = await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({
        email: `${randomUUID()}@example.test`,
        password: 'Strong-another-actor-42',
        displayName: 'Other actor',
        organizationName: 'Other',
      });
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
        password: 'Strong-another-actor-42',
        organizationId: org,
      });
    const c = (login.headers['set-cookie'] as unknown as string[])[0]!.split(
      ';',
    )[0]!;
    const replay = await request(app)
      .post(`/api/organizations/${org}/purchase-orders`)
      .set('Cookie', c)
      .set('Origin', origin)
      .set('X-CSRF-Token', login.body.csrfToken as string)
      .set('Idempotency-Key', key)
      .send(draftBody());
    expect(replay.status).toBe(409);
    expect(await db.purchaseOrder.count()).toBe(1);
  });
  it('rolls back draft, all lines and idempotency claim if execution fails after line insertion', async () => {
    const failing = createApp({
      prisma: db,
      purchasingHooks: {
        afterDraftLines: async () => {
          throw Error('Injected purchasing failure');
        },
      },
    });
    const key = randomUUID();
    expect((await create(draftBody(), key, failing)).status).toBe(500);
    expect(await db.purchaseOrder.count()).toBe(0);
    expect(await db.purchaseOrderLine.count()).toBe(0);
    expect(await db.purchasingCommand.count()).toBe(0);
    expect((await create(draftBody(), key)).status).toBe(201);
    await noStock();
  });
  it('rolls back a draft replacement on an injected failure, preserving original lines', async () => {
    const id = await draft();
    const before = (await get(id)).body;
    const failing = createApp({
      prisma: db,
      purchasingHooks: {
        afterDraftLines: async () => {
          throw Error('Injected edit failure');
        },
      },
    });
    expect(
      (
        await edit(
          id,
          draftBody({ lines: [{ productId: product, orderedQuantity: '9' }] }),
          failing,
        )
      ).status,
    ).toBe(500);
    expect((await get(id)).body).toEqual(before);
  });
  it('concurrent independent CREATE retries produce exactly one order and identical responses', async () => {
    const [a, b] = raceApps();
    const key = randomUUID();
    const results = await Promise.all([
      create(draftBody(), key, a),
      create(draftBody(), key, b),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(await db.purchaseOrder.count()).toBe(1);
    expect(await db.purchaseOrderLine.count()).toBe(1);
    expect(await db.purchasingCommand.count()).toBe(1);
  });
  it('A: simultaneous SEND commands with different keys perform only one transition', async () => {
    const id = await draft();
    const [a, b] = raceApps();
    const results = await Promise.all([
      transition(id, 'send', randomUUID(), a),
      transition(id, 'send', randomUUID(), b),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await get(id)).body.purchaseOrder.status).toBe('SENT');
    expect(await db.purchasingCommand.count()).toBe(2);
    await noStock();
  });
  it('concurrent SEND retries with the same key return the identical stored response', async () => {
    const id = await draft();
    const [a, b] = raceApps();
    const key = randomUUID();
    const results = await Promise.all([
      transition(id, 'send', key, a),
      transition(id, 'send', key, b),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(await db.purchasingCommand.count()).toBe(2);
  });
  it('B: draft editing and SEND serialize without editing a SENT order', async () => {
    const id = await draft();
    const [a, b] = raceApps();
    const [edited, sent] = await Promise.all([
      edit(
        id,
        draftBody({ lines: [{ productId: product, orderedQuantity: '8.5' }] }),
        a,
      ),
      transition(id, 'send', randomUUID(), b),
    ]);
    expect(sent.status).toBe(200);
    expect([200, 409]).toContain(edited.status);
    const order = (await get(id)).body.purchaseOrder;
    expect(order.status).toBe('SENT');
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].orderedQuantity).toBe(
      edited.status === 200 ? '8.500000' : '2.125000',
    );
    expect(sent.body.purchaseOrder.lines[0].orderedQuantity).toBe(
      order.lines[0].orderedQuantity,
    );
    await noStock();
  });
  it('D: simultaneous CANCEL and SEND obey the state machine and finish CANCELLED', async () => {
    const id = await draft();
    const [a, b] = raceApps();
    const [cancelled, sent] = await Promise.all([
      transition(id, 'cancel', randomUUID(), a),
      transition(id, 'send', randomUUID(), b),
    ]);
    expect(cancelled.status).toBe(200);
    expect([200, 409]).toContain(sent.status);
    expect((await get(id)).body.purchaseOrder.status).toBe('CANCELLED');
    expect(await db.purchasingCommand.count()).toBe(
      sent.status === 200 ? 3 : 2,
    );
    await noStock();
  });
  it('SQL rejects nonpositive quantities, cross-tenant references and edits to SENT lines', async () => {
    const id = await draft();
    const line = await db.purchaseOrderLine.findFirstOrThrow({
      where: { purchaseOrderId: id },
    });
    await expect(
      db.purchaseOrderLine.update({
        where: { id: line.id },
        data: { orderedQuantity: '0' },
      }),
    ).rejects.toBeDefined();
    const a = await alien();
    await expect(
      db.purchaseOrderLine.update({
        where: { id: line.id },
        data: { productId: a.product },
      }),
    ).rejects.toBeDefined();
    expect((await transition(id, 'send')).status).toBe(200);
    await expect(
      db.purchaseOrderLine.update({
        where: { id: line.id },
        data: { orderedQuantity: '3' },
      }),
    ).rejects.toBeDefined();
    await expect(
      db.purchaseOrderLine.delete({ where: { id: line.id } }),
    ).rejects.toBeDefined();
    await expect(
      db.purchaseOrder.update({ where: { id }, data: { status: 'DRAFT' } }),
    ).rejects.toBeDefined();
    expect((await get(id)).body.purchaseOrder.lines[0].orderedQuantity).toBe(
      '2.125000',
    );
  });
  it('SQL rejects empty orders, deleting their last line and erasing order history', async () => {
    await expect(
      db.purchaseOrder.create({
        data: {
          organizationId: org,
          supplierId: supplier,
          creatorId: user,
        },
      }),
    ).rejects.toBeDefined();
    expect(await db.purchaseOrder.count()).toBe(0);
    const id = await draft();
    const line = await db.purchaseOrderLine.findFirstOrThrow({
      where: { purchaseOrderId: id },
    });
    await expect(
      db.purchaseOrderLine.delete({ where: { id: line.id } }),
    ).rejects.toBeDefined();
    await expect(
      db.purchaseOrderLine.update({
        where: { id: line.id },
        data: { orderedQuantity: '0.0001' },
      }),
    ).rejects.toBeDefined();
    await expect(
      db.purchaseOrder.delete({ where: { id } }),
    ).rejects.toBeDefined();
    expect((await get(id)).body.purchaseOrder.lines).toHaveLength(1);
  });
  it('SQL preserves immutable command responses and protects open-order parents', async () => {
    await draft();
    const command = await db.purchasingCommand.findFirstOrThrow();
    await expect(
      db.purchasingCommand.update({
        where: { id: command.id },
        data: { response: {} },
      }),
    ).rejects.toBeDefined();
    await expect(
      db.purchasingCommand.delete({ where: { id: command.id } }),
    ).rejects.toBeDefined();
    await expect(
      db.supplier.update({ where: { id: supplier }, data: { active: false } }),
    ).rejects.toBeDefined();
    await expect(
      db.product.update({ where: { id: product }, data: { active: false } }),
    ).rejects.toBeDefined();
    await expect(
      db.product.update({ where: { id: product }, data: { quantityScale: 2 } }),
    ).rejects.toBeDefined();
    expect(await db.purchasingCommand.count()).toBe(1);
  });
});
