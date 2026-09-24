import { describe, expect, it } from 'vitest';
import { parseGitHubUrl, rawGitHubUrl, selectRepoFiles } from './github.js';

describe('parseGitHubUrl', () => {
  it('parses a bare org/user URL as kind org', () => {
    expect(parseGitHubUrl('github.com/acme')).toEqual({ kind: 'org', owner: 'acme' });
  });

  it('parses an https org URL with a trailing slash as kind org', () => {
    expect(parseGitHubUrl('https://github.com/acme/')).toEqual({ kind: 'org', owner: 'acme' });
  });

  it('treats a GitHub user page the same as an org (shared /users/{owner}/repos)', () => {
    expect(parseGitHubUrl('https://github.com/octocat')).toEqual({ kind: 'org', owner: 'octocat' });
  });

  it('parses a bare repo URL', () => {
    expect(parseGitHubUrl('github.com/acme/widget')).toEqual({
      kind: 'repo',
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('strips a .git suffix', () => {
    expect(parseGitHubUrl('https://github.com/acme/widget.git')).toEqual({
      kind: 'repo',
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('parses a /tree/<ref>/<path> URL', () => {
    expect(parseGitHubUrl('https://github.com/acme/widget/tree/main/docs')).toEqual({
      kind: 'repo',
      owner: 'acme',
      repo: 'widget',
      ref: 'main',
      path: 'docs',
    });
  });

  it('parses a /blob/<ref>/<path> URL', () => {
    expect(parseGitHubUrl('https://github.com/acme/widget/blob/main/README.md')).toEqual({
      kind: 'repo',
      owner: 'acme',
      repo: 'widget',
      ref: 'main',
      path: 'README.md',
    });
  });

  it('parses a /tree/<ref> URL with no path as a repo target with only a ref', () => {
    expect(parseGitHubUrl('https://github.com/acme/widget/tree/main')).toEqual({
      kind: 'repo',
      owner: 'acme',
      repo: 'widget',
      ref: 'main',
    });
  });

  it('parses an unrecognised repo sub-path as a plain repo target', () => {
    expect(parseGitHubUrl('https://github.com/acme/widget/issues/5')).toEqual({
      kind: 'repo',
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('rejects non-GitHub hosts', () => {
    expect(parseGitHubUrl('https://gitlab.com/acme')).toBeUndefined();
    expect(parseGitHubUrl('https://github.com.evil.example/acme')).toBeUndefined();
  });

  it('rejects github.com/settings', () => {
    expect(parseGitHubUrl('https://github.com/settings')).toBeUndefined();
  });

  it('rejects github.com/orgs/<x>/...', () => {
    expect(parseGitHubUrl('https://github.com/orgs/acme/repositories')).toBeUndefined();
  });

  it('rejects a bare host with no owner segment', () => {
    expect(parseGitHubUrl('https://github.com')).toBeUndefined();
    expect(parseGitHubUrl('https://github.com/')).toBeUndefined();
  });

  it('rejects an owner starting with a hyphen', () => {
    expect(parseGitHubUrl('https://github.com/-bad')).toBeUndefined();
  });

  it('rejects malformed input', () => {
    expect(parseGitHubUrl('')).toBeUndefined();
    expect(parseGitHubUrl('ftp://github.com/acme')).toBeUndefined();
  });
});

describe('rawGitHubUrl', () => {
  it('builds the raw.githubusercontent.com URL', () => {
    expect(rawGitHubUrl('acme', 'widget', 'main', 'docs/setup.md')).toBe(
      'https://raw.githubusercontent.com/acme/widget/main/docs/setup.md',
    );
  });

  it('percent-encodes unsafe path segments', () => {
    expect(rawGitHubUrl('acme', 'widget', 'main', 'docs/a b.md')).toBe(
      'https://raw.githubusercontent.com/acme/widget/main/docs/a%20b.md',
    );
  });
});

describe('selectRepoFiles', () => {
  it('selects README, docs markdown, CONTRIBUTING, CHANGELOG and root markdown, README first', () => {
    const entries = [
      { path: 'src/index.ts', type: 'blob' as const },
      { path: 'docs/guide.md', type: 'blob' as const },
      { path: 'CONTRIBUTING.md', type: 'blob' as const },
      { path: 'CHANGELOG.md', type: 'blob' as const },
      { path: 'NOTES.md', type: 'blob' as const },
      { path: 'readme.txt', type: 'blob' as const },
      { path: 'docs', type: 'tree' as const },
    ];
    const selected = selectRepoFiles(entries);
    expect(selected[0]).toBe('readme.txt');
    expect(selected).toEqual(
      expect.arrayContaining(['readme.txt', 'docs/guide.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'NOTES.md']),
    );
    expect(selected).not.toContain('src/index.ts');
    expect(selected).not.toContain('docs');
  });

  it('excludes node_modules/, .github/ and vendor/', () => {
    const entries = [
      { path: 'README.md', type: 'blob' as const },
      { path: 'node_modules/pkg/README.md', type: 'blob' as const },
      { path: '.github/README.md', type: 'blob' as const },
      { path: 'vendor/lib/README.md', type: 'blob' as const },
      { path: 'docs/node_modules_notes.md', type: 'blob' as const },
    ];
    const selected = selectRepoFiles(entries);
    expect(selected).toContain('README.md');
    expect(selected).toContain('docs/node_modules_notes.md');
    expect(selected).not.toContain('node_modules/pkg/README.md');
    expect(selected).not.toContain('.github/README.md');
    expect(selected).not.toContain('vendor/lib/README.md');
  });

  it('caps at 40 files', () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      path: `docs/page-${String(i).padStart(2, '0')}.md`,
      type: 'blob' as const,
    }));
    expect(selectRepoFiles(entries)).toHaveLength(40);
  });

  it('drops files over 200 KB and stops adding once the 2 MB total is reached', () => {
    const entries = [
      { path: 'README.md', type: 'blob' as const, size: 1_000 },
      { path: 'docs/huge.md', type: 'blob' as const, size: 250_000 }, // over the 200 KB per-file cap
      ...Array.from({ length: 10 }, (_, i) => ({
        path: `docs/big-${i}.md`,
        type: 'blob' as const,
        size: 300_000, // 10 * 300,000 = 3,000,000 > 2,000,000 total cap
      })),
    ];
    const selected = selectRepoFiles(entries);
    expect(selected).not.toContain('docs/huge.md');
    expect(selected).toContain('README.md');
    expect(selected.length).toBeLessThan(11);
  });

  it('honours a caller-supplied include glob, still excluding node_modules/', () => {
    const entries = [
      { path: 'src/app.ts', type: 'blob' as const },
      { path: 'src/lib.ts', type: 'blob' as const },
      { path: 'node_modules/dep/index.ts', type: 'blob' as const },
      { path: 'README.md', type: 'blob' as const },
    ];
    const selected = selectRepoFiles(entries, { include: ['src/**/*.ts'] });
    expect(selected).toEqual(expect.arrayContaining(['src/app.ts', 'src/lib.ts']));
    expect(selected).not.toContain('README.md');
    expect(selected).not.toContain('node_modules/dep/index.ts');
  });
});
