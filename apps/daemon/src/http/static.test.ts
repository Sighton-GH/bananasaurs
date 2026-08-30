import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerStaticAssets } from './static.js';

let dir: string;
let app: FastifyInstance;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bananasaurs-static-'));
  writeFileSync(path.join(dir, 'index.html'), '<html>spa shell</html>');
  writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');

  app = Fastify({ logger: false });
  app.get('/api/known', (_request, reply) => reply.status(200).send({ ok: true }));
  registerStaticAssets(app, dir);
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('registerStaticAssets', () => {
  it('lets a registered /api/* route match first', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/known' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('answers 404 for an unmatched /api/* path, never the SPA shell', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not-found' });
  });

  it('serves a real static file with its content type', async () => {
    const response = await app.inject({ method: 'GET', url: '/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.body).toBe('console.log(1);');
  });

  it('falls back to index.html for a client-side route', async () => {
    const response = await app.inject({ method: 'GET', url: '/bootstrap' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toBe('<html>spa shell</html>');
  });

  it('falls back to index.html rather than escaping the dist directory', async () => {
    // A `..` in the request path must not reach a file outside `dir` — the
    // fallback is the SPA shell, the same as any other path nothing claims.
    const response = await app.inject({ method: 'GET', url: '/../../../../etc/passwd' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<html>spa shell</html>');
  });
});
