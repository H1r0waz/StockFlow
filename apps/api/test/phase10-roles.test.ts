import { createHash, randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createApp } from '../src/app.js';
const url = process.env.TEST_DATABASE_URL,
  origin = 'http://127.0.0.1:5173';
describe.skipIf(!url)('Phase10 cross-module role matrix', () => {
  let db: PrismaClient, app: ReturnType<typeof createApp>;
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
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  it.each(['OWNER', 'ADMIN', 'MEMBER'] as const)(
    '%s permissions remain consistent across all modules',
    async (role) => {
      const reg = await request(app)
        .post('/api/auth/register')
        .set('Origin', origin)
        .send({
          email: `${randomUUID()}@example.test`,
          password: 'Strong-role-matrix-password42!',
          displayName: 'Role actor',
          organizationName: 'Role organization',
        });
      expect(reg.status).toBe(201);
      const org = reg.body.organization.id,
        user = reg.body.user.id,
        csrf = reg.body.csrfToken,
        cookie = (reg.headers['set-cookie'] as unknown as string[])[0]!.split(
          ';',
        )[0]!,
        base = `/api/organizations/${org}`;
      const product = await db.product.create({
          data: {
            organizationId: org,
            sku: 'ROLE',
            name: 'Role product',
            unitOfMeasure: 'UNIT',
          },
        }),
        supplier = await db.supplier.create({
          data: { organizationId: org, name: 'Role supplier' },
        }),
        a = await db.warehouse.create({
          data: { organizationId: org, name: 'A', code: 'A' },
        }),
        b = await db.warehouse.create({
          data: { organizationId: org, name: 'B', code: 'B' },
        });
      const auth = (t: request.Test) =>
        t.set('Cookie', cookie).set('Origin', origin).set('X-CSRF-Token', csrf);
      const post = (path: string, data: object, key = randomUUID()) =>
        auth(request(app).post(base + path))
          .set('Idempotency-Key', key)
          .send(data);
      // Set up legitimate stock/order through the normal writer before exercising each role.
      expect(
        (
          await post('/inventory/receipts', {
            productId: product.id,
            warehouseId: a.id,
            quantity: '10',
          })
        ).status,
      ).toBe(201);
      const made = await post('/purchase-orders', {
        supplierId: supplier.id,
        lines: [{ productId: product.id, orderedQuantity: '3' }],
      });
      expect(made.status).toBe(201);
      const order = made.body.purchaseOrder;
      expect((await post(`/purchase-orders/${order.id}/send`, {})).status).toBe(
        200,
      );
      await db.membership.updateMany({
        where: { organizationId: org, userId: user },
        data: { role },
      });
      for (const path of [
        '/products',
        '/suppliers',
        '/inventory/balances',
        '/inventory/movements',
        '/purchase-orders',
        `/purchase-orders/${order.id}/receipts`,
        '/dashboard',
        '/inventory/alerts',
        '/reports/products',
        '/exports/products',
      ])
        expect((await auth(request(app).get(base + path))).status, path).toBe(
          200,
        );
      for (const path of ['/audit', '/reports/audit', '/exports/audit'])
        expect((await auth(request(app).get(base + path))).status, path).toBe(
          role === 'MEMBER' ? 403 : 200,
        );
      for (const [path, data] of [
        ['/categories', { name: 'Created category' }],
        [
          '/products',
          { name: 'Created product', sku: 'NEW', unitOfMeasure: 'UNIT' },
        ],
        ['/warehouses', { name: 'C', code: 'C' }],
        ['/suppliers', { name: 'Created supplier' }],
        [
          '/inventory/receipts',
          { productId: product.id, warehouseId: a.id, quantity: '1' },
        ],
        [
          '/inventory/issues',
          { productId: product.id, warehouseId: a.id, quantity: '1' },
        ],
        [
          '/inventory/adjustments',
          {
            productId: product.id,
            warehouseId: a.id,
            quantity: '1',
            direction: 'IN',
            reason: 'Count correction',
          },
        ],
        [
          '/inventory/transfers',
          {
            productId: product.id,
            sourceWarehouseId: a.id,
            destinationWarehouseId: b.id,
            quantity: '1',
          },
        ],
        [
          '/purchase-orders',
          {
            supplierId: supplier.id,
            lines: [{ productId: product.id, orderedQuantity: '1' }],
          },
        ],
        [
          `/purchase-orders/${order.id}/receipts`,
          {
            warehouseId: a.id,
            lines: [{ purchaseOrderLineId: order.lines[0].id, quantity: '1' }],
          },
        ],
      ] as const) {
        const r = await post(path, data);
        expect(r.status, path + JSON.stringify(r.body)).toBe(
          role === 'MEMBER' ? 403 : 201,
        );
      }
      expect(
        (
          await auth(request(app).put(base + '/inventory/thresholds')).send({
            productId: product.id,
            warehouseId: a.id,
            minimumQuantity: '3',
          })
        ).status,
      ).toBe(role === 'MEMBER' ? 403 : 200);
      const csv = 'sku,name,unitOfMeasure\nIMPORT-ROLE,Imported role,UNIT';
      const preview = await post('/imports/products/preview', { csv });
      expect(preview.status).toBe(role === 'MEMBER' ? 403 : 200);
      if (role !== 'MEMBER')
        expect(
          (
            await post('/imports/products/confirm', {
              csv,
              token: preview.body.preview.token,
            })
          ).status,
        ).toBe(201);
      const other = await db.user.create({
        data: {
          email: `${randomUUID()}@example.test`,
          displayName: 'Another actor',
          passwordHash: 'not-a-login-hash',
        },
      });
      expect(
        (await post('/memberships', { email: other.email, role: 'OWNER' }))
          .status,
      ).toBe(role === 'OWNER' ? 201 : 403);
      if (role === 'OWNER') {
        const token = 'b'.repeat(64),
          otherCsrf = 'c'.repeat(64);
        await db.session.create({
          data: {
            organizationId: org,
            userId: other.id,
            tokenHash: createHash('sha256').update(token).digest('hex'),
            csrfToken: otherCsrf,
            expiresAt: new Date(Date.now() + 60000),
          },
        });
        const otherPost = (
          path: string,
          data: object,
          key: string = randomUUID(),
        ) =>
          request(app)
            .post(base + path)
            .set('Cookie', `stockflow_session=${token}`)
            .set('Origin', origin)
            .set('X-CSRF-Token', otherCsrf)
            .set('Idempotency-Key', key)
            .send(data);
        expect(
          (
            await otherPost('/imports/products/confirm', {
              csv,
              token: preview.body.preview.token,
            })
          ).status,
        ).toBe(400);
        const transfer = await db.inventoryTransfer.findFirstOrThrow({
          where: { organizationId: org },
        });
        const command = await db.inventoryCommand.findUniqueOrThrow({
          where: { id: transfer.commandId },
        });
        expect(
          (
            await otherPost(
              '/inventory/transfers',
              {
                productId: product.id,
                sourceWarehouseId: a.id,
                destinationWarehouseId: b.id,
                quantity: '1',
              },
              command.key,
            )
          ).status,
        ).toBe(409);
      }
    },
  );
});
