import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';
describe.skipIf(!url)('Phase 10 real PostgreSQL HTTP hardening', () => {
  let db: PrismaClient, app: ReturnType<typeof createApp>;
  let org: string, user: string, cookie: string, csrf: string;
  let clock: Date;
  const base = (path: string) => `/api/organizations/${org}${path}`;
  const auth = (test: request.Test) =>
    test.set('Cookie', cookie).set('Origin', origin).set('X-CSRF-Token', csrf);
  beforeAll(() => {
    const target = new URL(url!);
    if (
      target.protocol !== 'postgresql:' ||
      target.hostname !== '127.0.0.1' ||
      target.port !== '55434' ||
      target.pathname !== '/stockflow_test' ||
      target.username !== 'stockflow'
    )
      throw Error('Unsafe test database');
    db = createDatabase(url!);
  });
  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE "ImportJob", "AuditEvent", "InventoryThreshold", "InventoryMovement", "InventoryBalance", "InventoryCommand", "PurchaseOrderLine", "PurchaseOrder", "PurchasingCommand", "Supplier", "Product", "Warehouse", "Category", "Session", "Membership", "User", "Organization" CASCADE`;
    clock = new Date();
    app = createApp({
      prisma: db,
      now: () => clock,
      rateLimit: { max: 1000 },
      operationRateLimits: {
        windowMs: 1000,
        mutations: 2,
        imports: 2,
        reads: 2,
      },
    });
    const r = await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({
        email: `${randomUUID()}@example.test`,
        password: 'Strong-hardening-password-42!',
        displayName: 'Hardening Actor',
        organizationName: 'Hardening Org',
      });
    expect(r.status).toBe(201);
    org = r.body.organization.id;
    user = r.body.user.id;
    csrf = r.body.csrfToken;
    cookie = (r.headers['set-cookie'] as unknown as string[])[0]!.split(
      ';',
    )[0]!;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => db?.$disconnect());
  it('limits successful authenticated mutations, returns Retry-After and resets', async () => {
    const post = () =>
      auth(request(app).post(base('/categories'))).send({ name: randomUUID() });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const r = await post();
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
    expect(await db.category.count()).toBe(2);
    clock = new Date(clock.getTime() + 1000);
    expect((await post()).status).toBe(201);
  });
  it('rejects unauthenticated and invalid CSRF requests before consuming mutation quota', async () => {
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await request(app)
            .post(base('/categories'))
            .set('Origin', origin)
            .send({ name: 'No session' })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(app)
            .post(base('/categories'))
            .set('Origin', origin)
            .set('Cookie', cookie)
            .send({ name: 'No CSRF' })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await auth(request(app).post(base('/categories'))).send({
          name: 'Valid',
        })
      ).status,
    ).toBe(201);
  });
  it('allows session revocation after exhausting the mutation quota', async () => {
    for (let i = 0; i < 2; i++)
      expect(
        (
          await auth(request(app).post(base('/categories'))).send({
            name: randomUUID(),
          })
        ).status,
      ).toBe(201);
    expect(
      (
        await auth(request(app).post(base('/categories'))).send({
          name: 'Throttled',
        })
      ).status,
    ).toBe(429);
    expect((await auth(request(app).post('/api/auth/logout'))).status).toBe(
      204,
    );
    expect(
      (await request(app).get('/api/auth/session').set('Cookie', cookie))
        .status,
    ).toBe(401);
  });
  it('gives import and ordinary mutation independent budgets', async () => {
    const preview = () =>
      auth(request(app).post(base('/imports/products/preview'))).send({
        csv: 'sku,name,unitOfMeasure,quantityScale\r\nHARD,Hardening,UNIT,0\r\n',
      });
    expect((await preview()).status).toBe(200);
    expect((await preview()).status).toBe(200);
    expect((await preview()).status).toBe(429);
    expect(
      (
        await auth(request(app).post(base('/categories'))).send({
          name: 'Available budget',
        })
      ).status,
    ).toBe(201);
    expect(await db.product.count()).toBe(0);
    expect(await db.importJob.count()).toBe(0);
  });
  it('limits expensive reads across dashboard, reports and audit while normal catalog stays available', async () => {
    expect((await auth(request(app).get(base('/dashboard')))).status).toBe(200);
    expect((await auth(request(app).get(base('/audit')))).status).toBe(200);
    const r = await auth(request(app).get(base('/reports/products')));
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
    expect((await auth(request(app).get(base('/products')))).status).toBe(200);
  });
  it('does not share an operational budget with another user behind the same IP', async () => {
    for (let i = 0; i < 2; i++)
      expect((await auth(request(app).get(base('/dashboard')))).status).toBe(
        200,
      );
    const r = await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({
        email: `${randomUUID()}@example.test`,
        password: 'Another-strong-password-42!',
        displayName: 'Second Actor',
        organizationName: 'Second Org',
      });
    expect(r.status).toBe(201);
    const secondCookie = (
      r.headers['set-cookie'] as unknown as string[]
    )[0]!.split(';')[0]!;
    expect(
      (
        await request(app)
          .get(`/api/organizations/${r.body.organization.id}/dashboard`)
          .set('Cookie', secondCookie)
      ).status,
    ).toBe(200);
    expect((await auth(request(app).get(base('/dashboard')))).status).toBe(429);
  });
  it('keeps exact-origin and CSRF checks even for valid authenticated cookies', async () => {
    const r = await auth(request(app).post(base('/categories')))
      .set('Origin', `${origin}.attacker.test`)
      .send({ name: 'Rejected' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ORIGIN_REJECTED');
    expect(
      (
        await auth(request(app).post(base('/categories')))
          .set('X-CSRF-Token', '0'.repeat(64))
          .send({ name: 'Rejected' })
      ).status,
    ).toBe(403);
    expect(await db.category.count()).toBe(0);
  });
  it('bounds organization chooser pages without exposing other users organizations', async () => {
    const ids = [org];
    for (let i = 0; i < 2; i++) {
      const o = await db.organization.create({ data: { name: `Joined ${i}` } });
      ids.push(o.id);
      await db.membership.create({
        data: { userId: user, organizationId: o.id, role: 'MEMBER' },
      });
    }
    await db.organization.create({
      data: { name: 'Foreign secret organization' },
    });
    const first = await auth(request(app).get('/api/auth/organizations')).query(
      { limit: 2 },
    );
    expect(first.status).toBe(200);
    expect(first.body.organizations).toHaveLength(2);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextOffset).toBe(2);
    const second = await auth(
      request(app).get('/api/auth/organizations'),
    ).query({ limit: 2, offset: 2 });
    expect(second.body.organizations).toHaveLength(1);
    expect(second.body.hasMore).toBe(false);
    const received = [
      ...first.body.organizations,
      ...second.body.organizations,
    ] as { id: string }[];
    expect(received.map((o) => o.id).sort()).toEqual(ids.sort());
    expect(
      (
        await auth(request(app).get('/api/auth/organizations')).query({
          unknown: 'x',
        })
      ).status,
    ).toBe(400);
  });
  it.each([
    { type: 'RECEIPT' },
    { from: '2026-10-17T00:00:00Z' },
    { to: '2026-10-17T00:00:00Z' },
  ])('rejects ignored balance filters %s', async (query) => {
    expect(
      (await auth(request(app).get(base('/inventory/balances'))).query(query))
        .status,
    ).toBe(400);
  });
  it('uses Secure cookies in production and maintains safe session DTOs', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const prod = createApp({
      prisma: db,
      allowedOrigin: 'https://app.example.test',
    });
    const r = await request(prod)
      .post('/api/auth/register')
      .set('Origin', 'https://app.example.test')
      .send({
        email: `${randomUUID()}@example.test`,
        password: 'Production-test-password-42!',
        displayName: 'Production Actor',
        organizationName: 'Production Org',
      });
    expect(r.status).toBe(201);
    const setCookie = (r.headers['set-cookie'] as unknown as string[])[0]!;
    expect(setCookie).toContain('; Secure');
    expect(setCookie).toContain('; HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const session = await request(prod)
      .get('/api/auth/session')
      .set('Cookie', setCookie.split(';')[0]!);
    expect(session.status).toBe(200);
    expect(JSON.stringify(session.body)).not.toMatch(
      /passwordHash|tokenHash|Production-test-password/,
    );
    const logout = await request(prod)
      .post('/api/auth/logout')
      .set('Origin', 'https://app.example.test')
      .set('Cookie', setCookie.split(';')[0]!)
      .set('X-CSRF-Token', r.body.csrfToken);
    expect(logout.status).toBe(204);
    expect(
      (
        await request(prod)
          .get('/api/auth/session')
          .set('Cookie', setCookie.split(';')[0]!)
      ).status,
    ).toBe(401);
  });
});
