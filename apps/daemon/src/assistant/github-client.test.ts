import { describe, expect, it, vi } from 'vitest';
import { createGitHubClient, GitHubError } from './github-client.js';

const ok = (value: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

const repoItem = (
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name,
  description: `${name} description`,
  default_branch: 'main',
  fork: false,
  archived: false,
  private: false,
  ...overrides,
});

const noopGuard = async (): Promise<void> => {
  // no-op: tests supply their own guard when they need to assert on it
};

describe('createGitHubClient — auth and headers', () => {
  it('sets authenticated true and sends the Authorization header only when a token is present', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(ok({ tree: [], truncated: false }));
    const client = createGitHubClient({ token: () => 'ghp_secret', fetch, guard: noopGuard });
    expect(client.authenticated).toBe(true);
    await client.listTree('acme', 'widget', 'main');
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ghp_secret');
  });

  it('sets authenticated false and omits Authorization when token() returns undefined', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(ok({ tree: [], truncated: false }));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    expect(client.authenticated).toBe(false);
    await client.listTree('acme', 'widget', 'main');
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('treats an empty-string token the same as no token', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(ok({ tree: [], truncated: false }));
    const client = createGitHubClient({ token: () => '', fetch, guard: noopGuard });
    expect(client.authenticated).toBe(false);
  });

  it('authenticated follows the current token, so a token saved later takes effect at once', async () => {
    let token: string | undefined;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(ok({ tree: [], truncated: false }));
    const client = createGitHubClient({ token: () => token, fetch, guard: noopGuard });
    expect(client.authenticated).toBe(false);
    token = 'test-token';
    expect(client.authenticated).toBe(true);
    await client.listTree('acme', 'widget', 'main');
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
  });

  it('never logs or returns the token in an error', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 404 }));
    const client = createGitHubClient({ token: () => 'ghp_super_secret', fetch, guard: noopGuard });
    const error = await client.getRepo('acme', 'widget').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(JSON.stringify(error)).not.toContain('ghp_super_secret');
    expect((error as Error).message).not.toContain('ghp_super_secret');
  });

  it('sends the required Accept, API version and User-Agent headers on every request', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(ok({ tree: [], truncated: false }));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    await client.listTree('acme', 'widget', 'main');
    const init = fetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('user-agent')).toBe('Bananasaurs');
  });
});

describe('createGitHubClient — guard', () => {
  it('calls guard with the request URL before every fetch', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(ok({ tree: [], truncated: false }));
    const guard = vi.fn<(url: URL) => Promise<void>>().mockResolvedValue(undefined);
    const client = createGitHubClient({ token: () => undefined, fetch, guard });
    await client.listTree('acme', 'widget', 'main');
    expect(guard).toHaveBeenCalledTimes(1);
    const guardedUrl = guard.mock.calls[0]?.[0];
    expect(guardedUrl).toBeInstanceOf(URL);
    expect(guardedUrl?.hostname).toBe('api.github.com');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never calls fetch when guard rejects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const guard = vi.fn<(url: URL) => Promise<void>>().mockRejectedValue(new Error('blocked'));
    const client = createGitHubClient({ token: () => undefined, fetch, guard });
    await expect(client.listTree('acme', 'widget', 'main')).rejects.toThrow('blocked');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createGitHubClient — listOrgRepos', () => {
  it('paginates with per_page=100 and maps the fields', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(ok([repoItem('one'), repoItem('two', { fork: true })]));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const { repos, truncated } = await client.listOrgRepos('acme');
    expect(truncated).toBe(false);
    expect(repos).toEqual([
      {
        name: 'one',
        description: 'one description',
        defaultBranch: 'main',
        fork: false,
        archived: false,
        private: false,
      },
      {
        name: 'two',
        description: 'two description',
        defaultBranch: 'main',
        fork: true,
        archived: false,
        private: false,
      },
    ]);
    const url = new URL(fetch.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/orgs/acme/repos');
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.get('type')).toBe('all');
    expect(url.searchParams.get('page')).toBe('1');
  });

  it('returns private repos from the org path', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(ok([repoItem('secret', { private: true })]));
    const client = createGitHubClient({ token: () => 'test-token', fetch, guard: noopGuard });
    const { repos } = await client.listOrgRepos('acme');
    expect(new URL(fetch.mock.calls[0]?.[0] as string).pathname).toBe('/orgs/acme/repos');
    expect(repos).toEqual([
      {
        name: 'secret',
        description: 'secret description',
        defaultBranch: 'main',
        fork: false,
        archived: false,
        private: true,
      },
    ]);
  });

  it('falls back to the users path when the orgs first page answers 404', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(ok([repoItem('one')]));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const { repos } = await client.listOrgRepos('acme');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[0]?.[0] as string).pathname).toBe('/orgs/acme/repos');
    const fallbackUrl = new URL(fetch.mock.calls[1]?.[0] as string);
    expect(fallbackUrl.pathname).toBe('/users/acme/repos');
    expect(fallbackUrl.searchParams.get('type')).toBe('owner');
    expect(repos.map((r) => r.name)).toEqual(['one']);
  });

  it('stops paginating after 5 pages even if every page is full', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => repoItem(`repo-${i}`));
    // A fresh Response per call: Response.json() consumes the body stream,
    // so reusing one instance across calls would break every call after the
    // first.
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(ok(fullPage)));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const { repos, truncated } = await client.listOrgRepos('acme');
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(repos).toHaveLength(500);
    expect(truncated).toBe(true);
    const pages = fetch.mock.calls.map((call) =>
      new URL(call[0] as string).searchParams.get('page'),
    );
    expect(pages).toEqual(['1', '2', '3', '4', '5']);
  });

  it('stops paginating early once a page is not full', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => repoItem(`repo-${i}`));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(ok(fullPage))
      .mockResolvedValueOnce(ok([repoItem('last')]));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const { repos, truncated } = await client.listOrgRepos('acme');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(repos).toHaveLength(101);
    expect(truncated).toBe(false);
  });
});

