import { pagination, page } from '../../pagination.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import {
  Prisma,
  type PrismaClient,
  type InventoryMovementType,
} from '../../generated/prisma/client.js';
import { body, fail, validId } from '../../http.js';
import type { TenantContext } from '../../tenant.js';
import { quantity, decimal, maxQuantity } from './decimal.js';
import { creditBalance } from './transaction.js';

export interface InventoryHooks {
  beforeBalance?: () => Promise<void>;
  afterBalance?: () => Promise<void>;
  beforeTransferBalance?: () => Promise<void>;
  afterTransferDebit?: () => Promise<void>;
}
const types: readonly InventoryMovementType[] = [
  'RECEIPT',
  'ISSUE',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'TRANSFER_IN',
  'TRANSFER_OUT',
];
const productSelect = {
  id: true,
  sku: true,
  name: true,
  unitOfMeasure: true,
} as const;
const warehouseSelect = { id: true, code: true, name: true } as const;
const movementInclude = {
  product: { select: productSelect },
  warehouse: { select: warehouseSelect },
  actor: { select: { id: true, displayName: true } },
} as const;
const balanceInclude = {
  product: { select: productSelect },
  warehouse: { select: warehouseSelect },
} as const;
function id(value: unknown) {
  if (typeof value !== 'string' || !validId(value))
    return fail(400, 'INVALID_INPUT', 'Invalid resource identifier');
  return value.toLowerCase();
}
function optionalText(
  value: unknown,
  max: number,
  reserved = false,
): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.trim().length > max ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    return fail(400, 'INVALID_INPUT', 'Invalid reference or reason');
  if (reserved && value.trim() === 'PURCHASE_RECEIPT')
    return fail(
      400,
      'INVALID_INPUT',
      'Purchase receipt references are reserved for receiving',
    );
  return value.trim() || null;
}
function serialize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  ) as T;
}
function movementDto(
  m: Prisma.InventoryMovementGetPayload<{ include: typeof movementInclude }>,
) {
  return serialize({
    ...m,
    quantity: m.quantity.toFixed(6),
    previousBalance: m.previousBalance.toFixed(6),
    resultingBalance: m.resultingBalance.toFixed(6),
    balanceVersion: m.balanceVersion.toString(),
  });
}
function balanceDto(
  b: Prisma.InventoryBalanceGetPayload<{ include: typeof balanceInclude }>,
) {
  return serialize({
    ...b,
    quantity: b.quantity.toFixed(6),
    version: b.version.toString(),
  });
}
function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    code?: unknown;
    meta?: {
      code?: unknown;
      driverAdapterError?: { cause?: { originalCode?: unknown } };
    };
  };
  return (
    e.code === 'P2034' ||
    e.code === '40001' ||
    e.code === '40P01' ||
    ['40001', '40P01'].includes(String(e.meta?.code)) ||
    ['40001', '40P01'].includes(
      String(e.meta?.driverAdapterError?.cause?.originalCode),
    )
  );
}
export function registerInventoryRoutes(
  app: Express,
  {
    db,
    tenant,
    now,
    hooks = {},
  }: TenantContext & {
    db: () => PrismaClient;
    now: () => Date;
    hooks?: InventoryHooks;
  },
) {
  const prefix = '/api/organizations/:organizationId/inventory';
  function filters(request: Request) {
    const allowed = [
      'productId',
      'warehouseId',
      'type',
      'from',
      'to',
      'limit',
      'offset',
    ];
    if (Object.keys(request.query).some((k) => !allowed.includes(k)))
      fail(400, 'INVALID_INPUT', 'Unknown inventory filter');
    const where: Prisma.InventoryMovementWhereInput = {};
    if (request.query.productId !== undefined)
      where.productId = id(request.query.productId);
    if (request.query.warehouseId !== undefined)
      where.warehouseId = id(request.query.warehouseId);
    if (request.query.type !== undefined) {
      if (!types.includes(request.query.type as InventoryMovementType))
        fail(400, 'INVALID_INPUT', 'Invalid movement type');
      where.type = request.query.type as InventoryMovementType;
    }
    const dates: { gte?: Date; lte?: Date } = {};
    for (const [key, op] of [
      ['from', 'gte'],
      ['to', 'lte'],
    ] as const) {
      const v = request.query[key];
      if (v !== undefined) {
        if (
          typeof v !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T/.test(v) ||
          !Number.isFinite(Date.parse(v))
        )
          fail(400, 'INVALID_INPUT', 'Invalid timestamp filter');
        dates[op] = new Date(v as string);
      }
    }
    if (dates.gte && dates.lte && dates.gte > dates.lte)
      fail(400, 'INVALID_INPUT', 'Invalid timestamp range');
    if (Object.keys(dates).length) where.createdAt = dates;
    return {
      where,
      ...pagination(request, [
        'productId',
        'warehouseId',
        'type',
        'from',
        'to',
      ]),
    };
  }
  app.get(`${prefix}/balances`, async (request, response) => {
    const { session } = await tenant(request);
    pagination(request, ['productId', 'warehouseId']);
    const { where, limit, offset } = filters(request);
    for (const [key, model] of [
      ['productId', 'product'],
      ['warehouseId', 'warehouse'],
    ] as const) {
      const resource = where[key];
      if (resource) {
        const where = {
          id: resource as string,
          organizationId: session.organizationId,
        };
        const found =
          model === 'product'
            ? await db().product.findFirst({ where })
            : await db().warehouse.findFirst({ where });
        if (!found) fail(404, 'NOT_FOUND', 'Resource not found');
      }
    }
    const rows = await db().inventoryBalance.findMany({
      where: {
        organizationId: session.organizationId,
        ...(where.productId ? { productId: where.productId as string } : {}),
        ...(where.warehouseId
          ? { warehouseId: where.warehouseId as string }
          : {}),
      },
      include: balanceInclude,
      orderBy: { id: 'asc' },
      take: limit + 1,
      skip: offset,
    });
    response.json({
      balances: rows.slice(0, limit).map(balanceDto),
      ...page(rows, limit, offset),
    });
  });
  app.get(`${prefix}/movements`, async (request, response) => {
    const { session } = await tenant(request);
    const { where, limit, offset } = filters(request);
    for (const [key, model] of [
      ['productId', 'product'],
      ['warehouseId', 'warehouse'],
    ] as const) {
      const resource = where[key];
      if (resource) {
        const where = {
          id: resource as string,
          organizationId: session.organizationId,
        };
        const found =
          model === 'product'
            ? await db().product.findFirst({ where })
            : await db().warehouse.findFirst({ where });
        if (!found) fail(404, 'NOT_FOUND', 'Resource not found');
      }
    }
    const rows = await db().inventoryMovement.findMany({
      where: { ...where, organizationId: session.organizationId },
      include: movementInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      skip: offset,
    });
    response.json({
      movements: rows.slice(0, limit).map(movementDto),
      ...page(rows, limit, offset),
    });
  });
  async function execute(
    request: Request,
    type: Exclude<InventoryMovementType, 'TRANSFER_IN' | 'TRANSFER_OUT'>,
    input: Record<string, unknown>,
  ) {
    const context = await tenant(request, true);
    const key = request.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      return fail(400, 'INVALID_INPUT', 'A valid Idempotency-Key is required');
    const productId = id(input.productId),
      warehouseId = id(input.warehouseId);
    const amount = quantity(input.quantity);
    const reason = optionalText(input.reason, 500),
      referenceType = optionalText(input.referenceType, 64, true),
      referenceId = optionalText(input.referenceId, 128);
    if (type.startsWith('ADJUSTMENT') && !reason)
      fail(400, 'INVALID_INPUT', 'An adjustment reason is required');
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          type,
          productId,
          warehouseId,
          quantity: decimal(amount),
          reason,
          referenceType,
          referenceId,
          actorId: context.session.userId,
        }),
      )
      .digest('hex');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db().$transaction(
          async (tx) => {
            const commandId = randomUUID();
            const claim = await tx.$queryRaw<
              { id: string }[]
            >`INSERT INTO "InventoryCommand" (id,"organizationId",type,key,"payloadHash","actorId") VALUES (${commandId}::uuid,${context.session.organizationId}::uuid,${type}::"InventoryCommandType",${key},${payloadHash},${context.session.userId}::uuid) ON CONFLICT ("organizationId",type,key) DO NOTHING RETURNING id`;
            await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${context.session.organizationId}::uuid FOR SHARE`;
            await tx.$queryRaw`SELECT id FROM "Membership" WHERE id=${context.membership.id}::uuid FOR SHARE`;
            const actor = await tx.membership.findUnique({
              where: { id: context.membership.id },
            });
            const session = await tx.session.findUnique({
              where: { id: context.session.id },
            });
            if (!actor || !session || session.expiresAt <= now())
              fail(401, 'UNAUTHENTICATED', 'Authentication required');
            await tx.$queryRaw`SELECT set_config('stockflow.actor_id', ${actor!.userId}, true)`;
            if (actor!.role === 'MEMBER')
              fail(403, 'FORBIDDEN', 'Insufficient permission');
            if (!claim.length) {
              const existing = await tx.inventoryCommand.findUnique({
                where: {
                  organizationId_type_key: {
                    organizationId: actor!.organizationId,
                    type,
                    key,
                  },
                },
              });
              if (
                !existing ||
                existing.payloadHash !== payloadHash ||
                !existing.response
              )
                return fail(
                  409,
                  'IDEMPOTENCY_CONFLICT',
                  'Idempotency key conflicts with another command',
                );
              return existing.response;
            }
            const product = await tx.product.findFirst({
              where: { id: productId, organizationId: actor!.organizationId },
            });
            const warehouse = await tx.warehouse.findFirst({
              where: { id: warehouseId, organizationId: actor!.organizationId },
            });
            if (!product || !warehouse)
              return fail(404, 'NOT_FOUND', 'Resource not found');
            if (!product.active || !warehouse.active)
              fail(
                409,
                'INACTIVE_RESOURCE',
                'Product and warehouse must be active',
              );
            quantity(input.quantity, product.quantityScale);
            await hooks.beforeBalance?.();
            const credit = type === 'RECEIPT' || type === 'ADJUSTMENT_IN';
            const rows = credit
              ? [
                  await creditBalance(
                    tx,
                    actor!.organizationId,
                    productId,
                    warehouseId,
                    amount,
                  ),
                ]
              : await tx.$queryRaw<
                  { quantity: Prisma.Decimal; version: bigint }[]
                >`UPDATE "InventoryBalance" SET quantity=quantity-${decimal(amount)}::numeric,version=version+1,"updatedAt"=NOW() WHERE "organizationId"=${actor!.organizationId}::uuid AND "productId"=${productId}::uuid AND "warehouseId"=${warehouseId}::uuid AND quantity>=${decimal(amount)}::numeric RETURNING quantity,version`;
            const updated = rows[0];
            if (!updated)
              return fail(
                409,
                credit ? 'QUANTITY_OVERFLOW' : 'INSUFFICIENT_STOCK',
                credit
                  ? 'Balance exceeds supported range'
                  : 'Insufficient stock',
              );
            await hooks.afterBalance?.();
            const result = BigInt(updated.quantity.toFixed(6).replace('.', ''));
            const movement = await tx.inventoryMovement.create({
              data: {
                organizationId: actor!.organizationId,
                productId,
                warehouseId,
                type,
                quantity: decimal(amount),
                previousBalance: decimal(
                  credit ? result - amount : result + amount,
                ),
                resultingBalance: decimal(result),
                balanceVersion: updated.version,
                actorId: actor!.userId,
                commandId,
                reason,
                referenceType,
                referenceId,
                idempotencyKey: key,
                correlationKey: commandId,
              },
              include: movementInclude,
            });
            const balance = await tx.inventoryBalance.findUniqueOrThrow({
              where: {
                organizationId_productId_warehouseId: {
                  organizationId: actor!.organizationId,
                  productId,
                  warehouseId,
                },
              },
              include: balanceInclude,
            });
            const response = serialize({
              movement: movementDto(movement),
              balance: balanceDto(balance),
            });
            await tx.inventoryCommand.update({
              where: { id: commandId },
              data: { response: response as unknown as Prisma.InputJsonValue },
            });
            return response;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 5000,
            timeout: 15000,
          },
        );
      } catch (error) {
        if (!retryable(error) || attempt === 2) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 10 + Math.floor(Math.random() * 30)),
        );
      }
    }
    return fail(503, 'RETRY_EXHAUSTED', 'Please retry the same command key');
  }
  app.post(`${prefix}/transfers`, async (request, response) => {
    const input = body(request, [
      'productId',
      'sourceWarehouseId',
      'destinationWarehouseId',
      'quantity',
      'reason',
      'referenceType',
      'referenceId',
    ]);
    const context = await tenant(request, true);
    const key = request.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      return fail(400, 'INVALID_INPUT', 'A valid Idempotency-Key is required');
    const productId = id(input.productId),
      sourceWarehouseId = id(input.sourceWarehouseId),
      destinationWarehouseId = id(input.destinationWarehouseId);
    if (sourceWarehouseId === destinationWarehouseId)
      return fail(400, 'INVALID_INPUT', 'Source and destination must differ');
    const amount = quantity(input.quantity);
    const reason = optionalText(input.reason, 500),
      referenceType = optionalText(input.referenceType, 64, true),
      referenceId = optionalText(input.referenceId, 128);
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          type: 'TRANSFER',
          productId,
          sourceWarehouseId,
          destinationWarehouseId,
          quantity: decimal(amount),
          reason,
          referenceType,
          referenceId,
          actorId: context.session.userId,
        }),
      )
      .digest('hex');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await db().$transaction(
          async (tx) => {
            const commandId = randomUUID();
            const organizationId = context.session.organizationId;
            const claim = await tx.$queryRaw<
              { id: string }[]
            >`INSERT INTO "InventoryCommand" (id,"organizationId",type,key,"payloadHash","actorId") VALUES (${commandId}::uuid,${organizationId}::uuid,'TRANSFER'::"InventoryCommandType",${key},${payloadHash},${context.session.userId}::uuid) ON CONFLICT ("organizationId",type,key) DO NOTHING RETURNING id`;
            await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${organizationId}::uuid FOR SHARE`;
            await tx.$queryRaw`SELECT id FROM "Membership" WHERE id=${context.membership.id}::uuid FOR SHARE`;
            const actor = await tx.membership.findUnique({
              where: { id: context.membership.id },
            });
            const session = await tx.session.findUnique({
              where: { id: context.session.id },
            });
            if (!actor || !session || session.expiresAt <= now())
              return fail(401, 'UNAUTHENTICATED', 'Authentication required');
            await tx.$queryRaw`SELECT set_config('stockflow.actor_id', ${actor.userId}, true)`;
            if (actor.role === 'MEMBER')
              return fail(403, 'FORBIDDEN', 'Insufficient permission');
            if (!claim.length) {
              const existing = await tx.inventoryCommand.findUnique({
                where: {
                  organizationId_type_key: {
                    organizationId,
                    type: 'TRANSFER',
                    key,
                  },
                },
              });
              if (
                !existing ||
                existing.payloadHash !== payloadHash ||
                !existing.response
              )
                return fail(
                  409,
                  'IDEMPOTENCY_CONFLICT',
                  'Idempotency key conflicts with another command',
                );
              return existing.response;
            }
            const product = await tx.product.findFirst({
              where: { id: productId, organizationId },
            });
            const warehouses = await tx.warehouse.findMany({
              where: {
                organizationId,
                id: { in: [sourceWarehouseId, destinationWarehouseId] },
              },
            });
            if (!product || warehouses.length !== 2)
              return fail(404, 'NOT_FOUND', 'Resource not found');
            if (!product.active || warehouses.some((w) => !w.active))
              return fail(
                409,
                'INACTIVE_RESOURCE',
                'Product and both warehouses must be active',
              );
            quantity(input.quantity, product.quantityScale);
            await hooks.beforeTransferBalance?.();
            // Every multi-balance writer creates/locks keys in the same UUID order.
            // INSERT itself can wait on a unique conflict, so it belongs in this order too.
            for (const warehouseId of [
              sourceWarehouseId,
              destinationWarehouseId,
            ].sort()) {
              await tx.$executeRaw`INSERT INTO "InventoryBalance" (id,"organizationId","productId","warehouseId",quantity,version,"updatedAt") VALUES (${randomUUID()}::uuid,${organizationId}::uuid,${productId}::uuid,${warehouseId}::uuid,0,0,NOW()) ON CONFLICT ("organizationId","productId","warehouseId") DO NOTHING`;
              await tx.$queryRaw`SELECT id FROM "InventoryBalance" WHERE "organizationId"=${organizationId}::uuid AND "productId"=${productId}::uuid AND "warehouseId"=${warehouseId}::uuid FOR UPDATE`;
            }
            const debit = await tx.$queryRaw<
              { quantity: Prisma.Decimal; version: bigint }[]
            >`UPDATE "InventoryBalance" SET quantity=quantity-${decimal(amount)}::numeric,version=version+1,"updatedAt"=NOW() WHERE "organizationId"=${organizationId}::uuid AND "productId"=${productId}::uuid AND "warehouseId"=${sourceWarehouseId}::uuid AND quantity>=${decimal(amount)}::numeric RETURNING quantity,version`;
            if (!debit[0])
              return fail(409, 'INSUFFICIENT_STOCK', 'Insufficient stock');
            await hooks.afterTransferDebit?.();
            const credit = await tx.$queryRaw<
              { quantity: Prisma.Decimal; version: bigint }[]
            >`UPDATE "InventoryBalance" SET quantity=quantity+${decimal(amount)}::numeric,version=version+1,"updatedAt"=NOW() WHERE "organizationId"=${organizationId}::uuid AND "productId"=${productId}::uuid AND "warehouseId"=${destinationWarehouseId}::uuid AND quantity+${decimal(amount)}::numeric<=${decimal(maxQuantity)}::numeric RETURNING quantity,version`;
            if (!credit[0])
              return fail(
                409,
                'QUANTITY_OVERFLOW',
                'Balance exceeds supported range',
              );
            const transfer = await tx.inventoryTransfer.create({
              data: {
                organizationId,
                productId,
                sourceWarehouseId,
                destinationWarehouseId,
                quantity: decimal(amount),
                actorId: actor.userId,
                commandId,
                idempotencyKey: key,
                reason,
                referenceType,
                referenceId,
              },
            });
            const movements = [];
            for (const [warehouseId, type, updated, isCredit] of [
              [sourceWarehouseId, 'TRANSFER_OUT', debit[0], false],
              [destinationWarehouseId, 'TRANSFER_IN', credit[0], true],
            ] as const) {
              const finalAmount = BigInt(
                updated.quantity.toFixed(6).replace('.', ''),
              );
              movements.push(
                await tx.inventoryMovement.create({
                  data: {
                    organizationId,
                    productId,
                    warehouseId,
                    type,
                    quantity: decimal(amount),
                    previousBalance: decimal(
                      isCredit ? finalAmount - amount : finalAmount + amount,
                    ),
                    resultingBalance: decimal(finalAmount),
                    balanceVersion: updated.version,
                    actorId: actor.userId,
                    commandId,
                    transferId: transfer.id,
                    reason,
                    referenceType,
                    referenceId,
                    idempotencyKey: key,
                    correlationKey: transfer.id,
                  },
                  include: movementInclude,
                }),
              );
            }
            const readBalance = (warehouseId: string) =>
              tx.inventoryBalance.findUniqueOrThrow({
                where: {
                  organizationId_productId_warehouseId: {
                    organizationId,
                    productId,
                    warehouseId,
                  },
                },
                include: balanceInclude,
              });
            const sourceBalance = await readBalance(sourceWarehouseId),
              destinationBalance = await readBalance(destinationWarehouseId);
            const response = serialize({
              transfer: { ...transfer, quantity: transfer.quantity.toFixed(6) },
              sourceBalance: balanceDto(sourceBalance),
              destinationBalance: balanceDto(destinationBalance),
              movements: movements.map(movementDto),
            });
            await tx.inventoryCommand.update({
              where: { id: commandId },
              data: { response: response as unknown as Prisma.InputJsonValue },
            });
            return response;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 5000,
            timeout: 15000,
          },
        );
        response.status(201).json(result);
        return;
      } catch (error) {
        if (!retryable(error) || attempt === 2) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 10 + Math.floor(Math.random() * 30)),
        );
      }
    }
  });

  for (const [path, type] of [
    ['receipts', 'RECEIPT'],
    ['issues', 'ISSUE'],
    ['adjustments', null],
  ] as const) {
    app.post(`${prefix}/${path}`, async (request, response) => {
      const input = body(request, [
        'productId',
        'warehouseId',
        'quantity',
        'reason',
        'referenceType',
        'referenceId',
        ...(path === 'adjustments' ? ['direction'] : []),
      ]);
      let resolved: Exclude<
        InventoryMovementType,
        'TRANSFER_IN' | 'TRANSFER_OUT'
      >;
      if (type) resolved = type;
      else if (input.direction === 'IN') resolved = 'ADJUSTMENT_IN';
      else if (input.direction === 'OUT') resolved = 'ADJUSTMENT_OUT';
      else
        return fail(
          400,
          'INVALID_INPUT',
          'Adjustment direction must be IN or OUT',
        );
      response.status(201).json(await execute(request, resolved, input));
    });
  }
}
