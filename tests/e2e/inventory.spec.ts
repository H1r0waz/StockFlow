import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
test.skip(
  !process.env.TEST_DATABASE_URL,
  'Requires dedicated real PostgreSQL test database',
);
test('real login receipt issue adjustment history and persistence', async ({
  page,
}) => {
  const email = `${randomUUID()}@example.test`,
    password = 'Strong-inventory-browser-42!';
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Create a workspace', exact: true })
    .click();
  await page
    .getByLabel('Full name', { exact: true })
    .fill('Inventory Operator');
  await page
    .getByLabel('Organization name', { exact: true })
    .fill('Inventory Browser');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Inventory Browser', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome back', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Inventory Browser', exact: true }),
  ).toBeVisible();
  const session = await (await page.request.get('/api/auth/session')).json();
  const base = `/api/organizations/${session.organization.id}`;
  const options = {
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'X-CSRF-Token': session.csrfToken,
    },
  };
  const p = await page.request.post(`${base}/products`, {
    ...options,
    data: { name: 'Rice', sku: 'RICE', unitOfMeasure: 'KG', quantityScale: 3 },
  });
  expect(p.status()).toBe(201);
  const product = (await p.json()).product;
  const w = await page.request.post(`${base}/warehouses`, {
    ...options,
    data: { name: 'Central', code: 'CENTRAL' },
  });
  expect(w.status()).toBe(201);
  const warehouse = (await w.json()).warehouse;
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Inventory', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Inventory', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Product', { exact: true }).selectOption(product.id);
  await page
    .getByLabel('Warehouse', { exact: true })
    .selectOption(warehouse.id);
  await page.getByLabel('Quantity', { exact: true }).fill('5.250');
  await page
    .getByRole('button', { name: 'Record movement', exact: true })
    .click();
  await expect(
    page.getByText('Movement recorded.', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('table', { name: 'Current stock' })
      .getByRole('cell', { name: '5.250000', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Movement type', { exact: true }).selectOption('ISSUE');
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Record movement', exact: true })
    .click();
  await expect(
    page
      .getByRole('table', { name: 'Current stock' })
      .getByRole('cell', { name: '3.250000', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Quantity', { exact: true }).fill('4');
  await page
    .getByRole('button', { name: 'Record movement', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('conflicts');
  await expect(
    page
      .getByRole('table', { name: 'Current stock' })
      .getByRole('cell', { name: '3.250000', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Movement type', { exact: true })
    .selectOption('ADJUSTMENT_OUT');
  await page.getByLabel('Quantity', { exact: true }).fill('0.250');
  await page.getByLabel('Reason', { exact: true }).fill('Count correction');
  await page
    .getByRole('button', { name: 'Record movement', exact: true })
    .click();
  await expect(
    page
      .getByRole('table', { name: 'Current stock' })
      .getByRole('cell', { name: '3.000000', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Inventory', exact: true })
    .click();
  await expect(
    page
      .getByRole('table', { name: 'Current stock' })
      .getByRole('cell', { name: '3.000000', exact: true }),
  ).toBeVisible();
  const history = page.getByRole('table', { name: 'Movement history' });
  await expect(history.getByRole('row')).toHaveCount(4);
  await expect(
    history.getByRole('cell', { name: 'Inventory Operator', exact: true }),
  ).toHaveCount(3);
  await page.getByLabel('Product search').fill('does not exist');
  await expect(
    page.getByText('No movements match these filters.'),
  ).toBeVisible();
  await page.getByLabel('Product search').fill('Rice');
  await page.getByLabel('Movement type filter').selectOption('ISSUE');
  await expect(history.getByRole('row')).toHaveCount(2);
});
