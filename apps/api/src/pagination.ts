import type { Request } from 'express';
import { fail } from './http.js';
export function pagination(request: Request, filters: string[] = []) {
  if (
    Object.keys(request.query).some(
      (k) => !['limit', 'offset', ...filters].includes(k),
    )
  )
    fail(400, 'INVALID_INPUT', 'Unknown query filter');
  const parse = (
    value: unknown,
    fallback: string,
    max: number,
    zero: boolean,
  ) => {
    const raw = value ?? fallback;
    if (
      typeof raw !== 'string' ||
      !(zero ? /^(0|[1-9][0-9]{0,6})$/ : /^[1-9][0-9]{0,2}$/).test(raw) ||
      Number(raw) > max
    )
      return fail(400, 'INVALID_INPUT', 'Invalid pagination');
    return Number(raw);
  };
  return {
    limit: parse(request.query.limit, '50', 100, false),
    offset: parse(request.query.offset, '0', 1_000_000, true),
  };
}
export function page<T>(rows: T[], limit: number, offset: number) {
  return {
    hasMore: rows.length > limit,
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}
