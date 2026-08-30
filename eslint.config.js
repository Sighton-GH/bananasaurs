import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * The one module that may reach Discord's REST API, and the directories allowed
 * to import it. The fifth layer of the permission model in
 * `docs/19_RELEASE_0_1_PLAN.md` §5: even code holding a forged authorization
 * witness cannot reach Discord except through the effect gateway.
 */
const REST_PORT = ['@bananasaurs/discord/rest', '@bananasaurs/discord/rest/*'];
const REST_MESSAGE =
  'The Discord REST port is importable only from packages/core/src/effects (the effect gateway) and the composition root in apps/daemon. See docs/19 §5 and ADR 0014: every Discord write passes the kill switch, breaker, rate cap, hierarchy check, idempotency and dry-run, all of which live in that one function.';

const DB = ['better-sqlite3', 'drizzle-orm', 'drizzle-orm/*'];
const DISCORD_JS = ['discord.js', 'discord.js/*'];

// The typescript-eslint rule id, deliberately, not the base one. The base
// `no-restricted-imports` is already set globally for the ADR 0013
// child_process ban, and flat config resolves a repeated rule id by
// last-wins — a per-directory block using the same id would silently drop
// that ban for those files.
const ban = (...groups) => ({
  '@typescript-eslint/no-restricted-imports': [
    'error',
    { patterns: groups.map(([names, message]) => ({ group: names, message })) },
  ],
});

const CORE_MESSAGE =
  'packages/core depends on port interfaces only (docs/19 §1, ADR 0014). Reaching discord.js, a database handle, or a concrete adapter from core breaks the seam that lets every test run with no network, and makes single-writer discipline remembered rather than structural.';

/**
 * Each directory gets exactly one block. Flat config resolves overlapping
 * `files` by last-wins *per rule*, so a second block naming the same directory
 * would silently replace the first block's restrictions rather than add to
 * them.
 *
 * @type {import('eslint').Linter.Config[]}
 */
const boundaryRules = [
  {
    files: ['packages/core/**/*.ts'],
    ignores: ['packages/core/src/effects/**'],
    rules: ban(
      [[...DISCORD_JS, ...DB, '@bananasaurs/storage'], CORE_MESSAGE],
      [['@bananasaurs/discord', '@bananasaurs/discord/*'], CORE_MESSAGE],
    ),
  },
  {
    // The effect gateway: the one place allowed to hold the REST port. It still
    // may not open a database or reach discord.js directly.
    files: ['packages/core/src/effects/**/*.ts'],
    rules: ban([[...DISCORD_JS, ...DB, '@bananasaurs/storage'], CORE_MESSAGE]),
  },
  {
    files: ['packages/http/**/*.ts'],
    rules: ban(
      [REST_PORT, REST_MESSAGE],
      [
        DISCORD_JS,
        'The dashboard API reaches Discord through the same effect gateway as everything else (docs/19 §1).',
      ],
    ),
  },
  {
    files: ['packages/cli/**/*.ts'],
    rules: ban(
      [REST_PORT, REST_MESSAGE],
      [
        [...DB, '@bananasaurs/storage'],
        'ADR 0013: the operator CLI reaches the daemon over the Unix socket and never opens the database. That is what keeps the single writer single, and what makes the CLI reuse the daemon validation, authorization and audit paths.',
      ],
    ),
  },
  {
    files: ['packages/dashboard/**/*.ts', 'packages/dashboard/**/*.tsx'],
    rules: ban([
      [
        ...REST_PORT,
        ...DB,
        ...DISCORD_JS,
        '@bananasaurs/storage',
        '@bananasaurs/http',
        '@bananasaurs/discord',
        '@bananasaurs/discord/*',
        'fastify',
        'node:*',
      ],
      'The dashboard builds to static assets with Vite and must not import server code (docs/19 §1). Talk to the API over HTTP.',
    ]),
  },
  {
    // packages/discord owns the REST port; it reaches it by relative path, not
    // by importing its own package name back through node_modules.
    files: ['packages/discord/**/*.ts'],
    rules: ban([REST_PORT, REST_MESSAGE]),
  },
  {
    files: ['packages/testkit/**/*.ts'],
    rules: ban(
      [REST_PORT, REST_MESSAGE],
      [
        ['@bananasaurs/storage', 'better-sqlite3'],
        'The fake harness implements port interfaces from core and must not reach storage. It is a devDependency of the other packages; a fake that can write to the database is one import away from running in production.',
      ],
    ),
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'node_modules/**',
      'scratchpad/**',
      'coverage/**',
      'drizzle/**',
      // Git worktrees live inside the repo, so a worktree is a full second copy
      // of every source file. Without this, eslint walks into it and reports a
      // parse error per file — the copies are in no tsconfig project, and could
      // not be: two projects claiming the same logical file is exactly what
      // `parserOptions.project` refuses. Nothing here needs linting; the
      // worktree's own checkout lints itself.
      '.claude/worktrees/**',
      // Plain-JS build helper. Covered by prettier; no type-aware rules apply.
      'scripts/**',
      // tsc --build's declaration-only output for packages/dashboard (ADR: a
      // Vite app still needs a composite tsconfig for the project-reference
      // graph, so `tsc --build` emits harmless .d.ts/.js stubs nobody reads —
      // Vite does the real bundling). Not `dist/`: that name is Vite's own
      // build output and already ignored.
      '**/dist-types/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Two projects, not one: `packages/dashboard`'s tsconfig pulls in the
        // DOM lib for `window`/`document`/`fetch`, and TypeScript's DOM lib
        // and `@types/node`'s own fetch-family globals conflict if merged
        // into the same program. `tsconfig.all.json` stays Node-only and
        // covers everything else; typescript-eslint resolves each linted file
        // against whichever of the two actually includes it.
        project: ['./tsconfig.all.json', './packages/dashboard/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',

      // ADR 0013. The rule is absolute, so it is worth a lint error rather than
      // relying on review to notice a child_process import in a handler.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'child_process',
              message:
                'ADR 0013: application code never spawns processes. If you need the claude binary, you are in the wrong design.',
            },
            {
              name: 'node:child_process',
              message:
                'ADR 0013: application code never spawns processes. If you need the claude binary, you are in the wrong design.',
            },
          ],
        },
      ],

      // Guild scope and idempotency are enforced structurally, but a cast can
      // launder anything. Make the bypass visible in a diff.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'TSAsExpression > TSTypeReference > Identifier[name=/^(Authorized|GuildScope|GuildId|SnowflakeId)$/]',
          message:
            'Casting to an authorization or guild-scope type defeats the check it exists to make. Obtain the value from authorize() or forGuild().',
        },
      ],
    },
  },

  // --- package boundaries (ADR 0014) --------------------------------------
  //
  // These were supposed to be enforced by the workspace manifests. They are
  // not: npm symlinks every workspace package into the root node_modules and
  // hoists external deps there, so `packages/core` importing `better-sqlite3`
  // typechecks cleanly despite core/package.json not listing it. Measured, not
  // assumed — see ADR 0014.
  //
  // Rules for packages that do not exist yet are inert and bite the moment the
  // directory appears, which is the point: WP5 inherits enforcement.
  ...boundaryRules,

  {
    files: ['**/*.test.ts', 'packages/testkit/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // A fake implementing an async port is synchronous underneath. The async
      // signature is required by the interface, so there is nothing to await
      // and the rule is a false positive here.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Tool config files pull in untyped plugin exports; type-aware rules add
    // noise here and catch nothing.
    files: [
      'eslint.config.js',
      'vitest.config.ts',
      '*.config.js',
      '*.config.ts',
      'scripts/**/*.mjs',
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
