import { z } from 'zod';
import type { WebResult } from './tools.js';
import { SearchHttpError } from './web-search.js';

/**
 * The Parallel Search API (ADR 0147). The third outbound web-search
 * destination. Results are held only for the request that asked; nothing
 * here stores them. The key is only ever in the `x-api-key` header.
 */
const ENDPOINT = 'https://api.parallel.ai/v1/search';

/** Same strip as `brave-search.ts`: the model only needs the text. */
const stripTags = (text: string): string => text.replace(/<[^>]*>/g, '');

const parallelResponse = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        content: z.string().optional(),
        snippet: z.string().optional(),
        excerpts: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

export const parallelWebSearch = async (
  options: {
    readonly apiKey: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  },
  query: string,
): Promise<readonly WebResult[]> => {
  const response = await (options.fetch ?? globalThis.fetch)(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': options.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ objective: query, search_queries: [query], mode: 'fast' }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new SearchHttpError(response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Parallel returned an invalid response');
  }
  const parsed = parallelResponse.safeParse(body);
  if (!parsed.success) throw new Error('Parallel returned an invalid response');
  return parsed.data.results.slice(0, 5).flatMap((result) =>
    result.url === undefined || !/^https?:\/\//.test(result.url)
      ? []
      : [
          {
            title: stripTags(result.title ?? result.url),
            url: result.url,
            description: stripTags(
              result.content ?? result.excerpts?.join(' ') ?? result.snippet ?? '',
            ).slice(0, 1000),
          },
        ],
  );
};
