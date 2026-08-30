import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../server.js';

/**
 * `packages/dashboard` may not import `@bananasaurs/http` (the boundary rule
 * in `eslint.config.js`), so `packages/dashboard/src/api.ts` hard-codes the
 * CSRF header name rather than importing `CSRF_HEADER`. That leaves exactly
 * one way for the two to drift: someone renames the constant here and does
 * not know to update the literal there. This test is that connection — it
 * reads the dashboard's source file rather than importing it, so it survives
 * even though the two packages cannot see each other at the type level.
 */
describe('the dashboard’s hard-coded CSRF header agrees with CSRF_HEADER', () => {
  it('matches the literal in packages/dashboard/src/api.ts', () => {
    const apiTs = readFileSync(
      fileURLToPath(new URL('../../../dashboard/src/api.ts', import.meta.url)),
      'utf-8',
    );
    const match = /export const CSRF_HEADER = '([^']+)'/.exec(apiTs);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(CSRF_HEADER);
  });
});
