import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR 0014: package boundaries are enforced by per-directory lint rules,
 * because the workspace manifests enforce nothing — npm symlinks every
 * workspace package into the root node_modules and hoists external deps there,
 * so `packages/core` can import `better-sqlite3` and typecheck cleanly.
 *
 * A lint rule that lives only in a config file gets deleted by whoever it
 * blocks. This test reads the real `eslint.config.js` and fails if a rule is
 * removed, which turns a boundary regression into a failing suite rather than
 * something to notice in review.
 *
 * Most paths below name packages that do not exist yet (`http`, `cli`,
 * `dashboard`, `discord`). `calculateConfigForFile` resolves a config for a
 * path regardless, so WP5 inherits enforcement instead of having to remember
 * it. This test lives in `core` because core is the package every one of these
 * rules exists to protect.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: REPO_ROOT });

interface RestrictedPattern {
  group?: string[];
  message?: string;
}

/** Every module pattern banned for `filePath` by the given rule. */
const bannedFor = async (filePath: string, ruleId: string): Promise<string[]> => {
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, filePath));
  const entry = (config as { rules?: Record<string, unknown> }).rules?.[ruleId];
  if (!Array.isArray(entry)) return [];
  const options = entry[1] as { patterns?: RestrictedPattern[] } | undefined;
  return (options?.patterns ?? []).flatMap((p) => p.group ?? []);
};

const BOUNDARY_RULE = '@typescript-eslint/no-restricted-imports';
const REST_PORT = '@bananasaurs/discord/rest';

describe('packages/core may not reach concrete infrastructure', () => {
  it.each(['discord.js', 'better-sqlite3', 'drizzle-orm', '@bananasaurs/storage'])(
    'bans %s',
    async (module) => {
      expect(await bannedFor('packages/core/src/discord/port.ts', BOUNDARY_RULE)).toContain(module);
    },
  );

  it('bans the discord adapter package outright, not only its rest subpath', async () => {
    expect(await bannedFor('packages/core/src/discord/port.ts', BOUNDARY_RULE)).toContain(
      '@bananasaurs/discord',
    );
  });
});

describe('the effect gateway is the exception, and only for the REST port', () => {
  const gateway = 'packages/core/src/effects/gateway.ts';

  it('may import the REST port', async () => {
    expect(await bannedFor(gateway, BOUNDARY_RULE)).not.toContain(REST_PORT);
  });

  it.each(['discord.js', 'better-sqlite3', 'drizzle-orm', '@bananasaurs/storage'])(
    'still may not import %s',
    async (module) => {
      expect(await bannedFor(gateway, BOUNDARY_RULE)).toContain(module);
    },
  );
});

describe('nothing outside the effect gateway may reach the REST port', () => {
  it.each([
    ['http', 'packages/http/src/routes.ts'],
    ['cli', 'packages/cli/src/main.ts'],
    ['dashboard', 'packages/dashboard/src/App.tsx'],
    ['discord', 'packages/discord/src/adapter.ts'],
    ['testkit', 'packages/testkit/src/fake-discord.ts'],
  ])('%s cannot import it', async (_pkg, filePath) => {
    expect(await bannedFor(filePath, BOUNDARY_RULE)).toContain(REST_PORT);
  });
});

describe('ADR 0013 — the CLI never opens the database', () => {
  it.each(['@bananasaurs/storage', 'better-sqlite3', 'drizzle-orm'])(
    'bans %s in the CLI',
    async (module) => {
      expect(await bannedFor('packages/cli/src/main.ts', BOUNDARY_RULE)).toContain(module);
    },
  );
});

describe('the dashboard cannot import server code', () => {
  it.each(['@bananasaurs/storage', '@bananasaurs/http', 'fastify', 'discord.js', 'node:*'])(
    'bans %s',
    async (module) => {
      expect(await bannedFor('packages/dashboard/src/App.tsx', BOUNDARY_RULE)).toContain(module);
    },
  );
});

describe('the fake harness cannot reach storage', () => {
  it('bans @bananasaurs/storage in testkit', async () => {
    expect(await bannedFor('packages/testkit/src/fake-discord.ts', BOUNDARY_RULE)).toContain(
      '@bananasaurs/storage',
    );
  });
});

