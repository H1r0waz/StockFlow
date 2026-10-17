import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';
const products =
  'sku,name,unitOfMeasure,quantityScale\r\nCSV-1,CSV product,UNIT,0\r\n';
const suppliers =
  'name,email,phone,taxId,notes\r\nCSV supplier,private@example.test,555123,TAX-PRIVATE,PRIVATE-NOTES\r\n';
type Preview = {
  id: string;
  token: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  rows: { row: number; operation: string; errors: string[] }[];
};
function barrier() {
  let entered = 0,
    release!: () => void;
  const p = new Promise<void>((r) => {
    release = r;
  });
  return async () => {
    if (++entered === 2) release();
    await p;
  };
}
describe.skipIf(!url)('Phase 9 real PostgreSQL CSV and reports', () => {
  let db: PrismaClient,
    app: ReturnType<typeof createApp>,
    org: string,
    user: string,
    cookie: string,
    csrf: string;
  beforeAll(() => {
    const u = new URL(url!);
    if (
      u.hostname !== '127.0.0.1' ||
      u.port !== '55434' ||
      u.pathname !== '/stockflow_test' ||
      u.username !== 'stockflow'
    )
      throw Error('Unsafe database');
    db = createDatabase(url!);
  });
  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE "ImportJob", "AuditEvent", "InventoryThreshold", "InventoryMovement", "InventoryBalance", "InventoryCommand", "PurchaseOrderLine", "PurchaseOrder", "PurchasingCommand", "Supplier", "Product", "Warehouse", "Category", "Session", "Membership", "User", "Organization" CASCADE`;
    app = createApp({ prisma: db, rateLimit: { max: 1000 } });
    const r = await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({
        email: `${randomUUID()}@example.test`,
        password: 'Strong-csv-test-password-42!',
        displayName: 'CSV Operator',
        organizationName: 'CSV Org',
      });
    expect(r.status).toBe(201);
    org = r.body.organization.id;
    user = r.body.user.id;
    csrf = r.body.csrfToken;
    cookie = (r.headers['set-cookie'] as unknown as string[])[0]!.split(
      ';',
    )[0]!;
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const base = (p: string, o = org) => `/api/organizations/${o}${p}`;
  const auth = (t: request.Test) =>
    t.set('Cookie', cookie).set('Origin', origin).set('X-CSRF-Token', csrf);
  const get = (p: string, q: Record<string, unknown> = {}) =>
    auth(request(app).get(base(p))).query(q);
  const preview = (csv = products, type = 'products') =>
    auth(request(app).post(base(`/imports/${type}/preview`))).send({ csv });
  const confirm = (p: Preview, csv = products, type = 'products') =>
    auth(request(app).post(base(`/imports/${type}/confirm`))).send({
      csv,
      token: p.token,
    });
  const inspect = async (csv = products, type = 'products') => {
    const r = await preview(csv, type);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.preview as Preview;
  };
  it('previews without writes, confirms once, persists status and safe audit', async () => {
    const p = await inspect();
    expect(p.totalRows).toBe(1);
    expect(p.createdRows).toBe(1);
    expect(p.rows[0]!.operation).toBe('CREATE');
    expect(await db.product.count()).toBe(0);
    expect(await db.importJob.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
    const r = await confirm(p);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.job.id).toBe(p.id);
    expect(r.body.job.createdRows).toBe(1);
    expect((await get(`/imports/${p.id}`)).body.job).toEqual(r.body.job);
    expect((await confirm(p)).body).toEqual(r.body);
    expect(await db.product.count()).toBe(1);
    expect(await db.importJob.count()).toBe(1);
    const audit = await db.auditEvent.findMany({
      where: { action: 'IMPORT_CONFIRM' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(user);
    expect(audit[0]!.correlationKey).toBe(p.id);
    const rowAudit = await db.auditEvent.findMany({
      where: { entityType: 'Product' },
    });
    expect(rowAudit).toHaveLength(1);
    expect(rowAudit[0]!.correlationKey).toBe(p.id);
    expect(JSON.stringify(audit)).not.toContain('CSV product');
    expect(JSON.stringify(audit)).not.toContain(p.token);
  });
  it('uses normalized SKU to update metadata and skip identical products', async () => {
    await confirm(await inspect());
    const csv = products
      .replace('CSV-1', ' csv-1 ')
      .replace('CSV product', 'Changed product');
    const p = await inspect(csv);
    expect(p.updatedRows).toBe(1);
    expect((await confirm(p, csv)).status).toBe(201);
    expect(await db.product.count()).toBe(1);
    const same = await inspect(csv);
    expect(same.skippedRows).toBe(1);
    expect((await confirm(same, csv)).status).toBe(201);
    expect((await db.product.findFirstOrThrow()).name).toBe('Changed product');
  });
  it('creates suppliers without ambiguous name upsert and audits no contact values', async () => {
    const p = await inspect(suppliers, 'suppliers');
    expect((await confirm(p, suppliers, 'suppliers')).status).toBe(201);
    expect((await confirm(p, suppliers, 'suppliers')).status).toBe(201);
    expect(await db.supplier.count()).toBe(1);
    const audit = JSON.stringify(await db.auditEvent.findMany());
    for (const value of [
      'private@example.test',
      'TAX-PRIVATE',
      'PRIVATE-NOTES',
    ])
      expect(audit).not.toContain(value);
  });
  it('exports actual inventory, orders and receipts using current tenant filters', async () => {
    await confirm(await inspect());
    const product = await db.product.findFirstOrThrow();
    const warehouse = await db.warehouse.create({
      data: { organizationId: org, code: 'CSV-WH', name: 'CSV warehouse' },
    });
    const supplier = await db.supplier.create({
      data: { organizationId: org, name: 'Operational supplier' },
    });
    const made = await auth(request(app).post(base('/purchase-orders')))
      .set('Idempotency-Key', randomUUID())
      .send({
        supplierId: supplier.id,
        lines: [{ productId: product.id, orderedQuantity: '3' }],
      });
    expect(made.status).toBe(201);
    const order = made.body.purchaseOrder;
    expect(
      (
        await auth(request(app).post(base(`/purchase-orders/${order.id}/send`)))
          .set('Idempotency-Key', randomUUID())
          .send({})
      ).status,
    ).toBe(200);
    expect(
      (
        await auth(
          request(app).post(base(`/purchase-orders/${order.id}/receipts`)),
        )
          .set('Idempotency-Key', randomUUID())
          .send({
            warehouseId: warehouse.id,
            lines: [{ purchaseOrderLineId: order.lines[0].id, quantity: '2' }],
          })
      ).status,
    ).toBe(201);
    expect(
      (
        await auth(request(app).put(base('/inventory/thresholds'))).send({
          productId: product.id,
          warehouseId: warehouse.id,
          minimumQuantity: '3',
        })
      ).status,
    ).toBe(200);
    for (const [type, q] of [
      ['inventory', { productId: product.id, warehouseId: warehouse.id }],
      [
        'movements',
        {
          productId: product.id,
          type: 'RECEIPT',
          from: new Date(Date.now() - 60000).toISOString(),
        },
      ],
      [
        'purchase-orders',
        { status: 'PARTIALLY_RECEIVED', supplierId: supplier.id },
      ],
      ['receipts', { purchaseOrderId: order.id, warehouseId: warehouse.id }],
      ['alerts', { status: 'LOW', productId: product.id }],
      ['audit', { action: 'IMPORT_CONFIRM', actorId: user }],
    ] as const) {
      const r = await get('/reports/' + type, q);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.rows).toHaveLength(1);
      const x = await get('/exports/' + type, q);
      expect(x.status).toBe(200);
      expect(x.text.split('\r\n')).toHaveLength(3);
    }
    expect(
      (await get('/reports/inventory', { productId: product.id })).body.rows[0]
        .Quantity,
    ).toBe('2.000000');
    expect(
      (
        await get('/reports/inventory', {
          productId: product.id.toUpperCase(),
          warehouseId: warehouse.id.toUpperCase(),
        })
      ).body.rows,
    ).toHaveLength(1);
    for (const type of ['inventory', 'movements'])
      expect(
        (await get('/reports/' + type, { productId: randomUUID() })).body.rows,
      ).toEqual([]);
    expect(
      (await get('/reports/purchase-orders', { status: 'RECEIVED' })).body.rows,
    ).toEqual([]);
  });
  it('rejects unit changes with configured thresholds and leaves history unchanged', async () => {
    await confirm(await inspect());
    const product = await db.product.findFirstOrThrow();
    const w = await db.warehouse.create({
      data: { organizationId: org, code: 'W', name: 'W' },
    });
    await auth(request(app).put(base('/inventory/thresholds'))).send({
      productId: product.id,
      warehouseId: w.id,
      minimumQuantity: '1',
    });
    const csv = products.replace('UNIT,0', 'KG,3');
    const p = await inspect(csv);
    expect(p.invalidRows).toBe(1);
    expect((await confirm(p, csv)).status).toBe(400);
  });
  it('checks same-tenant supplier tax ID conflicts without name upsert', async () => {
    await confirm(
      await inspect(suppliers, 'suppliers'),
      suppliers,
      'suppliers',
    );
    const same = await inspect(suppliers, 'suppliers');
    expect(same.invalidRows).toBe(1);
    expect((await confirm(same, suppliers, 'suppliers')).status).toBe(400);
    const csv = 'name\nSame supplier\nSame supplier';
    const p = await inspect(csv, 'suppliers');
    expect(p.createdRows).toBe(2);
    expect((await confirm(p, csv, 'suppliers')).status).toBe(201);
  });
  it('preserves job immutability and rejects replay after permission revocation', async () => {
    const p = await inspect();
    expect((await confirm(p)).status).toBe(201);
    await expect(
      db.$executeRaw`UPDATE "ImportJob" SET "createdRows"=0 WHERE id=${p.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM "ImportJob" WHERE id=${p.id}::uuid`,
    ).rejects.toThrow();
    await db.membership.updateMany({
      where: { organizationId: org, userId: user },
      data: { role: 'MEMBER' },
    });
    expect((await confirm(p)).status).toBe(403);
  });
  it.each([
    ['duplicate SKU', 'sku,name,unitOfMeasure\nX,One,UNIT\nx,Two,UNIT\n'],
    ['invalid SKU', 'sku,name,unitOfMeasure\n=BAD,One,UNIT\n'],
    ['invalid unit', 'sku,name,unitOfMeasure\nX,One,EURO\n'],
    ['invalid scale', 'sku,name,unitOfMeasure,quantityScale\nX,One,UNIT,7\n'],
    [
      'foreign reference',
      `sku,name,unitOfMeasure,categoryId\nX,One,UNIT,${randomUUID()}\n`,
    ],
  ])('reports row errors and applies nothing: %s', async (_name, csv) => {
    const p = await inspect(csv);
    expect(p.invalidRows).toBeGreaterThan(0);
    expect(
      p.rows.some((r) => r.operation === 'ERROR' && r.errors.length > 0),
    ).toBe(true);
    expect((await confirm(p, csv)).status).toBe(400);
    expect(await db.product.count()).toBe(0);
    expect(await db.importJob.count()).toBe(0);
  });
  it.each([
    ['unterminated quote', 'sku,name,unitOfMeasure\nX,"unfinished,UNIT'],
    ['duplicate header', 'sku,sku,name\nX,X,One'],
    [
      'unknown header',
      'sku,name,unitOfMeasure,organizationId\nX,One,UNIT,nope',
    ],
    ['too many columns', 'a,b,c,d,e,f,g,h,i\n1,2,3,4,5,6,7,8,9'],
    ['invalid encoding', 'sku,name,unitOfMeasure\nX,\uFFFD,UNIT'],
    ['NUL', 'sku,name,unitOfMeasure\nX,\u0000,UNIT'],
    ['empty', ''],
    [
      'too many rows',
      'sku,name,unitOfMeasure\n' +
        Array.from({ length: 2001 }, (_, i) => `X${i},Row,UNIT`).join('\n'),
    ],
    ['oversized', 'sku,name,unitOfMeasure\nX,' + 'a'.repeat(262145) + ',UNIT'],
  ])('rejects invalid format or bounded input: %s', async (_name, csv) => {
    const r = await preview(csv);
    expect([400, 413]).toContain(r.status);
    expect(await db.product.count()).toBe(0);
  });
  it('accepts BOM, commas, escaped quotes, CRLF and blank lines', async () => {
    const csv =
      '\ufeffsku,name,unitOfMeasure,description\r\n\r\nX,"Coffee, ground",KG,"Quote ""ok""\r\nline"\r\n';
    const p = await inspect(csv);
    expect(p.totalRows).toBe(1);
    expect((await confirm(p, csv)).status).toBe(201);
    expect((await db.product.findFirstOrThrow()).description).toContain(
      'Quote "ok"',
    );
  });
  it('rejects stale product updates without losing another writer changes', async () => {
    await confirm(await inspect());
    const csv = products.replace('CSV product', 'Import edit');
    const p = await inspect(csv);
    const product = await db.product.findFirstOrThrow();
    expect(
      (
        await auth(request(app).patch(base(`/products/${product.id}`))).send({
          name: 'Concurrent edit',
        })
      ).status,
    ).toBe(200);
    expect((await confirm(p, csv)).status).toBe(409);
    expect((await db.product.findFirstOrThrow()).name).toBe('Concurrent edit');
    expect(await db.importJob.count()).toBe(1);
  });
  it('detects a created SKU after preview, and allows that SKU in another tenant', async () => {
    const p = await inspect();
    const other = await db.organization.create({ data: { name: 'Other' } });
    await db.product.create({
      data: {
        organizationId: other.id,
        sku: 'CSV-1',
        name: 'Foreign',
        unitOfMeasure: 'UNIT',
      },
    });
    expect((await confirm(p)).status).toBe(201);
    const csv = products.replaceAll('CSV-1', 'NEW');
    const p2 = await inspect(csv);
    await db.product.create({
      data: {
        organizationId: org,
        sku: 'NEW',
        name: 'Race',
        unitOfMeasure: 'UNIT',
      },
    });
    expect((await confirm(p2, csv)).status).toBe(409);
    expect(await db.product.count({ where: { organizationId: org } })).toBe(2);
  });
  it('revalidates category activity at confirmation', async () => {
    const category = await db.category.create({
      data: { organizationId: org, name: 'C', normalizedName: 'c' },
    });
    const csv = products
      .replace('quantityScale', 'quantityScale,categoryId')
      .replace('UNIT,0', 'UNIT,0,' + category.id);
    const p = await inspect(csv);
    await db.category.update({
      where: { id: category.id },
      data: { active: false },
    });
    expect((await confirm(p, csv)).status).toBe(409);
    expect(await db.product.count()).toBe(0);
  });
  it('preserves an existing category omitted from the CSV, including inactive retained assignment', async () => {
    const category = await db.category.create({
      data: {
        organizationId: org,
        name: 'Retained',
        normalizedName: 'retained',
      },
    });
    await db.product.create({
      data: {
        organizationId: org,
        sku: 'CSV-1',
        name: 'Previous',
        unitOfMeasure: 'UNIT',
        categoryId: category.id,
      },
    });
    await db.category.update({
      where: { id: category.id },
      data: { active: false },
    });
    const p = await inspect();
    expect(p.invalidRows).toBe(0);
    expect(p.updatedRows).toBe(1);
    expect((await confirm(p)).status).toBe(201);
    expect((await db.product.findFirstOrThrow()).categoryId).toBe(category.id);
    const same = await inspect();
    expect(same.skippedRows).toBe(1);
  });
  it('rejects tampered token, changed file, wrong resource and unknown body fields', async () => {
    const p = await inspect();
    expect((await confirm({ ...p, token: p.token + 'x' })).status).toBe(400);
    expect(
      (await confirm(p, products.replace('product', 'other'))).status,
    ).toBe(400);
    expect((await confirm(p, products, 'suppliers')).status).toBe(400);
    expect(
      (
        await auth(request(app).post(base('/imports/products/preview'))).send({
          csv: products,
          path: '../../external',
        })
      ).status,
    ).toBe(400);
  });
  it('expires an unconfirmed preview after thirty minutes', async () => {
    const p = await inspect();
    app = createApp({
      prisma: db,
      rateLimit: { max: 1000 },
      now: () => new Date(Date.now() + 31 * 60 * 1000),
    });
    expect((await confirm(p)).status).toBe(409);
    expect(await db.product.count()).toBe(0);
  });
  it('serializes two concurrent imports of the same SKU', async () => {
    const a = await inspect(),
      b = await inspect();
    app = createApp({
      prisma: db,
      rateLimit: { max: 1000 },
      importHooks: { beforeConfirmLock: barrier() },
    });
    const result = await Promise.all([confirm(a), confirm(b)]);
    expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.product.count()).toBe(1);
    expect(await db.importJob.count()).toBe(1);
  });
  it('two concurrent confirmations of one preview replay the same committed job', async () => {
    const p = await inspect();
    app = createApp({
      prisma: db,
      rateLimit: { max: 1000 },
      importHooks: { beforeConfirmLock: barrier() },
    });
    const [a, b] = await Promise.all([confirm(p), confirm(p)]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body).toEqual(b.body);
    expect(await db.product.count()).toBe(1);
    expect(
      await db.auditEvent.count({ where: { action: 'IMPORT_CONFIRM' } }),
    ).toBe(1);
  });
  it('rolls back all products, job and audit on a late failure, then retries safely', async () => {
    const p = await inspect();
    app = createApp({
      prisma: db,
      rateLimit: { max: 1000 },
      importHooks: {
        afterApply: async () => {
          throw Error('Injected failure');
        },
      },
    });
    expect((await confirm(p)).status).toBe(500);
    expect(await db.product.count()).toBe(0);
    expect(await db.importJob.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
    app = createApp({ prisma: db, rateLimit: { max: 1000 } });
    expect((await confirm(p)).status).toBe(201);
  });
  it('rejects MEMBER imports and audit exports, retaining ordinary report reads', async () => {
    const p = await inspect();
    await db.membership.updateMany({
      where: { organizationId: org, userId: user },
      data: { role: 'MEMBER' },
    });
    expect((await preview()).status).toBe(403);
    expect((await confirm(p)).status).toBe(403);
    expect((await get(`/imports/${p.id}`)).status).toBe(403);
    expect((await get('/exports/audit')).status).toBe(403);
    expect((await get('/reports/audit')).status).toBe(403);
    expect((await get('/reports/products')).status).toBe(200);
  });
  it('rejects a foreign organization path and foreign job lookup', async () => {
    const p = await inspect();
    await confirm(p);
    const other = await db.organization.create({ data: { name: 'Other' } });
    expect(
      (
        await auth(
          request(app).post(base('/imports/products/preview', other.id)),
        ).send({ csv: products })
      ).status,
    ).toBe(404);
    expect(
      (await auth(request(app).get(base('/exports/products', other.id))))
        .status,
    ).toBe(404);
    expect((await get(`/imports/${randomUUID()}`)).status).toBe(404);
  });
  it('exports only the current tenant and neutralizes formula cells without contact leakage', async () => {
    await confirm(await inspect());
    await confirm(
      await inspect(suppliers, 'suppliers'),
      suppliers,
      'suppliers',
    );
    await db.product.updateMany({
      where: { organizationId: org },
      data: { name: ' =HYPERLINK("bad")' },
    });
    const other = await db.organization.create({ data: { name: 'Foreign' } });
    await db.product.create({
      data: {
        organizationId: other.id,
        sku: 'FOREIGN',
        name: 'FOREIGN-PRIVATE',
        unitOfMeasure: 'UNIT',
      },
    });
    const r = await get('/exports/products');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.text).toContain("' =HYPERLINK");
    expect(r.text).not.toContain('FOREIGN-PRIVATE');
    const s = await get('/exports/suppliers');
    for (const secret of [
      'private@example.test',
      'TAX-PRIVATE',
      'PRIVATE-NOTES',
    ])
      expect(s.text).not.toContain(secret);
  });
  it.each([
    'products',
    'suppliers',
    'inventory',
    'movements',
    'purchase-orders',
    'receipts',
    'audit',
    'alerts',
  ])('returns bounded report and CSV contracts for %s', async (type) => {
    const r = await get('/reports/' + type, { limit: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Array.isArray(r.body.columns)).toBe(true);
    expect(Array.isArray(r.body.rows)).toBe(true);
    expect(r.body.rows.length).toBeLessThanOrEqual(1);
    const x = await get('/exports/' + type, { limit: 1 });
    expect(x.status).toBe(200);
    expect(x.headers['x-has-more']).toBeDefined();
    expect(x.text).not.toContain('passwordHash');
  });
  it('paginates stable report rows and signals truncated exports', async () => {
    const csv = 'sku,name,unitOfMeasure\nA,Same,UNIT\nB,Same,UNIT\nC,Same,UNIT';
    await confirm(await inspect(csv), csv);
    const a = await get('/reports/products', { limit: 2 }),
      b = await get('/reports/products', {
        limit: 2,
        offset: a.body.nextOffset,
      });
    expect(a.body.hasMore).toBe(true);
    expect(b.body.hasMore).toBe(false);
    expect(
      new Set(
        [...a.body.rows, ...b.body.rows].map((r: { SKU: string }) => r.SKU),
      ).size,
    ).toBe(3);
    const x = await get('/exports/products', { limit: 2 });
    expect(x.headers['x-has-more']).toBe('true');
    expect(x.headers['x-next-offset']).toBe('2');
  });
  it.each([
    { limit: 2001 },
    { limit: 0 },
    { offset: 1000001 },
    { unknown: 'x' },
    { limit: ['1', '2'] },
  ])('rejects abusive exports/report filters %j', async (q) => {
    expect((await get('/exports/products', q)).status).toBe(400);
  });
});
