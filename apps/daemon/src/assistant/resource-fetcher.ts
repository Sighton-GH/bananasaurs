import type { IncomingMessage } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import {
  embeddedIpv4,
  extractEvidenceText,
  ipv6Bytes,
  validateResourceUrl,
} from '@bananasaurs/core';

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
  extraHeaders?: Readonly<Record<string, string>>,
) => Promise<PinnedResponse>;
export interface ReviewedResourceEvidence {
  readonly url: string;
  readonly mediaType: string;
  readonly text: string;
  readonly fetchedAt: number;
  readonly trust: 'untrusted-reviewed-resource';
}
/**
 * A prior fetch's validator, for a conditional request (ADR 0073: the
 * resource cache re-chunks only when content actually changed).
 */
export interface ResourceConditional {
  readonly etag?: string;
  readonly lastModified?: string;
}
export interface ResourceFetchSuccess {
  readonly ok: true;
  /** Present (and `true`) only on `ResourceFetchNotModified`; narrows the conditional union without changing `ResourceFetchResult`'s two-variant shape. */
  readonly notModified?: false;
  readonly evidence: ReviewedResourceEvidence;
  readonly cache: 'hit' | 'miss';
  /** Only ever set on a fresh network fetch (`cache: 'miss'`), never a cache hit. */
  readonly etag?: string;
  readonly lastModified?: string;
}
export interface ResourceFetchNotModified {
  readonly ok: true;
  readonly notModified: true;
}
export interface ResourceFetchFailure {
  readonly ok: false;
  readonly code: ResourceFetchFailureCode;
  readonly message: string;
}
/**
 * The no-conditional-argument shape, unchanged from before ADR 0073: every
 * existing caller (`service.ts`) calls `fetch(url)` with one argument and
 * keeps compiling against exactly this two-variant union — a plain fetch can
 * never receive a 304, so `notModified` cannot appear here.
 */
export type ResourceFetchResult = ResourceFetchSuccess | ResourceFetchFailure;
/** The two-argument (conditional) shape, for the resource-cache refresh path. */
export type ConditionalResourceFetchResult =
  ResourceFetchSuccess | ResourceFetchNotModified | ResourceFetchFailure;
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

