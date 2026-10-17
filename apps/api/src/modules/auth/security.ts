import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

export const cookieName = 'stockflow_session';
export const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
export const opaqueToken = () => randomBytes(32).toString('hex');
export const digestToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export function presentedToken(request: Request) {
  const value = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function setSessionCookie(
  response: Response,
  token: string,
  secure: boolean,
) {
  response.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: sessionDurationMs,
  });
}

export function clearSessionCookie(response: Response, secure: boolean) {
  response.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
  });
}

export function equalToken(left: string | undefined, right: string) {
  if (!left || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
    return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export class AuthLimiter {
  private readonly entries = new Map<
    string,
    { count: number; until: number }
  >();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {
    if (
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1 ||
      !Number.isSafeInteger(max) ||
      max < 1
    )
      throw Error(
        'Rate limit window and budget must be positive safe integers',
      );
  }

  allow(keys: string[], now: number) {
    for (const [key, value] of this.entries) {
      if (value.until <= now) this.entries.delete(key);
    }
    if (keys.some((key) => (this.entries.get(key)?.count ?? 0) >= this.max))
      return false;
    // Reject new buckets when full: never evict an active attacker bucket.
    if (
      this.entries.size + keys.filter((key) => !this.entries.has(key)).length >
      10_000
    )
      return false;
    for (const key of keys) {
      const entry = this.entries.get(key) ?? {
        count: 0,
        until: now + this.windowMs,
      };
      entry.count += 1;
      this.entries.set(key, entry);
    }
    return true;
  }
}
