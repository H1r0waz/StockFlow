import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Express } from 'express';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { body, fail, validId, type Role } from '../../http.js';
import type { TenantContext } from '../../tenant.js';
import { importType, parseCsv } from './csv.js';
import { hash, planImport } from './plan.js';

const secret = randomBytes(32);
const lifetime = 30 * 60 * 1000;
interface Token {
  id: string;
  organizationId: string;
  actorId: string;
  type: string;
  csvHash: string;
  fingerprint: string;
  expiresAt: number;
}
export interface ImportHooks {
  beforeConfirmLock?: () => Promise<void>;
  afterApply?: () => Promise<void>;
}
function permission(actor: { role: Role }) {
  if (actor.role === 'MEMBER')
    fail(403, 'FORBIDDEN', 'Insufficient permission');
}
function signature(payload: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}
function encode(token: Token) {
  const payload = Buffer.from(JSON.stringify(token)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
function decode(value: unknown): Token {
  if (typeof value !== 'string' || value.length > 2048)
    return fail(400, 'INVALID_PREVIEW', 'Invalid preview token');
  const [payload, signed, ...rest] = value.split('.');
  if (!payload || !signed || rest.length || !/^[A-Za-z0-9_-]+$/.test(signed))
    return fail(400, 'INVALID_PREVIEW', 'Invalid preview token');
  const actual = Buffer.from(signed, 'base64url'),
    expected = Buffer.from(signature(payload), 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return fail(400, 'INVALID_PREVIEW', 'Invalid preview token');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Token;
  } catch {
    return fail(400, 'INVALID_PREVIEW', 'Invalid preview token');
  }
}
function dto(job: {
  id: string;
  type: string;
  status: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  createdAt: Date;
  confirmedAt: Date;
}) {
  const {
    id,
    type,
    status,
    totalRows,
    validRows,
    invalidRows,
    createdRows,
    updatedRows,
    skippedRows,
    failedRows,
    createdAt,
    confirmedAt,
  } = job;
  return {
    id,
    type,
    status,
    totalRows,
    validRows,
    invalidRows,
    createdRows,
    updatedRows,
    skippedRows,
    failedRows,
    createdAt,
    confirmedAt,
  };
}
export function registerImportRoutes(
  app: Express,
  {
    db,
    tenant,
    writeTenant,
    now = () => new Date(),
    hooks = {},
  }: TenantContext & {
    db: () => PrismaClient;
    now?: () => Date;
    hooks?: ImportHooks;
  },
) {
  const prefix = '/api/organizations/:organizationId/imports';
  app.post(`${prefix}/:type/preview`, async (request, response) => {
    const context = await tenant(request, true);
    permission(context.membership);
    const type = importType(request.params.type),
      fields = body(request, ['csv']);
    const csv = fields.csv;
    // Parsing is bounded before any database lookup; preview never persists a job.
    const plan = await planImport(
      db(),
      context.session.organizationId,
      typeof csv === 'string'
        ? csv
        : fail(400, 'INVALID_CSV', 'CSV is required'),
      type,
    );
    const token: Token = {
      id: randomUUID(),
      organizationId: context.session.organizationId,
      actorId: context.session.userId,
      type,
      csvHash: hash(csv as string),
      fingerprint: plan.fingerprint,
      expiresAt: now().getTime() + lifetime,
    };
    response.json({
      preview: {
        id: token.id,
        type,
        ...plan.summary,
        rows: plan.rows.map(({ existingId: _id, ...row }) => row),
        token: encode(token),
        expiresAt: new Date(token.expiresAt).toISOString(),
      },
    });
  });
  app.post(`${prefix}/:type/confirm`, async (request, response) => {
    const context = await tenant(request, true);
    permission(context.membership);
    const type = importType(request.params.type),
      fields = body(request, ['csv', 'token']),
      token = decode(fields.token);
    if (typeof fields.csv !== 'string')
      return fail(400, 'INVALID_CSV', 'CSV is required');
    const csv = fields.csv;
    if (
      token.organizationId !== context.session.organizationId ||
      token.actorId !== context.session.userId ||
      token.type !== type ||
      token.csvHash !== hash(csv)
    )
      return fail(
        400,
        'INVALID_PREVIEW',
        'Preview does not match this request',
      );
    // Reject oversized/malformed input before opening the serialized write transaction.
    parseCsv(csv, type);
    await hooks.beforeConfirmLock?.();
    const job = await writeTenant(
      request,
      async (tx, actor) => {
        permission(actor);
        const previous = await tx.importJob.findFirst({
          where: { id: token.id, organizationId: actor.organizationId },
        });
        if (previous) {
          if (
            previous.actorId !== actor.userId ||
            previous.type !== type ||
            previous.csvHash !== token.csvHash
          )
            return fail(409, 'IMPORT_CONFLICT', 'Import identity conflict');
          return previous;
        }
        if (token.expiresAt <= now().getTime())
          return fail(
            409,
            'EXPIRED_PREVIEW',
            'Preview expired; create a new preview',
          );
        const plan = await planImport(tx, actor.organizationId, csv, type);
        if (plan.fingerprint !== token.fingerprint)
          return fail(
            409,
            'STALE_PREVIEW',
            'Data changed; create a new preview',
          );
        if (plan.summary.invalidRows)
          return fail(
            400,
            'INVALID_IMPORT',
            'All rows must be valid before confirmation',
          );
        await tx.$queryRaw`SELECT set_config('stockflow.correlation_key',${token.id},true)`;
        const creates = plan.rows.filter((row) => row.operation === 'CREATE');
        if (type === 'products') {
          if (creates.length)
            await tx.product.createMany({
              data: creates.map(
                (row) =>
                  ({
                    organizationId: actor.organizationId,
                    ...row.data,
                  }) as Prisma.ProductCreateManyInput,
              ),
            });
          for (const row of plan.rows.filter(
            (row) => row.operation === 'UPDATE',
          ))
            await tx.product.update({
              where: {
                organizationId_id: {
                  organizationId: actor.organizationId,
                  id: row.existingId!,
                },
              },
              data: row.data as Prisma.ProductUpdateInput,
            });
        } else if (creates.length)
          await tx.supplier.createMany({
            data: creates.map(
              (row) =>
                ({
                  organizationId: actor.organizationId,
                  ...row.data,
                }) as Prisma.SupplierCreateManyInput,
            ),
          });
        await hooks.afterApply?.();
        const confirmedAt = now();
        const result = await tx.importJob.create({
          data: {
            id: token.id,
            organizationId: actor.organizationId,
            actorId: actor.userId,
            type,
            status: 'CONFIRMED',
            csvHash: token.csvHash,
            ...plan.summary,
            failedRows: 0,
            confirmedAt,
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: actor.organizationId,
            actorId: actor.userId,
            action: 'IMPORT_CONFIRM',
            entityType: 'ImportJob',
            entityId: token.id,
            correlationKey: token.id,
            metadata: { type, ...plan.summary, failedRows: 0 },
          },
        });
        return result;
      },
      { timeout: 30000 },
    );
    response.status(201).json({ job: dto(job) });
  });
  app.get(`${prefix}/:id`, async (request, response) => {
    const context = await tenant(request);
    permission(context.membership);
    const id = request.params.id;
    if (typeof id !== 'string' || !validId(id))
      return fail(404, 'NOT_FOUND', 'Import not found');
    const job = await db().importJob.findFirst({
      where: { id, organizationId: context.session.organizationId },
    });
    if (!job) return fail(404, 'NOT_FOUND', 'Import not found');
    response.json({ job: dto(job) });
  });
}
