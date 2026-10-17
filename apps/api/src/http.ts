import type { Request } from 'express';
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message);
};
export const validId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function body(request: Request, keys: string[]) {
  const input: unknown = request.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail(400, 'INVALID_INPUT', 'Invalid request body');
  }
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    return fail(400, 'INVALID_INPUT', 'Unexpected request fields');
  }
  return input as Record<string, unknown>;
}
export function text(input: Record<string, unknown>, key: string, max = 200) {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    return fail(400, 'INVALID_INPUT', 'Invalid request fields');
  }
  return value.trim();
}
export function email(input: Record<string, unknown>) {
  const value = text(input, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    fail(400, 'INVALID_INPUT', 'Invalid email');
  return value;
}
export function password(
  input: Record<string, unknown>,
  registration: boolean,
) {
  const value = input.password;
  if (
    typeof value !== 'string' ||
    value.length < (registration ? 12 : 1) ||
    value.length > 128
  ) {
    return fail(
      400,
      'INVALID_INPUT',
      'Password must contain 12–128 characters',
    );
  }
  return value;
}
export function role(input: Record<string, unknown>): Role {
  const value = input.role;
  if (value !== 'OWNER' && value !== 'ADMIN' && value !== 'MEMBER') {
    return fail(400, 'INVALID_INPUT', 'Invalid role');
  }
  return value;
}
