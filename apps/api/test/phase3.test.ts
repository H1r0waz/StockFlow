import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/database.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';
const password = 'Stockflow-catalog-test-password-42!';
function assertTestDatabase() {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55434' ||
    url.username !== 'stockflow' ||
    url.pathname !== '/stockflow_test' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Refusing cleanup outside dedicated StockFlow test database',
    );
}
if (databaseUrl) assertTestDatabase();

type Identity = {
  user: { id: string };
  organization: { id: string };
  csrfToken: string;
  cookie: string;
  email: string;
};
type Entity = {
  id: string;
  name: string;
  active: boolean;
  description?: string | null;
  organizationId: string;
  sku?: string;
  code?: string;
  categoryId?: string | null;
  unitOfMeasure?: string;
  quantityScale?: number;
};
const resources = ['categories', 'products', 'warehouses'] as const;
type Resource = (typeof resources)[number];
function cookieHeader(response: request.Response) {
  const cookies = response.headers['set-cookie'];
  if (!Array.isArray(cookies) || typeof cookies[0] !== 'string')
    throw new Error('Missing session cookie');
  return cookies[0].split(';')[0]!;
}
function entity(response: request.Response, resource: Resource): Entity {
  const keys = {
    categories: 'category',
    products: 'product',
    warehouses: 'warehouse',
  };
  return (response.body as Record<string, Entity>)[keys[resource]]!;
}
function validBody(resource: Resource) {
  if (resource === 'products')
    return {
      sku: 'SKU-1',
      name: 'Test product',
      unitOfMeasure: 'UNIT',
      quantityScale: 0,
    };
  if (resource === 'warehouses')
    return { code: 'WH-1', name: 'Test warehouse' };
  return { name: 'Test category' };
}

