import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * ADR 0044 §8, obligation 2: promoting `@modelcontextprotocol/sdk` to a
 * runtime dependency adds 82 packages to the production closure — itself
 * plus 81 dependencies, 254 real packages afterwards including
 * `@bananasaurs/mcp` — and the question that bounds the risk is which of
 * the heavy ones load into the daemon's process. The ruling, stated
 * exactly: `express`, `hono`, `cors`, `express-rate-limit`, `cross-spawn`,
 * `eventsource` and `jose` stay out — no second HTTP stack and no process
 * spawner in the daemon. **`ajv` is accepted and loaded.** It is a JSON
 * Schema validator doing pure computation, with no network, no child
 * processes and no filesystem writes, and Bananasaurs' own boundaries are
 * still Zod (hard rule 3), including every incoming tool call's arguments.
 * The honest cost: an `ajv` CVE is in the process rather than audit noise.
 *
 * This is a runtime probe of the module cache, not a static scan of imports.
 * A grep over `packages/mcp`'s imports would pass while a transitive import
 * three modules deep pulled Express in; the property worth defending is what
 * ends up in the process, so that is what this test measures. It loads the
 * package entry plus the two SDK server modules M4 uses and then asks
 * `require.cache` — via `createRequire`, because these are CJS packages and
 * ESM has no registry API to ask.
 *
 * Two traps this file has already fallen into, kept here so nobody
 * re-digs them. First, the probe scans cache keys for each package's
 * `node_modules/<pkg>/` directory instead of resolving one path per
 * package: npm may nest a second copy — the SDK resolves its own ajv 8
 * while the hoisted ajv 6 is eslint's — and a single `require.resolve`
 * from the repo root checks the wrong key and reports clean while the
 * nested copy sits in the process. The first version of this test did
 * exactly that, and ADR 0044's "zero loaded" claim came from the same
 * mistake: both asked about a package nobody loads and correctly answered
 * "no". Second, the match is on the package directory with a trailing
 * slash, so `ajv` does not match `ajv-formats` (or any other package that
 * merely starts with the same characters).
 *
 * `ajv` is asserted present rather than omitted: if a future SDK stops
 * loading it, this fails and someone reads ADR 0044 §8 again, which is the
 * correct outcome. And it is asserted to come from the SDK's own nested
 * `node_modules`, which is what distinguishes "the SDK validates schemas"
 * (expected) from "something else in the tree pulled in the hoisted ajv"
 * (a new fact worth failing on).
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const FORBIDDEN = [
  'express',
  'hono',
  'cors',
  'express-rate-limit',
  'cross-spawn',
  'eventsource',
  'jose',
];

const loadedFrom = (cache: NodeJS.Dict<unknown>, pkg: string): string[] =>
  Object.keys(cache).filter((k) => k.includes(`/node_modules/${pkg}/`));

describe('MCP SDK runtime surface (ADR 0044 §8)', () => {
  it('keeps the second HTTP stack and the process spawner out of the process', async () => {
    await import('./index.js');
    await import('@modelcontextprotocol/sdk/server/mcp.js');
    await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
    const { createRequire } = await import('node:module');
    const req = createRequire(REPO_ROOT);
    const found = FORBIDDEN.flatMap((pkg) =>
      loadedFrom(req.cache, pkg).map((path) => `${pkg}: ${path}`),
    );
    expect(found).toEqual([]);
  });

  it('loads ajv from the SDK’s own nested node_modules', async () => {
    await import('./index.js');
    await import('@modelcontextprotocol/sdk/server/mcp.js');
    await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
    const { createRequire } = await import('node:module');
    const req = createRequire(REPO_ROOT);
    const ajvPaths = loadedFrom(req.cache, 'ajv');
    expect(ajvPaths.length).toBeGreaterThan(0);
    expect(
      ajvPaths.some((p) => p.includes('/node_modules/@modelcontextprotocol/sdk/node_modules/ajv/')),
    ).toBe(true);
  });
});
