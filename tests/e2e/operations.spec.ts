import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env.TEST_DATABASE_URL, 'Requires dedicated real PostgreSQL');
const origin = 'http://127.0.0.1:5173';
const password = 'Strong-operations-browser-42!';

async function register(page: Page, name: string) {
  const email = `${randomUUID()}@example.test`;
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Create a workspace', exact: true })
    .click();
  await page
    .getByLabel('Full name', { exact: true })
    .fill('Operations Operator');
  await page.getByLabel('Organization name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return email;
}
async function section(
  page: Page,
  name: 'Dashboard' | 'Alerts' | 'Audit' | 'Inventory',
) {
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name, exact: true })
    .click();
  const heading = {
    Dashboard: 'Operational dashboard',
    Alerts: 'Stock alerts',
    Audit: 'Business audit',
    Inventory: 'Inventory',
  }[name];
  await expect(
    page.getByRole('heading', { name: heading, exact: true }),
  ).toBeVisible();
}
async function metric(page: Page, name: string, value: string) {
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card.locator('strong')).toHaveText(value);
}
async function prepare(page: Page) {
  const s = await (await page.request.get('/api/auth/session')).json();
  const base = `/api/organizations/${s.organization.id}`;
  const headers = { Origin: origin, 'X-CSRF-Token': s.csrfToken };
  const p = await page.request.post(`${base}/products`, {
    headers,
    data: {
      name: 'Operations Coffee',
      sku: 'OPERATIONS-COFFEE',
      unitOfMeasure: 'KG',
      quantityScale: 3,
    },
  });
  expect(p.status()).toBe(201);
  const w = await page.request.post(`${base}/warehouses`, {
    headers,
    data: { name: 'Operations Central', code: 'OPERATIONS-CENTRAL' },
  });
  expect(w.status()).toBe(201);
  return {
    s,
    base,
    headers,
    product: (await p.json()).product,
    warehouse: (await w.json()).warehouse,
  };
}

test('owner sees updated dashboard, exact critical stock and correlated immutable business audit after login', async ({
  page,
}) => {
  const email = await register(page, 'Operations Browser');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Operations Browser', exact: true }),
  ).toBeVisible();
  const { s, base, product, warehouse } = await prepare(page);
  await section(page, 'Dashboard');
  await metric(page, 'Active products', '1');
  await metric(page, 'Active warehouses', '1');
  await metric(page, 'Out of stock products', '1');
  await page
    .getByRole('button', { name: 'Review critical inventory', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Stock alerts', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Minimum stock product', { exact: true })
    .selectOption(product.id);
  await page
    .getByLabel('Minimum stock warehouse', { exact: true })
    .selectOption(warehouse.id);
  await page.getByLabel('Minimum quantity', { exact: true }).fill('3');
  await page
    .getByRole('button', { name: 'Save minimum stock', exact: true })
    .click();
  await expect(
    page.getByText('Minimum stock saved.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Stock alerts', exact: true }),
  ).toContainText('OUT_OF_STOCK');
  await section(page, 'Inventory');
  await page.getByLabel('Product', { exact: true }).selectOption(product.id);
  await page
    .getByLabel('Warehouse', { exact: true })
    .selectOption(warehouse.id);
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Record movement', exact: true })
    .click();
  await expect(
    page.getByText('Movement recorded.', { exact: true }),
  ).toBeVisible();
  await section(page, 'Dashboard');
  await metric(page, 'Low stock products', '1');
  await metric(page, 'Out of stock products', '0');
  await expect(
    page.getByRole('region', { name: 'Operational dashboard', exact: true }),
  ).toContainText('Receipt');
  await expect(
    page.getByRole('region', { name: 'Operational dashboard', exact: true }),
  ).toContainText('Operations Coffee');
  await expect(
    page.getByRole('region', { name: 'Operational dashboard', exact: true }),
  ).toContainText('2.000000');
  const movement = (
    await (await page.request.get(`${base}/inventory/movements`)).json()
  ).movements[0];
  await section(page, 'Audit');
  await page.getByLabel('Audit action', { exact: true }).fill('RECEIPT');
  await page
    .getByLabel('Audit entityType', { exact: true })
    .fill('InventoryMovement');
  await page.getByLabel('Audit entityId', { exact: true }).fill(movement.id);
  await page.getByLabel('Audit actorId', { exact: true }).fill(s.user.id);
  const audit = page.getByRole('table', { name: 'Audit events', exact: true });
  await expect(audit.getByRole('row')).toHaveCount(2);
  await expect(audit).toContainText('Operations Operator');
  await expect(audit).toContainText(movement.id);
  await expect(audit).toContainText(movement.correlationKey);
  await section(page, 'Alerts');
  await page.getByLabel('Alert status', { exact: true }).selectOption('LOW');
  const alerts = page.getByRole('table', { name: 'Stock alerts', exact: true });
  await expect(alerts.getByRole('row')).toHaveCount(2);
  await expect(alerts).toContainText('2.000000 KG');
  await expect(alerts).toContainText('3.000000');
  await page.reload();
  await section(page, 'Dashboard');
  await metric(page, 'Low stock products', '1');
  await section(page, 'Alerts');
  await expect(alerts).toContainText('LOW');
  await section(page, 'Audit');
  await page.getByLabel('Audit action', { exact: true }).fill('RECEIPT');
  await expect(audit).toContainText(movement.correlationKey);
});

test('MEMBER reads tenant dashboard and alerts while audit and threshold writes are denied', async ({
  page,
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await register(page, 'Operations Team');
    const data = await prepare(page);
    expect(
      (
        await page.request.put(`${data.base}/inventory/thresholds`, {
          headers: data.headers,
          data: {
            productId: data.product.id,
            warehouseId: data.warehouse.id,
            minimumQuantity: '3',
          },
        })
      ).status(),
    ).toBe(200);
    const member = await context.newPage();
    const email = await register(member, 'Operations Personal');
    expect(
      (
        await page.request.post(`${data.base}/memberships`, {
          headers: data.headers,
          data: { email, role: 'MEMBER' },
        })
      ).status(),
    ).toBe(201);
    const login = await member.request.post(`${origin}/api/auth/login`, {
      headers: { Origin: origin },
      data: { email, password, organizationId: data.s.organization.id },
    });
    expect(login.status()).toBe(200);
    const session = await login.json();
    await member.reload();
    await section(member, 'Dashboard');
    await metric(member, 'Active products', '1');
    await metric(member, 'Out of stock products', '1');
    await section(member, 'Alerts');
    await expect(
      member.getByRole('table', { name: 'Stock alerts', exact: true }),
    ).toContainText('OUT_OF_STOCK');
    await expect(
      member.getByRole('form', {
        name: 'Configure minimum stock',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      member
        .getByRole('navigation', { name: 'Workspace sections' })
        .getByRole('button', { name: 'Audit', exact: true }),
    ).toHaveCount(0);
    expect(
      (await member.request.get(`${origin}${data.base}/audit`)).status(),
    ).toBe(403);
    expect(
      (
        await member.request.put(`${origin}${data.base}/inventory/thresholds`, {
          headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken },
          data: {
            productId: data.product.id,
            warehouseId: data.warehouse.id,
            minimumQuantity: '4',
          },
        })
      ).status(),
    ).toBe(403);
    expect(
      (await member.request.get(`${origin}${data.base}/dashboard`)).status(),
    ).toBe(200);
    await member.reload();
    await section(member, 'Alerts');
    await expect(
      member.getByRole('table', { name: 'Stock alerts', exact: true }),
    ).toContainText('Operations Coffee');
  } finally {
    await context.close();
  }
});
