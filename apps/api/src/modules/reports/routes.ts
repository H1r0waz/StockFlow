import type { Express, Request } from 'express';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { TenantContext } from '../../tenant.js';
import { fail, validId } from '../../http.js';
import { pagination, page } from '../../pagination.js';
import { serializeCsv, type ReportRow } from './csv.js';

const definitions = {
  products: {
    columns: [
      'ID',
      'SKU',
      'Product',
      'Category',
      'Unit',
      'Precision',
      'Active',
    ],
    select: Prisma.sql`p.id::text AS "ID", p.sku AS "SKU", p.name AS "Product", c.name AS "Category", p."unitOfMeasure"::text AS "Unit", p."quantityScale"::text AS "Precision", p.active::text AS "Active"`,
    from: Prisma.sql`"Product" p LEFT JOIN "Category" c ON c.id=p."categoryId" AND c."organizationId"=p."organizationId"`,
    filters: {
      active: Prisma.sql`p.active::text`,
      categoryId: Prisma.sql`p."categoryId"::text`,
    },
    order: Prisma.sql`p.sku,p.id`,
  },
  suppliers: {
    columns: ['ID', 'Supplier', 'Active'],
    select: Prisma.sql`p.id::text AS "ID", p.name AS "Supplier", p.active::text AS "Active"`,
    from: Prisma.sql`"Supplier" p`,
    filters: { active: Prisma.sql`p.active::text` },
    order: Prisma.sql`p.name,p.id`,
  },
  inventory: {
    columns: [
      'SKU',
      'Product',
      'Warehouse code',
      'Warehouse',
      'Quantity',
      'Unit',
    ],
    select: Prisma.sql`product.sku AS "SKU", product.name AS "Product", w.code AS "Warehouse code", w.name AS "Warehouse", p.quantity::text AS "Quantity", product."unitOfMeasure"::text AS "Unit"`,
    from: Prisma.sql`"InventoryBalance" p JOIN "Product" product ON product.id=p."productId" AND product."organizationId"=p."organizationId" JOIN "Warehouse" w ON w.id=p."warehouseId" AND w."organizationId"=p."organizationId"`,
    filters: {
      productId: Prisma.sql`p."productId"::text`,
      warehouseId: Prisma.sql`p."warehouseId"::text`,
    },
    order: Prisma.sql`product.sku,w.code,p.id`,
  },
  movements: {
    columns: [
      'ID',
      'Date',
      'SKU',
      'Product',
      'Warehouse',
      'Type',
      'Quantity',
      'Unit',
      'Previous balance',
      'Resulting balance',
      'Actor',
    ],
    select: Prisma.sql`p.id::text AS "ID", p."createdAt" AS "Date", product.sku AS "SKU", product.name AS "Product", w.name AS "Warehouse", p.type::text AS "Type", p.quantity::text AS "Quantity", product."unitOfMeasure"::text AS "Unit", p."previousBalance"::text AS "Previous balance", p."resultingBalance"::text AS "Resulting balance", actor."displayName" AS "Actor"`,
    from: Prisma.sql`"InventoryMovement" p JOIN "Product" product ON product.id=p."productId" AND product."organizationId"=p."organizationId" JOIN "Warehouse" w ON w.id=p."warehouseId" AND w."organizationId"=p."organizationId" JOIN "User" actor ON actor.id=p."actorId"`,
    filters: {
      productId: Prisma.sql`p."productId"::text`,
      warehouseId: Prisma.sql`p."warehouseId"::text`,
      type: Prisma.sql`p.type::text`,
      from: Prisma.sql`p."createdAt"`,
      to: Prisma.sql`p."createdAt"`,
    },
    order: Prisma.sql`p."createdAt" DESC,p.id DESC`,
  },
  'purchase-orders': {
    columns: ['ID', 'Date', 'Supplier', 'Status'],
    select: Prisma.sql`p.id::text AS "ID", p."createdAt" AS "Date", s.name AS "Supplier", p.status::text AS "Status"`,
    from: Prisma.sql`"PurchaseOrder" p JOIN "Supplier" s ON s.id=p."supplierId" AND s."organizationId"=p."organizationId"`,
    filters: {
      status: Prisma.sql`p.status::text`,
      supplierId: Prisma.sql`p."supplierId"::text`,
      from: Prisma.sql`p."createdAt"`,
      to: Prisma.sql`p."createdAt"`,
    },
    order: Prisma.sql`p."createdAt" DESC,p.id DESC`,
  },
  receipts: {
    columns: ['ID', 'Date', 'Purchase order', 'Warehouse', 'Actor'],
    select: Prisma.sql`p.id::text AS "ID", p."createdAt" AS "Date", p."purchaseOrderId"::text AS "Purchase order", w.name AS "Warehouse", actor."displayName" AS "Actor"`,
    from: Prisma.sql`"PurchaseReceipt" p JOIN "Warehouse" w ON w.id=p."warehouseId" AND w."organizationId"=p."organizationId" JOIN "User" actor ON actor.id=p."actorId"`,
    filters: {
      warehouseId: Prisma.sql`p."warehouseId"::text`,
      purchaseOrderId: Prisma.sql`p."purchaseOrderId"::text`,
      from: Prisma.sql`p."createdAt"`,
      to: Prisma.sql`p."createdAt"`,
    },
    order: Prisma.sql`p."createdAt" DESC,p.id DESC`,
  },
  audit: {
    columns: ['ID', 'Date', 'Actor', 'Action', 'Entity type', 'Entity ID'],
    select: Prisma.sql`p.id::text AS "ID", p."createdAt" AS "Date", actor."displayName" AS "Actor", p.action AS "Action", p."entityType" AS "Entity type", p."entityId"::text AS "Entity ID"`,
    from: Prisma.sql`"AuditEvent" p LEFT JOIN "User" actor ON actor.id=p."actorId"`,
    filters: {
      actorId: Prisma.sql`p."actorId"::text`,
      entityId: Prisma.sql`p."entityId"::text`,
      entityType: Prisma.sql`p."entityType"`,
      action: Prisma.sql`p.action`,
      from: Prisma.sql`p."createdAt"`,
      to: Prisma.sql`p."createdAt"`,
    },
    order: Prisma.sql`p."createdAt" DESC,p.id DESC`,
  },
  alerts: {
    columns: [
      'SKU',
      'Product',
      'Warehouse',
      'Quantity',
      'Minimum',
      'Unit',
      'Status',
    ],
    select: Prisma.sql`product.sku AS "SKU", product.name AS "Product", w.name AS "Warehouse", COALESCE(b.quantity,0)::numeric(20,6)::text AS "Quantity", p."minimumQuantity"::text AS "Minimum", product."unitOfMeasure"::text AS "Unit", CASE WHEN COALESCE(b.quantity,0)=0 THEN 'OUT_OF_STOCK' WHEN b.quantity<p."minimumQuantity" THEN 'LOW' ELSE 'OK' END AS "Status"`,
    from: Prisma.sql`"InventoryThreshold" p JOIN "Product" product ON product.id=p."productId" AND product."organizationId"=p."organizationId" AND product.active JOIN "Warehouse" w ON w.id=p."warehouseId" AND w."organizationId"=p."organizationId" AND w.active LEFT JOIN "InventoryBalance" b ON b."organizationId"=p."organizationId" AND b."productId"=p."productId" AND b."warehouseId"=p."warehouseId"`,
    filters: {
      productId: Prisma.sql`p."productId"::text`,
      warehouseId: Prisma.sql`p."warehouseId"::text`,
      status: Prisma.sql`CASE WHEN COALESCE(b.quantity,0)=0 THEN 'OUT_OF_STOCK' WHEN b.quantity<p."minimumQuantity" THEN 'LOW' ELSE 'OK' END`,
    },
    order: Prisma.sql`product.sku,w.code,p.id`,
  },
} as const;