const fail = (code: ResourceFetchFailureCode, message: string): ResourceFetchFailure => ({
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
export const isPublicAddress = (address: string): boolean => {
  // A zone id ("fe80::1%eth0") never survives a public DNS answer; strip it
  // before classification rather than letting it defeat the parser.
  const bare = address.toLowerCase().split('%')[0]!;
  const family = isIP(bare);
  if (family === 4) {
    const value = ipv4Number(bare);
    return value !== undefined && !NON_PUBLIC_V4.some(([base, bits]) => inV4(value, base, bits));
  }
  if (family !== 6) return false;
  // Byte-level, like the URL-host boundary in core: a DNS answer can spell
  // the same private target expanded (`0:0:0:0:0:ffff:7f00:1`), hex-tailed
  // (`::ffff:7f00:1`), or as NAT64 (`64:ff9b::7f00:1`), and the old
  // textual `::ffff:` regex only caught the dotted spelling (round-2 audit).
  const v6 = ipv6Bytes(bare);
  if (v6 === undefined) return false;
  const embedded = embeddedIpv4(v6);
  if (embedded !== undefined) return isPublicAddress(embedded);
  return !(
    v6.every((b) => b === 0) || // ::
    v6.every((b, i) => (i < 15 ? b === 0 : b === 1)) || // ::1
    (v6[0]! & 0xfe) === 0xfc || // fc00::/7 (ULA)
    (v6[0] === 0xfe && (v6[1]! & 0xc0) === 0x80) || // fe80::/10 link-local
    v6[0] === 0xff || // ff00::/8 multicast
    (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) // 2001:db8::/32 documentation
  );
};

export const resolvePublicAddress: ResolveHost = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

export const pinnedHttpsRequest: PinnedRequest = (url, pinned, timeoutMs, extraHeaders) =>
  new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    const request = httpsRequest(
      url,
      {
        method: 'GET',
        agent: false,
        headers: {
          accept: 'text/plain, text/markdown, text/html, application/json',
          ...extraHeaders,
        },
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all === true)
            return callback(null, [{ address: pinned.address, family: pinned.family }]);
          return callback(null, pinned.address, pinned.family);
        },
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
  readonly #allowedHosts: readonly string[] | undefined;

  constructor(
    options: {
      readonly resolve?: ResolveHost;
      readonly request?: PinnedRequest;
      readonly limits?: Partial<ResourceFetchLimits>;
      readonly now?: () => number;
      /**
       * Task 17 fix: when set, the initial URL and every redirect target must
       * have a hostname exactly in this list (GitHub raw downloads pin to
       * `raw.githubusercontent.com`, so a redirect can never carry a refresh
       * to another host). Absent means today's behaviour: any allowed public
       * HTTPS URL, including redirects.
       */
      readonly allowedHosts?: readonly string[];
    } = {},
  ) {
    this.#resolve = options.resolve ?? resolvePublicAddress;
    this.#request = options.request ?? pinnedHttpsRequest;
    this.#limits = { ...DEFAULT_RESOURCE_FETCH_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    this.#allowedHosts = options.allowedHosts;
  }

  /**
   * The conditional overload, for the resource-cache refresh path: sends
   * `If-None-Match`/`If-Modified-Since` when the caller has a prior
   * validator, skips the in-memory cache (the persistent cache is what this
   * path is revalidating against), and can resolve to `notModified`.
   *
   * Declared before the plain overload deliberately: `service.ts` (out of
   * this task's scope) spells its test-port type as
   * `ReturnType<ReviewedResourceFetcher['fetch']>`, and `ReturnType` over an
   * overloaded method takes the *last* signature's return type — keeping the
   * plain, `ResourceFetchResult`-returning overload last is what keeps that
   * expression unchanged.
   */
  async fetch(
    rawUrl: string,
    conditional: ResourceConditional,
  ): Promise<ConditionalResourceFetchResult>;
  /**
   * The plain (no-conditional) overload: identical behaviour to before ADR
   * 0073, including the 5-minute in-memory cache — `service.ts`'s per-request
   * live fetch keeps working unchanged until Task 16 moves it onto the
   * persistent cache.
   */
  async fetch(rawUrl: string): Promise<ResourceFetchResult>;
  async fetch(
    rawUrl: string,
    conditional?: ResourceConditional,
  ): Promise<ConditionalResourceFetchResult> {
    let initial: URL;
    try {
      initial = validateResourceUrl(rawUrl);
    } catch {
      return fail('invalid-url', 'The reviewed resource URL is not an allowed public HTTPS URL.');
    }
    if (
      this.#allowedHosts !== undefined &&
      !this.#allowedHosts.some((host) => initial.hostname.toLowerCase() === host.toLowerCase())
    )
      return fail('redirect', 'The reviewed resource redirected outside the allowed hosts.');
    if (conditional === undefined) {
      const cached = this.#cache.get(initial.href);
      if (cached !== undefined && this.#now() - cached.fetchedAt < this.#limits.cacheTtlMs)
        return { ok: true, evidence: cached, cache: 'hit' };
    }
    const extraHeaders: Record<string, string> = {};
    if (conditional?.etag !== undefined) extraHeaders['if-none-match'] = conditional.etag;
    if (conditional?.lastModified !== undefined)
      extraHeaders['if-modified-since'] = conditional.lastModified;
    const result = await this.#fetchFrom(initial, new Set(), 0, extraHeaders);
    if (conditional === undefined && result.ok && result.notModified !== true)
      this.#cache.set(initial.href, result.evidence);
    return result;
  }

  async #fetchFrom(
    url: URL,
    visited: Set<string>,
    redirects: number,
    extraHeaders: Readonly<Record<string, string>>,
  ): Promise<ConditionalResourceFetchResult> {
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
    let response: PinnedResponse | undefined;
    let lastError: unknown;
    for (const address of addresses) {
      try {
        response =
          Object.keys(extraHeaders).length > 0
            ? await this.#request(url, address, this.#limits.timeoutMs, extraHeaders)
            : await this.#request(url, address, this.#limits.timeoutMs);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (response === undefined) {
      return fail(
        lastError instanceof Error && /timed out/i.test(lastError.message) ? 'timeout' : 'network',
        'The reviewed resource could not be retrieved safely.',
      );
    }
    if (response.status === 304) {
      // No body to read; nothing changed since the caller's validator.
      response.discard?.();
      return { ok: true, notModified: true };
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
      if (
        this.#allowedHosts !== undefined &&
        !this.#allowedHosts.some((host) => redirected.hostname.toLowerCase() === host.toLowerCase())
      )
        return fail('redirect', 'The reviewed resource redirected outside the allowed hosts.');
      return this.#fetchFrom(redirected, visited, redirects + 1, extraHeaders);
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
    const etag = response.headers.etag;
    const lastModified = response.headers['last-modified'];
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
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
    };
  }
}
