import { pagination, page } from '../../pagination.js';
import type { Express, Request } from 'express';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { body, fail, validId, type Role } from '../../http.js';
import type { TenantContext } from '../../tenant.js';
import { categoryData, productData, warehouseData } from './validation.js';

function resourceId(request: Request) {
  const id = request.params.id;
  if (typeof id !== 'string' || !validId(id))
    return fail(404, 'NOT_FOUND', 'Resource not found');
  return id;
}
function editPermission(actor: { role: Role }) {
  if (actor.role === 'MEMBER')
    fail(403, 'FORBIDDEN', 'Insufficient permission');
}
function input(request: Request, keys: string[]) {
  const value = body(request, keys);
  if (Object.keys(value).length === 0)
    return fail(400, 'INVALID_INPUT', 'At least one field is required');
  return value;
}
async function categoryReference(
  tx: Prisma.TransactionClient,
  organizationId: string,
  categoryId: string | null,
  previousId?: string | null,
) {
  if (categoryId === null) return;
  const category = await tx.category.findFirst({
    where: { id: categoryId, organizationId },
  });
  if (!category) return fail(404, 'NOT_FOUND', 'Resource not found');
  if (!category.active && categoryId !== previousId)
    fail(409, 'INACTIVE_CATEGORY', 'Category is inactive');
}

