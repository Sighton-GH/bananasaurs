import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { extractEvidenceText, validateResourceUrl } from '@bananasaurs/core';

export const DEFAULT_RESOURCE_FETCH_LIMITS = {
  maxBytes: 1_000_000,
  timeoutMs: 5_000,
  maxRedirects: 3,
  cacheTtlMs: 5 * 60_000,
} as const;

export interface ResourceFetchLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly cacheTtlMs: number;
}
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
export type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;
export interface PinnedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  /**
   * Releases the response without reading the body (round-2 low): every
   * early return after headers must call this or the stream - and its
   * socket and timeout - is left hanging.
   */
  readonly discard?: () => void;
}
export type PinnedRequest = (
  url: URL,
  address: ResolvedAddress,
  timeoutMs: number,
) => Promise<PinnedResponse>;
export interface ReviewedResourceEvidence {
  readonly url: string;
  readonly mediaType: string;
  readonly text: string;
  readonly fetchedAt: number;
  readonly trust: 'untrusted-reviewed-resource';
}
export type ResourceFetchResult =
  | {
      readonly ok: true;
      readonly evidence: ReviewedResourceEvidence;
      readonly cache: 'hit' | 'miss';
    }
  | { readonly ok: false; readonly code: ResourceFetchFailureCode; readonly message: string };
export type ResourceFetchFailureCode =
  | 'invalid-url'
  | 'dns-failed'
  | 'private-address'
  | 'redirect'
  | 'http-status'
  | 'content-type'
  | 'too-large'
  | 'timeout'
  | 'network';

const fail = (code: ResourceFetchFailureCode, message: string): ResourceFetchResult => ({
  ok: false,
  code,
  message,
});

const ipv4Number = (address: string): number | undefined => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return undefined;
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0;
};
const inV4 = (value: number, base: string, bits: number): boolean => {
  const network = ipv4Number(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
};
const NON_PUBLIC_V4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const normaliseV6 = (address: string): string => address.toLowerCase().split('%')[0]!;
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return value !== undefined && !NON_PUBLIC_V4.some(([base, bits]) => inV4(value, base, bits));
  }
  if (family !== 6) return false;
  const value = normaliseV6(address);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  if (mapped !== undefined) return isPublicAddress(mapped);
  return !(
    value === '::' ||
    value === '::1' ||
    /^f[cd]/.test(value) ||
    /^fe[89ab]/.test(value) ||
    /^ff/.test(value) ||
    value.startsWith('2001:db8:')
  );
};

export const resolvePublicAddress: ResolveHost = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

export const pinnedHttpsRequest: PinnedRequest = (url, pinned, timeoutMs) =>
  new Promise((resolve, reject) => {
    let response: import('node:http').IncomingMessage | undefined;
    const request = httpsRequest(
      url,
      {
        method: 'GET',
        agent: false,
        headers: { accept: 'text/plain, text/markdown, text/html, application/json' },
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        servername: url.hostname,
      },
      (res) => {
        response = res;
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(res.headers))
          headers[name] = Array.isArray(value) ? value.join(', ') : value;
        // The timeout clears when the body finishes or the stream closes for
        // any reason (including discard's destroy), so an early return never
        // leaves a live timer holding a socket (round-2 low).
        const clear = (): void => clearTimeout(timer);
        res.once('end', clear);
        res.once('close', clear);
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: res,
          discard: () => {
            clear();
            res.destroy();
          },
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error('resource fetch timed out'));
      response?.destroy();
    }, timeoutMs);
    request.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });

const mediaTypeOf = (value: string | undefined): string =>
  (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
const ALLOWED_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/html',
  'application/json',
  'application/xhtml+xml',
]);
const redirectLocation = (response: PinnedResponse): string | undefined =>
  response.headers.location ?? response.headers.Location;

export class ReviewedResourceFetcher {
  readonly #cache = new Map<string, ReviewedResourceEvidence>();
  readonly #resolve: ResolveHost;
  readonly #request: PinnedRequest;
  readonly #limits: ResourceFetchLimits;
  readonly #now: () => number;

