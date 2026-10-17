import type { Request, Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  configuredOrigin,
  operationLimiter,
  securityHeaders,
} from '../src/http-security.js';
import { AuthLimiter } from '../src/modules/auth/security.js';

afterEach(() => vi.unstubAllEnvs());
describe('Phase 10 HTTP boundary', () => {
  it.each([
    'https://app.example.test/',
    'https://app.example.test/path',
    'https://app.example.test?x=1',
    'https://app.example.test#x',
    'https://user:secret@app.example.test',
    'https://*.example.test',
    'null',
    '*',
    'file:///tmp/example',
  ])('rejects non-origin WEB_ORIGIN %s', (value) => {
    expect(() => configuredOrigin(value, false)).toThrow('WEB_ORIGIN');
  });
  it('accepts exact origins, requires production HTTPS and forbids insecure cookies', () => {
    expect(configuredOrigin('http://127.0.0.1:5173', false)).toBe(
      'http://127.0.0.1:5173',
    );
    expect(() => configuredOrigin('http://app.example.test', true)).toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      createApp({
        allowedOrigin: 'https://app.example.test',
        secureCookies: false,
      }),
    ).toThrow('Secure');
  });
  it('applies API response policies to success and errors without enabling CORS', async () => {
    const app = createApp();
    for (const path of ['/api/health', '/unknown']) {
      const r = await request(app)
        .get(path)
        .set('Origin', 'https://hostile.example.test');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['strict-transport-security']).toBeUndefined();
      expect(r.headers['x-powered-by']).toBeUndefined();
    }
  });
  it('does not trust forwarded HTTPS for HSTS', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = createApp({ allowedOrigin: 'https://app.example.test' });
    const r = await request(app)
      .get('/api/health')
      .set('X-Forwarded-Proto', 'https');
    expect(app.get('trust proxy')).toBe(false);
    expect(r.headers['strict-transport-security']).toBeUndefined();
    const headers = new Map<string, string>();
    const response = {
      set: () => undefined,
      setHeader: (key: string, value: string) => headers.set(key, value),
    } as unknown as Response;
    securityHeaders({ secure: true } as Request, response, true);
    expect(headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    headers.clear();
    securityHeaders({ secure: true } as Request, response, false);
    expect(headers.size).toBe(0);
  });
  it('rejects cross-origin mutation and hides malformed/oversized parser details', async () => {
    const app = createApp();
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .set('Origin', 'https://hostile.example.test')
          .send({})
      ).status,
    ).toBe(403);
    const broken = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"private-secret":');
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual({
      error: { code: 'INVALID_JSON', message: 'Invalid request body' },
    });
    const large = await request(app)
      .post('/api/auth/login')
      .send({ password: 'private-secret'.repeat(10000) });
    expect(large.status).toBe(413);
    expect(large.body).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Invalid request body' },
    });
  });
  it.each([0, -1, NaN, Infinity, 1.1])(
    'rejects invalid limiter configuration %s',
    (value) => {
      expect(() => new AuthLimiter(value, 1)).toThrow();
      expect(() => new AuthLimiter(1, value)).toThrow();
    },
  );
  it('expires operational buckets and keeps users, tenants and classes independent', () => {
    const limit = operationLimiter({
      windowMs: 1000,
      mutations: 1,
      imports: 1,
      reads: 1,
    });
    const mutation = { path: '/api/organizations/org/products' } as Request;
    limit(mutation, 'u', 'o', true, 0);
    expect(() => limit(mutation, 'u', 'o', true, 999)).toThrow('operational');
    expect(() => limit(mutation, 'u2', 'o', true, 999)).not.toThrow();
    expect(() => limit(mutation, 'u', 'o2', true, 999)).not.toThrow();
    expect(() =>
      limit(
        { path: '/api/organizations/org/imports/products/preview' } as Request,
        'u',
        'o',
        true,
        999,
      ),
    ).not.toThrow();
    expect(() =>
      limit(
        { path: '/api/organizations/org/dashboard' } as Request,
        'u',
        'o',
        false,
        999,
      ),
    ).not.toThrow();
    expect(() => limit(mutation, 'u', 'o', true, 1000)).not.toThrow();
  });
});
