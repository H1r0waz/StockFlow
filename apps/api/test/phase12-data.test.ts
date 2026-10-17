import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import {
  assertPublicDemoTarget,
  assertPublicDemoMarker,
  publicDemoMarker,
} from '../src/demo/public-target.js';
import {
  assertDemoTarget,
  demoPassword,
  seedDemo,
  verifyDemo,
} from '../src/demo/seed.js';

const cloud =
  'postgresql://admin:fictional-secret@stockflow.cloud.example:5432/stockflow_public?sslmode=verify-full';
const target = {
  host: 'stockflow.cloud.example',
  database: 'stockflow_public',
  confirmation: 'SC-PROJ-STOCKFLOW',
};
describe('Phase 12 public demo administrative boundary', () => {
  it('allows the pinned TLS cloud target in production without relaxing local guards', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => assertPublicDemoTarget(cloud, target)).not.toThrow();
      expect(() =>
        assertDemoTarget(
          'postgresql://stockflow:fake@127.0.0.1:55434/stockflow_demo',
        ),
      ).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    [
      'wrong host',
      cloud.replace('stockflow.cloud.example', 'foreign.cloud.example'),
    ],
    ['wrong database', cloud.replace('/stockflow_public?', '/other?')],
    [
      'local development',
      cloud.replace('/stockflow_public?', '/stockflow_dev?'),
    ],
    ['local test', cloud.replace('/stockflow_public?', '/stockflow_test?')],
    ['local demo', cloud.replace('/stockflow_public?', '/stockflow_demo?')],
    ['missing TLS', cloud.split('?')[0]!],
    ['disabled TLS', cloud.replace('verify-full', 'disable')],
    ['runtime credential', cloud.replace('admin:', 'stockflow_runtime:')],
    [
      'encoded runtime credential',
      cloud.replace('admin:', '%73tockflow_runtime:'),
    ],
    ['connection override', `${cloud}&options=-csearch_path=foreign`],
    ['duplicate key', `${cloud}&sslmode=disable`],
    ['fragment', `${cloud}#foreign`],
    ['foreign port', cloud.replace(':5432/', ':5433/')],
  ])('rejects %s before connecting', (_label, connection) => {
    expect(() => assertPublicDemoTarget(connection, target)).toThrow();
  });
  it('requires explicit consent and pins both host and database', () => {
    for (const host of [
      '127.0.0.2',
      '192.168.1.1',
      'stockflow.local',
      'stockflow.localhost',
    ])
      expect(() =>
        assertPublicDemoTarget(cloud.replace(target.host, host), {
          ...target,
          host,
        }),
      ).toThrow();
    for (const key of ['host', 'database', 'confirmation'] as const)
      expect(() =>
        assertPublicDemoTarget(cloud, { ...target, [key]: undefined }),
      ).toThrow();
    expect(() =>
      assertPublicDemoTarget(cloud, { ...target, confirmation: 'yes' }),
    ).toThrow();
  });
  it('rejects unmarked or foreign databases', () => {
    for (const marker of [
      null,
      undefined,
      '',
      'StockFlow fictional demo v1',
      'other',
    ])
      expect(() => assertPublicDemoMarker(marker)).toThrow();
    expect(() => assertPublicDemoMarker(publicDemoMarker)).not.toThrow();
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('Phase 12 restricted runtime role', () => {
  it('supports auth, transfer, receiving, CSV and member removal with no DDL/history edit grants', async () => {
    assertDemoTarget(url!, true);
    const db = createDatabase(url!);
    const namespace = `runtime-${randomUUID()}`;
    const seeded = await seedDemo(url!, { testing: true, namespace });
    const role = `sf_test_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    const connection = new URL(url!);
    connection.username = role;
    connection.password = password;
    const runtime = createDatabase(connection.toString());
    await db.$executeRawUnsafe(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      const sql = readFileSync(
        new URL('../../../scripts/sql/stockflow-runtime.sql', import.meta.url),
        'utf8',
      ).replaceAll('stockflow_runtime', role);
      for (const statement of sql
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((entry) => entry.trim())
        .filter((entry) => entry && !['BEGIN', 'COMMIT'].includes(entry)))
        await db.$executeRawUnsafe(statement);
      const [grants] = await runtime.$queryRaw<
        {
          canRead: boolean;
          canEditHistory: boolean;
          canTruncate: boolean;
          canCreate: boolean;
          canMigrate: boolean;
        }[]
      >`
        SELECT has_table_privilege(current_user, '"Product"', 'SELECT') AS "canRead",
        has_table_privilege(current_user, '"InventoryMovement"', 'UPDATE') AS "canEditHistory",
        has_table_privilege(current_user, '"InventoryBalance"', 'TRUNCATE') AS "canTruncate",
        has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreate",
        has_table_privilege(current_user, '_prisma_migrations', 'SELECT') AS "canMigrate"`;
      expect(grants).toEqual({
        canRead: true,
        canEditHistory: false,
        canTruncate: false,
        canCreate: false,
        canMigrate: false,
      });
      const app = createApp({
        prisma: runtime,
        publicDemo: false,
        rateLimit: { max: 1000 },
      });
      const origin = 'http://127.0.0.1:5173';
      const login = await request(app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({
          email: `owner+${namespace}@nova.example.test`,
          password: demoPassword,
        });
      expect(login.status).toBe(200);
      const cookie = (
        login.headers['set-cookie'] as unknown as string[]
      )[0]!.split(';')[0]!;
      const prefix = `/api/organizations/${seeded.organizationId}`;
      const post = (path: string, body: object) =>
        request(app)
          .post(`${prefix}${path}`)
          .set('Origin', origin)
          .set('Cookie', cookie)
          .set('X-CSRF-Token', login.body.csrfToken as string)
          .set('Idempotency-Key', randomUUID())
          .send(body);
      const product = await db.product.findFirstOrThrow({
        where: { organizationId: seeded.organizationId, sku: 'NOVA-001' },
      });
      const source = await db.warehouse.findFirstOrThrow({
        where: { organizationId: seeded.organizationId, code: 'CENTRAL' },
      });
      const destination = await db.warehouse.findFirstOrThrow({
        where: { organizationId: seeded.organizationId, code: 'NORTH' },
      });
      expect(
        (
          await post('/inventory/transfers', {
            productId: product.id,
            sourceWarehouseId: source.id,
            destinationWarehouseId: destination.id,
            quantity: '1',
            reason: 'Runtime grant verification',
          })
        ).status,
      ).toBe(201);
      const order = await db.purchaseOrder.findFirstOrThrow({
        where: { organizationId: seeded.organizationId, status: 'SENT' },
        include: { lines: true },
      });
      expect(
        (
          await post(`/purchase-orders/${order.id}/receipts`, {
            warehouseId: source.id,
            lines: [{ purchaseOrderLineId: order.lines[0]!.id, quantity: '1' }],
          })
        ).status,
      ).toBe(201);
      const csv =
        'sku,name,description,unitOfMeasure,quantityScale,categoryId\nNOVA-001,Long grain rice,Runtime grant verification,KG,3,\n';
      const preview = await post('/imports/products/preview', { csv });
      expect(preview.status).toBe(200);
      expect(
        (
          await post('/imports/products/confirm', {
            csv,
            token: preview.body.preview.token,
          })
        ).status,
      ).toBe(201);
      const member = await db.membership.findFirstOrThrow({
        where: { organizationId: seeded.organizationId, role: 'MEMBER' },
      });
      const remove = (id: string) =>
        request(app)
          .delete(`${prefix}/memberships/${id}`)
          .set('Origin', origin)
          .set('Cookie', cookie)
          .set('X-CSRF-Token', login.body.csrfToken as string);
      expect((await remove(member.id)).status).toBe(204);
      const owner = await db.membership.findFirstOrThrow({
        where: { organizationId: seeded.organizationId, role: 'OWNER' },
      });
      expect((await remove(owner.id)).status).toBe(409);
    } finally {
      await runtime.$disconnect();
      await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await db.$executeRawUnsafe(`DROP ROLE "${role}"`);
      await db.$disconnect();
    }
  }, 60000);
});
describe.skipIf(!url)(
  'Phase 12 shared dataset on explicit isolated PostgreSQL test target',
  () => {
    const db = url ? createDatabase(url) : undefined;
    afterAll(async () => {
      await db?.$disconnect();
    });
    it('reuses domain seeding and verifies ledger and receiving consistency without any cloud bypass', async () => {
      assertDemoTarget(url!, true);
      const options = { testing: true, namespace: `phase12-${randomUUID()}` };
      const seeded = await seedDemo(url!, options);
      expect(seeded).toMatchObject({
        products: 40,
        orders: 10,
        receipts: 5,
        transfers: 6,
        memberships: 3,
        reused: false,
      });
      expect(await verifyDemo(db!, seeded.organizationId)).toMatchObject({
        organizationId: seeded.organizationId,
        movements: 88,
      });
      expect(await seedDemo(url!, options)).toMatchObject({
        organizationId: seeded.organizationId,
        reused: true,
      });
    }, 60000);
  },
);
