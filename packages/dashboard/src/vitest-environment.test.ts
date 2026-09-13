import { describe, expect, it } from 'vitest';
import config from '../../../vitest.config.js';

describe('the vitest default environment', () => {
  it('is node, so dashboard tests must opt into jsdom per file', () => {
    expect(config.test?.environment).toBe('node');
    expect(config.test?.include).toContain('packages/**/*.test.tsx');
  });
});
