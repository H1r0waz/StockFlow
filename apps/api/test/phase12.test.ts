import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../src/app.js';
import { observeRequests, proxyHops } from '../src/deployment.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

describe('Phase 12 deployment boundary', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'stockflow-web-'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><title>StockFlow</title>',
    );
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log("StockFlow")');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const production = () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEB_ORIGIN', 'https://stockflow.example.test');
    vi.spyOn(console, 'info').mockImplementation(() => {});
  };
  it('serves production HTML and assets with a working frontend CSP, keeping API CSP', async () => {
    production();
    const app = createApp({ webDirectory: root });
    const page = await request(app).get('/').expect(200);
    expect(page.text).toContain('<title>StockFlow');
    expect(page.headers['content-security-policy']).toContain(
      "script-src 'self'",
    );
    expect(page.headers['cache-control']).toBe('no-store');
    await request(app).get('/assets/app.js').expect(200);
    const api = await request(app).get('/api/health').expect(200);
    expect(api.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });
  it('falls back for HTML navigation but never API, missing assets or JSON navigation', async () => {
    const app = createApp({ webDirectory: root });
    await request(app)
      .get('/inventory/overview')
      .set('Accept', 'text/html')
      .expect(200);
    for (const path of [
      '/api',
      '/api/unknown',
      '/API/unknown',
      '/assets/missing.js',
      '/assets/missing',
      '/favicon.ico',
    ]) {
      const result = await request(app)
        .get(path)
        .set('Accept', 'text/html')
        .expect(404);
      expect(result.body.error.code).toBe('NOT_FOUND');
    }
    await request(app)
      .get('/inventory')
      .set('Accept', 'application/json')
      .expect(404);
    await request(app).get('/%2e%2e/package.json').expect(404);
  });
  it('requires built frontend explicitly and leaves normal API-only mode unchanged', async () => {
    expect(() => createApp({ webDirectory: join(root, 'absent') })).toThrow(
      'built frontend',
    );
    await request(createApp()).get('/').expect(404);
  });
  it('rejects loose proxy configuration', () => {
    for (const value of ['true', '2', '-1', '*', ''])
      expect(() => proxyHops(value)).toThrow();
    expect(proxyHops('0')).toBe(false);
    expect(proxyHops('1')).toBe(1);
  });
  it('ignores spoofed forwarded protocol by default', async () => {
    production();
    vi.stubEnv('TRUST_PROXY_HOPS', '0');
    const result = await request(createApp())
      .get('/api/health')
      .set('X-Forwarded-Proto', 'https');
    expect(result.headers['strict-transport-security']).toBeUndefined();
  });
  it('uses only the nearest forwarded address with one explicitly trusted proxy', async () => {
    const app = express();
    app.set('trust proxy', proxyHops('1'));
    app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
    const result = await request(app)
      .get('/')
      .set('X-Forwarded-For', '192.0.2.99, 198.51.100.12')
      .set('X-Forwarded-Proto', 'https');
    expect(result.body).toEqual({ ip: '198.51.100.12', secure: true });
    production();
    vi.stubEnv('TRUST_PROXY_HOPS', '1');
    const health = await request(createApp())
      .get('/api/health')
      .set('X-Forwarded-Proto', 'https');
    expect(health.headers['strict-transport-security']).toBe(
      'max-age=31536000',
    );
  });
  it('keeps liveness independent and returns safe readiness failure', async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValue(Error('postgresql://secret:password@private/db')),
    } as unknown as PrismaClient;
    const app = createApp({ prisma });
    await request(app).get('/api/health').expect(200);
    const result = await request(app).get('/api/ready').expect(503);
    expect(result.body).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(result.body)).not.toContain('password');
  });
  it('checks readiness using bounded transaction and statement timeout', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const transaction = vi.fn(
      async (
        callback: (value: typeof tx) => Promise<void>,
        _options?: unknown,
      ) => callback(tx),
    );
    const app = createApp({
      prisma: { $transaction: transaction } as unknown as PrismaClient,
    });
    await request(app).get('/api/ready').expect(200, { status: 'ready' });
    expect(transaction.mock.calls[0]?.[1]).toEqual({
      maxWait: 1000,
      timeout: 2500,
    });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  });
  it('bounds the readiness response even when acquisition does not settle', async () => {
    const app = createApp({
      prisma: {
        $transaction: () => new Promise(() => {}),
      } as unknown as PrismaClient,
    });
    const started = performance.now();
    await request(app).get('/api/ready').expect(503, { status: 'unavailable' });
    expect(performance.now() - started).toBeLessThan(4500);
    await request(app).get('/api/health').expect(200);
  });
  it('disables public registration server-side', async () => {
    vi.stubEnv('PUBLIC_DEMO', 'true');
    const result = await request(createApp())
      .post('/api/auth/register')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({})
      .expect(403);
    expect(result.body.error.code).toBe('REGISTRATION_DISABLED');
  });
  it('generates request IDs and logs route patterns without input values', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const app = express();
    observeRequests(app, true);
    app.get('/private/:id', (_req, res) => res.json({ ok: true }));
    const result = await request(app)
      .get('/private/secret-value?token=secret-token')
      .set('X-Request-ID', 'attacker-id')
      .set('Cookie', 'sensitive-cookie');
    expect(result.headers['x-request-id']).toMatch(/^[a-f\d-]{36}$/);
    const log = JSON.parse(String(logs.mock.calls[0]?.[0]));
    expect(log.route).toBe('/private/:id');
    expect(log.requestId).toBe(result.headers['x-request-id']);
    expect(JSON.stringify(log)).not.toMatch(/secret|attacker|sensitive/);
  });
});
