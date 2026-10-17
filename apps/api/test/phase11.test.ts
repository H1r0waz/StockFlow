import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createApp } from '../src/app.js';
import {
  assertDemoTarget,
  demoAccounts,
  demoOrganization,
  demoPassword,
  seedDemo,
  verifyDemo,
} from '../src/demo/seed.js';

describe('Phase 11 demo database boundary', () => {
  const local =
    'postgresql://stockflow:fictional-password@127.0.0.1:55434/stockflow_demo';
  it('accepts only the isolated demo database by default', () => {
    expect(() => assertDemoTarget(local)).not.toThrow();
    expect(() =>
      assertDemoTarget(local.replace('stockflow_demo', 'stockflow_test')),
    ).toThrow();
    expect(() =>
      assertDemoTarget(local.replace('stockflow_demo', 'stockflow_test'), true),
    ).not.toThrow();
  });
  it.each([
    ['development database', local.replace('stockflow_demo', 'stockflow_dev')],
    ['foreign database', local.replace('stockflow_demo', 'other_project')],
    ['foreign host', local.replace('127.0.0.1', 'example.test')],
    ['foreign port', local.replace('55434', '5432')],
    ['foreign user', local.replace('stockflow:', 'postgres:')],
    ['connection overrides', `${local}?options=-csearch_path=other`],
    ['URL fragment', `${local}#other`],
  ])('rejects %s before connecting', (_label, value) => {
    expect(() => assertDemoTarget(value)).toThrow();
  });
  it('rejects production even on the dedicated database', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => assertDemoTarget(local)).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('Phase 11 real PostgreSQL fictional demo', () => {
  let db: PrismaClient;
  let summary: Awaited<ReturnType<typeof seedDemo>>;
  const namespace = `phase11-${randomUUID()}`;
  beforeAll(async () => {
    assertDemoTarget(url!, true);
    summary = await seedDemo(url!, { testing: true, namespace });
    db = createDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await db?.$disconnect();
  });
  it('preserves timestamptz literals and bound Date epochs with UTC sessions', async () => {
    const instant = new Date('2026-10-17T12:00:00.000Z');
    const [result] = await db.$queryRaw<
      {
        zone: string;
        literal: Date;
        bound: Date;
        literalEpoch: string;
        boundEpoch: string;
      }[]
    >`SELECT current_setting('TimeZone') AS zone,
      '2026-10-17 12:00:00+00'::timestamptz AS literal,
      ${instant}::timestamptz AS bound,
      extract(epoch from '2026-10-17 12:00:00+00'::timestamptz)::text AS "literalEpoch",
      extract(epoch from ${instant}::timestamptz)::text AS "boundEpoch"`;
    expect(result!.zone).toBe('UTC');
    expect(result!.literal.toISOString()).toBe(instant.toISOString());
    expect(result!.bound.toISOString()).toBe(instant.toISOString());
    expect(Number(result!.literalEpoch)).toBe(instant.getTime() / 1000);
    expect(Number(result!.boundEpoch)).toBe(instant.getTime() / 1000);
  });
  it('keeps domain movement and trigger audit timestamps at the same instant', async () => {
    const [result] = await db.$queryRaw<
      { count: bigint; maximumSeconds: string }[]
    >`
      SELECT count(*) AS count, max(abs(extract(epoch FROM (movement."createdAt" - audit."createdAt"))))::text AS "maximumSeconds"
      FROM "InventoryMovement" movement JOIN "AuditEvent" audit ON audit."entityId" = movement.id AND audit."entityType" = 'InventoryMovement'
      WHERE movement."organizationId" = ${summary.organizationId}::uuid`;
    expect(Number(result!.count)).toBeGreaterThan(0);
    expect(Number(result!.maximumSeconds)).toBeLessThan(5);
  });
  it('creates the bounded commercial scenario with real domain operations', async () => {
    expect(summary).toMatchObject({
      products: 40,
      categories: 6,
      warehouses: 3,
      suppliers: 6,
      orders: 10,
      receipts: 5,
      transfers: 6,
      movements: 88,
      imports: 1,
      memberships: 3,
      reused: false,
    });
    expect(summary.audit).toBeGreaterThan(100);
    expect(
      (
        await db.organization.findUniqueOrThrow({
          where: { id: summary.organizationId },
        })
      ).name,
    ).toBe(demoOrganization);
  });
  it('reuses a complete scenario without creating duplicate history', async () => {
    const repeated = await seedDemo(url!, { testing: true, namespace });
    expect(repeated).toEqual({ ...summary, reused: true });
  });
  it('reconciles ledger/balances, purchase receipt totals and exact order statuses', async () => {
    expect(await verifyDemo(db, summary.organizationId)).toMatchObject({
      movements: 88,
      receipts: 5,
    });
    const groups = await db.purchaseOrder.groupBy({
      by: ['status'],
      where: { organizationId: summary.organizationId },
      _count: true,
    });
    expect(
      Object.fromEntries(groups.map((group) => [group.status, group._count])),
    ).toEqual({
      DRAFT: 2,
      SENT: 2,
      PARTIALLY_RECEIVED: 2,
      RECEIVED: 3,
      CANCELLED: 1,
    });
    expect(
      await db.inventoryBalance.count({
        where: { organizationId: summary.organizationId, quantity: { lt: 0 } },
      }),
    ).toBe(0);
  });
  it('authenticates all fictional accounts with the intended roles and permissions', async () => {
    const app = createApp({ prisma: db, rateLimit: { max: 1000 } });
    for (const account of demoAccounts) {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'http://127.0.0.1:5173')
        .send({
          email: account.email.replace('@', `+${namespace}@`),
          password: demoPassword,
        });
      expect(response.status).toBe(200);
      expect(response.body.membership.role).toBe(account.role);
      expect(response.body.organization.id).toBe(summary.organizationId);
      const cookie = (
        response.headers['set-cookie'] as unknown as string[]
      )[0]!.split(';')[0]!;
      const audit = await request(app)
        .get(`/api/organizations/${summary.organizationId}/audit`)
        .set('Cookie', cookie);
      expect(audit.status).toBe(account.role === 'MEMBER' ? 403 : 200);
      const dashboard = await request(app)
        .get(`/api/organizations/${summary.organizationId}/dashboard`)
        .set('Cookie', cookie);
      expect(dashboard.body.dashboard).toMatchObject({
        activeProducts: 40,
        activeWarehouses: 3,
        lowStockProducts: 6,
        outOfStockProducts: 6,
        purchaseOrders: {
          DRAFT: 2,
          SENT: 2,
          PARTIALLY_RECEIVED: 2,
          recentReceived: 3,
        },
      });
    }
  });
  it('contains correlated transfers, receipts and import audit without raw fictional contacts', async () => {
    const events = await db.auditEvent.findMany({
      where: { organizationId: summary.organizationId },
    });
    expect(events.filter((event) => event.action === 'TRANSFER')).toHaveLength(
      6,
    );
    expect(
      events.filter((event) => event.action === 'PURCHASE_RECEIPT'),
    ).toHaveLength(5);
    for (const event of events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(demoPassword);
      expect(serialized).not.toContain('@supplier.example.test');
      expect(serialized).not.toContain('passwordHash');
    }
  });
});
