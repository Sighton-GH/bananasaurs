import { describe, expect, it, vi } from 'vitest';
import {
  isPublicAddress,
  ReviewedResourceFetcher,
  type PinnedRequest,
  type PinnedResponse,
  type ResolveHost,
} from './resource-fetcher.js';

const body = async function* (text: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(text);
};
const response = (
  status: number,
  text = '',
  headers: Record<string, string> = { 'content-type': 'text/plain' },
): PinnedResponse => ({ status, headers, body: body(text) });
const publicDns: ResolveHost = async () => [{ address: '93.184.216.34', family: 4 }];

describe('reviewed resource fetcher', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.31.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    // The same private targets in the spellings a DNS answer can use, which
    // the old textual ::ffff: regex never matched (round-2 audit):
    '0:0:0:0:0:ffff:7f00:1', // expanded IPv4-mapped loopback
    '::ffff:7f00:1', // hex-tailed IPv4-mapped loopback
    '::ffff:a00:1', // hex-tailed IPv4-mapped 10.0.0.1
    '64:ff9b::7f00:1', // NAT64 loopback
    '64:ff9b::a9fe:a9fe', // NAT64 169.254.169.254
    '2001:db8::1',
    'ff02::1',
  ])('rejects non-public address %s', (address) => expect(isPublicAddress(address)).toBe(false));

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '::ffff:808:808',
    '64:ff9b::808:808',
  ])('accepts public address %s', (address) => expect(isPublicAddress(address)).toBe(true));

  it('rejects DNS rebinding if any answer is private and never opens a request', async () => {
    const request = vi.fn<PinnedRequest>();
    const fetcher = new ReviewedResourceFetcher({
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      request,
    });
    await expect(fetcher.fetch('https://example.com/')).resolves.toMatchObject({
      ok: false,
      code: 'private-address',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('pins the validated DNS answer into the HTTPS request', async () => {
    const request = vi.fn<PinnedRequest>(async () => response(200, 'reviewed text'));
    const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request, now: () => 10 });
    await expect(fetcher.fetch('https://example.com/guide')).resolves.toMatchObject({
      ok: true,
      cache: 'miss',
      evidence: { text: 'reviewed text', trust: 'untrusted-reviewed-resource' },
    });
    expect(request).toHaveBeenCalledWith(
      new URL('https://example.com/guide'),
      { address: '93.184.216.34', family: 4 },
      5_000,
    );
  });

  it('passes the body through whole: NULs removed, lines kept, never cut at 8,000 characters', async () => {
    const long = `# Guide\n\n${'word '.repeat(4_000)}\n\n## Last section\n\nthe end`;
    const request = vi.fn<PinnedRequest>(async () => response(200, `a\u0000b\n${long}`));
    const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request, now: () => 10 });
    const result = await fetcher.fetch('https://example.com/guide.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.text).toBe(`ab\n${long}`);
    expect(result.evidence.text.length).toBeGreaterThan(8_000);
  });

  it('revalidates and re-resolves every redirect target', async () => {
    const resolve = vi.fn<ResolveHost>(async (hostname) =>
      hostname === 'one.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '1.1.1.1', family: 4 }],
    );
    const request = vi.fn<PinnedRequest>(async (url) =>
      url.hostname === 'one.example'
        ? response(302, '', { location: 'https://two.example/final' })
        : response(200, 'final'),
    );
    const result = await new ReviewedResourceFetcher({ resolve, request }).fetch(
      'https://one.example/start',
    );
    expect(result).toMatchObject({ ok: true, evidence: { url: 'https://two.example/final' } });
    expect(resolve.mock.calls).toEqual([['one.example'], ['two.example']]);
    expect(request.mock.calls[1]?.[1]).toEqual({ address: '1.1.1.1', family: 4 });
  });

  it.each([
    ['http://private.example/', 'redirect'],
    ['https://127.0.0.1/', 'redirect'],
    ['https://user:secret@example.com/', 'redirect'],
  ])('blocks an unsafe redirect to %s', async (location, code) => {
    const fetcher = new ReviewedResourceFetcher({
      resolve: publicDns,
      request: async () => response(302, '', { location }),
    });
    await expect(fetcher.fetch('https://example.com/')).resolves.toMatchObject({ ok: false, code });
  });

  it('blocks a redirect whose fresh DNS answer becomes private', async () => {
    const fetcher = new ReviewedResourceFetcher({
      resolve: async (hostname) => [
        { address: hostname === 'example.com' ? '93.184.216.34' : '169.254.169.254', family: 4 },
      ],
      request: async () => response(302, '', { location: 'https://metadata.example/latest' }),
    });
    await expect(fetcher.fetch('https://example.com/')).resolves.toMatchObject({
      ok: false,
      code: 'private-address',
    });
  });

  it('enforces status, media type, declared size and streamed size limits', async () => {
    const run = (res: PinnedResponse) =>
      new ReviewedResourceFetcher({ resolve: publicDns, request: async () => res }).fetch(
        'https://example.com/',
      );
    await expect(run(response(404))).resolves.toMatchObject({ code: 'http-status' });
    await expect(
      run(response(200, 'zip', { 'content-type': 'application/zip' })),
    ).resolves.toMatchObject({
      code: 'content-type',
    });
    await expect(
      run(response(200, '', { 'content-type': 'text/plain', 'content-length': '1000001' })),
    ).resolves.toMatchObject({ code: 'too-large' });
    await expect(
      new ReviewedResourceFetcher({
        resolve: publicDns,
        request: async () => response(200, '12345'),
        limits: { maxBytes: 4 },
      }).fetch('https://example.com/'),
    ).resolves.toMatchObject({ code: 'too-large' });
  });

  it('falls back across every validated address before reporting a network failure', async () => {
    const request = vi.fn<PinnedRequest>(async (_url, address) => {
      if (address.family === 6) throw new Error('IPv6 unavailable');
      return response(200, 'IPv4 succeeded');
    });
    const fetcher = new ReviewedResourceFetcher({
      resolve: async () => [
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '1.1.1.1', family: 4 },
      ],
      request,
    });
    await expect(fetcher.fetch('https://example.com/')).resolves.toMatchObject({
      ok: true,
      evidence: { text: 'IPv4 succeeded' },
    });
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 },
    ]);
  });

  it('maps timeouts to a safe failure without exposing network details', async () => {
    const fetcher = new ReviewedResourceFetcher({
      resolve: publicDns,
      request: async () => {
        throw new Error('resource fetch timed out at internal-proxy:8443');
      },
    });
    await expect(fetcher.fetch('https://example.com/')).resolves.toEqual({
      ok: false,
      code: 'timeout',
      message: 'The reviewed resource could not be retrieved safely.',
      host: 'example.com',
    });
  });

  it('uses a short freshness cache and refetches after expiry', async () => {
    let now = 1_000;
    let version = 0;
    const request = vi.fn<PinnedRequest>(async () => {
      version += 1;
      return response(200, `version ${version}`);
    });
    const fetcher = new ReviewedResourceFetcher({
      resolve: publicDns,
      request,
      now: () => now,
      limits: { cacheTtlMs: 100 },
    });
    await expect(fetcher.fetch('https://example.com/')).resolves.toMatchObject({ cache: 'miss' });
    now = 1_050;
    await expect(fetcher.fetch('https://example.com/')).resolves.toMatchObject({ cache: 'hit' });
    now = 1_101;
    await expect(fetcher.fetch('https://example.com/')).resolves.toMatchObject({ cache: 'miss' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  describe('allowedHosts (Task 17 fix: GitHub raw downloads stay on raw.githubusercontent.com)', () => {
    it('refuses a redirect off the allowlist without requesting the target', async () => {
      const request = vi.fn<PinnedRequest>(async (url) => {
        if (url.hostname === 'raw.githubusercontent.com')
          return response(302, '', { location: 'https://example.com/evil' });
        return response(200, 'evil');
      });
      const fetcher = new ReviewedResourceFetcher({
        resolve: publicDns,
        request,
        allowedHosts: ['raw.githubusercontent.com'],
      });
      await expect(
        fetcher.fetch('https://raw.githubusercontent.com/acme/widget/main/README.md'),
      ).resolves.toEqual({
        ok: false,
        code: 'redirect',
        message: 'The reviewed resource redirected outside the allowed hosts.',
        host: 'example.com',
      });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('follows a redirect that stays on the allowlist', async () => {
      const request = vi.fn<PinnedRequest>(async (url) =>
        url.pathname === '/start'
          ? response(302, '', { location: 'https://raw.githubusercontent.com/final' })
          : response(200, 'final'),
      );
      const fetcher = new ReviewedResourceFetcher({
        resolve: publicDns,
        request,
        allowedHosts: ['raw.githubusercontent.com'],
      });
      await expect(fetcher.fetch('https://raw.githubusercontent.com/start')).resolves.toMatchObject(
        { ok: true, evidence: { text: 'final' } },
      );
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('refuses an initial URL off the allowlist without any request', async () => {
      const request = vi.fn<PinnedRequest>(async () => response(200, 'evil'));
      const fetcher = new ReviewedResourceFetcher({
        resolve: publicDns,
        request,
        allowedHosts: ['raw.githubusercontent.com'],
      });
      await expect(fetcher.fetch('https://example.com/guide')).resolves.toEqual({
        ok: false,
        code: 'redirect',
        message: 'The reviewed resource redirected outside the allowed hosts.',
        host: 'example.com',
      });
      expect(request).not.toHaveBeenCalled();
    });

    it('without allowedHosts still follows a public redirect as before', async () => {
      const request = vi.fn<PinnedRequest>(async (url) =>
        url.hostname === 'one.example'
          ? response(302, '', { location: 'https://two.example/final' })
          : response(200, 'final'),
      );
      const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
      await expect(fetcher.fetch('https://one.example/start')).resolves.toMatchObject({
        ok: true,
        evidence: { text: 'final' },
      });
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure codes (challenge classification, status and host)', () => {
    it("a 403 with a Cloudflare challenge header is a 'challenge' failure", async () => {
      const fetcher = new ReviewedResourceFetcher({
        resolve: publicDns,
        request: async () => response(403, 'challenge page', { 'cf-mitigated': 'challenge' }),
      });
      await expect(fetcher.fetch('https://example.com/')).resolves.toEqual({
        ok: false,
        code: 'challenge',
        message: "The site's Cloudflare bot protection challenged Bananasaurs.",
        httpStatus: 403,
        host: 'example.com',
      });
    });

    it('a plain 403 is an http-status failure with status and host', async () => {
      const fetcher = new ReviewedResourceFetcher({
        resolve: publicDns,
        request: async () => response(403, 'forbidden'),
      });
      await expect(fetcher.fetch('https://example.com/')).resolves.toMatchObject({
        ok: false,
        code: 'http-status',
        httpStatus: 403,
        host: 'example.com',
      });
    });
  });

  describe('headersFor (owner-set website fetch header)', () => {
    it('sends the header to a listed host and not to any other host', async () => {
      const request = vi.fn<PinnedRequest>(async () => response(200, 'body'));
      const fetcher = new ReviewedResourceFetcher({
        resolve: publicDns,
        request,
        headersFor: (host) =>
          host === 'example.com' ? { 'x-bananasaurs-fetch': 'tok' } : undefined,
      });
      await fetcher.fetch('https://example.com/guide');
      expect(request).toHaveBeenCalledWith(
        new URL('https://example.com/guide'),
        { address: '93.184.216.34', family: 4 },
        5_000,
        { 'x-bananasaurs-fetch': 'tok' },
      );
      request.mockClear();
      await fetcher.fetch('https://other.com/guide');
      expect(request).toHaveBeenCalledWith(
        new URL('https://other.com/guide'),
        { address: '93.184.216.34', family: 4 },
        5_000,
      );
    });
  });

  describe('limits getter (live fetch timeout)', () => {
    it('reads the getter on every fetch, including the second request', async () => {
      let timeoutMs = 5_000;
      const request = vi.fn<PinnedRequest>(async () => response(200, 'body'));
      const fetcher = new ReviewedResourceFetcher({
        resolve: publicDns,
        request,
        now: () => 1_000_000,
        limits: () => ({ timeoutMs, cacheTtlMs: 0 }),
      });
      await fetcher.fetch('https://example.com/one');
      timeoutMs = 9_000;
      await fetcher.fetch('https://example.com/two');
      expect(request.mock.calls[0]?.[2]).toBe(5_000);
      expect(request.mock.calls[1]?.[2]).toBe(9_000);
    });
  });

  describe('conditional requests (ADR 0073)', () => {
    it('sends If-None-Match / If-Modified-Since and returns notModified on a 304, without reading a body', async () => {
      const request = vi.fn<PinnedRequest>(async () => response(304));
      const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
      await expect(
        fetcher.fetch('https://example.com/guide', {
          etag: '"v1"',
          lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
        }),
      ).resolves.toEqual({ ok: true, notModified: true });
      expect(request).toHaveBeenCalledWith(
        new URL('https://example.com/guide'),
        { address: '93.184.216.34', family: 4 },
        5_000,
        {
          'if-none-match': '"v1"',
          'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT',
        },
      );
    });

    it('returns the fresh body plus etag/last-modified when the content changed', async () => {
      const request = vi.fn<PinnedRequest>(async () =>
        response(200, 'new text', {
          'content-type': 'text/plain',
          etag: '"v2"',
          'last-modified': 'Thu, 02 Jan 2025 00:00:00 GMT',
        }),
      );
      const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
      await expect(
        fetcher.fetch('https://example.com/guide', { etag: '"v1"' }),
      ).resolves.toMatchObject({
        ok: true,
        evidence: { text: 'new text' },
        etag: '"v2"',
        lastModified: 'Thu, 02 Jan 2025 00:00:00 GMT',
      });
    });

    it('bypasses the in-memory freshness cache on the conditional path', async () => {
      const request = vi.fn<PinnedRequest>(async () => response(200, 'body'));
      const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
      await fetcher.fetch('https://example.com/guide');
      await fetcher.fetch('https://example.com/guide', { etag: '"v1"' });
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('sends no conditional headers, and 3 call arguments, when called with no conditional (unchanged from before ADR 0073)', async () => {
      const request = vi.fn<PinnedRequest>(async () => response(200, 'body'));
      const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
      await fetcher.fetch('https://example.com/guide');
      expect(request).toHaveBeenCalledWith(
        new URL('https://example.com/guide'),
        { address: '93.184.216.34', family: 4 },
        5_000,
      );
    });
  });
});

it('fetchBytes returns raw bytes for an allowlisted host and refuses anything else', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const bytesBody = async function* (): AsyncIterable<Uint8Array> {
    yield png;
  };
  const request = vi.fn<PinnedRequest>(async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: bytesBody(),
  }));
  const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
  const good = await fetcher.fetchBytes('https://cdn.discordapp.com/attachments/1/2/a.png', {
    allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'],
    maxBytes: 5_242_880,
  });
  expect(good).toMatchObject({ ok: true, mediaType: 'image/png' });
  if (good.ok) expect([...good.bytes]).toEqual([...png]);
  const bad = await fetcher.fetchBytes('https://evil.example/a.png', {
    allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'],
    maxBytes: 5_242_880,
  });
  expect(bad).toMatchObject({ ok: false, code: 'redirect', host: 'evil.example' });
  expect(request).toHaveBeenCalledTimes(1);
});

it('fetchBytes refuses a redirect to another host without following it', async () => {
  const emptyBody = async function* (): AsyncIterable<Uint8Array> {};
  const request = vi.fn<PinnedRequest>(async () => ({
    status: 302,
    headers: { location: 'https://evil.example/final.png' },
    body: emptyBody(),
  }));
  const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
  const result = await fetcher.fetchBytes('https://cdn.discordapp.com/attachments/1/2/a.png', {
    allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'],
    maxBytes: 1_024,
  });
  expect(result).toMatchObject({ ok: false, code: 'redirect', host: 'evil.example' });
  expect(request).toHaveBeenCalledTimes(1);
});

describe('fetchBytes port and same-host redirect rules (T5 repair)', () => {
  const hosts = ['cdn.discordapp.com', 'media.discordapp.net'];
  const empty = async function* (): AsyncIterable<Uint8Array> {};
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const body = async function* (): AsyncIterable<Uint8Array> {
    yield png;
  };

  it('refuses a non-443 initial port before any request', async () => {
    const request = vi.fn<PinnedRequest>();
    const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
    const result = await fetcher.fetchBytes('https://cdn.discordapp.com:8443/a/b/c.png', {
      allowedHosts: hosts,
      maxBytes: 1_024,
    });
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a redirect to a non-443 port on the same host', async () => {
    const request = vi.fn<PinnedRequest>(async () => ({
      status: 302,
      headers: { location: 'https://cdn.discordapp.com:444/final.png' },
      body: empty(),
    }));
    const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
    const result = await fetcher.fetchBytes('https://cdn.discordapp.com/a/b/c.png', {
      allowedHosts: hosts,
      maxBytes: 1_024,
    });
    expect(result).toMatchObject({ ok: false, code: 'redirect' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect from one allowed host to the other', async () => {
    const request = vi.fn<PinnedRequest>(async () => ({
      status: 302,
      headers: { location: 'https://media.discordapp.net/a/b/c.png' },
      body: empty(),
    }));
    const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
    const result = await fetcher.fetchBytes('https://cdn.discordapp.com/a/b/c.png', {
      allowedHosts: hosts,
      maxBytes: 1_024,
    });
    expect(result).toMatchObject({ ok: false, code: 'redirect' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('still follows a same-host https redirect', async () => {
    let calls = 0;
    const request = vi.fn<PinnedRequest>(async () => {
      calls += 1;
      return calls === 1
        ? { status: 302, headers: { location: '/other/path.png' }, body: empty() }
        : { status: 200, headers: { 'content-type': 'image/png' }, body: body() };
    });
    const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
    const result = await fetcher.fetchBytes('https://cdn.discordapp.com/a/b/c.png', {
      allowedHosts: hosts,
      maxBytes: 1_024,
    });
    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('fetchBytes timeout (live, timeout only)', () => {
  const png = async function* (): AsyncIterable<Uint8Array> {
    yield new Uint8Array([1]);
  };
  const run = async (
    limits:
      | (ConstructorParameters<typeof ReviewedResourceFetcher>[0] extends infer O
          ? O extends { limits?: infer L }
            ? L
            : never
          : never)
      | undefined,
    calls: () => void = () => undefined,
  ): Promise<number[]> => {
    const timeouts: number[] = [];
    const request = vi.fn<PinnedRequest>(async (_url, _addr, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { status: 200, headers: { 'content-type': 'image/png' }, body: png() };
    });
    const fetcher = new ReviewedResourceFetcher({
      resolve: publicDns,
      request,
      ...(limits === undefined ? {} : { limits }),
    });
    const opts = { allowedHosts: ['cdn.discordapp.com'], maxBytes: 100 };
    await fetcher.fetchBytes('https://cdn.discordapp.com/a.png', opts);
    calls();
    await fetcher.fetchBytes('https://cdn.discordapp.com/a.png', opts);
    return timeouts;
  };

  it('uses the default timeout when no limits are given', async () => {
    expect(await run(undefined)).toEqual([5_000, 5_000]);
  });
  it('uses an object snapshot timeout', async () => {
    expect(await run({ timeoutMs: 1_234 })).toEqual([1_234, 1_234]);
  });
  it('re-reads a limits getter on every call', async () => {
    let timeoutMs = 2_000;
    const timeouts = await run(
      () => ({ timeoutMs }),
      () => {
        timeoutMs = 9_000;
      },
    );
    expect(timeouts).toEqual([2_000, 9_000]);
  });
  it('takes only timeout from the getter: maxBytes stays per call, no caching', async () => {
    const request = vi.fn<PinnedRequest>(async () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: (async function* () {
        yield new Uint8Array([1, 2, 3, 4]);
      })(),
    }));
    const fetcher = new ReviewedResourceFetcher({
      resolve: publicDns,
      request,
      limits: () => ({ timeoutMs: 1_000, maxBytes: 1, maxRedirects: 0, cacheTtlMs: 999_999 }),
    });
    const opts = { allowedHosts: ['cdn.discordapp.com'], maxBytes: 100 };
    expect((await fetcher.fetchBytes('https://cdn.discordapp.com/a.png', opts)).ok).toBe(true);
    expect((await fetcher.fetchBytes('https://cdn.discordapp.com/a.png', opts)).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
