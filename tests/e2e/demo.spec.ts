import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import {
  seedDemo,
  demoPassword,
  demoOrganization,
} from '../../apps/api/src/demo/seed.js';

test.skip(!process.env.TEST_DATABASE_URL, 'Requires dedicated real PostgreSQL');
const namespace = `portfolio-${randomUUID()}`;
let organizationId: string;
async function section(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function login(page: Page, role: string) {
  await page.goto('/');
  await page
    .getByLabel('Email', { exact: true })
    .fill(`${role}+${namespace}@nova.example.test`);
  await page.getByLabel('Password', { exact: true }).fill(demoPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: demoOrganization, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Operational dashboard', exact: true }),
  ).toBeVisible();
}
test.beforeAll(async () => {
  test.setTimeout(120000);
  const demo = await seedDemo(process.env.TEST_DATABASE_URL!, {
    testing: true,
    namespace,
  });
  organizationId = demo.organizationId;
});
test('portfolio demo moves from critical inventory through purchasing audit and reports', async ({
  page,
}) => {
  test.setTimeout(120000);
  await login(page, 'owner');
  await expect(
    page.getByText('A working day at Distribuidora Nova', { exact: true }),
  ).toBeVisible();
  const base = `/api/organizations/${organizationId}`;
  const { products } = await (
    await page.request.get(base + '/products')
  ).json();
  const { warehouses } = await (
    await page.request.get(base + '/warehouses')
  ).json();
  const product = products.find((p: { sku: string }) => p.sku === 'NOVA-001'),
    central = warehouses.find((w: { code: string }) => w.code === 'CENTRAL'),
    north = warehouses.find((w: { code: string }) => w.code === 'NORTH');
  await section(page, 'Alerts');
  await page.getByLabel('Alert status', { exact: true }).selectOption('LOW');
  await expect(page.getByRole('table', { name: 'Stock alerts' })).toContainText(
    'LOW',
  );
  await section(page, 'Products');
  await expect(page.getByRole('table')).toContainText('Long grain rice');
  await section(page, 'Inventory');
  await page.getByLabel('Product', { exact: true }).selectOption(product.id);
  await page.getByLabel('Warehouse', { exact: true }).selectOption(central.id);
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Record movement', exact: true })
    .click();
  await expect(
    page.getByText('Movement recorded.', { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Transfer product', { exact: true })
    .selectOption(product.id);
  await page
    .getByLabel('Source warehouse', { exact: true })
    .selectOption(central.id);
  await page
    .getByLabel('Destination warehouse', { exact: true })
    .selectOption(north.id);
  await page.getByLabel('Transfer quantity', { exact: true }).fill('1');
  await page
    .getByRole('button', { name: 'Transfer stock', exact: true })
    .click();
  await expect(
    page.getByText('Transfer recorded.', { exact: true }),
  ).toBeVisible();
  await section(page, 'Purchasing');
  await expect(page.getByRole('table', { name: 'Suppliers' })).toContainText(
    'Nova Pantry Partners',
  );
  const { purchaseOrders } = await (
    await page.request.get(base + '/purchase-orders')
  ).json();
  const order = purchaseOrders.find(
    (o: { status: string }) => o.status === 'SENT',
  );
  await page
    .getByRole('button', { name: `View order ${order.id}`, exact: true })
    .click();
  await page
    .getByLabel('Receipt warehouse', { exact: true })
    .selectOption(central.id);
  await page.getByLabel('Receive line 1 quantity', { exact: true }).fill('1');
  await page
    .getByRole('button', { name: 'Record receipt', exact: true })
    .click();
  await expect(
    page.getByText('Receipt recorded.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Purchase order detail' }),
  ).toContainText('PARTIALLY_RECEIVED');
  await section(page, 'Audit');
  await page
    .getByLabel('Audit action', { exact: true })
    .fill('PURCHASE_RECEIPT');
  await expect(page.getByRole('table', { name: 'Audit events' })).toContainText(
    'PURCHASE_RECEIPT',
  );
  await section(page, 'Imports');
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({
    name: 'nova-preview.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'sku,name,unitOfMeasure\nNOVA-DEMO-EXTRA,Demo display sample,UNIT',
    ),
  });
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Import preview', exact: true }),
  ).toBeVisible();
  // Preview remains read-only: portfolio exploration need not alter the catalog.
  expect(
    (await (await page.request.get(base + '/products')).json()).products,
  ).toHaveLength(40);
  await section(page, 'Reports');
  await page
    .getByLabel('Report type', { exact: true })
    .selectOption('inventory');
  await expect(
    page.getByRole('table', { name: 'Operational report' }),
  ).toContainText('NOVA-001');
  const next = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export CSV page', exact: true })
    .click();
  const download = await next;
  expect(download.suggestedFilename()).toBe('stockflow-inventory.csv');
  expect(await download.failure()).toBeNull();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Operational dashboard', exact: true }),
  ).toBeVisible();
});
test('demo MEMBER uses the same authentication and read-only role boundaries', async ({
  page,
}) => {
  await login(page, 'member');
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace sections' })
      .getByRole('button', { name: 'Imports', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace sections' })
      .getByRole('button', { name: 'Audit', exact: true }),
  ).toHaveCount(0);
  await section(page, 'Inventory');
  await expect(
    page.getByRole('button', { name: 'Record movement', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('table', { name: 'Current stock' }),
  ).toContainText('NOVA-001');
  expect(
    (
      await page.request.get(`/api/organizations/${organizationId}/audit`)
    ).status(),
  ).toBe(403);
});
