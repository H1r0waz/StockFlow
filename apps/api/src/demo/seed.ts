import request from 'supertest';
import { createDatabase } from '../database.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createApp } from '../app.js';
import { hashPassword } from '../modules/auth/passwords.js';
import {
  assertPublicDemoTarget,
  assertPublicDemoMarker,
  type PublicDemoTarget,
} from './public-target.js';

export const demoOrganization = 'Distribuidora Nova · Fictional demo';
export class DemoError extends Error {}
export const demoPassword = 'Nova-demo-only-42!';
export const demoAccounts = [
  {
    email: 'owner@nova.example.test',
    displayName: 'Alex Nova · Owner',
    role: 'OWNER',
  },
  {
    email: 'admin@nova.example.test',
    displayName: 'Sam Nova · Operations',
    role: 'ADMIN',
  },
  {
    email: 'member@nova.example.test',
    displayName: 'Robin Nova · Warehouse',
    role: 'MEMBER',
  },
] as const;

export function assertDemoTarget(value: string, testing = false) {
  const url = new URL(value);
  if (
    process.env.NODE_ENV === 'production' ||
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55434' ||
    url.username !== 'stockflow' ||
    url.search ||
    url.hash ||
    url.pathname !== (testing ? '/stockflow_test' : '/stockflow_demo')
  )
    throw new DemoError(
      'Demo commands require the dedicated local demo database (or explicit test helper).',
    );
}

export async function verifyDemo(db: PrismaClient, organizationId: string) {
  const [
    products,
    categories,
    warehouses,
    suppliers,
    orders,
    receipts,
    transfers,
    movements,
    audit,
    imports,
    memberships,
  ] = await Promise.all([
    db.product.count({ where: { organizationId } }),
    db.category.count({ where: { organizationId } }),
    db.warehouse.count({ where: { organizationId } }),
    db.supplier.count({ where: { organizationId } }),
    db.purchaseOrder.count({ where: { organizationId } }),
    db.purchaseReceipt.count({ where: { organizationId } }),
    db.inventoryTransfer.count({ where: { organizationId } }),
    db.inventoryMovement.count({ where: { organizationId } }),
    db.auditEvent.count({ where: { organizationId } }),
    db.importJob.count({ where: { organizationId } }),
    db.membership.count({ where: { organizationId } }),
  ]);
  const mismatches = await db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM (
      SELECT "productId", "warehouseId", sum(CASE WHEN type::text IN ('RECEIPT','ADJUSTMENT_IN','TRANSFER_IN') THEN quantity ELSE -quantity END) AS quantity
      FROM "InventoryMovement" WHERE "organizationId" = ${organizationId}::uuid GROUP BY "productId", "warehouseId"
    ) ledger FULL JOIN (SELECT * FROM "InventoryBalance" WHERE "organizationId" = ${organizationId}::uuid) balance
      USING ("productId", "warehouseId") WHERE coalesce(ledger.quantity, 0) <> coalesce(balance.quantity, 0)`;
  const incorrectOrders = await db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM "PurchaseOrderLine" line WHERE line."organizationId" = ${organizationId}::uuid AND
      line."receivedQuantity" <> coalesce((SELECT sum(receipt."receivedQuantity") FROM "PurchaseReceiptLine" receipt WHERE receipt."purchaseOrderLineId" = line.id AND receipt."organizationId" = ${organizationId}::uuid),0)`;
  if (
    products !== 40 ||
    categories !== 6 ||
    warehouses !== 3 ||
    suppliers !== 6 ||
    orders !== 10 ||
    memberships !== 3 ||
    receipts < 5 ||
    transfers < 6 ||
    movements < 80 ||
    !audit ||
    imports !== 1 ||
    mismatches[0]?.count !== 0n ||
    incorrectOrders[0]?.count !== 0n
  )
    throw new DemoError(
      'Demo is incomplete or has changed. Review it, then use the explicit demo reset to rebuild.',
    );
  return {
    organizationId,
    products,
    categories,
    warehouses,
    suppliers,
    orders,
    receipts,
    transfers,
    movements,
    audit,
    imports,
    memberships,
  };
}

/** Isolated demo initializer; test mode is explicitly restricted to stockflow_test. */
export async function seedDemo(
  value: string,
  options: { testing?: boolean; namespace?: string } = {},
) {
  assertDemoTarget(value, options.testing);
  return seedScenario(value, options);
}

/** Administrative entry only: pinned cloud database, explicit consent and marker. */
export async function seedPublicDemo(value: string, target: PublicDemoTarget) {
  assertPublicDemoTarget(value, target);
  return seedScenario(value, {}, true);
}

