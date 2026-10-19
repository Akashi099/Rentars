import { describe, expect, it } from 'bun:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { csrfMiddleware, csrfTokenMiddleware } from '../../src/middleware/csrf.middleware.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(csrfTokenMiddleware);
  app.use(csrfMiddleware);
  app.get('/safe', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/mutation', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

async function csrfCookieFrom(app: express.Express) {
  const res = await request(app).get('/safe');
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  const cookie = setCookie.find((c) => c.startsWith('__Host-csrf-token='));
  return cookie?.split(';')[0] ?? '';
}

describe('CSRF — Bearer-authenticated mutations', () => {
  const app = makeApp();

  it('accepts a Bearer POST without a CSRF header or cookie', async () => {
    const res = await request(app)
      .post('/mutation')
      .set('Authorization', 'Bearer some.jwt.token')
      .send({ data: 'test' });
    expect(res.status).toBe(200);
  });

  it('accepts a Bearer POST whose CSRF header does not match the cookie', async () => {
    const cookie = await csrfCookieFrom(app);
    const res = await request(app)
      .post('/mutation')
      .set('Authorization', 'Bearer some.jwt.token')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'wrong-token')
      .send({ data: 'test' });
    expect(res.status).toBe(200);
  });

  it('does not treat a non-Bearer Authorization header as a bypass', async () => {
    const res = await request(app)
      .post('/mutation')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .send({ data: 'test' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_MISSING');
  });

  it('does not treat an empty Bearer header as a bypass', async () => {
    const res = await request(app)
      .post('/mutation')
      .set('Authorization', 'Bearer ')
      .send({ data: 'test' });
    expect(res.status).toBe(403);
  });
});

describe('CSRF — cookie-only cross-site mutations', () => {
  const app = makeApp();

  it('rejects a POST that has no Authorization header and no CSRF token', async () => {
    const res = await request(app)
      .post('/mutation')
      .set('Origin', 'https://evil.example')
      .send({ data: 'test' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_MISSING');
  });

  it('rejects a POST that replays the cookie without the matching header', async () => {
    const cookie = await csrfCookieFrom(app);
    const res = await request(app)
      .post('/mutation')
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie)
      .send({ data: 'test' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_MISSING');
  });
});