function bounds(request: Request, filters: string[], exporting: boolean) {
  if (!exporting) return pagination(request, filters);
  if (
    Object.keys(request.query).some(
      (key) => !['limit', 'offset', ...filters].includes(key),
    )
  )
    fail(400, 'INVALID_INPUT', 'Unknown query filter');
  const limit = request.query.limit ?? '1000',
    offset = request.query.offset ?? '0';
  if (
    typeof limit !== 'string' ||
    !/^[1-9][0-9]{0,3}$/.test(limit) ||
    Number(limit) > 2000 ||
    typeof offset !== 'string' ||
    !/^(0|[1-9][0-9]{0,6})$/.test(offset) ||
    Number(offset) > 1_000_000
  )
    fail(400, 'INVALID_INPUT', 'Invalid pagination');
  return { limit: Number(limit), offset: Number(offset) };
}

function filterValue(key: string, raw: unknown, type: string): string | Date {
  if (typeof raw !== 'string')
    return fail(400, 'INVALID_INPUT', 'Invalid report filter');
  if (key.endsWith('Id')) {
    if (!validId(raw)) fail(400, 'INVALID_INPUT', 'Invalid identifier');
    return raw.toLowerCase();
  } else if (key === 'active') {
    if (!['true', 'false'].includes(raw))
      fail(400, 'INVALID_INPUT', 'Invalid active filter');
  } else if (key === 'from' || key === 'to') {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(Date.parse(raw)))
      fail(400, 'INVALID_INPUT', 'Invalid timestamp');
    return new Date(raw);
  } else if (key === 'status') {
    const allowed =
      type === 'alerts'
        ? ['OK', 'LOW', 'OUT_OF_STOCK']
        : ['DRAFT', 'SENT', 'CANCELLED', 'PARTIALLY_RECEIVED', 'RECEIVED'];
    if (!allowed.includes(raw)) fail(400, 'INVALID_INPUT', 'Invalid status');
  } else if (key === 'type') {
    if (
      ![
        'RECEIPT',
        'ISSUE',
        'ADJUSTMENT_IN',
        'ADJUSTMENT_OUT',
        'TRANSFER_IN',
        'TRANSFER_OUT',
      ].includes(raw)
    )
      fail(400, 'INVALID_INPUT', 'Invalid movement type');
  } else if (!/^[A-Za-z_]{1,64}$/.test(raw))
    fail(400, 'INVALID_INPUT', 'Invalid report filter');
  return raw;
}