describe('createGitHubClient — getRepo', () => {
  it('maps defaultBranch, description and private', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(ok({ default_branch: 'develop', description: 'A widget', private: true }));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    await expect(client.getRepo('acme', 'widget')).resolves.toEqual({
      defaultBranch: 'develop',
      description: 'A widget',
      private: true,
    });
  });
});

describe('createGitHubClient — listTree', () => {
  it('maps entries and the truncated flag, keeping only blob and tree types', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      ok({
        tree: [
          { path: 'README.md', type: 'blob', size: 120 },
          { path: 'docs', type: 'tree' },
          { path: 'vendor/lib', type: 'commit' },
        ],
        truncated: true,
      }),
    );
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const result = await client.listTree('acme', 'widget', 'main');
    expect(result).toEqual({
      entries: [
        { path: 'README.md', type: 'blob', size: 120 },
        { path: 'docs', type: 'tree' },
      ],
      truncated: true,
    });
  });
});

describe('createGitHubClient — getFileRaw', () => {
  it('requests the contents URL with the raw accept type and the token', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('hello', { status: 200, headers: { etag: '"v1"' } }));
    const client = createGitHubClient({ token: () => 'test-token', fetch, guard: noopGuard });
    const result = await client.getFileRaw('acme', 'widget', 'main', 'docs/a b.md');
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/acme/widget/contents/docs/a%20b.md?ref=main',
    );
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('accept')).toBe('application/vnd.github.raw+json');
    expect(headers.get('authorization')).toBe('Bearer test-token');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('user-agent')).toBe('Bananasaurs');
    expect(result).toEqual({ notModified: false, text: 'hello', etag: '"v1"' });
  });

  it('omits Authorization when no token is set and sends if-none-match when an etag is given', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('hello', { status: 200 }));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const result = await client.getFileRaw('acme', 'widget', 'main', 'README.md', '"v1"');
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.get('if-none-match')).toBe('"v1"');
    expect(result).toEqual({ notModified: false, text: 'hello' });
  });

  it('maps a 304 to notModified', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue({ status: 304, headers: new Headers() } as Response);
    const client = createGitHubClient({ token: () => 'test-token', fetch, guard: noopGuard });
    await expect(client.getFileRaw('acme', 'widget', 'main', 'README.md', '"v1"')).resolves.toEqual(
      { notModified: true },
    );
  });

  it('maps a 404 to a not-found GitHubError', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 404 }));
    const client = createGitHubClient({ token: () => 'test-token', fetch, guard: noopGuard });
    const error = await client.getFileRaw('acme', 'widget', 'main', 'missing.md').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe('not-found');
  });
});

describe('createGitHubClient — errors', () => {
  it('maps a 404 to a not-found GitHubError', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 404 }));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const error = await client.getRepo('acme', 'missing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe('not-found');
  });

  it('maps a 403 with x-ratelimit-remaining: 0 to rate-limited with resetAt from x-ratelimit-reset', async () => {
    const resetEpochSeconds = 1_893_456_000;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) },
      }),
    );
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const error = await client.getRepo('acme', 'widget').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe('rate-limited');
    expect((error as GitHubError).resetAt).toBe(resetEpochSeconds * 1000);
  });

  it('a plain 403 without the rate-limit headers is a network error, not rate-limited', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 403 }));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const error = await client.getRepo('acme', 'widget').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe('network');
  });

  it('maps invalid JSON to invalid-response', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const error = await client.getRepo('acme', 'widget').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe('invalid-response');
  });

  it('maps a response shaped wrong for the schema to invalid-response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(ok({ nope: true }));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const error = await client.getRepo('acme', 'widget').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe('invalid-response');
  });

  it('maps a fetch rejection to a network error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('ECONNRESET'));
    const client = createGitHubClient({ token: () => undefined, fetch, guard: noopGuard });
    const error = await client.getRepo('acme', 'widget').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe('network');
  });
});
