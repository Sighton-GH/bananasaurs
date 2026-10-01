import { z } from 'zod';
import type { WebResult } from './tools.js';
import { SearchHttpError } from './web-search.js';

/**
 * The Tavily search API (ADR 0120). The second outbound web-search
 * destination. Results are held only for the request that asked; nothing
 * here stores them. The key is only ever in the Authorization header.
 */
const ENDPOINT = 'https://api.tavily.com/search';

const tavilyResponse = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        content: z.string().optional(),
      }),
    )
    .default([]),
});

export const tavilyWebSearch = async (
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
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: 5,
      chunks_per_source: 2,
      safe_search: true,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new SearchHttpError(response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Tavily returned an invalid response');
  }
  const parsed = tavilyResponse.safeParse(body);
  if (!parsed.success) throw new Error('Tavily returned an invalid response');
  return parsed.data.results.flatMap((result) =>
    result.url === undefined || !/^https?:\/\//.test(result.url)
      ? []
      : [
          {
            title: result.title ?? result.url,
            url: result.url,
            description: result.content ?? '',
          },
        ],
  );
};
