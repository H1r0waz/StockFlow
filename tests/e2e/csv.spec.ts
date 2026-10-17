import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
test.skip(!process.env.TEST_DATABASE_URL, 'Requires dedicated real PostgreSQL');
const origin = 'http://127.0.0.1:5173',
  password = 'Strong-csv-browser-password42!';
async function register(page: Page, name: string) {
  const email = `${randomUUID()}@example.test`;
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Create a workspace', exact: true })
    .click();
  await page
    .getByLabel('Full name', { exact: true })
    .fill('CSV Browser Operator');
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
}
async function upload(page: Page, csv: string) {
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({
    name: 'fictional.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Import preview', exact: true }),
  ).toBeVisible();
}
test('real CSV preview, invalid rows, atomic confirmation retry, persistence and safe downloaded reports', async ({
  page,
}, info) => {
  const email = await register(page, 'CSV Browser Workspace');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'CSV Browser Workspace', exact: true }),
  ).toBeVisible();
  const s = await (await page.request.get('/api/auth/session')).json(),
    base = `/api/organizations/${s.organization.id}`;
  await section(page, 'Imports');
  await expect(page.getByText(/No changes are saved until/)).toBeVisible();
  await upload(
    page,
    'sku,name,unitOfMeasure\nX,Duplicate one,UNIT\nx,Duplicate two,UNIT',
  );
  await expect(
    page.getByRole('table', { name: 'Import preview' }),
  ).toContainText('Duplicate SKU');
  await expect(
    page.getByRole('button', { name: 'Confirm import', exact: true }),
  ).toBeDisabled();
  expect(
    (await (await page.request.get(`${base}/products`)).json()).products,
  ).toHaveLength(0);
  const csv =
    'sku,name,unitOfMeasure,quantityScale\r\nCSV-RICE,CSV rice,KG,3\r\nCSV-FORMULA,=SUM(1+1),UNIT,0\r\n';
  await upload(page, csv);
  await expect(
    page.getByRole('table', { name: 'Import preview' }),
  ).toContainText('Create');
  expect(
    (await (await page.request.get(`${base}/products`)).json()).products,
  ).toHaveLength(0);
  let dropped = false;
  await page.route('**/imports/products/confirm', async (route) => {
    const response = await route.fetch();
    if (!dropped) {
      dropped = true;
      expect(response.status()).toBe(201);
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page
    .getByRole('button', { name: 'Confirm import', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Retry confirmation');
  await page
    .getByRole('button', { name: 'Confirm import', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Import confirmed', exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`${base}/products`)).json()).products,
  ).toHaveLength(2);
  const audit = await (
    await page.request.get(`${base}/audit?action=IMPORT_CONFIRM`)
  ).json();
  expect(audit.events).toHaveLength(1);
  await page
    .getByLabel('Import type', { exact: true })
    .selectOption('suppliers');
  await upload(
    page,
    'name,email,taxId,notes\nFictional CSV supplier,private@example.test,CSV-TAX,PRIVATE-NOTES',
  );
  await page
    .getByRole('button', { name: 'Confirm import', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Import confirmed', exact: true }),
  ).toBeVisible();
  await page.reload();
  await section(page, 'Reports');
  await expect(
    page.getByRole('table', { name: 'Operational report' }),
  ).toContainText('CSV rice');
  const pending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export CSV page', exact: true })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('stockflow-products.csv');
  const output = info.outputPath('products.csv');
  await download.saveAs(output);
  const contents = await readFile(output, 'utf8');
  expect(contents).toContain('CSV-RICE');
  expect(contents).toContain("'=SUM(1+1)");
  expect(contents).not.toContain('passwordHash');
  await page
    .getByLabel('Report type', { exact: true })
    .selectOption('suppliers');
  await expect(
    page.getByRole('table', { name: 'Operational report' }),
  ).toContainText('Fictional CSV supplier');
  const next = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export CSV page', exact: true })
    .click();
  const supplierDownload = await next;
  const supplierOutput = info.outputPath('suppliers.csv');
  await supplierDownload.saveAs(supplierOutput);
  const supplierCsv = await readFile(supplierOutput, 'utf8');
  expect(supplierCsv).toContain('Fictional CSV supplier');
  expect(supplierCsv).not.toContain('private@example.test');
  expect(supplierCsv).not.toContain('PRIVATE-NOTES');
});
test('MEMBER can use scoped reports but cannot import or export full business audit', async ({
  page,
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await register(page, 'CSV Team');
    const s = await (await page.request.get('/api/auth/session')).json();
    const member = await context.newPage();
    const email = await register(member, 'CSV Personal');
    const added = await page.request.post(
      `/api/organizations/${s.organization.id}/memberships`,
      {
        headers: { Origin: origin, 'X-CSRF-Token': s.csrfToken },
        data: { email, role: 'MEMBER' },
      },
    );
    expect(added.status()).toBe(201);
    const login = await member.request.post(`${origin}/api/auth/login`, {
      headers: { Origin: origin },
      data: { email, password, organizationId: s.organization.id },
    });
    expect(login.status()).toBe(200);
    const session = await login.json();
    await member.reload();
    await expect(
      member
        .getByRole('navigation', { name: 'Workspace sections' })
        .getByRole('button', { name: 'Imports', exact: true }),
    ).toHaveCount(0);
    await section(member, 'Reports');
    await expect(
      member.getByRole('heading', { name: 'Operational reports', exact: true }),
    ).toBeVisible();
    await expect(
      member.getByLabel('Report type').locator('option[value="audit"]'),
    ).toHaveCount(0);
    const base = `/api/organizations/${s.organization.id}`;
    expect(
      (
        await member.request.post(`${base}/imports/products/preview`, {
          headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken },
          data: { csv: 'sku,name,unitOfMeasure\nX,X,UNIT' },
        })
      ).status(),
    ).toBe(403);
    expect((await member.request.get(`${base}/exports/audit`)).status()).toBe(
      403,
    );
    expect(
      (await member.request.get(`${base}/exports/products`)).status(),
    ).toBe(200);
  } finally {
    await context.close();
  }
});
