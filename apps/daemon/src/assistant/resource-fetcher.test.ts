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
});
