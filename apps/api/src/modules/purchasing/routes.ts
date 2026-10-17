import { pagination, page } from '../../pagination.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import type {
  Prisma,
  PrismaClient,
  PurchasingCommandType,
} from '../../generated/prisma/client.js';
import { body, fail, validId, type Role } from '../../http.js';
import type { TenantContext } from '../../tenant.js';
import { decimal, quantity } from '../inventory/decimal.js';
import { creditBalance } from '../inventory/transaction.js';

export interface PurchasingHooks {
  beforeWrite?: () => Promise<void>;
  afterDraftLines?: () => Promise<void>;
  afterReceiptStock?: () => Promise<void>;
}
const include = {
  supplier: { select: { id: true, name: true, active: true } },
  creator: { select: { id: true, displayName: true } },
  lines: {
    include: {
      product: {
        select: { id: true, sku: true, name: true, unitOfMeasure: true },
      },
    },
    orderBy: { id: 'asc' as const },
  },
} as const;
type Order = Prisma.PurchaseOrderGetPayload<{ include: typeof include }>;
const receiptInclude = {
  warehouse: { select: { id: true, code: true, name: true } },
  actor: { select: { id: true, displayName: true } },
  lines: {
    include: {
      product: {
        select: { id: true, sku: true, name: true, unitOfMeasure: true },
      },
      inventoryMovement: {
        select: {
          id: true,
          referenceType: true,
          referenceId: true,
          correlationKey: true,
        },
      },
    },
    orderBy: { id: 'asc' as const },
  },
} as const;
function receiptDto(
  receipt: Prisma.PurchaseReceiptGetPayload<{ include: typeof receiptInclude }>,
) {
  return JSON.parse(
    JSON.stringify({
      ...receipt,
      lines: receipt.lines.map((line) => ({
        ...line,
        receivedQuantity: line.receivedQuantity.toFixed(6),
        inventoryMovementId: line.inventoryMovement?.id ?? null,
      })),
    }),
  ) as Prisma.InputJsonObject;
}
function dto(order: Order) {
  return JSON.parse(
    JSON.stringify({
      ...order,
      lines: order.lines.map((line) => ({
        ...line,
        orderedQuantity: line.orderedQuantity.toFixed(6),
        receivedQuantity: line.receivedQuantity.toFixed(6),
        remainingQuantity: line.orderedQuantity
          .minus(line.receivedQuantity)
          .toFixed(6),
        pendingQuantity:
          order.status === 'CANCELLED'
            ? '0.000000'
            : line.orderedQuantity.minus(line.receivedQuantity).toFixed(6),
        cancelledQuantity:
          order.status === 'CANCELLED'
            ? line.orderedQuantity.minus(line.receivedQuantity).toFixed(6)
            : '0.000000',
      })),
    }),
  ) as Prisma.InputJsonObject;
}
function id(value: unknown, resource = false): string {
  if (typeof value !== 'string' || !validId(value))
    return fail(
      resource ? 404 : 400,
      resource ? 'NOT_FOUND' : 'INVALID_INPUT',
      'Invalid resource identifier',
    );
  return value.toLowerCase();
}
function optional(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.trim().length > max ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    return fail(400, 'INVALID_INPUT', 'Invalid text field');
  return value.trim() || null;
}
function required(value: unknown, max: number): string {
  return (
    optional(value, max) ?? fail(400, 'INVALID_INPUT', 'Required text field')
  );
}
function permission(actor: { role: Role }) {
  if (actor.role === 'MEMBER')
    fail(403, 'FORBIDDEN', 'Insufficient permission');
}
function draftInput(request: Request) {
  const fields = body(request, ['supplierId', 'notes', 'lines']);
  if (
    !Array.isArray(fields.lines) ||
    fields.lines.length === 0 ||
    fields.lines.length > 100
  )
    return fail(400, 'INVALID_INPUT', 'Orders require 1–100 lines');
  const lines = fields.lines
    .map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        return fail(400, 'INVALID_INPUT', 'Invalid order line');
      const line = entry as Record<string, unknown>;
      if (
        Object.keys(line).some(
          (k) => !['productId', 'orderedQuantity'].includes(k),
        )
      )
        return fail(400, 'INVALID_INPUT', 'Unexpected line field');
      return {
        productId: id(line.productId),
        orderedQuantity: decimal(quantity(line.orderedQuantity)),
      };
    })
    .sort((a, b) => a.productId.localeCompare(b.productId));
  if (new Set(lines.map((l) => l.productId)).size !== lines.length)
    return fail(
      400,
      'INVALID_INPUT',
      'Duplicate products must be consolidated',
    );
  return {
    supplierId: id(fields.supplierId),
    notes: optional(fields.notes, 2000),
    lines,
  };
}
function supplierInput(request: Request, create: boolean) {
  const fields = body(request, [
    'name',
    'legalName',
    'taxId',
    'email',
    'phone',
    'notes',
    'active',
  ]);
  if (Object.keys(fields).length === 0)
    return fail(400, 'INVALID_INPUT', 'At least one field is required');
  const data: {
    name?: string;
    legalName?: string | null;
    taxId?: string | null;
    email?: string | null;
    phone?: string | null;
    notes?: string | null;
    active?: boolean;
  } = {};
  if (create || fields.name !== undefined)
    data.name = required(fields.name, 200);
  for (const [key, max] of [
    ['legalName', 200],
    ['taxId', 100],
    ['email', 254],
    ['phone', 100],
    ['notes', 2000],
  ] as const) {
    if (fields[key] !== undefined) data[key] = optional(fields[key], max);
  }
  if (data.email) {
    data.email = data.email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
      fail(400, 'INVALID_INPUT', 'Invalid email');
  }
  if (fields.active !== undefined) {
    if (typeof fields.active !== 'boolean')
      fail(400, 'INVALID_INPUT', 'Invalid active flag');
    data.active = fields.active as boolean;
  }
  return data;
}
export function registerPurchasingRoutes(
  app: Express,
  {
    db,
    tenant,
    writeTenant,
    hooks = {},
  }: TenantContext & { db: () => PrismaClient; hooks?: PurchasingHooks },
) {
  const prefix = '/api/organizations/:organizationId';
  async function write<T>(
    request: Request,
    fn: Parameters<typeof writeTenant<T>>[1],
  ) {
    await hooks.beforeWrite?.();
    return writeTenant(request, async (tx, actor) => {
      permission(actor);
      return fn(tx, actor);
    });
  }
  async function findOrder(
    tx: Prisma.TransactionClient,
    organizationId: string,
    orderId: string,
    lock = false,
  ) {
    if (lock)
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id=${orderId}::uuid AND "organizationId"=${organizationId}::uuid FOR UPDATE`;
    const order = await tx.purchaseOrder.findFirst({
      where: { id: orderId, organizationId },
      include,
    });
    return order ?? fail(404, 'NOT_FOUND', 'Resource not found');
  }
  async function validateParents(
    tx: Prisma.TransactionClient,
    organizationId: string,
    data: ReturnType<typeof draftInput>,
  ) {
    const supplier = await tx.supplier.findFirst({
      where: { id: data.supplierId, organizationId },
    });
    if (!supplier) return fail(404, 'NOT_FOUND', 'Resource not found');
    if (!supplier.active)
      fail(409, 'INACTIVE_SUPPLIER', 'Supplier is inactive');
    for (const line of data.lines) {
      const product = await tx.product.findFirst({
        where: { id: line.productId, organizationId },
      });
      if (!product) return fail(404, 'NOT_FOUND', 'Resource not found');
      if (!product.active) fail(409, 'INACTIVE_PRODUCT', 'Product is inactive');
      // Already normalized to six places: inspect exact multiples, not lexical padding.
      const units = quantity(line.orderedQuantity);
      if (units % 10n ** BigInt(6 - product.quantityScale) !== 0n)
        fail(400, 'INVALID_QUANTITY', 'Quantity exceeds product precision');
    }
  }
  async function command(
    request: Request,
    type: PurchasingCommandType,
    payload: unknown,
    action: (
      tx: Prisma.TransactionClient,
      organizationId: string,
      userId: string,
    ) => Promise<Order>,
  ) {
    const key = request.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      return fail(400, 'INVALID_INPUT', 'Valid Idempotency-Key is required');
    return write(request, async (tx, actor) => {
      const payloadHash = createHash('sha256')
        .update(JSON.stringify({ actor: actor.userId, payload }))
        .digest('hex');
      const existing = await tx.purchasingCommand.findUnique({
        where: {
          organizationId_type_key: {
            organizationId: actor.organizationId,
            type,
            key,
          },
        },
      });
      if (existing) {
        if (
          existing.payloadHash !== payloadHash ||
          existing.actorId !== actor.userId
        )
          return fail(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was used for a different request',
          );
        return existing.response;
      }
      const result = {
        purchaseOrder: dto(
          await action(tx, actor.organizationId, actor.userId),
        ),
      };
      await tx.purchasingCommand.create({
        data: {
          organizationId: actor.organizationId,
          type,
          key,
          payloadHash,
          actorId: actor.userId,
          response: result,
        },
      });
      return result;
    });
  }
  app.get(
    `${prefix}/purchase-orders/:id/receipts`,
    async (request, response) => {
      const { session } = await tenant(request);
      const orderId = id(request.params.id, true);
      await findOrder(db(), session.organizationId, orderId);
      const { limit, offset } = pagination(request);
      const receipts = await db().purchaseReceipt.findMany({
        where: {
          organizationId: session.organizationId,
          purchaseOrderId: orderId,
        },
        include: receiptInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        skip: offset,
      });
      response.json({
        receipts: receipts.slice(0, limit).map(receiptDto),
        ...page(receipts, limit, offset),
      });
    },
  );
  app.get(
    `${prefix}/purchase-orders/:id/receipts/:receiptId`,
    async (request, response) => {
      const { session } = await tenant(request);
      const receipt = await db().purchaseReceipt.findFirst({
        where: {
          organizationId: session.organizationId,
          purchaseOrderId: id(request.params.id, true),
          id: id(request.params.receiptId, true),
        },
        include: receiptInclude,
      });
      if (!receipt) return fail(404, 'NOT_FOUND', 'Resource not found');
      response.json({ receipt: receiptDto(receipt) });
    },
  );
  app.post(
    `${prefix}/purchase-orders/:id/receipts`,
    async (request, response) => {
      const fields = body(request, ['warehouseId', 'lines']);
      const orderId = id(request.params.id, true);
      const warehouseId = id(fields.warehouseId);
      if (
        !Array.isArray(fields.lines) ||
        !fields.lines.length ||
        fields.lines.length > 100
      )
        return fail(400, 'INVALID_INPUT', 'Receipts require 1–100 lines');
      const lines = fields.lines
        .map((entry: unknown) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return fail(400, 'INVALID_INPUT', 'Invalid receipt line');
          const line = entry as Record<string, unknown>;
          if (
            Object.keys(line).some(
              (k) => !['purchaseOrderLineId', 'quantity'].includes(k),
            )
          )
            return fail(400, 'INVALID_INPUT', 'Unexpected receipt line field');
          return {
            purchaseOrderLineId: id(line.purchaseOrderLineId),
            quantity: decimal(quantity(line.quantity)),
          };
        })
        .sort((a, b) =>
          a.purchaseOrderLineId.localeCompare(b.purchaseOrderLineId),
        );
      if (
        new Set(lines.map((l) => l.purchaseOrderLineId)).size !== lines.length
      )
        return fail(400, 'INVALID_INPUT', 'Duplicate receipt lines');
      const key = request.get('Idempotency-Key');
      if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
        return fail(400, 'INVALID_INPUT', 'Valid Idempotency-Key is required');
      const result = await write(request, async (tx, actor) => {
        const payloadHash = createHash('sha256')
          .update(
            JSON.stringify({
              actor: actor.userId,
              orderId,
              warehouseId,
              lines,
            }),
          )
          .digest('hex');
        const existing = await tx.purchasingCommand.findUnique({
          where: {
            organizationId_type_key: {
              organizationId: actor.organizationId,
              type: 'RECEIVE',
              key,
            },
          },
        });
        if (existing) {
          if (
            existing.payloadHash !== payloadHash ||
            existing.actorId !== actor.userId
          )
            return fail(
              409,
              'IDEMPOTENCY_CONFLICT',
              'Idempotency key was used for a different request',
            );
          return existing.response;
        }
        const current = await findOrder(
          tx,
          actor.organizationId,
          orderId,
          true,
        );
        if (
          current.status !== 'SENT' &&
          current.status !== 'PARTIALLY_RECEIVED'
        )
          return fail(
            409,
            'INVALID_STATE',
            'Only sent or partially received orders can receive',
          );
        await tx.$queryRaw`SELECT id FROM "PurchaseOrderLine" WHERE "organizationId"=${actor.organizationId}::uuid AND "purchaseOrderId"=${orderId}::uuid ORDER BY id FOR UPDATE`;
        const warehouse = await tx.warehouse.findFirst({
          where: { id: warehouseId, organizationId: actor.organizationId },
        });
        if (!warehouse) return fail(404, 'NOT_FOUND', 'Resource not found');
        if (!warehouse.active)
          return fail(409, 'INACTIVE_RESOURCE', 'Warehouse must be active');
        if (!current.supplier.active)
          return fail(409, 'INACTIVE_SUPPLIER', 'Supplier must be active');
        const selected = lines
          .map((line) => {
            const orderLine = current.lines.find(
              (l) => l.id === line.purchaseOrderLineId,
            );
            if (!orderLine) return fail(404, 'NOT_FOUND', 'Resource not found');
            const amount = quantity(line.quantity);
            if (
              orderLine.orderedQuantity
                .minus(orderLine.receivedQuantity)
                .lessThan(line.quantity)
            )
              return fail(
                409,
                'OVER_RECEIPT',
                'Receipt exceeds pending quantity',
              );
            return { ...line, orderLine, amount };
          })
          .sort((a, b) =>
            a.orderLine.productId.localeCompare(b.orderLine.productId),
          );
        for (const line of selected) {
          const product = await tx.product.findFirst({
            where: {
              id: line.orderLine.productId,
              organizationId: actor.organizationId,
            },
          });
          if (!product) return fail(404, 'NOT_FOUND', 'Resource not found');
          if (!product.active)
            return fail(409, 'INACTIVE_RESOURCE', 'Product must be active');
          if (line.amount % 10n ** BigInt(6 - product.quantityScale) !== 0n)
            return fail(
              400,
              'INVALID_QUANTITY',
              'Quantity exceeds product precision',
            );
        }
        const receiptId = randomUUID(),
          purchasingCommandId = randomUUID();
        await tx.purchaseReceipt.create({
          data: {
            id: receiptId,
            organizationId: actor.organizationId,
            purchaseOrderId: orderId,
            warehouseId,
            actorId: actor.userId,
            commandId: purchasingCommandId,
            idempotencyKey: key,
          },
        });
        for (const line of selected) {
          const receiptLine = await tx.purchaseReceiptLine.create({
            data: {
              organizationId: actor.organizationId,
              receiptId,
              purchaseOrderLineId: line.orderLine.id,
              productId: line.orderLine.productId,
              receivedQuantity: line.quantity,
            },
          });
          const inventoryKey = `purchase-receipt:${receiptLine.id}`;
          const command = await tx.inventoryCommand.create({
            data: {
              organizationId: actor.organizationId,
              type: 'RECEIPT',
              key: inventoryKey,
              actorId: actor.userId,
              payloadHash: createHash('sha256')
                .update(
                  JSON.stringify({
                    receiptLineId: receiptLine.id,
                    quantity: line.quantity,
                    warehouseId,
                  }),
                )
                .digest('hex'),
            },
          });
          const balance = await creditBalance(
            tx,
            actor.organizationId,
            line.orderLine.productId,
            warehouseId,
            line.amount,
          );
          const resulting = BigInt(
            balance.quantity.toFixed(6).replace('.', ''),
          );
          const movement = await tx.inventoryMovement.create({
            data: {
              organizationId: actor.organizationId,
              productId: line.orderLine.productId,
              warehouseId,
              type: 'RECEIPT',
              quantity: line.quantity,
              previousBalance: decimal(resulting - line.amount),
              resultingBalance: decimal(resulting),
              balanceVersion: balance.version,
              actorId: actor.userId,
              commandId: command.id,
              purchaseReceiptLineId: receiptLine.id,
              referenceType: 'PURCHASE_RECEIPT',
              referenceId: receiptId,
              idempotencyKey: inventoryKey,
              correlationKey: receiptId,
            },
          });
          await tx.inventoryCommand.update({
            where: { id: command.id },
            data: {
              response: {
                movementId: movement.id,
                receiptId,
                purchaseReceiptLineId: receiptLine.id,
                balanceQuantity: balance.quantity.toFixed(6),
                balanceVersion: balance.version.toString(),
              },
            },
          });
          await hooks.afterReceiptStock?.();
          await tx.purchaseOrderLine.update({
            where: { id: line.orderLine.id },
            data: { receivedQuantity: { increment: line.quantity } },
          });
        }
        const remaining = await tx.purchaseOrderLine.count({
          where: {
            organizationId: actor.organizationId,
            purchaseOrderId: orderId,
            receivedQuantity: {
              lt: tx.purchaseOrderLine.fields.orderedQuantity,
            },
          },
        });
        const order = await tx.purchaseOrder.update({
          where: { id: orderId },
          data: {
            status: remaining ? 'PARTIALLY_RECEIVED' : 'RECEIVED',
            version: { increment: 1 },
          },
          include,
        });
        const receipt = await tx.purchaseReceipt.findUniqueOrThrow({
          where: { id: receiptId },
          include: receiptInclude,
        });
        const result = {
          receipt: receiptDto(receipt),
          purchaseOrder: dto(order),
        };
        await tx.purchasingCommand.create({
          data: {
            id: purchasingCommandId,
            organizationId: actor.organizationId,
            type: 'RECEIVE',
            key,
            payloadHash,
            actorId: actor.userId,
            response: result,
          },
        });
        return result;
      });
      response.status(201).json(result);
    },
  );
  app.get(`${prefix}/suppliers`, async (request, response) => {
    const { session } = await tenant(request);
    const { limit, offset } = pagination(request);
    const suppliers = await db().supplier.findMany({
      where: { organizationId: session.organizationId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      skip: offset,
    });
    response.json({
      suppliers: suppliers.slice(0, limit),
      ...page(suppliers, limit, offset),
    });
  });
  app.get(`${prefix}/suppliers/:id`, async (request, response) => {
    const { session } = await tenant(request);
    const supplier = await db().supplier.findFirst({
      where: {
        id: id(request.params.id, true),
        organizationId: session.organizationId,
      },
    });
    if (!supplier) return fail(404, 'NOT_FOUND', 'Resource not found');
    response.json({ supplier });
  });
  app.post(`${prefix}/suppliers`, async (request, response) => {
    const data = supplierInput(request, true);
    const supplier = await write(request, (tx, actor) =>
      tx.supplier.create({
        data: {
          ...data,
          name: data.name!,
          organizationId: actor.organizationId,
        },
      }),
    );
    response.status(201).json({ supplier });
  });
  app.patch(`${prefix}/suppliers/:id`, async (request, response) => {
    const data = supplierInput(request, false);
    const supplier = await write(request, async (tx, actor) => {
      const current = await tx.supplier.findFirst({
        where: {
          id: id(request.params.id, true),
          organizationId: actor.organizationId,
        },
      });
      if (!current) return fail(404, 'NOT_FOUND', 'Resource not found');
      if (
        data.active === false &&
        (await tx.purchaseOrder.count({
          where: {
            organizationId: actor.organizationId,
            supplierId: current.id,
            status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] },
          },
        }))
      )
        fail(409, 'SUPPLIER_IN_USE', 'Supplier has open purchase orders');
      return tx.supplier.update({
        where: {
          organizationId_id: {
            organizationId: actor.organizationId,
            id: current.id,
          },
        },
        data,
      });
    });
    response.json({ supplier });
  });
  app.get(`${prefix}/purchase-orders`, async (request, response) => {
    const { session } = await tenant(request);
    const { limit, offset } = pagination(request);
    const purchaseOrders = await db().purchaseOrder.findMany({
      where: { organizationId: session.organizationId },
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      skip: offset,
    });
    response.json({
      purchaseOrders: purchaseOrders.slice(0, limit).map(dto),
      ...page(purchaseOrders, limit, offset),
    });
  });
  app.get(`${prefix}/purchase-orders/:id`, async (request, response) => {
    const { session } = await tenant(request);
    response.json({
      purchaseOrder: dto(
        await findOrder(
          db(),
          session.organizationId,
          id(request.params.id, true),
        ),
      ),
    });
  });
  app.post(`${prefix}/purchase-orders`, async (request, response) => {
    const data = draftInput(request);
    const result = await command(
      request,
      'CREATE',
      data,
      async (tx, organizationId, creatorId) => {
        await validateParents(tx, organizationId, data);
        const order = await tx.purchaseOrder.create({
          data: {
            organizationId,
            creatorId,
            supplierId: data.supplierId,
            notes: data.notes,
          },
        });
        await tx.purchaseOrderLine.createMany({
          data: data.lines.map((line) => ({
            ...line,
            organizationId,
            purchaseOrderId: order.id,
          })),
        });
        await hooks.afterDraftLines?.();
        return findOrder(tx, organizationId, order.id);
      },
    );
    response.status(201).json(result);
  });
  app.patch(`${prefix}/purchase-orders/:id`, async (request, response) => {
    const data = draftInput(request);
    const order = await write(request, async (tx, actor) => {
      const current = await findOrder(
        tx,
        actor.organizationId,
        id(request.params.id, true),
        true,
      );
      if (current.status !== 'DRAFT')
        return fail(409, 'INVALID_STATE', 'Only drafts can be edited');
      await validateParents(tx, actor.organizationId, data);
      await tx.purchaseOrderLine.deleteMany({
        where: {
          organizationId: actor.organizationId,
          purchaseOrderId: current.id,
        },
      });
      await tx.purchaseOrderLine.createMany({
        data: data.lines.map((line) => ({
          ...line,
          organizationId: actor.organizationId,
          purchaseOrderId: current.id,
        })),
      });
      await tx.purchaseOrder.update({
        where: { id: current.id },
        data: {
          supplierId: data.supplierId,
          notes: data.notes,
          version: { increment: 1 },
        },
      });
      await hooks.afterDraftLines?.();
      return findOrder(tx, actor.organizationId, current.id);
    });
    response.json({ purchaseOrder: dto(order) });
  });
  for (const transition of ['send', 'cancel'] as const)
    app.post(
      `${prefix}/purchase-orders/:id/${transition}`,
      async (request, response) => {
        const fields = body(request, transition === 'send' ? [] : ['reason']);
        const orderId = id(request.params.id, true);
        const reason =
          transition === 'cancel' ? required(fields.reason, 500) : null;
        const result = await command(
          request,
          transition === 'send' ? 'SEND' : 'CANCEL',
          { orderId, reason },
          async (tx, organizationId) => {
            const current = await findOrder(tx, organizationId, orderId, true);
            if (transition === 'send') {
              if (current.status !== 'DRAFT')
                return fail(409, 'INVALID_STATE', 'Only drafts can be sent');
              await validateParents(tx, organizationId, {
                supplierId: current.supplierId,
                notes: current.notes,
                lines: current.lines.map((line) => ({
                  productId: line.productId,
                  orderedQuantity: line.orderedQuantity.toFixed(6),
                })),
              });
            } else if (
              !['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'].includes(current.status)
            )
              return fail(409, 'INVALID_STATE', 'Order cannot be cancelled');
            return tx.purchaseOrder.update({
              where: { id: current.id },
              data:
                transition === 'send'
                  ? {
                      status: 'SENT',
                      sentAt: new Date(),
                      version: { increment: 1 },
                    }
                  : {
                      status: 'CANCELLED',
                      cancelledAt: new Date(),
                      cancellationReason: reason,
                      version: { increment: 1 },
                    },
              include,
            });
          },
        );
        response.json(result);
      },
    );
}
