import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
test.skip(!process.env.TEST_DATABASE_URL, 'Requires dedicated real PostgreSQL');
const origin = 'http://127.0.0.1:5173';
const password = 'Strong-purchasing-browser-42!';
async function register(page: Page, name: string) {
  const email = `${randomUUID()}@example.test`;
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Create a workspace', exact: true })
    .click();
  await page
    .getByLabel('Full name', { exact: true })
    .fill('Purchasing Operator');
  await page.getByLabel('Organization name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return email;
}
async function section(page: Page) {
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Purchasing', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Purchasing', exact: true }),
  ).toBeVisible();
}

test('real supplier lifecycle and draft edits, send, freeze, reload and cancel never create stock', async ({
  page,
}) => {
  const email = await register(page, 'Purchasing Browser');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Purchasing Browser', exact: true }),
  ).toBeVisible();
  const s = await (await page.request.get('/api/auth/session')).json();
  const base = `/api/organizations/${s.organization.id}`;
  const headers = { Origin: origin, 'X-CSRF-Token': s.csrfToken };
  const p = await page.request.post(`${base}/products`, {
    headers,
    data: {
      name: 'Ordered Coffee',
      sku: 'ORDER-COFFEE',
      unitOfMeasure: 'KG',
      quantityScale: 3,
    },
  });
  expect(p.status()).toBe(201);
  const product = (await p.json()).product;
  await section(page);
  await page.getByRole('button', { name: 'New supplier', exact: true }).click();
  await page
    .getByLabel('Supplier name', { exact: true })
    .fill('Coffee Supplier');
  await page
    .getByLabel('Legal name', { exact: true })
    .fill('Coffee Supplier Demo');
  await page.getByLabel('Tax ID', { exact: true }).fill('DEMO-TAX-42');
  await page
    .getByLabel('Supplier email', { exact: true })
    .fill('supplier@example.test');
  await page.getByLabel('Phone', { exact: true }).fill('+1 555 0100');
  await page
    .getByLabel('Supplier notes', { exact: true })
    .fill('Fictional browser supplier');
  await page
    .getByRole('button', { name: 'Save supplier', exact: true })
    .click();
  await expect(
    page.getByText('Supplier saved.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Edit supplier Coffee Supplier', exact: true })
    .click();
  await page
    .getByLabel('Supplier notes', { exact: true })
    .fill('Edited fictional supplier');
  await page
    .getByRole('button', { name: 'Save supplier', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: 'Deactivate supplier Coffee Supplier',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Activate supplier Coffee Supplier',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Activate supplier Coffee Supplier',
      exact: true,
    })
    .click();
  const suppliers = await (await page.request.get(`${base}/suppliers`)).json();
  const supplier = suppliers.suppliers[0];
  expect(supplier.notes).toBe('Edited fictional supplier');
  await page
    .getByRole('button', { name: 'New purchase order', exact: true })
    .click();
  await page
    .getByLabel('Order supplier', { exact: true })
    .selectOption(supplier.id);
  await page
    .getByLabel('Line 1 product', { exact: true })
    .selectOption(product.id);
  await page.getByLabel('Line 1 quantity', { exact: true }).fill('2.125');
  await page
    .getByRole('button', { name: 'Add order line', exact: true })
    .click();
  await expect(
    page.getByLabel('Line 2 product', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Remove line 2', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  const detail = page.getByRole('region', {
    name: 'Purchase order detail',
    exact: true,
  });
  await expect(detail).toContainText('DRAFT');
  await expect(detail).toContainText('2.125000');
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  await page.getByLabel('Line 1 quantity', { exact: true }).fill('3.250');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(detail).toContainText('3.250000');
  await page.getByRole('button', { name: 'Send order', exact: true }).click();
  await expect(page.getByText('Order sent.', { exact: true })).toBeVisible();
  await expect(detail).toContainText('SENT');
  await expect(
    page.getByRole('button', { name: 'Edit draft', exact: true }),
  ).toHaveCount(0);
  const orders = await (
    await page.request.get(`${base}/purchase-orders`)
  ).json();
  const order = orders.purchaseOrders[0];
  const rejected = await page.request.patch(
    `${base}/purchase-orders/${order.id}`,
    {
      headers,
      data: {
        supplierId: supplier.id,
        lines: [{ productId: product.id, orderedQuantity: '99' }],
      },
    },
  );
  expect(rejected.status()).toBe(409);
  await page.reload();
  await section(page);
  await page
    .getByRole('button', { name: `View order ${order.id}`, exact: true })
    .click();
  await expect(detail).toContainText('SENT');
  await expect(detail).toContainText('3.250000');
  await expect(detail).toContainText('Purchasing Operator');
  await page
    .getByLabel('Cancellation reason', { exact: true })
    .fill('Demo purchase no longer needed');
  await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await expect(
    page.getByText('Order cancelled.', { exact: true }),
  ).toBeVisible();
  await expect(detail).toContainText('CANCELLED');
  await page.reload();
  await section(page);
  await page
    .getByRole('button', { name: `View order ${order.id}`, exact: true })
    .click();
  await expect(detail).toContainText('CANCELLED');
  await expect(detail).toContainText('3.250000');
  expect(
    (await (await page.request.get(`${base}/inventory/balances`)).json())
      .balances,
  ).toEqual([]);
  expect(
    (await (await page.request.get(`${base}/inventory/movements`)).json())
      .movements,
  ).toEqual([]);
});

test('MEMBER reads purchasing but UI and HTTP refuse mutations', async ({
  page,
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await register(page, 'Purchasing Team');
    const member = await context.newPage();
    const email = await register(member, 'Purchasing Personal');
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
    const supplier = await page.request.post(`${base}/suppliers`, {
      headers,
      data: { name: 'Visible Supplier' },
    });
    expect(supplier.status()).toBe(201);
    const login = await member.request.post(`${origin}/api/auth/login`, {
      headers: { Origin: origin },
      data: { email, password, organizationId: s.organization.id },
    });
    expect(login.status()).toBe(200);
    const session = await login.json();
    await member.reload();
    await section(member);
    await expect(
      member.getByText('Visible Supplier', { exact: true }),
    ).toBeVisible();
    await expect(
      member.getByRole('button', { name: 'New supplier', exact: true }),
    ).toHaveCount(0);
    await expect(
      member.getByRole('button', { name: 'New purchase order', exact: true }),
    ).toHaveCount(0);
    const response = await member.request.post(
      `${origin}${base}/purchase-orders`,
      {
        headers: {
          Origin: origin,
          'X-CSRF-Token': session.csrfToken,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          supplierId: (await supplier.json()).supplier.id,
          lines: [{ productId: randomUUID(), orderedQuantity: '1' }],
        },
      },
    );
    expect(response.status()).toBe(403);
  } finally {
    await context.close();
  }
});
