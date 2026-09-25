import { isPublicAddress, resolvePublicAddress } from './resource-fetcher.js';
import type { PinnedRequest, ResolveHost } from './resource-fetcher.js';
import { pinnedHttpsRequest } from './resource-fetcher.js';

/**
 * The GitHub outbound boundary (hard rule 8, Task 17 ruling).
 *
 * Only `https://api.github.com` and `https://raw.githubusercontent.com` are
 * ever allowed — the exact hosts, not subdomains or lookalikes. The GitHub
 * REST client is constructed with `githubGuard` + the adapter below, never
 * with global `fetch`; raw file downloads go through the existing
 * `ReviewedResourceFetcher` instead.
 *
 * The token, when present, travels only in the `Authorization` header the
 * client sets. Nothing here logs, throws, or returns it: errors name the
 * host and the failure, never the headers.
 */

const ALLOWED_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);

export const GITHUB_API_TIMEOUT_MS = 10_000;
export const GITHUB_API_MAX_BYTES = 1_000_000;

export const githubGuard = (url: URL): Promise<void> => {
  if (url.protocol !== 'https:')
    return Promise.reject(new Error('GitHub requests must use HTTPS.'));
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase()))
    return Promise.reject(new Error(`GitHub requests to ${url.hostname} are not allowed.`));
  return Promise.resolve();
};

export interface GithubFetchOptions {
  readonly resolve?: ResolveHost;
  readonly request?: PinnedRequest;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const headersOf = (init?: RequestInit): Record<string, string> => {
  const raw = init?.headers;
  if (raw === undefined) return {};
  if (raw instanceof Headers) {
    const out: Record<string, string> = {};
    raw.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [key, value] of raw) {
      if (key !== undefined && value !== undefined) out[key] = value;
    }
    return out;
  }
  return { ...(raw as Record<string, string>) };
};

/**
 * A fetch-shaped adapter over the DNS-pinned HTTPS request: resolves the
 * host, refuses any non-public answer, performs the pinned request with the
 * caller's headers (including `Authorization`), and returns a `Response`.
 * The body is capped at `maxBytes` (1 MB for API JSON); anything larger is
 * refused before it is fully buffered.
 */
export const createGithubFetch = (options: GithubFetchOptions = {}): typeof fetch => {
  const resolve = options.resolve ?? resolvePublicAddress;
  const request = options.request ?? pinnedHttpsRequest;
  const timeoutMs = options.timeoutMs ?? GITHUB_API_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? GITHUB_API_MAX_BYTES;

  const githubFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('GitHub requests must use HTTPS.');
    }
    await githubGuard(url);

    let addresses: readonly { address: string; family: 4 | 6 }[];
    try {
      addresses = await resolve(url.hostname);
    } catch {
      throw new Error(`GitHub host ${url.hostname} could not be resolved.`);
    }
    if (addresses.length === 0) throw new Error(`GitHub host ${url.hostname} has no address.`);
    if (addresses.some(({ address }) => !isPublicAddress(address)))
      throw new Error(`GitHub host ${url.hostname} resolved to a non-public address.`);

    const extraHeaders = {
      ...headersOf(input instanceof Request ? { headers: input.headers } : undefined),
      ...headersOf(init),
    };

    let response:
      | {
          status: number;
          headers: Readonly<Record<string, string | undefined>>;
          body: AsyncIterable<Uint8Array>;
          discard?: () => void;
        }
      | undefined;
    let lastError: unknown;
    for (const address of addresses) {
      try {
        response =
          Object.keys(extraHeaders).length > 0
            ? await request(url, address, timeoutMs, extraHeaders)
            : await request(url, address, timeoutMs);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (response === undefined) {
      if (lastError instanceof Error && /timed out/i.test(lastError.message))
        throw new Error(`GitHub request to ${url.hostname} timed out.`);
      throw new Error(`GitHub request to ${url.hostname} could not be completed.`);
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          response.discard?.();
          throw new Error('GitHub response exceeded the size limit.');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof Error && /size limit/i.test(error.message)) throw error;
      throw new Error(`GitHub request to ${url.hostname} could not be read.`);
    }
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(name, value);
    }
    return new Response(body, { status: response.status, headers });
  };

  return githubFetch;
};