export function registerReportRoutes(
  app: Express,
  { db, tenant }: TenantContext & { db: () => PrismaClient },
) {
  for (const exporting of [false, true])
    app.get(
      `/api/organizations/:organizationId/${exporting ? 'exports' : 'reports'}/:type`,
      async (request, response) => {
        const context = await tenant(request),
          type = request.params.type as string;
        if (!Object.hasOwn(definitions, type))
          return fail(404, 'NOT_FOUND', 'Report not found');
        if (type === 'audit' && context.membership.role === 'MEMBER')
          return fail(403, 'FORBIDDEN', 'Insufficient permission');
        const definition = definitions[type as keyof typeof definitions];
        const { limit, offset } = bounds(
          request,
          Object.keys(definition.filters),
          exporting,
        );
        const conditions: Prisma.Sql[] = [
          Prisma.sql`p."organizationId"=${context.session.organizationId}::uuid`,
        ];
        let from: Date | undefined, to: Date | undefined;
        for (const [key, column] of Object.entries(definition.filters)) {
          if (request.query[key] === undefined) continue;
          const value = filterValue(key, request.query[key], type);
          if (key === 'from') {
            from = value as Date;
            conditions.push(Prisma.sql`${column}>=${value}`);
          } else if (key === 'to') {
            to = value as Date;
            conditions.push(Prisma.sql`${column}<=${value}`);
          } else conditions.push(Prisma.sql`${column}=${value}`);
        }
        if (from && to && from > to)
          fail(400, 'INVALID_INPUT', 'Invalid date range');
        const result = await db().$queryRaw<
          Record<string, string | Date | null>[]
        >(
          Prisma.sql`SELECT ${definition.select} FROM ${definition.from} WHERE ${Prisma.join(conditions, ' AND ')} ORDER BY ${definition.order} LIMIT ${limit + 1} OFFSET ${offset}`,
        );
        const rows: ReportRow[] = result
          .slice(0, limit)
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                value instanceof Date ? value.toISOString() : value,
              ]),
            ),
          );
        const paging = page(result, limit, offset);
        if (exporting) {
          response
            .set('Content-Type', 'text/csv; charset=utf-8')
            .set(
              'Content-Disposition',
              `attachment; filename="stockflow-${type}.csv"`,
            )
            .set('Cache-Control', 'no-store')
            .set('X-Content-Type-Options', 'nosniff')
            .set('X-Has-More', String(paging.hasMore))
            .set(
              'X-Next-Offset',
              paging.nextOffset === null ? '' : String(paging.nextOffset),
            )
            .send(serializeCsv([...definition.columns], rows));
        } else
          response
            .set('Cache-Control', 'no-store')
            .json({ columns: definition.columns, rows, ...paging });
      },
    );
}
