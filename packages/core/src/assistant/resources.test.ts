import { describe, expect, it } from 'vitest';
import { githubChildId, githubOrgId, parseResourceMeta } from './resources.js';

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

  it('keeps private: true for a private repository', () => {
    expect(parseResourceMeta('{"owner":"acme","repo":"w","private":true}')).toEqual({
      owner: 'acme',
      repo: 'w',
      private: true,
    });
  });

  it('keeps disabledByOwner: true for a resource the owner turned off', () => {
    expect(parseResourceMeta('{"owner":"acme","repo":"w","disabledByOwner":true}')).toEqual({
      owner: 'acme',
      repo: 'w',
      disabledByOwner: true,
    });
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

describe('github resource ids (Task 17)', () => {
  it('derives a short readable org id', () => {
    expect(githubOrgId('acme')).toBe('gh-acme');
  });

  it('derives a short readable child id for usual names', () => {
    const id = githubChildId('acme', 'widget');
    expect(id).toBe('gh-acme-widget');
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it('is deterministic and stays within 64 characters for very long names', () => {
    const id = githubChildId('a'.repeat(39), 'b'.repeat(100));
    expect(id).toBe(githubChildId('a'.repeat(39), 'b'.repeat(100)));
    expect(id.length).toBeLessThanOrEqual(64);
    expect(githubChildId('acme', 'widget')).not.toBe(githubChildId('acme', 'widget2'));
  });
});
