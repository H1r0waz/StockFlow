import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';

describe('API bootstrap', () => {
  it('does not expose parser internals for malformed JSON', async () => {
    const response = await request(app)
      .post('/api/organizations')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'INVALID_JSON', message: 'Invalid request body' },
    });
  });
  it('reports process liveness without claiming database readiness', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body).toEqual({ status: 'ok', service: 'stockflow-api' });
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('returns a structured 404 for an unknown endpoint', async () => {
    const response = await request(app).get('/api/organizations');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });
});
