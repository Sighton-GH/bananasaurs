import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Serves `packages/dashboard`'s built assets, with an SPA fallback to
 * `index.html` (`docs/19` §6.10).
 *
 * A manual handler rather than `@fastify/static`: it is one more dependency to
 * justify for a GET-only, single-directory case with no upload path and no
 * directory listing (ADR 0008 asks for a one-line reason on every new
 * dependency, and "twenty lines instead" is a shorter one).
 *
 * Registered as Fastify's not-found handler, so every `/api/*` route
 * registered by `registerReadRoutes` / `registerWriteRoutes` still matches
 * first — this only runs for a request nothing else claimed, which is exactly
 * the set of requests an SPA's client-side router is allowed to own.
 */
export const registerStaticAssets = (app: FastifyInstance, distDir: string): void => {
  const indexHtml = path.join(distDir, 'index.html');

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not-found' });
    }

    // `path.normalize` collapses a `..` segment against the leading `/`
    // rather than escaping past it (POSIX semantics), and the `startsWith`
    // check is a second, independent guard against the same thing — a
    // request path is untrusted input and gets both.
    const requestedPath = path.normalize(request.url.split('?')[0] ?? '/');
    const candidate = path.join(distDir, requestedPath);
    const filePath =
      candidate.startsWith(distDir) && (await fileExists(candidate)) ? candidate : indexHtml;

    return reply
      .status(200)
      .header('content-type', CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream')
      .send(createReadStream(filePath));
  });
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};