  constructor(
    options: {
      readonly resolve?: ResolveHost;
      readonly request?: PinnedRequest;
      readonly limits?: Partial<ResourceFetchLimits>;
      readonly now?: () => number;
    } = {},
  ) {
    this.#resolve = options.resolve ?? resolvePublicAddress;
    this.#request = options.request ?? pinnedHttpsRequest;
    this.#limits = { ...DEFAULT_RESOURCE_FETCH_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
  }

  async fetch(rawUrl: string): Promise<ResourceFetchResult> {
    let initial: URL;
    try {
      initial = validateResourceUrl(rawUrl);
    } catch {
      return fail('invalid-url', 'The reviewed resource URL is not an allowed public HTTPS URL.');
    }
    const cached = this.#cache.get(initial.href);
    if (cached !== undefined && this.#now() - cached.fetchedAt < this.#limits.cacheTtlMs)
      return { ok: true, evidence: cached, cache: 'hit' };
    const result = await this.#fetchFrom(initial, new Set(), 0);
    if (result.ok) this.#cache.set(initial.href, result.evidence);
    return result;
  }

  async #fetchFrom(
    url: URL,
    visited: Set<string>,
    redirects: number,
  ): Promise<ResourceFetchResult> {
    if (visited.has(url.href)) return fail('redirect', 'The reviewed resource redirect looped.');
    visited.add(url.href);
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.#resolve(url.hostname);
    } catch {
      return fail('dns-failed', 'The reviewed resource host could not be resolved.');
    }
    if (addresses.length === 0)
      return fail('dns-failed', 'The reviewed resource host has no address.');
    if (addresses.some(({ address }) => !isPublicAddress(address)))
      return fail('private-address', 'The reviewed resource resolved to a non-public address.');
    let response: PinnedResponse;
    try {
      response = await this.#request(url, addresses[0]!, this.#limits.timeoutMs);
    } catch (error) {
      return fail(
        error instanceof Error && /timed out/i.test(error.message) ? 'timeout' : 'network',
        'The reviewed resource could not be retrieved safely.',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      response.discard?.();
      if (redirects >= this.#limits.maxRedirects)
        return fail('redirect', 'The reviewed resource exceeded the redirect limit.');
      const location = redirectLocation(response);
      if (location === undefined)
        return fail('redirect', 'The reviewed resource redirect had no location.');
      let redirected: URL;
      try {
        redirected = validateResourceUrl(new URL(location, url).href);
      } catch {
        return fail(
          'redirect',
          'The reviewed resource redirected outside allowed public HTTPS URLs.',
        );
      }
      return this.#fetchFrom(redirected, visited, redirects + 1);
    }
    if (response.status < 200 || response.status >= 300) {
      response.discard?.();
      return fail('http-status', `The reviewed resource returned HTTP ${response.status}.`);
    }
    const mediaType = mediaTypeOf(response.headers['content-type']);
    if (!ALLOWED_TYPES.has(mediaType)) {
      response.discard?.();
      return fail('content-type', 'The reviewed resource did not return a supported text type.');
    }
    const declaredLength = Number(response.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > this.#limits.maxBytes) {
      response.discard?.();
      return fail('too-large', 'The reviewed resource exceeded the size limit.');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > this.#limits.maxBytes) {
          response.discard?.();
          return fail('too-large', 'The reviewed resource exceeded the size limit.');
        }
        chunks.push(chunk);
      }
    } catch {
      return fail('network', 'The reviewed resource body could not be read.');
    }
    // Useful page text, not raw markup: raw HTML truncated at the byte cap
    // used to deliver mostly <head> and no content (should-fix, round 2).
    const text = extractEvidenceText(
      mediaType,
      Buffer.concat(chunks).toString('utf8').replaceAll('\u0000', ''),
    );
    return {
      ok: true,
      evidence: {
        url: url.href,
        mediaType,
        text,
        fetchedAt: this.#now(),
        trust: 'untrusted-reviewed-resource',
      },
      cache: 'miss',
    };
  }
}
