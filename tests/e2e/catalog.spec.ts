import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:5173';
const password = 'Stockflow-catalog-browser-password-42!';
test.skip(
  !process.env.TEST_DATABASE_URL,
  'Real catalog E2E requires explicit TEST_DATABASE_URL',
);

async function register(page: Page, organization: string) {
  const email = `${randomUUID()}@example.test`;
  await page.goto(origin);
  await page
    .getByRole('button', { name: 'Create a workspace', exact: true })
    .click();
  await page.getByLabel('Full name', { exact: true }).fill('Catalog Browser');
  await page
    .getByLabel('Organization name', { exact: true })
    .fill(organization);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: organization, exact: true }),
  ).toBeVisible();
  return email;
}
async function section(
  page: Page,
  name: 'Categories' | 'Products' | 'Warehouses',
) {
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 2, name, exact: true }),
  ).toBeVisible();
}
function row(page: Page, text: string) {
  return page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: text, exact: true }) });
}

test('real login and catalog create/edit/archive persist after browser reloads', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const organization = `Catalog E2E ${suffix}`;
  const email = await register(page, organization);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome back', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: organization, exact: true }),
  ).toBeVisible();

  await section(page, 'Categories');
  await page.getByRole('button', { name: 'New category', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(`Ingredients ${suffix}`);
  await page.getByLabel('Description', { exact: true }).fill('Food supplies');
  await page
    .getByRole('button', { name: 'Create category', exact: true })
    .click();
  await expect(row(page, `Ingredients ${suffix}`)).toBeVisible();
  await row(page, `Ingredients ${suffix}`)
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.getByLabel('Name', { exact: true }).fill(`Baking ${suffix}`);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(row(page, `Baking ${suffix}`)).toBeVisible();
  await page.reload();
  await section(page, 'Categories');
  await expect(row(page, `Baking ${suffix}`)).toBeVisible();

  await section(page, 'Products');
  await page.getByRole('button', { name: 'New product', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Bulk flour');
  await page.getByLabel('SKU', { exact: true }).fill(`flour-${suffix}`);
  await page
    .getByLabel('Category', { exact: true })
    .selectOption({ label: `Baking ${suffix}` });
  await page.getByLabel('Unit of measure', { exact: true }).selectOption('KG');
  await page
    .getByLabel('Quantity precision', { exact: true })
    .selectOption('3');
  await page
    .getByRole('button', { name: 'Create product', exact: true })
    .click();
  const sku = `FLOUR-${suffix.toUpperCase()}`;
  await expect(row(page, sku)).toContainText('KG · 3 dp');
  await row(page, sku)
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.getByLabel('Name', { exact: true }).fill('Fine flour');
  await page
    .getByLabel('Quantity precision', { exact: true })
    .selectOption('6');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(row(page, sku)).toContainText('Fine flour');
  await expect(row(page, sku)).toContainText('KG · 6 dp');
  await row(page, sku)
    .getByRole('button', { name: 'Deactivate', exact: true })
    .click();
  await expect(
    row(page, sku).getByRole('cell', { name: 'Inactive', exact: true }),
  ).toBeVisible();
  await page.reload();
  await section(page, 'Products');
  await expect(row(page, sku)).toContainText('Fine flour');
  await expect(row(page, sku)).toContainText('Inactive');
  await row(page, sku)
    .getByRole('button', { name: 'Activate', exact: true })
    .click();
  await expect(
    row(page, sku).getByRole('cell', { name: 'Active', exact: true }),
  ).toBeVisible();

  await section(page, 'Warehouses');
  await page
    .getByRole('button', { name: 'New warehouse', exact: true })
    .click();
  await page.getByLabel('Name', { exact: true }).fill('Main warehouse');
  await page.getByLabel('Code', { exact: true }).fill(`main-${suffix}`);
  await page
    .getByRole('button', { name: 'Create warehouse', exact: true })
    .click();
  const code = `MAIN-${suffix.toUpperCase()}`;
  await expect(row(page, code)).toBeVisible();
  await row(page, code)
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.getByLabel('Name', { exact: true }).fill('North warehouse');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(row(page, code)).toContainText('North warehouse');
  await row(page, code)
    .getByRole('button', { name: 'Deactivate', exact: true })
    .click();
  await expect(row(page, code)).toContainText('Inactive');
  await page.reload();
  await section(page, 'Warehouses');
  await expect(row(page, code)).toContainText('North warehouse');
  await expect(row(page, code)).toContainText('Inactive');
  await section(page, 'Categories');
  await row(page, `Baking ${suffix}`)
    .getByRole('button', { name: 'Deactivate', exact: true })
    .click();
  await expect(row(page, `Baking ${suffix}`)).toContainText('Inactive');
  await page.reload();
  await section(page, 'Categories');
  await expect(row(page, `Baking ${suffix}`)).toContainText('Inactive');
});

test('MEMBER can view all three catalog lists and has no edit controls', async ({
  page,
  browser,
}) => {
  const memberContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    await register(page, `Catalog team ${randomUUID().slice(0, 8)}`);
    const memberEmail = await register(
      memberPage,
      `Member personal ${randomUUID().slice(0, 8)}`,
    );
    const session = (await (
      await page.request.get(`${origin}/api/auth/session`)
    ).json()) as { organization: { id: string }; csrfToken: string };
    const base = `${origin}/api/organizations/${session.organization.id}`;
    const headers = { Origin: origin, 'X-CSRF-Token': session.csrfToken };
    expect(
      (
        await page.request.post(`${base}/memberships`, {
          headers,
          data: { email: memberEmail, role: 'MEMBER' },
        })
      ).status(),
    ).toBe(201);
    for (const [kind, data] of [
      ['categories', { name: 'Visible category' }],
      [
        'products',
        {
          name: 'Visible product',
          sku: 'VISIBLE-1',
          unitOfMeasure: 'UNIT',
          quantityScale: 0,
        },
      ],
      ['warehouses', { name: 'Visible warehouse', code: 'VISIBLE-1' }],
    ] as const) {
      expect(
        (
          await page.request.post(`${base}/${kind}`, { headers, data })
        ).status(),
      ).toBe(201);
    }
    const login = await memberPage.request.post(`${origin}/api/auth/login`, {
      headers: { Origin: origin },
      data: {
        email: memberEmail,
        password,
        organizationId: session.organization.id,
      },
    });
    expect(login.status()).toBe(200);
    await memberPage.reload();
    for (const [name, item, singular] of [
      ['Categories', 'Visible category', 'category'],
      ['Products', 'Visible product', 'product'],
      ['Warehouses', 'Visible warehouse', 'warehouse'],
    ] as const) {
      await section(memberPage, name);
      await expect(row(memberPage, item)).toBeVisible();
      await expect(
        memberPage.getByRole('button', {
          name: `New ${singular}`,
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        memberPage.getByRole('button', { name: 'Edit', exact: true }),
      ).toHaveCount(0);
      await expect(
        memberPage.getByRole('button', { name: 'Deactivate', exact: true }),
      ).toHaveCount(0);
    }
  } finally {
    await memberContext.close();
  }
});
