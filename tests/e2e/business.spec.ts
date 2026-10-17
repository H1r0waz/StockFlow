import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env.TEST_DATABASE_URL, 'Requires dedicated real PostgreSQL');
const password = 'Stockflow-business-browser-42!';
async function section(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function noDocumentOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test('business journey uses real UI writes, reconciles stock and survives logout across responsive views', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const email = `${randomUUID()}@example.test`;
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to main content' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await noDocumentOverflow(page);
  await page
    .getByRole('button', { name: 'Create a workspace', exact: true })
    .click();
  await page.getByLabel('Full name', { exact: true }).fill('Business Operator');
  await page
    .getByLabel('Organization name', { exact: true })
    .fill('Fictional Business Journey');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Fictional Business Journey',
      exact: true,
    }),
  ).toBeVisible();
  await noDocumentOverflow(page);
  await section(page, 'Categories');
  await page.getByRole('button', { name: 'New category', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Baking');
  await page
    .getByRole('button', { name: 'Create category', exact: true })
    .click();
  await expect(
    page.getByRole('cell', { name: 'Baking', exact: true }),
  ).toBeVisible();
  await section(page, 'Products');
  await page.getByRole('button', { name: 'New product', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Business Flour');
  await page.getByLabel('SKU', { exact: true }).fill('BUSINESS-FLOUR');
  await page
    .getByLabel('Category', { exact: true })
    .selectOption({ label: 'Baking' });
  await page.getByLabel('Unit of measure', { exact: true }).selectOption('KG');
  await page
    .getByLabel('Quantity precision', { exact: true })
    .selectOption('3');
  await noDocumentOverflow(page);
  await page
    .getByRole('button', { name: 'Create product', exact: true })
    .click();
  await expect(
    page.getByRole('cell', { name: 'BUSINESS-FLOUR', exact: true }),
  ).toBeVisible();
  await section(page, 'Warehouses');
  for (const name of ['Central', 'Branch']) {
    await page
      .getByRole('button', { name: 'New warehouse', exact: true })
      .click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Code', { exact: true }).fill(name.toUpperCase());
    await page
      .getByRole('button', { name: 'Create warehouse', exact: true })
      .click();
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  }
  // API reads identify persisted rows; every business write above and below uses the UI.
  const session = await (await page.request.get('/api/auth/session')).json();
  const base = `/api/organizations/${session.organization.id}`;
  const {
    products: [product],
  } = await (await page.request.get(`${base}/products`)).json();
  const { warehouses } = await (
    await page.request.get(`${base}/warehouses`)
  ).json();
  const central = warehouses.find(
    (w: { code: string }) => w.code === 'CENTRAL',
  );
  const branch = warehouses.find((w: { code: string }) => w.code === 'BRANCH');
  await section(page, 'Inventory');
  await page.getByLabel('Product', { exact: true }).selectOption(product.id);
  await page.getByLabel('Warehouse', { exact: true }).selectOption(central.id);
  await page.getByLabel('Quantity', { exact: true }).fill('10');
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
    .selectOption(branch.id);
  await page.getByLabel('Transfer quantity', { exact: true }).fill('3');
  await page
    .getByRole('button', { name: 'Transfer stock', exact: true })
    .click();
  await expect(
    page.getByText('Transfer recorded.', { exact: true }),
  ).toBeVisible();
  await noDocumentOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('inventory-320.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 768, height: 1024 });
  await section(page, 'Purchasing');
  await page.getByRole('button', { name: 'New supplier', exact: true }).click();
  await page
    .getByLabel('Supplier name', { exact: true })
    .fill('Fictional Mill');
  await page
    .getByRole('button', { name: 'Save supplier', exact: true })
    .click();
  await expect(
    page.getByText('Supplier saved.', { exact: true }),
  ).toBeVisible();
  const {
    suppliers: [supplier],
  } = await (await page.request.get(`${base}/suppliers`)).json();
  await page
    .getByRole('button', { name: 'New purchase order', exact: true })
    .click();
  await page
    .getByLabel('Order supplier', { exact: true })
    .selectOption(supplier.id);
  await page
    .getByLabel('Line 1 product', { exact: true })
    .selectOption(product.id);
  await page.getByLabel('Line 1 quantity', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send order', exact: true }).click();
  await expect(page.getByText('Order sent.', { exact: true })).toBeVisible();
  const detail = page.getByRole('region', {
    name: 'Purchase order detail',
    exact: true,
  });
  for (const [quantity, status] of [
    ['2', 'PARTIALLY_RECEIVED'],
    ['3', 'RECEIVED'],
  ]) {
    await page
      .getByLabel('Receipt warehouse', { exact: true })
      .selectOption(central.id);
    await page
      .getByLabel('Receive line 1 quantity', { exact: true })
      .fill(quantity!);
    await page
      .getByRole('button', { name: 'Record receipt', exact: true })
      .click();
    await expect(
      page.getByText('Receipt recorded.', { exact: true }),
    ).toBeVisible();
    await expect(detail).toContainText(status!);
  }
  await noDocumentOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('purchasing-768.png'),
    fullPage: true,
  });
  await section(page, 'Inventory');
  const stocks = page.getByRole('table', { name: 'Current stock' });
  await expect(
    stocks.getByRole('row').filter({ hasText: 'Central' }),
  ).toContainText('12.000000');
  await expect(
    stocks.getByRole('row').filter({ hasText: 'Branch' }),
  ).toContainText('3.000000');
  await page.setViewportSize({ width: 320, height: 800 });
  await section(page, 'Alerts');
  await page
    .getByLabel('Minimum stock product', { exact: true })
    .selectOption(product.id);
  await page
    .getByLabel('Minimum stock warehouse', { exact: true })
    .selectOption(branch.id);
  await page.getByLabel('Minimum quantity', { exact: true }).fill('4');
  await page
    .getByRole('button', { name: 'Save minimum stock', exact: true })
    .click();
  await expect(
    page.getByText('Minimum stock saved.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Stock alerts' })).toContainText(
    'LOW',
  );
  await noDocumentOverflow(page);
  await section(page, 'Imports');
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({
    name: 'business-products.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'sku,name,unitOfMeasure,quantityScale\nBUSINESS-SALT,Business Salt,KG,3',
    ),
  });
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Import preview', exact: true }),
  ).toBeVisible();
  await noDocumentOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('imports-320.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Confirm import', exact: true })
    .click();
  await expect(
    page.getByText('Import confirmed', { exact: true }),
  ).toBeVisible();
  await section(page, 'Audit');
  await page
    .getByLabel('Audit action', { exact: true })
    .fill('PURCHASE_RECEIPT');
  await expect(
    page.getByRole('table', { name: 'Audit events' }).getByRole('row'),
  ).toHaveCount(3);
  await section(page, 'Reports');
  await page
    .getByLabel('Report type', { exact: true })
    .selectOption('inventory');
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export CSV page', exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('stockflow-inventory.csv');
  expect(await download.failure()).toBeNull();
  const exported = await readFile((await download.path())!, 'utf8');
  expect(exported).toContain('BUSINESS-FLOUR');
  expect(exported).toContain('12.000000');
  expect(exported).toContain('3.000000');
  await page.setViewportSize({ width: 1440, height: 900 });
  await section(page, 'Dashboard');
  await expect(
    page.getByRole('heading', { name: 'Operational dashboard', exact: true }),
  ).toBeVisible();
  for (const [label, value] of [
    ['Active products', '2'],
    ['Active warehouses', '2'],
    ['Low stock products', '1'],
    ['Received orders · last 30 days', '1'],
  ]) {
    await expect(
      page
        .getByRole('article')
        .filter({
          has: page.getByRole('heading', { name: label!, exact: true }),
        })
        .locator('strong'),
    ).toHaveText(value!);
  }
  await noDocumentOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('dashboard-1440.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Fictional Business Journey',
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await section(page, 'Inventory');
  await expect(
    stocks.getByRole('row').filter({ hasText: 'Central' }),
  ).toContainText('12.000000');
  await expect(
    stocks.getByRole('row').filter({ hasText: 'Branch' }),
  ).toContainText('3.000000');
});
