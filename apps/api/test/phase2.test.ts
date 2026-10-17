import { createHash, randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';
const password = 'Stockflow-test-password-42!';
const assertTestDatabase = () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/stockflow_test' ||
    url.port !== '55434' ||
    url.username !== 'stockflow' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Refusing cleanup outside loopback stockflow_test database',
    );
};
// No fallback to DATABASE_URL: these tests delete only the explicitly named test DB.
if (databaseUrl) assertTestDatabase();

type Auth = {
  user: { id: string; email: string; displayName: string };
  organization: { id: string; name: string };
  membership: { id: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' };
  csrfToken: string;
};
type Identity = Auth & { cookie: string; email: string };
function cookieHeader(response: request.Response): string {
  const cookies = response.headers['set-cookie'];
  if (!Array.isArray(cookies) || typeof cookies[0] !== 'string') {
    throw new Error('Expected session Set-Cookie response header');
  }
  return cookies[0];
}

describe.skipIf(!databaseUrl)(
  'Phase 2 / real PostgreSQL (TEST_DATABASE_URL required)',
  () => {
    let prisma: PrismaClient;
    let app: ReturnType<typeof createApp>;
    let currentTime: Date;
    beforeAll(() => {
      assertTestDatabase();
      prisma = createDatabase(databaseUrl!);
    });
    beforeEach(async () => {
      assertTestDatabase();
      await prisma.$executeRaw`TRUNCATE TABLE "InventoryMovement", "InventoryBalance", "InventoryCommand", "PurchaseOrderLine", "PurchaseOrder", "Supplier", "PurchasingCommand", "ImportJob", "AuditEvent", "InventoryThreshold" CASCADE`;
      await prisma.$transaction([
        prisma.product.deleteMany(),
        prisma.warehouse.deleteMany(),
        prisma.category.deleteMany(),
        prisma.session.deleteMany(),
        prisma.membership.deleteMany(),
        prisma.user.deleteMany(),
        prisma.organization.deleteMany(),
      ]);
      currentTime = new Date('2026-10-17T12:00:00Z');
      app = createApp({
        prisma,
        now: () => currentTime,
        rateLimit: { max: 1000 },
      });
    });
    afterAll(async () => {
      await prisma?.$disconnect();
    });

    function registration(email = `${randomUUID()}@example.test`) {
      return {
        email,
        password,
        displayName: 'Test Person',
        organizationName: 'Test Organization',
      };
    }
    async function register(): Promise<Identity> {
      const input = registration();
      const response = await request(app)
        .post('/api/auth/register')
        .set('Origin', origin)
        .send(input);
      expect(response.status).toBe(201);
      return {
        ...(response.body as Auth),
        email: input.email,
        cookie: cookieHeader(response).split(';')[0]!,
      };
    }
    function orgPath(identity: Identity) {
      return `/api/organizations/${identity.organization.id}`;
    }
    function membersPath(identity: Identity) {
      return `${orgPath(identity)}/memberships`;
    }
    function authenticated(test: request.Test, identity: Identity) {
      return test
        .set('Cookie', identity.cookie)
        .set('Origin', origin)
        .set('X-CSRF-Token', identity.csrfToken);
    }
    async function add(
      owner: Identity,
      person: Identity,
      role: 'OWNER' | 'ADMIN' | 'MEMBER',
    ) {
      const response = await authenticated(
        request(app).post(membersPath(owner)),
        owner,
      ).send({ email: person.email, role });
      expect(response.status).toBe(201);
      const row = await prisma.membership.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: owner.organization.id,
            userId: person.user.id,
          },
        },
      });
      return row;
    }
    // A scoped opaque session is issued by the real login. This lets existing users
    // join A while keeping independent B membership for tenant-negative scenarios.
    async function loginIn(
      person: Identity,
      organizationId: string,
    ): Promise<Identity> {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ email: person.email, password, organizationId });
      expect(response.status).toBe(200);
      expect((response.body as Auth).organization.id).toBe(organizationId);
      return {
        ...(response.body as Auth),
        email: person.email,
        cookie: cookieHeader(response).split(';')[0]!,
      };
    }

    it('registers one owner and stores password/session hashes without leaking them', async () => {
      const input = registration('  Person@Example.Test ');
      const response = await request(app)
        .post('/api/auth/register')
        .set('Origin', origin)
        .send(input);
      expect(response.status).toBe(201);
      const body = response.body as Auth;
      expect(body.user.email).toBe('person@example.test');
      expect(body.membership.role).toBe('OWNER');
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: body.user.id },
      });
      expect(user.passwordHash).not.toBe(password);
      expect(user.passwordHash.length).toBeGreaterThan(60);
      const rawCookie = cookieHeader(response);
      const token = rawCookie.split(';')[0]!.split('=')[1]!;
      const session = await prisma.session.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(session.tokenHash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
      expect(session.tokenHash).not.toBe(token);
      expect(JSON.stringify(body)).not.toContain(user.passwordHash);
      expect(JSON.stringify(body)).not.toContain(session.tokenHash);
      expect(rawCookie).toMatch(/HttpOnly/i);
      expect(rawCookie).toMatch(/SameSite=Lax/i);
      expect(rawCookie).toMatch(/Path=\//i);
    });

    it.each([
      { email: 'bad' },
      { password: 'short' },
      { displayName: '' },
      { organizationName: '' },
    ])(
      'rejects invalid registration before creating rows (%j)',
      async (change) => {
        const response = await request(app)
          .post('/api/auth/register')
          .set('Origin', origin)
          .send({ ...registration(), ...change });
        expect(response.status).toBe(400);
        expect(await prisma.user.count()).toBe(0);
        expect(await prisma.organization.count()).toBe(0);
      },
    );

    it('rejects duplicate normalized email without leaking database details', async () => {
      const person = await register();
      const response = await request(app)
        .post('/api/auth/register')
        .set('Origin', origin)
        .send(registration(person.email.toUpperCase()));
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).not.toMatch(
        /prisma|passwordHash|unique constraint|P2002/i,
      );
      expect(await prisma.organization.count()).toBe(1);
    });

    it('logs in, returns current session, and rotates the opaque token', async () => {
      const person = await register();
      const response = await request(app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .set('Cookie', person.cookie)
        .send({ email: person.email, password });
      expect(response.status).toBe(200);
      const login = {
        ...(response.body as Auth),
        email: person.email,
        cookie: cookieHeader(response).split(';')[0]!,
      };
      expect(login.cookie).not.toBe(person.cookie);
      expect(
        (await authenticated(request(app).get('/api/auth/session'), person))
          .status,
      ).toBe(401);
      const current = await authenticated(
        request(app).get('/api/auth/session'),
        login,
      );
      expect(current.status).toBe(200);
      expect((current.body as Auth).user.id).toBe(person.user.id);
      expect((current.body as Auth).organization.id).toBe(
        person.organization.id,
      );
    });

    it('uses the same safe error for unknown accounts and wrong passwords', async () => {
      const person = await register();
      const wrong = await request(app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ email: person.email, password: 'wrong-password-42!' });
      const unknown = await request(app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ email: 'unknown@example.test', password });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
    });

    it('requires a live session for current session and private organization routes', async () => {
      const owner = await register();
      for (const path of [
        '/api/auth/session',
        orgPath(owner),
        membersPath(owner),
      ]) {
        expect((await request(app).get(path)).status).toBe(401);
        expect(
          (
            await request(app)
              .get(path)
              .set('Cookie', 'stockflow_session=invalid')
          ).status,
        ).toBe(401);
      }
    });

    it('expires sessions under the injected clock', async () => {
      const owner = await register();
      currentTime = new Date('2027-10-17T12:00:00Z');
      expect(
        (await authenticated(request(app).get('/api/auth/session'), owner))
          .status,
      ).toBe(401);
    });

    it('rejects a deleted session token', async () => {
      const owner = await register();
      await prisma.session.deleteMany({ where: { userId: owner.user.id } });
      expect(
        (await authenticated(request(app).get('/api/auth/session'), owner))
          .status,
      ).toBe(401);
    });

    it('logs out, clears the cookie and invalidates the old token', async () => {
      const owner = await register();
      const response = await authenticated(
        request(app).post('/api/auth/logout'),
        owner,
      ).send({});
      expect([200, 204]).toContain(response.status);
      expect(cookieHeader(response)).toMatch(/stockflow_session=;/);
      expect(
        (await authenticated(request(app).get('/api/auth/session'), owner))
          .status,
      ).toBe(401);
      expect(
        await prisma.session.count({ where: { userId: owner.user.id } }),
      ).toBe(0);
    });

    it('requires trusted Origin for public auth mutations', async () => {
      for (const route of ['register', 'login']) {
        expect(
          (await request(app).post(`/api/auth/${route}`).send(registration()))
            .status,
        ).toBe(403);
        expect(
          (
            await request(app)
              .post(`/api/auth/${route}`)
              .set('Origin', 'https://evil.example')
              .send(registration())
          ).status,
        ).toBe(403);
      }
    });

    it('rejects absent/wrong CSRF and cross-origin authenticated mutations', async () => {
      const owner = await register();
      for (const csrf of ['', 'wrong']) {
        const response = await request(app)
          .patch(orgPath(owner))
          .set('Cookie', owner.cookie)
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .send({ name: 'Forbidden' });
        expect(response.status).toBe(403);
      }
      const crossOrigin = await authenticated(
        request(app).patch(orgPath(owner)),
        owner,
      )
        .set('Origin', 'https://evil.example')
        .send({ name: 'Forbidden' });
      expect(crossOrigin.status).toBe(403);
      expect(
        (
          await prisma.organization.findUniqueOrThrow({
            where: { id: owner.organization.id },
          })
        ).name,
      ).toBe(owner.organization.name);
    });

    it('sets Secure cookies when explicitly configured for HTTPS', async () => {
      app = createApp({ prisma, secureCookies: true });
      const response = await request(app)
        .post('/api/auth/register')
        .set('Origin', origin)
        .send(registration());
      expect(response.status).toBe(201);
      expect(cookieHeader(response)).toMatch(/; Secure/i);
    });

    it('rate-limits repeated auth attempts with a bounded factory override', async () => {
      app = createApp({ prisma, rateLimit: { max: 2, windowMs: 60_000 } });
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++)
        statuses.push(
          (
            await request(app)
              .post('/api/auth/login')
              .set('Origin', origin)
              .send({ email: 'missing@example.test', password })
          ).status,
        );
      expect(statuses).toEqual([401, 401, 429]);
    });

    it('allows owner organization updates and lists same-tenant memberships', async () => {
      const owner = await register();
      const updated = await authenticated(
        request(app).patch(orgPath(owner)),
        owner,
      ).send({ name: 'Updated Organization' });
      expect(updated.status).toBe(200);
      expect(
        (
          await prisma.organization.findUniqueOrThrow({
            where: { id: owner.organization.id },
          })
        ).name,
      ).toBe('Updated Organization');
      const listed = await authenticated(
        request(app).get(membersPath(owner)),
        owner,
      );
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).toContain(owner.email);
      expect(JSON.stringify(listed.body)).not.toMatch(/passwordHash|tokenHash/);
    });

    it('prevents MEMBER from changing organization or managing memberships', async () => {
      const owner = await register();
      const person = await register();
      const membership = await add(owner, person, 'MEMBER');
      const member = await loginIn(person, owner.organization.id);
      expect(
        (await authenticated(request(app).get(orgPath(owner)), member)).status,
      ).toBe(200);
      expect(
        (await authenticated(request(app).get(membersPath(owner)), member))
          .status,
      ).toBe(200);
      expect(
        (
          await authenticated(request(app).patch(orgPath(owner)), member).send({
            name: 'No',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await authenticated(
            request(app).post(membersPath(owner)),
            member,
          ).send({ email: person.email, role: 'ADMIN' })
        ).status,
      ).toBe(403);
      expect(
        (
          await authenticated(
            request(app).patch(`${membersPath(owner)}/${membership.id}`),
            member,
          ).send({ role: 'ADMIN' })
        ).status,
      ).toBe(403);
      expect(
        (
          await authenticated(
            request(app).delete(`${membersPath(owner)}/${membership.id}`),
            member,
          )
        ).status,
      ).toBe(403);
    });

    it('allows ADMIN to manage MEMBER but blocks owner/admin privilege escalation', async () => {
      const owner = await register();
      const person = await register();
      const target = await register();
      await add(owner, person, 'ADMIN');
      const admin = await loginIn(person, owner.organization.id);
      const membership = await add(admin, target, 'MEMBER');
      expect(
        (
          await authenticated(request(app).patch(orgPath(owner)), admin).send({
            name: 'Admin update',
          })
        ).status,
      ).toBe(200);
      for (const role of ['OWNER', 'ADMIN']) {
        expect(
          (
            await authenticated(
              request(app).patch(`${membersPath(owner)}/${membership.id}`),
              admin,
            ).send({ role })
          ).status,
        ).toBe(403);
      }
      expect(
        (
          await authenticated(
            request(app).delete(`${membersPath(owner)}/${owner.membership.id}`),
            admin,
          )
        ).status,
      ).toBe(403);
      expect([200, 204]).toContain(
        (
          await authenticated(
            request(app).delete(`${membersPath(owner)}/${membership.id}`),
            admin,
          )
        ).status,
      );
    });

    it('rejects unknown-user additions and duplicate membership without partial writes', async () => {
      const owner = await register();
      const person = await register();
      const unknown = await authenticated(
        request(app).post(membersPath(owner)),
        owner,
      ).send({ email: 'absent@example.test', role: 'MEMBER' });
      expect([400, 404]).toContain(unknown.status);
      await add(owner, person, 'MEMBER');
      const duplicate = await authenticated(
        request(app).post(membersPath(owner)),
        owner,
      ).send({ email: person.email, role: 'MEMBER' });
      expect(duplicate.status).toBe(409);
      expect(
        await prisma.membership.count({
          where: { organizationId: owner.organization.id },
        }),
      ).toBe(2);
    });

    it('blocks tenant A from all B private reads and mutations, including mixed path IDs', async () => {
      const a = await register();
      const b = await register();
      expect(
        (await authenticated(request(app).get(orgPath(b)), a)).status,
      ).toBe(404);
      expect(
        (await authenticated(request(app).get(membersPath(b)), a)).status,
      ).toBe(404);
      expect(
        (
          await authenticated(request(app).patch(orgPath(b)), a).send({
            name: 'Stolen',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await authenticated(request(app).post(membersPath(b)), a).send({
            email: a.email,
            role: 'OWNER',
          })
        ).status,
      ).toBe(404);
      for (const parent of [a, b]) {
        expect(
          (
            await authenticated(
              request(app).patch(`${membersPath(parent)}/${b.membership.id}`),
              a,
            ).send({ role: 'MEMBER' })
          ).status,
        ).toBe(404);
        expect(
          (
            await authenticated(
              request(app).delete(`${membersPath(parent)}/${b.membership.id}`),
              a,
            )
          ).status,
        ).toBe(404);
      }
      expect(
        (
          await prisma.organization.findUniqueOrThrow({
            where: { id: b.organization.id },
          })
        ).name,
      ).toBe(b.organization.name);
      expect(
        (
          await prisma.membership.findUniqueOrThrow({
            where: { id: b.membership.id },
          })
        ).role,
      ).toBe('OWNER');
    });

    it('rejects artificial organizationId fields and unauthorized login tenant selection', async () => {
      const a = await register();
      const b = await register();
      const manipulated = await authenticated(
        request(app).patch(orgPath(a)),
        a,
      ).send({ name: 'Changed', organizationId: b.organization.id });
      expect([200, 400]).toContain(manipulated.status);
      expect(
        (
          await prisma.organization.findUniqueOrThrow({
            where: { id: b.organization.id },
          })
        ).name,
      ).toBe(b.organization.name);
      const login = await request(app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ email: a.email, password, organizationId: b.organization.id });
      expect([401, 403, 404]).toContain(login.status);
    });

    it('protects the last OWNER against demotion and deletion', async () => {
      const owner = await register();
      expect(
        (
          await authenticated(
            request(app).patch(`${membersPath(owner)}/${owner.membership.id}`),
            owner,
          ).send({ role: 'MEMBER' })
        ).status,
      ).toBe(409);
      expect(
        (
          await authenticated(
            request(app).delete(`${membersPath(owner)}/${owner.membership.id}`),
            owner,
          )
        ).status,
      ).toBe(409);
      expect(
        await prisma.membership.count({
          where: { organizationId: owner.organization.id, role: 'OWNER' },
        }),
      ).toBe(1);
    });

    it('enforces membership uniqueness in PostgreSQL independently of HTTP', async () => {
      const owner = await register();
      await expect(
        prisma.membership.create({
          data: {
            organizationId: owner.organization.id,
            userId: owner.user.id,
            role: 'MEMBER',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(
        await prisma.membership.count({
          where: { organizationId: owner.organization.id },
        }),
      ).toBe(1);
    });

    it('rejects a session combining an existing organization with a nonmember user at DB level', async () => {
      const a = await register();
      const b = await register();
      await expect(
        prisma.session.create({
          data: {
            tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            csrfToken: randomUUID(),
            userId: a.user.id,
            organizationId: b.organization.id,
            expiresAt: new Date('2026-10-18T00:00:00Z'),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('preserves at least one owner under concurrent owner demotions', async () => {
      const first = await register();
      const person = await register();
      const otherMembership = await add(first, person, 'OWNER');
      const second = await loginIn(person, first.organization.id);
      const responses = await Promise.all([
        authenticated(
          request(app).patch(`${membersPath(first)}/${first.membership.id}`),
          first,
        ).send({ role: 'MEMBER' }),
        authenticated(
          request(app).patch(`${membersPath(first)}/${otherMembership.id}`),
          second,
        ).send({ role: 'MEMBER' }),
      ]);
      expect(
        responses.filter((response) => response.status === 200),
      ).toHaveLength(1);
      expect(
        responses.every((response) =>
          [200, 401, 403, 409].includes(response.status),
        ),
      ).toBe(true);
      expect(
        await prisma.membership.count({
          where: { organizationId: first.organization.id, role: 'OWNER' },
        }),
      ).toBe(1);
    });

    it('revokes affected organization sessions on membership changes and removal', async () => {
      const owner = await register();
      const person = await register();
      const membership = await add(owner, person, 'ADMIN');
      const admin = await loginIn(person, owner.organization.id);
      expect(
        (
          await authenticated(
            request(app).patch(`${membersPath(owner)}/${membership.id}`),
            owner,
          ).send({ role: 'MEMBER' })
        ).status,
      ).toBe(200);
      expect(
        (await authenticated(request(app).get('/api/auth/session'), admin))
          .status,
      ).toBe(401);
      const member = await loginIn(person, owner.organization.id);
      expect([200, 204]).toContain(
        (
          await authenticated(
            request(app).delete(`${membersPath(owner)}/${membership.id}`),
            owner,
          )
        ).status,
      );
      expect(
        (await authenticated(request(app).get('/api/auth/session'), member))
          .status,
      ).toBe(401);
      expect(
        (await authenticated(request(app).get('/api/auth/session'), person))
          .status,
      ).toBe(200);
    });
  },
);
