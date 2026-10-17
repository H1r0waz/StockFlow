import { fail } from '../../http.js';

export const MAX_CSV_BYTES = 256 * 1024;
export const MAX_CSV_ROWS = 2000;
export type ImportType = 'products' | 'suppliers';
export function importType(value: unknown): ImportType {
  if (value !== 'products' && value !== 'suppliers')
    return fail(404, 'NOT_FOUND', 'Import type not found');
  return value;
}
export function parseCsv(value: unknown, type: ImportType) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_CSV_BYTES
  )
    return fail(400, 'INVALID_CSV', 'CSV must contain at most 256 KiB');
  if (
    // eslint-disable-next-line no-control-regex
    /\uFFFD|\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    return fail(400, 'INVALID_CSV', 'CSV contains invalid characters');
  const source = value.replace(/^\uFEFF/u, '');
  const records: { row: number; cells: string[] }[] = [];
  let cells: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    line = 1,
    start = 1;
  const cell = () => {
    cells.push(field);
    field = '';
    closed = false;
    if (cells.length > 8)
      fail(400, 'INVALID_CSV', 'At most 8 columns are allowed');
  };
  const record = () => {
    cell();
    if (cells.some((v) => v.trim() !== '')) records.push({ row: start, cells });
    cells = [];
    if (records.length > MAX_CSV_ROWS + 1)
      fail(400, 'INVALID_CSV', 'At most 2000 data rows are allowed');
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        field += c;
        if (c === '\n') line++;
      }
    } else if (c === ',') cell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      record();
      line++;
      start = line;
    } else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed || c === '"')
        fail(400, 'INVALID_CSV', 'Malformed CSV quoting');
      field += c;
    }
  }
  if (quoted) fail(400, 'INVALID_CSV', 'Unterminated CSV quote');
  if (field || cells.length || closed) record();
  const header = records.shift()?.cells.map((v) => v.trim());
  const allowed =
    type === 'products'
      ? [
          'sku',
          'name',
          'unitOfMeasure',
          'quantityScale',
          'categoryId',
          'description',
        ]
      : ['name', 'email', 'phone', 'taxId', 'notes'];
  const required =
    type === 'products' ? ['sku', 'name', 'unitOfMeasure'] : ['name'];
  if (
    !header ||
    new Set(header).size !== header.length ||
    header.some((v) => !allowed.includes(v)) ||
    required.some((v) => !header.includes(v))
  )
    return fail(400, 'INVALID_CSV', 'Invalid or duplicate CSV headers');
  if (!records.length) fail(400, 'INVALID_CSV', 'CSV requires data rows');
  return records.map(({ row, cells }) => ({
    row,
    fields: Object.fromEntries(
      header.map((key, index) => [key, cells[index] ?? '']),
    ),
    mismatch: cells.length !== header.length,
  }));
}
