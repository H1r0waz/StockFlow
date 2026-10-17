import type { Request, Response } from 'express';
import { HttpError } from './http.js';
import { AuthLimiter } from './modules/auth/security.js';

export function configuredOrigin(value: string, production: boolean) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Error('WEB_ORIGIN must be an exact HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== value ||
    parsed.hostname.includes('*') ||
    parsed.username ||
    parsed.password ||
    (production && parsed.protocol !== 'https:')
  )
    throw Error(
      'WEB_ORIGIN must be an exact HTTP(S) origin; production requires HTTPS',
    );
  return parsed.origin;
}

export function securityHeaders(
  request: Request,
  response: Response,
  production: boolean,
) {
  response.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  // Forwarded protocol is trusted only with the explicit deployment proxy option.
  if (production && request.secure)
    response.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

export class RateLimitError extends HttpError {
  constructor(
    readonly retryAfterSeconds: number,
    message: string,
  ) {
    super(429, 'RATE_LIMITED', message);
  }
}

export interface OperationRateLimits {
  windowMs?: number;
  mutations?: number;
  imports?: number;
  reads?: number;
}

export function operationLimiter(options: OperationRateLimits = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const limits = {
    mutations: new AuthLimiter(windowMs, options.mutations ?? 120),
    imports: new AuthLimiter(windowMs, options.imports ?? 60),
    reads: new AuthLimiter(windowMs, options.reads ?? 120),
  };
  return (
    request: Request,
    userId: string,
    organizationId: string,
    mutation: boolean,
    now: number,
  ) => {
    // Revoking a session must remain available after its write quota is spent.
    if (request.path === '/api/auth/logout') return;
    const kind = mutation
      ? request.path?.includes('/imports/')
        ? 'imports'
        : 'mutations'
      : /\/(dashboard|audit|reports|exports)(\/|$)/.test(request.path ?? '')
        ? 'reads'
        : undefined;
    if (kind && !limits[kind].allow([`${userId}:${organizationId}`], now))
      throw new RateLimitError(
        Math.ceil(windowMs / 1000),
        'Too many operational requests',
      );
  };
}
