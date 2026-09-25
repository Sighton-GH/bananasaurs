import { describe, expect, it } from 'vitest';
import { parseResourceMeta } from './resources.js';

describe('parseResourceMeta (Task 17)', () => {
  it('parses a full github-repo meta', () => {
    expect(
      parseResourceMeta(
        JSON.stringify({
          owner: 'acme',
          repo: 'widget',
          branch: 'main',
          include: ['README.md', 'docs/**'],
          autoDiscovered: true,
          includeForks: false,
          includeArchived: false,
        }),
      ),
    ).toEqual({
      owner: 'acme',
      repo: 'widget',
      branch: 'main',
      include: ['README.md', 'docs/**'],
      autoDiscovered: true,
      includeForks: false,
      includeArchived: false,
    });
  });

  it('parses an org meta with only the owner', () => {
    expect(parseResourceMeta(JSON.stringify({ owner: 'acme' }))).toEqual({ owner: 'acme' });
  });

  it('reads null and undefined as undefined', () => {
    expect(parseResourceMeta(null)).toBeUndefined();
    expect(parseResourceMeta(undefined)).toBeUndefined();
  });

  it('reads corrupt JSON as undefined instead of throwing', () => {
    expect(parseResourceMeta('not-json{')).toBeUndefined();
  });

  it('reads schema-invalid JSON as undefined instead of throwing', () => {
    expect(parseResourceMeta(JSON.stringify({ repo: 'widget' }))).toBeUndefined();
    expect(parseResourceMeta(JSON.stringify(null))).toBeUndefined();
    expect(parseResourceMeta(JSON.stringify({ owner: '' }))).toBeUndefined();
    expect(
      parseResourceMeta(JSON.stringify({ owner: 'acme', include: 'README.md' })),
    ).toBeUndefined();
  });
});
