import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
test.skip(!process.env.TEST_DATABASE_URL, 'Requires dedicated real PostgreSQL');
const origin = 'http://127.0.0.1:5173';
const password = 'Strong-receiving-browser-42!';
async function register(page: Page, name: string) {
  const email = `${randomUUID()}@example.test`;
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Create a workspace', exact: true })
    .click();
  await page
    .getByLabel('Full name', { exact: true })
    .fill('Receiving Operator');
  await page.getByLabel('Organization name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return email;
}
async function section(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function prepare(page: Page) {
  const s = await (await page.request.get('/api/auth/session')).json();
  const base = `/api/organizations/${s.organization.id}`;
  const headers = { Origin: origin, 'X-CSRF-Token': s.csrfToken };
  const create = async (path: string, data: unknown, keyed = false) => {
    const r = await page.request.post(`${base}/${path}`, {
      headers: {
        ...headers,
        ...(keyed ? { 'Idempotency-Key': randomUUID() } : {}),
      },
      data,
    });
    expect(r.status()).toBe(201);
    return r.json();
  };
  const { supplier } = await create('suppliers', {
    name: 'Fictional Receiving Supplier',
  });
  const { product } = await create('products', {
    name: 'Receiving Coffee',
    sku: 'RECEIVING-COFFEE',
    unitOfMeasure: 'KG',
    quantityScale: 3,
  });
  const { warehouse } = await create('warehouses', {
    name: 'Receiving Central',
    code: 'RECEIVING-CENTRAL',
  });
  const { purchaseOrder } = await create(
    'purchase-orders',
    {
      supplierId: supplier.id,
      lines: [{ productId: product.id, orderedQuantity: '5' }],
    },
    true,
  );
  const sent = await page.request.post(
    `${base}/purchase-orders/${purchaseOrder.id}/send`,
    { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: {} },
  );
  expect(sent.status()).toBe(200);
  return {
    s,
    base,
    headers,
    product,
    warehouse,
    order: (await sent.json()).purchaseOrder,
  };
}
async function openOrder(page: Page, id: string) {
  await section(page, 'Purchasing');
  await page
    .getByRole('button', { name: `View order ${id}`, exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Purchase order detail' }),
  ).toBeVisible();
}

test('partial and final receipt update order stock and correlated ledger atomically and persist on reload', async ({
  page,
}) => {
  const email = await register(page, 'Receiving Browser');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Receiving Browser', exact: true }),
  ).toBeVisible();
  const { base, order, warehouse } = await prepare(page);
  await openOrder(page, order.id);
  const detail = page.getByRole('region', { name: 'Purchase order detail' });
  const orderLines = detail.getByRole('table', { name: 'Order lines' });
  await page
    .getByLabel('Receipt warehouse', { exact: true })
    .selectOption(warehouse.id);
  await page
    .getByLabel('Receive line 1 quantity', { exact: true })
    .fill('1.250');
  await page
    .getByRole('button', { name: 'Record receipt', exact: true })
    .click();
  await expect(
    page.getByText('Receipt recorded.', { exact: true }),
  ).toBeVisible();
  await expect(detail).toContainText('PARTIALLY_RECEIVED');
  await expect(orderLines).toContainText('1.250000');
  await expect(orderLines).toContainText('3.750000');
  await section(page, 'Inventory');
  await expect(
    page.getByRole('table', { name: 'Current stock' }),
  ).toContainText('1.250000');
  await openOrder(page, order.id);
  await page
    .getByLabel('Receipt warehouse', { exact: true })
    .selectOption(warehouse.id);
  await page.getByLabel('Receive line 1 quantity', { exact: true }).fill('4');
  await page
    .getByRole('button', { name: 'Record receipt', exact: true })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(detail).toContainText('PARTIALLY_RECEIVED');
  expect(
    (
      await (
        await page.request.get(`${base}/purchase-orders/${order.id}/receipts`)
      ).json()
    ).receipts,
  ).toHaveLength(1);
  await page
    .getByLabel('Receive line 1 quantity', { exact: true })
    .fill('3.750');
  await page
    .getByRole('button', { name: 'Record receipt', exact: true })
    .click();
  await expect(
    page.getByText('Receipt recorded.', { exact: true }),
  ).toBeVisible();
  await expect(detail.getByText('RECEIVED', { exact: true })).toBeVisible();
  await expect(orderLines).toContainText('5.000000');
  await expect(orderLines).toContainText('0.000000');
  await expect(
    page.getByRole('button', { name: 'Record receipt', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('table', { name: 'Purchase receipts' }).getByRole('row'),
  ).toHaveCount(3);
  const receipts = (
    await (
      await page.request.get(`${base}/purchase-orders/${order.id}/receipts`)
    ).json()
  ).receipts;
  expect(receipts).toHaveLength(2);
  await section(page, 'Inventory');
  await expect(
    page.getByRole('table', { name: 'Current stock' }),
  ).toContainText('5.000000');
  const history = page.getByRole('table', { name: 'Movement history' });
  await expect(history.getByRole('row')).toHaveCount(3);
  await expect(
    history.getByRole('cell', { name: 'Receiving Operator', exact: true }),
  ).toHaveCount(2);
  const movements = (
    await (await page.request.get(`${base}/inventory/movements`)).json()
  ).movements;
  expect(movements).toHaveLength(2);
  for (const movement of movements) {
    expect(movement.type).toBe('RECEIPT');
    expect(movement.referenceType).toBe('PURCHASE_RECEIPT');
    expect(receipts.map((r: { id: string }) => r.id)).toContain(
      movement.referenceId,
    );
    expect(movement.correlationKey).toBe(movement.referenceId);
    expect(movement.purchaseReceiptLineId).toBeTruthy();
  }
  await page.reload();
  await section(page, 'Inventory');
  await expect(
    page.getByRole('table', { name: 'Current stock' }),
  ).toContainText('5.000000');
  await openOrder(page, order.id);
  await expect(detail.getByText('RECEIVED', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Purchase receipts' }).getByRole('row'),
  ).toHaveCount(3);
});

test('MEMBER reads receipt history and pending but cannot receive through UI or HTTP', async ({
  page,
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await register(page, 'Receiving Team');
    const data = await prepare(page);
    const received = await page.request.post(
      `${data.base}/purchase-orders/${data.order.id}/receipts`,
      {
        headers: { ...data.headers, 'Idempotency-Key': randomUUID() },
        data: {
          warehouseId: data.warehouse.id,
          lines: [
            { purchaseOrderLineId: data.order.lines[0].id, quantity: '2' },
          ],
        },
      },
    );
    expect(received.status()).toBe(201);
    const member = await context.newPage();
    const email = await register(member, 'Receiving Personal');
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
    await openOrder(member, data.order.id);
    await expect(
      member.getByRole('table', { name: 'Order lines' }),
    ).toContainText('3.000000');
    await expect(
      member.getByRole('table', { name: 'Purchase receipts' }).getByRole('row'),
    ).toHaveCount(2);
    await expect(
      member.getByRole('button', { name: 'Record receipt', exact: true }),
    ).toHaveCount(0);
    const denied = await member.request.post(
      `${origin}${data.base}/purchase-orders/${data.order.id}/receipts`,
      {
        headers: {
          Origin: origin,
          'X-CSRF-Token': session.csrfToken,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          warehouseId: data.warehouse.id,
          lines: [
            { purchaseOrderLineId: data.order.lines[0].id, quantity: '1' },
          ],
        },
      },
    );
    expect(denied.status()).toBe(403);
  } finally {
    await context.close();
  }
});