describe('the boundary rules do not displace the ADR 0013 process ban', () => {
  /**
   * The regression this guards against is real and was nearly shipped. Flat
   * config resolves a repeated rule id by last-wins, so a per-directory block
   * using the base `no-restricted-imports` id would silently drop the global
   * child_process ban for exactly the directories that most need it. The
   * boundary rules therefore use the typescript-eslint rule id instead.
   */
  it.each([
    'packages/core/src/discord/port.ts',
    'packages/core/src/effects/gateway.ts',
    'packages/cli/src/main.ts',
    'packages/testkit/src/fake-discord.ts',
  ])('child_process is still banned in %s', async (filePath) => {
    const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, filePath));
    const entry = (config as { rules?: Record<string, unknown> }).rules?.['no-restricted-imports'];
    expect(Array.isArray(entry)).toBe(true);
    const options = Array.isArray(entry)
      ? (entry[1] as { paths?: { name?: string }[] } | undefined)
      : undefined;
    expect((options?.paths ?? []).map((p) => p.name)).toContain('node:child_process');
  });
});

describe('the rules actually fire, not merely resolve', () => {
  it('reports a restricted import in core', async () => {
    const results = await eslint.lintText(
      "import Database from 'better-sqlite3';\nexport const x = Database;\n",
      { filePath: path.join(REPO_ROOT, 'packages/core/src/ids.ts') },
    );
    const messages = results[0]?.messages ?? [];
    expect(messages.map((m) => m.ruleId)).toContain(BOUNDARY_RULE);
    expect(messages[0]?.message).toMatch(/port interfaces only/);
  });

  it('does not report an import that is allowed', async () => {
    const results = await eslint.lintText("import { z } from 'zod';\nexport const x = z;\n", {
      filePath: path.join(REPO_ROOT, 'packages/core/src/ids.ts'),
    });
    const messages = results[0]?.messages ?? [];
    expect(messages.map((m) => m.ruleId)).not.toContain(BOUNDARY_RULE);
  });

  /**
   * `packages/http` and `packages/dashboard` are no longer hypothetical.
   *
   * Their rules were written in slice 13a's ADR 0014 pass, before the
   * directories existed, and were inert until slice 14 created them — exactly
   * as `packages/cli`'s were. These cases lint a real path inside each, so the
   * rules are now shown to fire against files that exist rather than only to
   * resolve for paths that might.
   */
  it('reports discord.js in packages/http', async () => {
    const results = await eslint.lintText(
      "import { Client } from 'discord.js';\nexport const x = Client;\n",
      { filePath: path.join(REPO_ROOT, 'packages/http/src/server.ts') },
    );
    const messages = results[0]?.messages ?? [];
    expect(messages.map((m) => m.ruleId)).toContain(BOUNDARY_RULE);
    expect(messages[0]?.message).toMatch(/effect gateway/);
  });

  it('allows @bananasaurs/storage in packages/http, which is how it reads a session', async () => {
    // The API is the one package outside the daemon that legitimately holds a
    // scope: ADR 0014 keeps the handle out of `core`, not out of `http`.
    const results = await eslint.lintText(
      "import { accountRepo } from '@bananasaurs/storage';\nexport const x = accountRepo;\n",
      { filePath: path.join(REPO_ROOT, 'packages/http/src/auth.ts') },
    );
    const messages = results[0]?.messages ?? [];
    expect(messages.map((m) => m.ruleId)).not.toContain(BOUNDARY_RULE);
  });

  /**
   * There is deliberately no `lintText` case for `packages/dashboard` yet.
   *
   * `lintText` runs the typed parser, which needs the file to belong to a
   * tsconfig — so a path inside a directory that does not exist reports a
   * parse error whose `ruleId` is `null`, and an assertion against it passes or
   * fails for reasons that have nothing to do with the boundary. The
   * `calculateConfigForFile` cases above already prove the dashboard's rules
   * resolve; the firing case belongs with the slice that creates the package.
   */
});
