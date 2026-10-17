import { fail } from '../../http.js';

const factor = 1_000_000n;
export const maxQuantity = 99_999_999_999_999_999_999n;
export function quantity(value: unknown, scale = 6): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,13})(\.[0-9]{1,6})?$/.test(value)
  )
    return fail(
      400,
      'INVALID_QUANTITY',
      'Quantity must be a positive exact decimal string',
    );
  const [whole = '', fraction = ''] = value.split('.');
  if (fraction.length > scale)
    return fail(400, 'INVALID_QUANTITY', 'Quantity exceeds product precision');
  const result = BigInt(whole) * factor + BigInt(fraction.padEnd(6, '0'));
  if (result <= 0n || result > maxQuantity)
    return fail(
      400,
      'INVALID_QUANTITY',
      'Quantity is outside the supported range',
    );
  return result;
}
export function decimal(value: bigint) {
  return `${value / factor}.${(value % factor).toString().padStart(6, '0')}`;
}