async function seedScenario(
  value: string,
  options: { testing?: boolean; namespace?: string },
  publicTarget = false,
) {
  if (
    options.namespace &&
    (!options.testing || !/^[a-z0-9-]{1,80}$/.test(options.namespace))
  )
    throw new DemoError(
      'Demo namespaces are restricted to isolated test scenarios.',
    );
  const accounts = demoAccounts.map((account) => ({
    ...account,
    email: options.namespace
      ? account.email.replace('@', `+${options.namespace}@`)
      : account.email,
  }));
  const db = createDatabase(value);
  try {
    if (publicTarget) {
      const [database] = await db.$queryRaw<
        { marker: string | null }[]
      >`SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`;
      assertPublicDemoMarker(database?.marker);
    }
    const existing = options.namespace
      ? await db.organization.findFirst({
          where: {
            memberships: { some: { user: { email: accounts[0]!.email } } },
          },
        })
      : await db.organization.findFirst({ where: { name: demoOrganization } });
    if (existing)
      return { ...(await verifyDemo(db, existing.id)), reused: true };
    if (
      !options.namespace &&
      ((await db.organization.count()) || (await db.user.count()))
    )
      throw new DemoError(
        'Demo initialization requires an empty isolated database.',
      );
    const origin =
      process.env.NODE_ENV === 'production'
        ? 'https://stockflow.example.test'
        : 'http://127.0.0.1:5173';
    const app = createApp({
      prisma: db,
      // Only the administrative in-process client can bootstrap demo accounts.
      publicDemo: false,
      allowedOrigin: origin,
      rateLimit: { max: 10000 },
      operationRateLimits: { mutations: 10000, imports: 10000, reads: 10000 },
    });
    const registration = await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({
        email: accounts[0]!.email,
        displayName: accounts[0]!.displayName,
        password: demoPassword,
        organizationName: demoOrganization,
      });
    if (registration.status !== 201)
      throw new DemoError(
        `Demo owner registration failed (${registration.status}).`,
      );
    const organizationId = registration.body.organization.id as string;
    const cookie = (
      registration.headers['set-cookie'] as unknown as string[]
    )[0]!.split(';')[0]!;
    const csrf = registration.body.csrfToken as string;
    const prefix = `/api/organizations/${organizationId}`;
    let sequence = 0;
    async function write(
      path: string,
      body: object,
      method: 'post' | 'put' = 'post',
    ) {
      const pending =
        method === 'post'
          ? request(app).post(`${prefix}${path}`)
          : request(app).put(`${prefix}${path}`);
      const result = await pending
        .set('Cookie', cookie)
        .set('Origin', origin)
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', `nova-demo-v1-${++sequence}`)
        .send(body);
      if (result.status < 200 || result.status > 201)
        throw new DemoError(
          `Demo domain operation ${path} failed (${result.status}: ${result.body.error?.code ?? 'unknown'}). Use demo:reset after resolving the cause.`,
        );
      return result.body;
    }
    // Authentication bootstrap only; role membership itself uses the normal OWNER route.
    for (const account of accounts.slice(1)) {
      await db.user.create({
        data: {
          email: account.email,
          displayName: account.displayName,
          passwordHash: await hashPassword(demoPassword),
        },
      });
      await write('/memberships', { email: account.email, role: account.role });
    }
    const categoryIds: string[] = [];
    for (const name of [
      'Pantry staples',
      'Beverages',
      'Cleaning',
      'Packaging',
      'Personal care',
      'Office supplies',
    ])
      categoryIds.push(
        (
          await write('/categories', {
            name,
            description: 'Fictional Nova demonstration catalog.',
          })
        ).category.id,
      );
    const warehouseIds: string[] = [];
    for (const [code, name] of [
      ['CENTRAL', 'Central distribution'],
      ['NORTH', 'North branch'],
      ['SHOWROOM', 'Retail showroom'],
    ])
      warehouseIds.push(
        (await write('/warehouses', { code, name })).warehouse.id,
      );
    const supplierIds: string[] = [];
    for (const name of [
      'Nova Pantry Partners',
      'Blue Orchard Drinks',
      'Clear Harbor Supplies',
      'Paper Kite Packaging',
      'Meadow Personal Care',
      'Desk Grove Office',
    ])
      supplierIds.push(
        (
          await write('/suppliers', {
            name,
            email: `${supplierIds.length + 1}@supplier.example.test`,
            notes:
              'Entirely fictional supplier. No real commercial relationship.',
          })
        ).supplier.id,
      );
    const names = [
      'Long grain rice',
      'All-purpose flour',
      'Brown sugar',
      'Chickpeas',
      'Olive oil',
      'Coffee beans',
      'Black tea',
      'Sparkling water',
      'Apple juice',
      'Lemon drink',
      'Ground coffee',
      'Cocoa powder',
      'Dish soap',
      'Floor cleaner',
      'Laundry powder',
      'Microfiber cloth',
      'Cleaning sponge',
      'Hand sanitizer',
      'Cardboard box small',
      'Cardboard box large',
      'Packing tape',
      'Paper carry bag',
      'Bubble wrap roll',
      'Shipping label',
      'Hand soap',
      'Cotton pads',
      'Shampoo',
      'Toothbrush',
      'Facial tissue',
      'Body lotion',
      'Notebook',
      'Ballpoint pen',
      'Printer paper',
      'Desk organizer',
      'Sticky notes',
      'File folder',
      'Oat flakes',
      'Tomato sauce',
      'Herbal infusion',
      'Reusable bottle',
    ];
    const productIds: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const fractional = i < 6;
      const category =
        i < 5 || i === 11 || i === 36 || i === 37
          ? 0
          : i < 12 || i === 38
            ? 1
            : i < 18
              ? 2
              : i < 24 || i === 39
                ? 3
                : i < 30
                  ? 4
                  : 5;
      const product = (
        await write('/products', {
          sku: `NOVA-${String(i + 1).padStart(3, '0')}`,
          name: names[i],
          categoryId: categoryIds[category],
          unitOfMeasure: i === 4 ? 'L' : fractional ? 'KG' : 'UNIT',
          quantityScale: fractional ? 3 : 0,
          description:
            'Fictional demo merchandise. Quantities do not represent real inventory.',
        })
      ).product;
      productIds.push(product.id);
      await write(
        '/inventory/thresholds',
        {
          productId: product.id,
          warehouseId: warehouseIds[0],
          minimumQuantity: '10',
        },
        'put',
      );
      // Keep the last six products out of stock; six others have low stock.
      if (i < 34)
        await write('/inventory/receipts', {
          productId: product.id,
          warehouseId: warehouseIds[0],
          quantity: i >= 28 ? '4' : String(70 + i * 3),
          reason: 'Fictional opening delivery',
          referenceType: 'DEMO',
          referenceId: `NOVA-OPEN-${i + 1}`,
        });
    }
    for (let i = 0; i < 24; i++) {
      await write('/inventory/issues', {
        productId: productIds[i],
        warehouseId: warehouseIds[0],
        quantity: String(3 + (i % 4)),
        reason: 'Fictional customer dispatch',
      });
    }
    for (let i = 0; i < 8; i++)
      await write('/inventory/adjustments', {
        productId: productIds[i],
        warehouseId: warehouseIds[0],
        quantity: '1',
        direction: i % 2 ? 'OUT' : 'IN',
        reason: 'Fictional cycle count reconciliation',
      });
    for (let i = 0; i < 6; i++)
      await write('/inventory/transfers', {
        productId: productIds[i],
        sourceWarehouseId: warehouseIds[0],
        destinationWarehouseId: warehouseIds[1 + (i % 2)],
        quantity: '8',
        reason: 'Fictional branch replenishment',
      });
    for (let i = 0; i < 10; i++) {
      const order = (
        await write('/purchase-orders', {
          supplierId: supplierIds[i % 6],
          notes: `NOVA-DEMO-PO-${String(i + 1).padStart(2, '0')} · fictional replenishment`,
          lines: [
            { productId: productIds[i % 12], orderedQuantity: '20' },
            { productId: productIds[(i + 12) % 24], orderedQuantity: '12' },
          ],
        })
      ).purchaseOrder;
      if (i < 2) continue;
      await write(`/purchase-orders/${order.id}/send`, {});
      if (i < 4) continue;
      if (i === 9) {
        await write(`/purchase-orders/${order.id}/cancel`, {
          reason: 'Fictional supplier substitution',
        });
        continue;
      }
      await write(`/purchase-orders/${order.id}/receipts`, {
        warehouseId: warehouseIds[i % 3],
        lines: order.lines.map(
          (line: { id: string; orderedQuantity: string }) => ({
            purchaseOrderLineId: line.id,
            quantity: i < 6 ? '4' : line.orderedQuantity,
          }),
        ),
      });
    }
    const csv = `sku,name,description,unitOfMeasure,quantityScale,categoryId\nNOVA-001,Long grain rice,Fictional CSV catalog refresh,KG,3,${categoryIds[0]}\n`;
    const preview = await write('/imports/products/preview', { csv });
    await write('/imports/products/confirm', {
      csv,
      token: preview.preview.token,
    });
    await db.session.deleteMany({ where: { organizationId } });
    return { ...(await verifyDemo(db, organizationId)), reused: false };
  } finally {
    await db.$disconnect();
  }
}
