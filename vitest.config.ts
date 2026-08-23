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
      '@bananasaurs/storage': src('./packages/storage/src/index.ts'),
      '@bananasaurs/testkit': src('./packages/testkit/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    coverage: { provider: 'v8', include: ['packages/*/src/**', 'apps/*/src/**'] },
  },
});
