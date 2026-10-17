import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env.TEST_DATABASE_URL, 'Requires dedicated real PostgreSQL');
const origin = 'http://127.0.0.1:5173';
const password = 'Strong-transfer-browser-42!';
async function register(page: Page, name: string) {
  const email = `${randomUUID()}@example.test`;
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Create a workspace', exact: true })
    .click();
  await page.getByLabel('Full name', { exact: true }).fill('Transfer Operator');
  await page.getByLabel('Organization name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return email;
}
async function inventory(page: Page) {
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Inventory', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Inventory', exact: true }),
  ).toBeVisible();
}
test('real transfer persists paired ledger and balances; rejects insufficient and identical warehouses', async ({
  page,
}) => {
  const email = await register(page, 'Transfer Browser');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Transfer Browser', exact: true }),
  ).toBeVisible();
  const s = await (await page.request.get('/api/auth/session')).json();
  const base = `/api/organizations/${s.organization.id}`;
  const headers = { Origin: origin, 'X-CSRF-Token': s.csrfToken };
  const p = await page.request.post(`${base}/products`, {
    headers,
    data: {
      name: 'Coffee',
      sku: 'COFFEE',
      unitOfMeasure: 'KG',
      quantityScale: 3,
    },
  });
  expect(p.status()).toBe(201);
  const product = (await p.json()).product;
  const ids: string[] = [];
  for (const name of ['Origin', 'Destination']) {
    const w = await page.request.post(`${base}/warehouses`, {
      headers,
      data: { name, code: name.toUpperCase() },
    });
    expect(w.status()).toBe(201);
    ids.push((await w.json()).warehouse.id);
  }
  const source = ids[0]!,
    destination = ids[1]!;
  const seed = await page.request.post(`${base}/inventory/receipts`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { productId: product.id, warehouseId: source, quantity: '5.250' },
  });
  expect(seed.status()).toBe(201);
  await inventory(page);
  await page
    .getByLabel('Transfer product', { exact: true })
    .selectOption(product.id);
  await page
    .getByLabel('Source warehouse', { exact: true })
    .selectOption(source);
  await page
    .getByLabel('Destination warehouse', { exact: true })
    .selectOption(destination);
  await expect(
    page.getByText('Available in source: 5.250000', { exact: false }),
  ).toBeVisible();
  await page.getByLabel('Transfer quantity', { exact: true }).fill('2.125');
  await page
    .getByRole('button', { name: 'Transfer stock', exact: true })
    .click();
  await expect(
    page.getByText('Transfer recorded.', { exact: true }),
  ).toBeVisible();
  const stocks = page.getByRole('table', { name: 'Current stock' });
  await expect(
    stocks.getByRole('row').filter({ hasText: 'Origin' }),
  ).toContainText('3.125000');
  await expect(
    stocks.getByRole('row').filter({ hasText: 'Destination' }),
  ).toContainText('2.125000');
  const history = page.getByRole('table', { name: 'Movement history' });
  await expect(history.getByRole('row')).toHaveCount(4);
  const movements = await (
    await page.request.get(`${base}/inventory/movements`)
  ).json();
  const paired = movements.movements.filter((m: { type: string }) =>
    m.type.startsWith('TRANSFER_'),
  );
  expect(paired).toHaveLength(2);
  expect(paired[0].transferId).toBeTruthy();
  expect(paired[0].transferId).toBe(paired[1].transferId);
  expect(paired[0].correlationKey).toBe(paired[0].transferId);
  await expect(
    history.getByText(paired[0].transferId, { exact: true }),
  ).toHaveCount(2);
  await page.getByLabel('Transfer quantity', { exact: true }).fill('4');
  await page
    .getByRole('button', { name: 'Transfer stock', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('conflicts');
  await expect(
    stocks.getByRole('row').filter({ hasText: 'Origin' }),
  ).toContainText('3.125000');
  await page
    .getByLabel('Destination warehouse', { exact: true })
    .selectOption(source);
  await page
    .getByRole('button', { name: 'Transfer stock', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(/different|same/i);
  await page.reload();
  await inventory(page);
  await expect(
    stocks.getByRole('row').filter({ hasText: 'Origin' }),
  ).toContainText('3.125000');
  await expect(
    stocks.getByRole('row').filter({ hasText: 'Destination' }),
  ).toContainText('2.125000');
  await expect(history.getByRole('row')).toHaveCount(4);
  await expect(
    history.getByText(paired[0].transferId, { exact: true }),
  ).toHaveCount(2);
});

test('MEMBER sees transfer history but cannot transfer through UI or HTTP', async ({
  page,
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await register(page, 'Transfer Team');
    const member = await context.newPage();
    const email = await register(member, 'Transfer Personal');
    const s = await (await page.request.get('/api/auth/session')).json();
    const base = `/api/organizations/${s.organization.id}`;
    const headers = { Origin: origin, 'X-CSRF-Token': s.csrfToken };
    expect(
      (
        await page.request.post(`${base}/memberships`, {
          headers,
          data: { email, role: 'MEMBER' },
        })
      ).status(),
    ).toBe(201);
    const login = await member.request.post(`${origin}/api/auth/login`, {
      headers: { Origin: origin },
      data: { email, password, organizationId: s.organization.id },
    });
    expect(login.status()).toBe(200);
    const memberSession = await login.json();
    await member.reload();
    await inventory(member);
    await expect(
      member.getByRole('button', { name: 'Transfer stock', exact: true }),
    ).toHaveCount(0);
    const r = await member.request.post(
      `${origin}${base}/inventory/transfers`,
      {
        headers: {
          Origin: origin,
          'X-CSRF-Token': memberSession.csrfToken,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          productId: randomUUID(),
          sourceWarehouseId: randomUUID(),
          destinationWarehouseId: randomUUID(),
          quantity: '1',
        },
      },
    );
    expect(r.status()).toBe(403);
    await expect(
      member.getByRole('table', { name: 'Movement history' }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
