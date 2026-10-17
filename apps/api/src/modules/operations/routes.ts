import type { Express, Request } from 'express';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { TenantContext } from '../../tenant.js';
import { body, fail, validId } from '../../http.js';
import { pagination, page } from '../../pagination.js';
import { decimal, quantity } from '../inventory/decimal.js';
const uuid = (v: unknown) =>
  typeof v === 'string' && validId(v)
    ? v
    : fail(400, 'INVALID_INPUT', 'Invalid identifier');
function dates(request: Request) {
  const result: { gte?: Date; lte?: Date } = {};
  for (const [k, op] of [
    ['from', 'gte'],
    ['to', 'lte'],
  ] as const) {
    const v = request.query[k];
    if (v !== undefined) {
      if (
        typeof v !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T/.test(v) ||
        !Number.isFinite(Date.parse(v))
      )
        fail(400, 'INVALID_INPUT', 'Invalid timestamp');
      result[op] = new Date(v as string);
    }
  }
  if (result.gte && result.lte && result.gte > result.lte)
    fail(400, 'INVALID_INPUT', 'Invalid date range');
  return result;
}
const alertBase = Prisma.sql`FROM "InventoryThreshold" t JOIN "Product" p ON p.id=t."productId" AND p."organizationId"=t."organizationId" AND p.active JOIN "Warehouse" w ON w.id=t."warehouseId" AND w."organizationId"=t."organizationId" AND w.active LEFT JOIN "InventoryBalance" b ON b."organizationId"=t."organizationId" AND b."productId"=t."productId" AND b."warehouseId"=t."warehouseId"`;
const alertStatus = Prisma.sql`CASE WHEN COALESCE(b.quantity,0)=0 THEN 'OUT_OF_STOCK' WHEN b.quantity<t."minimumQuantity" THEN 'LOW' ELSE 'OK' END`;
type Alert = {
  id: string;
  productId: string;
  warehouseId: string;
  minimumQuantity: string;
  quantity: string;
  status: string;
  product: {
    id: string;
    sku: string;
    name: string;
    unitOfMeasure: string;
    quantityScale: number;
  };
  warehouse: { id: string; code: string; name: string };
};
export function registerOperationsRoutes(
  app: Express,
  {
    db,
    tenant,
    writeTenant,
    now,
  }: TenantContext & { db: () => PrismaClient; now: () => Date },
) {
  const prefix = '/api/organizations/:organizationId';
  app.put(`${prefix}/inventory/thresholds`, async (request, response) => {
    const input = body(request, [
      'productId',
      'warehouseId',
      'minimumQuantity',
    ]);
    const productId = uuid(input.productId),
      warehouseId = uuid(input.warehouseId);
    const threshold = await writeTenant(request, async (tx, actor) => {
      if (actor.role === 'MEMBER')
        fail(403, 'FORBIDDEN', 'Insufficient permission');
      const product = await tx.product.findFirst({
          where: { id: productId, organizationId: actor.organizationId },
        }),
        warehouse = await tx.warehouse.findFirst({
          where: { id: warehouseId, organizationId: actor.organizationId },
        });
      if (!product || !warehouse)
        return fail(404, 'NOT_FOUND', 'Resource not found');
      if (!product.active || !warehouse.active)
        fail(409, 'INACTIVE_RESOURCE', 'Resource is inactive');
      let minimumQuantity: string;
      if (
        typeof input.minimumQuantity === 'string' &&
        /^0(?:\.0{1,6})?$/.test(input.minimumQuantity)
      ) {
        if (
          (input.minimumQuantity.split('.')[1]?.length ?? 0) >
          product.quantityScale
        )
          fail(400, 'INVALID_QUANTITY', 'Quantity exceeds product precision');
        minimumQuantity = '0.000000';
      } else
        minimumQuantity = decimal(
          quantity(input.minimumQuantity, product.quantityScale),
        );
      return tx.inventoryThreshold.upsert({
        where: {
          organizationId_productId_warehouseId: {
            organizationId: actor.organizationId,
            productId,
            warehouseId,
          },
        },
        create: {
          organizationId: actor.organizationId,
          productId,
          warehouseId,
          minimumQuantity,
        },
        update: { minimumQuantity },
      });
    });
    response.json({
      threshold: {
        ...threshold,
        minimumQuantity: threshold.minimumQuantity.toFixed(6),
      },
    });
  });
  app.get(`${prefix}/inventory/alerts`, async (request, response) => {
    const { session } = await tenant(request);
    const { limit, offset } = pagination(request, [
      'productId',
      'warehouseId',
      'status',
    ]);
    const conditions = [
      Prisma.sql`t."organizationId"=${session.organizationId}::uuid`,
    ];
    for (const key of ['productId', 'warehouseId'] as const) {
      if (request.query[key] !== undefined) {
        const value = uuid(request.query[key]);
        conditions.push(
          key === 'productId'
            ? Prisma.sql`t."productId"=${value}::uuid`
            : Prisma.sql`t."warehouseId"=${value}::uuid`,
        );
      }
    }
    if (request.query.status !== undefined) {
      if (
        !['OK', 'LOW', 'OUT_OF_STOCK'].includes(request.query.status as string)
      )
        fail(400, 'INVALID_INPUT', 'Invalid alert status');
      conditions.push(
        Prisma.sql`(${alertStatus})=${request.query.status as string}`,
      );
    }
    const rows = await db().$queryRaw<Alert[]>(
      Prisma.sql`SELECT t.id,t."productId",t."warehouseId",t."minimumQuantity"::text AS "minimumQuantity",COALESCE(b.quantity,0)::numeric(20,6)::text AS quantity,${alertStatus} AS status,json_build_object('id',p.id,'sku',p.sku,'name',p.name,'unitOfMeasure',p."unitOfMeasure",'quantityScale',p."quantityScale") AS product,json_build_object('id',w.id,'code',w.code,'name',w.name) AS warehouse ${alertBase} WHERE ${Prisma.join(conditions, ' AND ')} ORDER BY t.id ASC LIMIT ${limit + 1} OFFSET ${offset}`,
    );
    response.json({
      alerts: rows.slice(0, limit),
      ...page(rows, limit, offset),
    });
  });
  app.get(`${prefix}/audit`, async (request, response) => {
    const { session, membership } = await tenant(request);
    if (membership.role === 'MEMBER')
      fail(403, 'FORBIDDEN', 'Insufficient permission');
    const { limit, offset } = pagination(request, [
      'actorId',
      'entityId',
      'entityType',
      'action',
      'from',
      'to',
    ]);
    const where: Prisma.AuditEventWhereInput = {
      organizationId: session.organizationId,
    };
    for (const k of ['actorId', 'entityId'] as const)
      if (request.query[k] !== undefined) where[k] = uuid(request.query[k]);
    for (const k of ['entityType', 'action'] as const)
      if (request.query[k] !== undefined) {
        const value = request.query[k];
        if (typeof value !== 'string' || !/^[A-Za-z_]{1,64}$/.test(value))
          fail(400, 'INVALID_INPUT', 'Invalid audit filter');
        where[k] = value as string;
      }
    const range = dates(request);
    if (Object.keys(range).length) where.createdAt = range;
    const events = await db().auditEvent.findMany({
      where,
      include: { actor: { select: { id: true, displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      skip: offset,
    });
    response.json({
      events: events.slice(0, limit),
      ...page(events, limit, offset),
    });
  });
  app.get(`${prefix}/dashboard`, async (request, response) => {
    const { session } = await tenant(request);
    pagination(request);
    if (Object.keys(request.query).length)
      fail(400, 'INVALID_INPUT', 'Dashboard does not accept pagination');
    const organizationId = session.organizationId,
      since = new Date(now().getTime() - 30 * 86400000);
    const dashboard = await db().$transaction(
      async (tx) => {
        const activeProducts = await tx.product.count({
            where: { organizationId, active: true },
          }),
          activeWarehouses = await tx.warehouse.count({
            where: { organizationId, active: true },
          });
        const [critical] = await tx.$queryRaw<{ low: number; out: number }[]>(
          Prisma.sql`SELECT (SELECT count(DISTINCT t."productId")::int ${alertBase} WHERE t."organizationId"=${organizationId}::uuid AND COALESCE(b.quantity,0)>0 AND b.quantity<t."minimumQuantity") AS low,(SELECT count(*)::int FROM "Product" p WHERE p."organizationId"=${organizationId}::uuid AND p.active AND NOT EXISTS(SELECT 1 FROM "InventoryBalance" b JOIN "Warehouse" w ON w.id=b."warehouseId" AND w."organizationId"=b."organizationId" AND w.active WHERE b."organizationId"=p."organizationId" AND b."productId"=p.id AND b.quantity>0)) AS out`,
        );
        const counts = await tx.purchaseOrder.groupBy({
          by: ['status'],
          where: { organizationId },
          _count: true,
        });
        const count = (status: string) =>
          counts.find((c) => c.status === status)?._count ?? 0;
        const recentReceived = await tx.purchaseOrder.count({
          where: {
            organizationId,
            status: 'RECEIVED',
            updatedAt: { gte: since },
          },
        });
        const recentMovements = await tx.inventoryMovement.findMany({
          where: { organizationId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 5,
          select: {
            id: true,
            type: true,
            quantity: true,
            createdAt: true,
            product: {
              select: { id: true, sku: true, name: true, unitOfMeasure: true },
            },
            warehouse: { select: { id: true, code: true, name: true } },
            actor: { select: { id: true, displayName: true } },
            correlationKey: true,
          },
        });
        const recentReceipts = await tx.purchaseReceipt.findMany({
          where: { organizationId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 5,
          select: {
            id: true,
            purchaseOrderId: true,
            warehouseId: true,
            createdAt: true,
            actor: { select: { id: true, displayName: true } },
            warehouse: { select: { id: true, code: true, name: true } },
          },
        });
        return {
          asOf: now().toISOString(),
          activeProducts,
          activeWarehouses,
          lowStockProducts: critical!.low,
          outOfStockProducts: critical!.out,
          purchaseOrders: {
            DRAFT: count('DRAFT'),
            SENT: count('SENT'),
            PARTIALLY_RECEIVED: count('PARTIALLY_RECEIVED'),
            recentReceived,
          },
          recentMovements: recentMovements.map((m) => ({
            ...m,
            quantity: m.quantity.toFixed(6),
          })),
          recentReceipts,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    response.json({ dashboard });
  });
}
