import { describe, expect, it } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { corsMiddleware } from '../../src/middleware/cors.middleware.js';

// CORS_ORIGIN from the test environment is http://localhost:3001 (see the CI unit-test env).
const ALLOWED = 'http://localhost:3001';

function makeApp() {
  const app = express();
  app.use(corsMiddleware);
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/mutate', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('CORS policy', () => {
  it('echoes an allowlisted origin with credentials enabled', async () => {
    const res = await request(makeApp()).get('/ping').set('Origin', ALLOWED);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('withholds CORS headers for a hostile origin without failing the request', async () => {
    const res = await request(makeApp()).get('/ping').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers a hostile preflight with an allow-origin header', async () => {
    const res = await request(makeApp())
      .options('/mutate')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.status).not.toBe(500);
  });

  it('never returns a wildcard allow-origin', async () => {
    const res = await request(makeApp()).get('/ping').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});
