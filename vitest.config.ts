import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to SOURCE, not dist. Without this, vitest
    // reads the last build output, so a test can pass against code that no
    // longer exists and fail against code that was never built. Discovered the
    // hard way: a new export was invisible to the suite until `npm run build`.
    alias: {
      '@bananasaurs/core': src('./packages/core/src/index.ts'),
      // The REST port keeps its own alias, and it must come first: vitest
      // matches string aliases by prefix, so a bare '@bananasaurs/discord'
      // entry listed above this one would swallow the subpath and resolve
      // `/rest` to the package index. ADR 0014 §4 makes `/rest` the only way
      // in; an alias that quietly widened it would defeat that in tests only,
      // which is the worst place for a boundary to be softer than production.
      '@bananasaurs/discord/rest': src('./packages/discord/src/rest/index.ts'),
      '@bananasaurs/discord': src('./packages/discord/src/index.ts'),
      '@bananasaurs/storage/test-support': src('./packages/storage/src/test-support.ts'),
      '@bananasaurs/storage': src('./packages/storage/src/index.ts'),
      '@bananasaurs/http': src('./packages/http/src/index.ts'),
      '@bananasaurs/testkit': src('./packages/testkit/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'apps/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    environment: 'node',
    coverage: { provider: 'v8', include: ['packages/*/src/**', 'apps/*/src/**'] },
  },
});
