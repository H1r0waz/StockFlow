import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

describe('Database failure privacy at the HTTP boundary', () => {
  it.each(['connection refused', 'statement timeout'])(
    'returns a safe response for %s without logging credentials',
    async (reason) => {
      const sensitive = `${reason}: postgresql://private-user:private-password@private-host/db`;
      const prisma = {
        session: {
          findUnique: async () => {
            throw new Error(sensitive);
          },
        },
      } as unknown as PrismaClient;
      const app = createApp({ prisma });
      const r = await request(app)
        .get('/api/auth/session')
        .set('Cookie', `stockflow_session=${'a'.repeat(64)}`);
      expect(r.status).toBe(500);
      expect(r.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' },
      });
      expect(r.text).not.toMatch(/private-|postgresql|stack|timeout|refused/);
      expect(r.headers['cache-control']).toBe('no-store');
    },
  );
});
