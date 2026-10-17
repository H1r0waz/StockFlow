import { HttpError, validId } from '../../http.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { productData } from '../catalog/validation.js';
import { parseCsv, type ImportType } from './csv.js';
import { createHash } from 'node:crypto';
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export async function planImport(
  tx: Prisma.TransactionClient,
  organizationId: string,
  csv: string,
  type: ImportType,
) {
  const parsed = parseCsv(csv, type);
  const skus = parsed
    .map(({ fields }) => fields.sku?.trim().toUpperCase())
    .filter((v): v is string => !!v);
  const products =
    type === 'products'
      ? await tx.product.findMany({
          where: { organizationId, sku: { in: skus } },
          orderBy: { id: 'asc' },
          include: {
            _count: {
              select: {
                inventoryMovements: true,
                purchaseOrderLines: true,
                inventoryThresholds: true,
              },
            },
          },
        })
      : [];
  const categories =
    type === 'products'
      ? await tx.category.findMany({
          orderBy: { id: 'asc' },
          where: {
            organizationId,
            id: {
              in: [
                ...new Set(
                  [
                    ...parsed.map(({ fields }) =>
                      fields.categoryId?.trim().toLowerCase(),
                    ),
                    ...products.map((product) => product.categoryId),
                  ].filter((v): v is string => !!v && validId(v)),
                ),
              ],
            },
          },
        })
      : [];
  const taxIds = parsed
    .map(({ fields }) => fields.taxId?.trim())
    .filter((v): v is string => !!v);
  const suppliers =
    type === 'suppliers'
      ? await tx.supplier.findMany({
          where: { organizationId, taxId: { in: taxIds } },
          select: { id: true, taxId: true, updatedAt: true },
          orderBy: { id: 'asc' },
        })
      : [];
  const seen = new Set<string>();
  const rows = parsed.map(({ row, fields, mismatch }) => {
    const errors: string[] = [];
    let operation: 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR' = 'CREATE';
    let data: Record<string, unknown> | undefined;
    let existingId: string | undefined;
    try {
      if (mismatch) throw new Error('Row column count differs from header');
      if (type === 'products') {
        const current = products.find(
          (p) => p.sku === fields.sku?.trim().toUpperCase(),
        );
        if (
          Object.hasOwn(fields, 'quantityScale') &&
          !/^[0-6]$/.test(fields.quantityScale ?? '')
        )
          throw new Error('Quantity scale must be an integer from 0 to 6');
        data = productData(
          {
            ...fields,
            ...(Object.hasOwn(fields, 'quantityScale')
              ? { quantityScale: Number(fields.quantityScale) }
              : {}),
            ...(Object.hasOwn(fields, 'categoryId')
              ? { categoryId: fields.categoryId?.trim() || null }
              : {}),
          },
          current,
        );
        const key = String(data.sku);
        if (seen.has(key)) throw new Error('Duplicate SKU in CSV');
        seen.add(key);
        if (data.categoryId) {
          const category = categories.find((c) => c.id === data!.categoryId);
          if (
            !category ||
            (!category.active && category.id !== current?.categoryId)
          )
            throw new Error('Category is unavailable in this organization');
        }
        if (current) {
          existingId = current.id;
          if (
            (data.unitOfMeasure !== current.unitOfMeasure ||
              data.quantityScale !== current.quantityScale) &&
            Object.values(current._count).some((n) => n > 0)
          )
            throw new Error(
              'Unit and precision cannot change after inventory, orders or thresholds',
            );
          operation = Object.entries(data).every(
            ([key, value]) => current[key as keyof typeof current] === value,
          )
            ? 'SKIP'
            : 'UPDATE';
        }
      } else {
        const optional = (key: string, max: number) => {
          const value = fields[key]?.trim() || null;
          if (
            value &&
            (value.length > max ||
              Array.from(value).some(
                (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
              ))
          )
            throw new Error(`Invalid ${key}`);
          return value;
        };
        const name = optional('name', 200);
        if (!name) throw new Error('Name is required');
        const email = optional('email', 254)?.toLowerCase() ?? null;
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          throw new Error('Invalid email');
        const taxId = optional('taxId', 100);
        if (
          taxId &&
          (seen.has(taxId) || suppliers.some((s) => s.taxId === taxId))
        )
          throw new Error('Duplicate tax ID');
        if (taxId) seen.add(taxId);
        data = {
          name,
          email,
          taxId,
          phone: optional('phone', 100),
          notes: optional('notes', 2000),
        };
      }
    } catch (error) {
      operation = 'ERROR';
      errors.push(
        error instanceof HttpError || error instanceof Error
          ? error.message
          : 'Invalid row',
      );
      data = undefined;
    }
    return { row, operation, data, errors, existingId };
  });
  const invalidRows = rows.filter((r) => r.operation === 'ERROR').length;
  const summary = {
    totalRows: rows.length,
    validRows: rows.length - invalidRows,
    invalidRows,
    createdRows: rows.filter((r) => r.operation === 'CREATE').length,
    updatedRows: rows.filter((r) => r.operation === 'UPDATE').length,
    skippedRows: rows.filter((r) => r.operation === 'SKIP').length,
  };
  const fingerprint = hash(
    JSON.stringify({ rows, products, categories, suppliers }),
  );
  return { rows, summary, fingerprint };
}
