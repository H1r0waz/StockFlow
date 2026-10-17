import type {
  Category,
  Product,
  Warehouse,
  UnitOfMeasure,
} from '../../generated/prisma/client.js';
import { fail, validId } from '../../http.js';

type Input = Record<string, unknown>;
const owns = (input: Input, key: string) => Object.hasOwn(input, key);
export const units: UnitOfMeasure[] = ['UNIT', 'KG', 'G', 'L', 'ML', 'M', 'CM'];

function invalidCharacters(value: string, whitespace: number[]) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return (
      code === 127 ||
      (code < 32 && !whitespace.includes(code)) ||
      (code >= 0xd800 && code <= 0xdfff)
    );
  });
}

function name(value: unknown) {
  if (
    typeof value !== 'string' ||
    invalidCharacters(value, [9, 10, 11, 12, 13])
  ) {
    return fail(400, 'INVALID_INPUT', 'Invalid name');
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 200)
    return fail(400, 'INVALID_INPUT', 'Name must contain 1–200 characters');
  return normalized;
}
function description(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    invalidCharacters(value, [9, 10, 13]) ||
    value.trim().length > 2000
  ) {
    return fail(400, 'INVALID_INPUT', 'Invalid description');
  }
  return value.trim() || null;
}
function active(value: unknown) {
  if (typeof value !== 'boolean')
    return fail(400, 'INVALID_INPUT', 'Active must be a boolean');
  return value;
}
function identifier(value: unknown, max: number) {
  if (typeof value !== 'string')
    return fail(400, 'INVALID_INPUT', 'Invalid SKU or code');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return fail(400, 'INVALID_INPUT', 'Invalid SKU or code');
  }
  return trimmed.toUpperCase();
}
function common(
  input: Input,
  existing?: { name: string; description: string | null; active: boolean },
) {
  return {
    name: owns(input, 'name')
      ? name(input.name)
      : (existing?.name ?? name(undefined)),
    description: owns(input, 'description')
      ? description(input.description)
      : (existing?.description ?? null),
    active: owns(input, 'active')
      ? active(input.active)
      : (existing?.active ?? true),
  };
}
export function categoryData(input: Input, existing?: Category) {
  const data = common(input, existing);
  const normalizedName = data.name.toLowerCase();
  if (normalizedName.length > 200)
    return fail(400, 'INVALID_INPUT', 'Invalid category name');
  return { ...data, normalizedName };
}
export function warehouseData(input: Input, existing?: Warehouse) {
  return {
    ...common(input, existing),
    code: owns(input, 'code')
      ? identifier(input.code, 32)
      : (existing?.code ?? identifier(undefined, 32)),
  };
}
export function productData(input: Input, existing?: Product) {
  let categoryId = existing?.categoryId ?? null;
  if (owns(input, 'categoryId')) {
    if (input.categoryId === null) categoryId = null;
    else if (typeof input.categoryId === 'string' && validId(input.categoryId))
      categoryId = input.categoryId.toLowerCase();
    else return fail(400, 'INVALID_INPUT', 'Invalid category ID');
  }
  let unitOfMeasure = existing?.unitOfMeasure;
  if (owns(input, 'unitOfMeasure')) {
    if (
      typeof input.unitOfMeasure !== 'string' ||
      !units.includes(input.unitOfMeasure as UnitOfMeasure)
    ) {
      return fail(400, 'INVALID_INPUT', 'Invalid unit of measure');
    }
    unitOfMeasure = input.unitOfMeasure as UnitOfMeasure;
  }
  if (!unitOfMeasure)
    return fail(400, 'INVALID_INPUT', 'Unit of measure is required');
  let quantityScale =
    existing?.quantityScale ?? (unitOfMeasure === 'UNIT' ? 0 : 3);
  if (existing && unitOfMeasure !== existing.unitOfMeasure)
    quantityScale = unitOfMeasure === 'UNIT' ? 0 : 3;
  if (owns(input, 'quantityScale')) {
    const value = input.quantityScale;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 6
    ) {
      return fail(
        400,
        'INVALID_INPUT',
        'Quantity scale must be an integer from 0 to 6',
      );
    }
    quantityScale = value;
  }
  return {
    ...common(input, existing),
    sku: owns(input, 'sku')
      ? identifier(input.sku, 64)
      : (existing?.sku ?? identifier(undefined, 64)),
    categoryId,
    unitOfMeasure,
    quantityScale,
  };
}
