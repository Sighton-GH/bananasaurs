import { describe, expect, it, vi } from 'vitest';
import { createGitHubClient } from './github-client.js';
import { createGithubFetch, githubGuard } from './github-fetch.js';

const publicAddr = { address: '140.82.114.6', family: 4 as const };

const pinnedOk = (body: unknown) => ({
  status: 200,
  headers: { 'content-type': 'application/json' } as Readonly<Record<string, string | undefined>>,
  body: (async function* () {
    yield Buffer.from(JSON.stringify(body), 'utf8');
  })(),
});

describe('githubGuard', () => {
  it('allows api.github.com over https', async () => {
    await expect(githubGuard(new URL('https://api.github.com/repos/a/b'))).resolves.toBeUndefined();
  });

  it('allows raw.githubusercontent.com over https', async () => {
    await expect(
      githubGuard(new URL('https://raw.githubusercontent.com/a/b/main/README.md')),
    ).resolves.toBeUndefined();
  });

  it('refuses a non-GitHub host', async () => {
    await expect(githubGuard(new URL('https://example.com/x'))).rejects.toThrow();
  });

  it('refuses lookalike hosts', async () => {
    await expect(githubGuard(new URL('https://api.github.com.evil.com/x'))).rejects.toThrow();
    await expect(githubGuard(new URL('https://github.com/a/b'))).rejects.toThrow();
  });

  it('refuses non-https', async () => {
    await expect(githubGuard(new URL('http://api.github.com/x'))).rejects.toThrow();
  });
});

describe('githubFetch adapter', () => {
  it('refuses a non-GitHub host before any resolve or request', async () => {
    const resolve = vi.fn(async () => [publicAddr]);
    const request = vi.fn(async () => pinnedOk({ ok: true }));
    const fetch = createGithubFetch({ resolve, request });
    await expect(fetch('https://example.com/x')).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a private resolved address', async () => {
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);
    const request = vi.fn(async () => pinnedOk({ ok: true }));
    const fetch = createGithubFetch({ resolve, request });
    await expect(fetch('https://api.github.com/repos/a/b')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses when any resolved address is non-public', async () => {
    const resolve = vi.fn(async () => [publicAddr, { address: '10.0.0.1', family: 4 as const }]);
    const request = vi.fn(async () => pinnedOk({ ok: true }));
    const fetch = createGithubFetch({ resolve, request });
    await expect(fetch('https://api.github.com/repos/a/b')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('returns the pinned body as a Response', async () => {
    const resolve = vi.fn(async () => [publicAddr]);
    const request = vi.fn(async () => pinnedOk({ hello: 'world' }));
    const fetch = createGithubFetch({ resolve, request });
    const res = await fetch('https://api.github.com/repos/a/b');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ hello: 'world' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('forwards the Authorization header and never includes the token in an error', async () => {
    const resolve = vi.fn(async () => [publicAddr]);
    let seenAuth: string | undefined;
    const request = vi.fn(
      async (
        _url: URL,
        _addr: { address: string; family: 4 | 6 },
        _timeout: number,
        extra?: Readonly<Record<string, string>>,
      ) => {
        seenAuth = extra?.authorization ?? extra?.Authorization;
        return pinnedOk({ tree: [], truncated: false });
      },
    );
    const fetch = createGithubFetch({ resolve, request });
    const client = createGitHubClient({
      token: () => 'ghp_super_secret_token',
      fetch,
      guard: githubGuard,
    });
    await client.listTree('acme', 'widget', 'main');
    expect(seenAuth).toBe('Bearer ghp_super_secret_token');

    const failingRequest = vi.fn(async () => {
      throw new Error('socket hung up');
    });
    const failingFetch = createGithubFetch({ resolve, request: failingRequest });
    const failingClient = createGitHubClient({
      token: () => 'ghp_super_secret_token',
      fetch: failingFetch,
      guard: githubGuard,
    });
    const error = await failingClient.getRepo('acme', 'widget').catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('ghp_super_secret_token');
    expect(JSON.stringify(error)).not.toContain('ghp_super_secret_token');
  });

  it('enforces the 1 MB response cap', async () => {
    const resolve = vi.fn(async () => [publicAddr]);
    const big = Buffer.alloc(1_000_001, 65);
    const request = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: (async function* () {
        yield big;
      })(),
    }));
    const fetch = createGithubFetch({ resolve, request, maxBytes: 1_000_000 });
    await expect(fetch('https://api.github.com/repos/a/b')).rejects.toThrow(/size/i);
  });
});