export function registerCatalogRoutes(
  app: Express,
  { db, tenant, writeTenant }: TenantContext & { db: () => PrismaClient },
) {
  const prefix = '/api/organizations/:organizationId';
  const common = ['name', 'description', 'active'];

  app.get(`${prefix}/categories`, async (request, response) => {
    const { session } = await tenant(request);
    const { limit, offset } = pagination(request);
    const categories = await db().category.findMany({
      where: { organizationId: session.organizationId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      skip: offset,
    });
    response.json({
      categories: categories.slice(0, limit),
      ...page(categories, limit, offset),
    });
  });
  app.get(`${prefix}/categories/:id`, async (request, response) => {
    const { session } = await tenant(request);
    const category = await db().category.findFirst({
      where: {
        id: resourceId(request),
        organizationId: session.organizationId,
      },
    });
    if (!category) return fail(404, 'NOT_FOUND', 'Resource not found');
    response.json({ category });
  });
  app.post(`${prefix}/categories`, async (request, response) => {
    const fields = input(request, common);
    const category = await writeTenant(request, async (tx, actor) => {
      editPermission(actor);
      return tx.category.create({
        data: { organizationId: actor.organizationId, ...categoryData(fields) },
      });
    });
    response.status(201).json({ category });
  });
  app.patch(`${prefix}/categories/:id`, async (request, response) => {
    const fields = input(request, common);
    const category = await writeTenant(request, async (tx, actor) => {
      editPermission(actor);
      const current = await tx.category.findFirst({
        where: {
          id: resourceId(request),
          organizationId: actor.organizationId,
        },
      });
      if (!current) return fail(404, 'NOT_FOUND', 'Resource not found');
      return tx.category.update({
        where: {
          organizationId_id: {
            organizationId: actor.organizationId,
            id: current.id,
          },
        },
        data: categoryData(fields, current),
      });
    });
    response.json({ category });
  });

  app.get(`${prefix}/products`, async (request, response) => {
    const { session } = await tenant(request);
    const { limit, offset } = pagination(request);
    const products = await db().product.findMany({
      where: { organizationId: session.organizationId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      skip: offset,
    });
    response.json({
      products: products.slice(0, limit),
      ...page(products, limit, offset),
    });
  });
  app.get(`${prefix}/products/:id`, async (request, response) => {
    const { session } = await tenant(request);
    const product = await db().product.findFirst({
      where: {
        id: resourceId(request),
        organizationId: session.organizationId,
      },
    });
    if (!product) return fail(404, 'NOT_FOUND', 'Resource not found');
    response.json({ product });
  });
  app.post(`${prefix}/products`, async (request, response) => {
    const fields = input(request, [
      ...common,
      'sku',
      'categoryId',
      'unitOfMeasure',
      'quantityScale',
    ]);
    const product = await writeTenant(request, async (tx, actor) => {
      editPermission(actor);
      const data = productData(fields);
      await categoryReference(tx, actor.organizationId, data.categoryId);
      return tx.product.create({
        data: { organizationId: actor.organizationId, ...data },
      });
    });
    response.status(201).json({ product });
  });
  app.patch(`${prefix}/products/:id`, async (request, response) => {
    const fields = input(request, [
      ...common,
      'sku',
      'categoryId',
      'unitOfMeasure',
      'quantityScale',
    ]);
    const product = await writeTenant(request, async (tx, actor) => {
      editPermission(actor);
      const current = await tx.product.findFirst({
        where: {
          id: resourceId(request),
          organizationId: actor.organizationId,
        },
      });
      if (!current) return fail(404, 'NOT_FOUND', 'Resource not found');
      const data = productData(fields, current);
      if (
        (data.unitOfMeasure !== current.unitOfMeasure ||
          data.quantityScale !== current.quantityScale) &&
        ((await tx.inventoryThreshold.findFirst({
          where: {
            organizationId: actor.organizationId,
            productId: current.id,
          },
        })) ||
          (await tx.inventoryMovement.findFirst({
            where: {
              organizationId: actor.organizationId,
              productId: current.id,
            },
          })) ||
          (await tx.purchaseOrderLine.findFirst({
            where: {
              organizationId: actor.organizationId,
              productId: current.id,
            },
          })))
      )
        fail(
          409,
          'PRODUCT_HISTORY',
          'Unit and precision cannot change after inventory, order or threshold configuration',
        );
      if (
        !data.active &&
        (await tx.inventoryBalance.findFirst({
          where: {
            organizationId: actor.organizationId,
            productId: current.id,
            quantity: { gt: 0 },
          },
        }))
      )
        fail(
          409,
          'POSITIVE_STOCK',
          'Cannot deactivate a product with positive stock',
        );
      if (
        !data.active &&
        (await tx.purchaseOrderLine.findFirst({
          where: {
            organizationId: actor.organizationId,
            productId: current.id,
            purchaseOrder: {
              status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] },
            },
          },
        }))
      )
        fail(
          409,
          'OPEN_ORDER',
          'Cannot deactivate a product referenced by an open order',
        );
      await categoryReference(
        tx,
        actor.organizationId,
        data.categoryId,
        current.categoryId,
      );
      return tx.product.update({
        where: {
          organizationId_id: {
            organizationId: actor.organizationId,
            id: current.id,
          },
        },
        data,
      });
    });
    response.json({ product });
  });

  app.get(`${prefix}/warehouses`, async (request, response) => {
    const { session } = await tenant(request);
    const { limit, offset } = pagination(request);
    const warehouses = await db().warehouse.findMany({
      where: { organizationId: session.organizationId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      skip: offset,
    });
    response.json({
      warehouses: warehouses.slice(0, limit),
      ...page(warehouses, limit, offset),
    });
  });
  app.get(`${prefix}/warehouses/:id`, async (request, response) => {
    const { session } = await tenant(request);
    const warehouse = await db().warehouse.findFirst({
      where: {
        id: resourceId(request),
        organizationId: session.organizationId,
      },
    });
    if (!warehouse) return fail(404, 'NOT_FOUND', 'Resource not found');
    response.json({ warehouse });
  });
  app.post(`${prefix}/warehouses`, async (request, response) => {
    const fields = input(request, [...common, 'code']);
    const warehouse = await writeTenant(request, async (tx, actor) => {
      editPermission(actor);
      return tx.warehouse.create({
        data: {
          organizationId: actor.organizationId,
          ...warehouseData(fields),
        },
      });
    });
    response.status(201).json({ warehouse });
  });
  app.patch(`${prefix}/warehouses/:id`, async (request, response) => {
    const fields = input(request, [...common, 'code']);
    const warehouse = await writeTenant(request, async (tx, actor) => {
      editPermission(actor);
      const current = await tx.warehouse.findFirst({
        where: {
          id: resourceId(request),
          organizationId: actor.organizationId,
        },
      });
      if (!current) return fail(404, 'NOT_FOUND', 'Resource not found');
      if (
        fields.active === false &&
        (await tx.inventoryBalance.findFirst({
          where: {
            organizationId: actor.organizationId,
            warehouseId: current.id,
            quantity: { gt: 0 },
          },
        }))
      )
        fail(
          409,
          'POSITIVE_STOCK',
          'Cannot deactivate a warehouse with positive stock',
        );
      return tx.warehouse.update({
        where: {
          organizationId_id: {
            organizationId: actor.organizationId,
            id: current.id,
          },
        },
        data: warehouseData(fields, current),
      });
    });
    response.json({ warehouse });
  });
}
