import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * ADR 0044 §8, obligation 2: promoting `@modelcontextprotocol/sdk` to a
 * runtime dependency adds 82 packages to the production closure — itself
 * plus 81 dependencies, 254 real packages afterwards including
 * `@bananasaurs/mcp` — and the number that bounds the risk is how many of
 * the heavy ones load into the daemon's process: zero.
 *
 * This is a runtime probe of the module cache, not a static scan of imports.
 * A grep over `packages/mcp`'s imports would pass while a transitive import
 * three modules deep pulled Express in; the property worth defending is what
 * ends up in the process, so that is what this test measures. It loads the
 * package entry plus the two SDK server modules M4 uses and then asks
 * `require.cache` — via `createRequire`, because these are CJS packages and
 * ESM has no registry API to ask — whether any of the heavy transitive
 * packages (`express`, `hono`, `cors`, `express-rate-limit`, `ajv`,
 * `cross-spawn`, `eventsource`, `jose`) arrived with them. Importing the
 * SDK's auth router, Express transport, or client modules would turn this
 * red; that is what keeps a CVE in `express` audit noise rather than an
 * exposure in the running daemon.
 *
 * The probe scans cache keys for each package's `node_modules/<pkg>/`
 * directory instead of resolving one path per package. npm may nest a
 * second copy — the SDK resolves its own ajv 8 while the hoisted ajv 6 is
 * eslint's — and a single `require.resolve` from the repo root would check
 * the wrong key and report clean while the nested copy sat in the process.
 * The match is on the package directory with a trailing slash, so `ajv`
 * does not match `ajv-formats` (or any other package that merely starts
 * with the same characters).
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const HEAVY = [
  'express',
  'hono',
  'cors',
  'express-rate-limit',
  'ajv',
  'cross-spawn',
  'eventsource',
  'jose',
];

const loadedFrom = (cache: NodeJS.Dict<unknown>, pkg: string): string[] =>
  Object.keys(cache).filter((k) => k.includes(`/node_modules/${pkg}/`));

describe('MCP SDK runtime surface (ADR 0044 §8)', () => {
  it("loads none of the SDK's heavy transitive packages", async () => {
    await import('./index.js');
    await import('@modelcontextprotocol/sdk/server/mcp.js');
    await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
    const { createRequire } = await import('node:module');
    const req = createRequire(REPO_ROOT);
    const found = HEAVY.flatMap((pkg) =>
      loadedFrom(req.cache, pkg).map((path) => `${pkg}: ${path}`),
    );
    expect(found).toEqual([]);
  });
});