describe.skipIf(!databaseUrl)(
  'Phase 3 / real PostgreSQL catalog (TEST_DATABASE_URL required)',
  () => {
    let prisma: PrismaClient;
    let app: ReturnType<typeof createApp>;
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
      app = createApp({ prisma, rateLimit: { max: 1000 } });
    });
    afterAll(async () => {
      await prisma?.$disconnect();
    });
    function path(identity: Identity, resource: Resource) {
      return `/api/organizations/${identity.organization.id}/${resource}`;
    }
    function auth(test: request.Test, identity: Identity) {
      return test
        .set('Cookie', identity.cookie)
        .set('Origin', origin)
        .set('X-CSRF-Token', identity.csrfToken);
    }
    async function register(): Promise<Identity> {
      const email = `${randomUUID()}@example.test`;
      const response = await request(app)
        .post('/api/auth/register')
        .set('Origin', origin)
        .send({
          email,
          password,
          displayName: 'Catalog tester',
          organizationName: 'Catalog workspace',
        });
      expect(response.status).toBe(201);
      return {
        ...(response.body as Omit<Identity, 'email' | 'cookie'>),
        email,
        cookie: cookieHeader(response),
      };
    }
    async function create(
      owner: Identity,
      resource: Resource,
      data: object = validBody(resource),
    ) {
      const response = await auth(
        request(app).post(path(owner, resource)),
        owner,
      ).send(data);
      expect(response.status).toBe(201);
      return entity(response, resource);
    }
    async function join(owner: Identity, role: 'ADMIN' | 'MEMBER') {
      const person = await register();
      const added = await auth(
        request(app).post(
          `/api/organizations/${owner.organization.id}/memberships`,
        ),
        owner,
      ).send({ email: person.email, role });
      expect(added.status).toBe(201);
      const login = await request(app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({
          email: person.email,
          password,
          organizationId: owner.organization.id,
        });
      expect(login.status).toBe(200);
      return {
        ...(login.body as Omit<Identity, 'email' | 'cookie'>),
        email: person.email,
        cookie: cookieHeader(login),
      };
    }

    it('normalizes category names, edits descriptions, and retains archived rows', async () => {
      const owner = await register();
      const category = await create(owner, 'categories', {
        name: '  Office   Tools  ',
        description: 'Initial',
      });
      expect(category.name).toBe('Office Tools');
      const changed = await auth(
        request(app).patch(`${path(owner, 'categories')}/${category.id}`),
        owner,
      ).send({ name: 'Office equipment', description: null, active: false });
      expect(changed.status).toBe(200);
      expect(entity(changed, 'categories')).toMatchObject({
        name: 'Office equipment',
        description: null,
        active: false,
      });
      const listed = await auth(
        request(app).get(path(owner, 'categories')),
        owner,
      );
      expect(listed.status).toBe(200);
      expect((listed.body as { categories: Entity[] }).categories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: category.id, active: false }),
        ]),
      );
    });

    it('prevents normalized category duplicates per tenant including NFKC and archived rows', async () => {
      const a = await register();
      const b = await register();
      const category = await create(a, 'categories', { name: 'Office Tools' });
      for (const name of [' office   TOOLS ', 'Ｏｆｆｉｃｅ Tools']) {
        const duplicate = await auth(
          request(app).post(path(a, 'categories')),
          a,
        ).send({ name });
        expect(duplicate.status).toBe(409);
      }
      expect(
        (await create(b, 'categories', { name: 'Office Tools' }))
          .organizationId,
      ).toBe(b.organization.id);
      await auth(
        request(app).patch(`${path(a, 'categories')}/${category.id}`),
        a,
      ).send({ active: false });
      expect(
        (
          await auth(request(app).post(path(a, 'categories')), a).send({
            name: 'office tools',
          })
        ).status,
      ).toBe(409);
    });

    it('normalizes SKU and preserves exact fractional unit metadata through updates', async () => {
      const owner = await register();
      const category = await create(owner, 'categories');
      const product = await create(owner, 'products', {
        sku: ' flour-01 ',
        name: '  Bulk   flour ',
        unitOfMeasure: 'KG',
        quantityScale: 3,
        categoryId: category.id,
        description: 'For bakeries',
      });
      expect(product).toMatchObject({
        sku: 'FLOUR-01',
        name: 'Bulk flour',
        unitOfMeasure: 'KG',
        quantityScale: 3,
        categoryId: category.id,
        active: true,
      });
      const edited = await auth(
        request(app).patch(`${path(owner, 'products')}/${product.id}`),
        owner,
      ).send({
        sku: 'flour-02',
        name: 'Fine flour',
        categoryId: null,
        description: null,
        quantityScale: 6,
      });
      expect(edited.status).toBe(200);
      const detail = await auth(
        request(app).get(`${path(owner, 'products')}/${product.id}`),
        owner,
      );
      expect(detail.status).toBe(200);
      expect(entity(detail, 'products')).toMatchObject({
        sku: 'FLOUR-02',
        name: 'Fine flour',
        quantityScale: 6,
        categoryId: null,
        description: null,
      });
    });

    it('reserves inactive SKUs within the organization and permits the same SKU in another', async () => {
      const a = await register();
      const b = await register();
      const product = await create(a, 'products');
      const archived = await auth(
        request(app).patch(`${path(a, 'products')}/${product.id}`),
        a,
      ).send({ active: false });
      expect(archived.status).toBe(200);
      expect(
        (
          await auth(request(app).post(path(a, 'products')), a).send(
            validBody('products'),
          )
        ).status,
      ).toBe(409);
      expect((await create(b, 'products')).organizationId).toBe(
        b.organization.id,
      );
      const list = await auth(request(app).get(path(a, 'products')), a);
      expect((list.body as { products: Entity[] }).products).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: product.id, active: false }),
        ]),
      );
    });

    it.each(['UNIT', 'KG', 'G', 'L', 'ML', 'M', 'CM'])(
      'accepts the documented unit %s',
      async (unitOfMeasure) => {
        const owner = await register();
        const product = await create(owner, 'products', {
          sku: 'UNIT-TEST',
          name: 'Unit test',
          unitOfMeasure,
        });
        expect(product.unitOfMeasure).toBe(unitOfMeasure);
        expect(product.quantityScale).toBe(unitOfMeasure === 'UNIT' ? 0 : 3);
      },
    );

    it('rejects cross-tenant category references through API and composite PostgreSQL FK', async () => {
      const a = await register();
      const b = await register();
      const category = await create(b, 'categories');
      const response = await auth(
        request(app).post(path(a, 'products')),
        a,
      ).send({ ...validBody('products'), categoryId: category.id });
      expect(response.status).toBe(404);
      expect(await prisma.product.count()).toBe(0);
      await expect(
        prisma.product.create({
          data: {
            organizationId: a.organization.id,
            sku: 'DIRECT',
            name: 'Direct cross tenant',
            unitOfMeasure: 'UNIT',
            categoryId: category.id,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      const product = await create(a, 'products');
      expect(
        (
          await auth(
            request(app).patch(`${path(a, 'products')}/${product.id}`),
            a,
          ).send({ categoryId: category.id })
        ).status,
      ).toBe(404);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
          .categoryId,
      ).toBeNull();
    });

    it('keeps existing inactive category associations editable but rejects new assignments', async () => {
      const owner = await register();
      const category = await create(owner, 'categories');
      const existing = await create(owner, 'products', {
        ...validBody('products'),
        categoryId: category.id,
      });
      expect(
        (
          await auth(
            request(app).patch(`${path(owner, 'categories')}/${category.id}`),
            owner,
          ).send({ active: false })
        ).status,
      ).toBe(200);
      expect(
        (
          await auth(request(app).post(path(owner, 'products')), owner).send({
            ...validBody('products'),
            sku: 'NEW',
            categoryId: category.id,
          })
        ).status,
      ).toBe(409);
      const other = await create(owner, 'products', {
        ...validBody('products'),
        sku: 'OTHER',
      });
      expect(
        (
          await auth(
            request(app).patch(`${path(owner, 'products')}/${other.id}`),
            owner,
          ).send({ categoryId: category.id })
        ).status,
      ).toBe(409);
      const preserved = await auth(
        request(app).patch(`${path(owner, 'products')}/${existing.id}`),
        owner,
      ).send({ name: 'Edited existing', categoryId: category.id });
      expect(preserved.status).toBe(200);
      expect(entity(preserved, 'products')).toMatchObject({
        active: true,
        categoryId: category.id,
        name: 'Edited existing',
      });
    });

    it.each([
      { sku: 'bad sku' },
      { sku: 'é' },
      { sku: 'A'.repeat(65) },
      { sku: '' },
      { unitOfMeasure: 'BOX' },
      { unitOfMeasure: null },
      { quantityScale: -1 },
      { quantityScale: 7 },
      { quantityScale: 1.5 },
      { quantityScale: '3' },
      { categoryId: 'invalid-id' },
      { active: 'false' },
      { name: null },
      { minimumStock: 5 },
    ])('rejects invalid product data %j without inserting', async (change) => {
      const owner = await register();
      const response = await auth(
        request(app).post(path(owner, 'products')),
        owner,
      ).send({ ...validBody('products'), ...change });
      expect(response.status).toBe(400);
      expect(await prisma.product.count()).toBe(0);
    });

    it.each([
      { name: '' },
      { name: null },
      { name: 'A'.repeat(201) },
      { active: null },
      { description: 3 },
    ])('rejects invalid category data %j', async (change) => {
      const owner = await register();
      expect(
        (
          await auth(request(app).post(path(owner, 'categories')), owner).send({
            name: 'Category',
            ...change,
          })
        ).status,
      ).toBe(400);
      expect(await prisma.category.count()).toBe(0);
    });

    it('enforces SKU syntax and quantity scale CHECKs independently of HTTP', async () => {
      const owner = await register();
      const product = await create(owner, 'products');
      for (const sku of ['lowercase', 'WITH SPACE', '']) {
        await expect(
          prisma.product.update({ where: { id: product.id }, data: { sku } }),
        ).rejects.toThrow();
      }
      for (const quantityScale of [-1, 7]) {
        await expect(
          prisma.product.update({
            where: { id: product.id },
            data: { quantityScale },
          }),
        ).rejects.toThrow();
      }
      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
      ).toMatchObject({ sku: 'SKU-1', quantityScale: 0 });
    });

    it('normalizes warehouse codes, edits metadata and archives without deleting', async () => {
      const owner = await register();
      const warehouse = await create(owner, 'warehouses', {
        code: ' main-01 ',
        name: '  Main   warehouse ',
        description: 'Initial',
      });
      expect(warehouse).toMatchObject({
        code: 'MAIN-01',
        name: 'Main warehouse',
        active: true,
      });
      const update = await auth(
        request(app).patch(`${path(owner, 'warehouses')}/${warehouse.id}`),
        owner,
      ).send({
        code: 'north-02',
        name: 'North warehouse',
        description: null,
        active: false,
      });
      expect(update.status).toBe(200);
      expect(entity(update, 'warehouses')).toMatchObject({
        code: 'NORTH-02',
        name: 'North warehouse',
        description: null,
        active: false,
      });
      const list = await auth(
        request(app).get(path(owner, 'warehouses')),
        owner,
      );
      expect((list.body as { warehouses: Entity[] }).warehouses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: warehouse.id, active: false }),
        ]),
      );
      expect(
        (
          await auth(
            request(app).patch(`${path(owner, 'warehouses')}/${warehouse.id}`),
            owner,
          ).send({ active: true })
        ).status,
      ).toBe(200);
    });

    it('reserves warehouse codes per tenant including inactive rows and rejects bad codes', async () => {
      const a = await register();
      const b = await register();
      const warehouse = await create(a, 'warehouses');
      expect(
        (
          await auth(request(app).post(path(a, 'warehouses')), a).send({
            code: ' wh-1 ',
            name: 'Duplicate',
          })
        ).status,
      ).toBe(409);
      await auth(
        request(app).patch(`${path(a, 'warehouses')}/${warehouse.id}`),
        a,
      ).send({ active: false });
      expect(
        (
          await auth(request(app).post(path(a, 'warehouses')), a).send(
            validBody('warehouses'),
          )
        ).status,
      ).toBe(409);
      expect((await create(b, 'warehouses')).organizationId).toBe(
        b.organization.id,
      );
      for (const code of ['', 'WITH SPACE', 'É', 'A'.repeat(33)]) {
        expect(
          (
            await auth(request(app).post(path(a, 'warehouses')), a).send({
              code,
              name: 'Invalid',
            })
          ).status,
        ).toBe(400);
      }
      await expect(
        prisma.warehouse.update({
          where: { id: warehouse.id },
          data: { code: 'lowercase' },
        }),
      ).rejects.toThrow();
    });

    it.each(resources)(
      'isolates all %s reads and mutations across tenants and mixed IDs',
      async (resource) => {
        const a = await register();
        const b = await register();
        const item = await create(b, resource);
        expect(
          (await auth(request(app).get(path(b, resource)), a)).status,
        ).toBe(404);
        for (const owner of [a, b]) {
          expect(
            (
              await auth(
                request(app).get(`${path(owner, resource)}/${item.id}`),
                a,
              )
            ).status,
          ).toBe(404);
          expect(
            (
              await auth(
                request(app).patch(`${path(owner, resource)}/${item.id}`),
                a,
              ).send({ name: 'Stolen' })
            ).status,
          ).toBe(404);
        }
        expect(
          (
            await auth(request(app).post(path(b, resource)), a).send(
              validBody(resource),
            )
          ).status,
        ).toBe(404);
        const list = await auth(request(app).get(path(a, resource)), a);
        expect((list.body as Record<string, Entity[]>)[resource]).toEqual([]);
        const unchanged = await auth(
          request(app).get(`${path(b, resource)}/${item.id}`),
          b,
        );
        expect(entity(unchanged, resource).name).toBe(item.name);
      },
    );

    it.each(resources)(
      'rejects mass assignment, malformed resource IDs and hard delete for %s',
      async (resource) => {
        const owner = await register();
        const other = await register();
        const item = await create(owner, resource);
        expect(
          (
            await auth(request(app).post(path(owner, resource)), owner).send({
              ...validBody(resource),
              organizationId: other.organization.id,
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await auth(
              request(app).patch(`${path(owner, resource)}/${item.id}`),
              owner,
            ).send({ organizationId: other.organization.id })
          ).status,
        ).toBe(400);
        expect(
          (
            await auth(
              request(app).get(`${path(owner, resource)}/not-an-id`),
              owner,
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await auth(
              request(app).patch(`${path(owner, resource)}/not-an-id`),
              owner,
            ).send({ name: 'No' })
          ).status,
        ).toBe(404);
        expect(
          (
            await auth(
              request(app).delete(`${path(owner, resource)}/${item.id}`),
              owner,
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await auth(
              request(app).get(`${path(owner, resource)}/${item.id}`),
              owner,
            )
          ).status,
        ).toBe(200);
      },
    );

    it('applies OWNER/ADMIN write and MEMBER read-only permissions to all catalog modules', async () => {
      const owner = await register();
      const admin = await join(owner, 'ADMIN');
      const member = await join(owner, 'MEMBER');
      for (const resource of resources) {
        const created = await create(admin, resource);
        expect(
          (
            await auth(
              request(app).patch(`${path(owner, resource)}/${created.id}`),
              admin,
            ).send({ name: 'Admin edited' })
          ).status,
        ).toBe(200);
        expect(
          (await auth(request(app).get(path(owner, resource)), member)).status,
        ).toBe(200);
        expect(
          (
            await auth(
              request(app).get(`${path(owner, resource)}/${created.id}`),
              member,
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await auth(request(app).post(path(owner, resource)), member).send(
              validBody(resource),
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await auth(
              request(app).patch(`${path(owner, resource)}/${created.id}`),
              member,
            ).send({ active: false })
          ).status,
        ).toBe(403);
      }
    });

    it.each(resources)(
      'requires sessions, trusted origin and CSRF for %s',
      async (resource) => {
        const owner = await register();
        const item = await create(owner, resource);
        expect((await request(app).get(path(owner, resource))).status).toBe(
          401,
        );
        expect(
          (await request(app).get(`${path(owner, resource)}/${item.id}`))
            .status,
        ).toBe(401);
        expect(
          (
            await request(app)
              .post(path(owner, resource))
              .set('Origin', origin)
              .send(validBody(resource))
          ).status,
        ).toBe(401);
        expect(
          (
            await request(app)
              .patch(`${path(owner, resource)}/${item.id}`)
              .set('Origin', origin)
              .send({ active: false })
          ).status,
        ).toBe(401);
        expect(
          (
            await request(app)
              .post(path(owner, resource))
              .set('Cookie', owner.cookie)
              .set('Origin', origin)
              .send(validBody(resource))
          ).status,
        ).toBe(403);
        expect(
          (
            await auth(
              request(app).patch(`${path(owner, resource)}/${item.id}`),
              owner,
            )
              .set('X-CSRF-Token', 'wrong')
              .send({ active: false })
          ).status,
        ).toBe(403);
        expect(
          (
            await auth(request(app).post(path(owner, resource)), owner)
              .set('Origin', 'https://evil.example')
              .send(validBody(resource))
          ).status,
        ).toBe(403);
        expect(
          (
            await auth(
              request(app).get(`${path(owner, resource)}/${item.id}`),
              owner,
            )
          ).status,
        ).toBe(200);
      },
    );
  },
);
