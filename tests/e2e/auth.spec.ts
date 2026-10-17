import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const password = 'Stockflow-browser-password-42!';
const origin = 'http://127.0.0.1:5173';
const databaseUrl = process.env.TEST_DATABASE_URL;
test.skip(
  !databaseUrl,
  'Real auth E2E requires explicitly configured TEST_DATABASE_URL',
);

async function register(page: Page, organizationName: string) {
  const email = `${randomUUID()}@example.test`;
  await page.goto(origin);
  await page
    .getByRole('button', { name: 'Create a workspace', exact: true })
    .click();
  await page.getByLabel('Full name', { exact: true }).fill('Browser Person');
  await page
    .getByLabel('Organization name', { exact: true })
    .fill(organizationName);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: organizationName,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Workspace members', exact: true }),
  ).toBeVisible();
  return email;
}

test('real registration, refresh persistence, logout and login protect the workspace', async ({
  page,
}) => {
  const organization = `Browser workspace ${randomUUID().slice(0, 8)}`;
  const email = await register(page, organization);
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: organization, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: email, exact: true }),
  ).toBeVisible();
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === 'stockflow_session',
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome back', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Workspace members', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: organization, exact: true }),
  ).toBeVisible();
});

test('independent browser organizations cannot read each other memberships', async ({
  page,
  browser,
}) => {
  const otherContext = await browser.newContext();
  try {
    const otherPage = await otherContext.newPage();
    const emailA = await register(page, `Tenant A ${randomUUID().slice(0, 8)}`);
    const emailB = await register(
      otherPage,
      `Tenant B ${randomUUID().slice(0, 8)}`,
    );
    const sessionB = (await (
      await otherPage.request.get(`${origin}/api/auth/session`)
    ).json()) as { organization: { id: string } };
    const forbidden = await page.request.get(
      `${origin}/api/organizations/${sessionB.organization.id}/memberships`,
    );
    expect(forbidden.status()).toBe(404);
    await expect(
      page.getByRole('cell', { name: emailA, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: emailB, exact: true }),
    ).toHaveCount(0);
    await expect(
      otherPage.getByRole('cell', { name: emailB, exact: true }),
    ).toBeVisible();
  } finally {
    await otherContext.close();
  }
});

test('MEMBER sees the scoped member view while backend refuses administration', async ({
  page,
  browser,
}) => {
  const memberContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    const organization = `Shared workspace ${randomUUID().slice(0, 8)}`;
    await register(page, organization);
    const memberEmail = await register(
      memberPage,
      `Personal ${randomUUID().slice(0, 8)}`,
    );
    const ownerSession = (await (
      await page.request.get(`${origin}/api/auth/session`)
    ).json()) as { organization: { id: string }; csrfToken: string };
    const added = await page.request.post(
      `${origin}/api/organizations/${ownerSession.organization.id}/memberships`,
      {
        headers: { Origin: origin, 'X-CSRF-Token': ownerSession.csrfToken },
        data: { email: memberEmail, role: 'MEMBER' },
      },
    );
    expect(added.status()).toBe(201);
    const login = await memberPage.request.post(`${origin}/api/auth/login`, {
      headers: { Origin: origin },
      data: {
        email: memberEmail,
        password,
        organizationId: ownerSession.organization.id,
      },
    });
    expect(login.status()).toBe(200);
    const memberSession = (await login.json()) as {
      organization: { id: string };
      membership: { role: string };
      csrfToken: string;
    };
    expect(memberSession.organization.id).toBe(ownerSession.organization.id);
    expect(memberSession.membership.role).toBe('MEMBER');
    await memberPage.reload();
    await expect(
      memberPage.getByRole('heading', {
        level: 1,
        name: organization,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      memberPage.getByRole('cell', { name: memberEmail, exact: true }),
    ).toBeVisible();
    const denied = await memberPage.request.patch(
      `${origin}/api/organizations/${ownerSession.organization.id}`,
      {
        headers: { Origin: origin, 'X-CSRF-Token': memberSession.csrfToken },
        data: { name: 'Forbidden rename' },
      },
    );
    expect(denied.status()).toBe(403);
    await memberPage.reload();
    await expect(
      memberPage.getByRole('heading', {
        level: 1,
        name: organization,
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await memberContext.close();
  }
});
