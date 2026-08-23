import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'node_modules/**',
      'scratchpad/**',
      'coverage/**',
      'drizzle/**',
      // Plain-JS build helper. Covered by prettier; no type-aware rules apply.
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.all.json', tsconfigRootDir: import.meta.dirname },
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
            'TSAsExpression > TSTypeReference > Identifier[name=/^(Authorized|GuildScope|GuildId)$/]',
          message:
            'Casting to an authorization or guild-scope type defeats the check it exists to make. Obtain the value from authorize() or forGuild().',
        },
      ],
    },
  },
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
