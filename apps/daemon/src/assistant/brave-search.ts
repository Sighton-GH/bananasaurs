import { z } from 'zod';
import type { WebResult } from './tools.js';
import { SearchHttpError } from './web-search.js';

/**
 * The Brave Search API (ADR 0066). The one outbound destination web search
 * adds. Results are held only for the request that asked (Brave terms
 * §3(b)(i)); nothing here stores them.
 */
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const braveResponse = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().optional(),
            url: z.string().optional(),
            description: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});

/** Brave marks matches with <strong>; the model only needs the text. */
const stripTags = (text: string): string => text.replace(/<[^>]*>/g, '');

export const braveWebSearch = async (
  options: {
    readonly apiKey: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  },
  query: string,
): Promise<readonly WebResult[]> => {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', '5');
  url.searchParams.set('safesearch', 'strict');
  const response = await (options.fetch ?? globalThis.fetch)(url.toString(), {
    headers: { accept: 'application/json', 'x-subscription-token': options.apiKey },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new SearchHttpError(response.status);
  const parsed = braveResponse.safeParse(await response.json());
  if (!parsed.success) throw new Error('Brave returned an invalid response');
  return (parsed.data.web?.results ?? []).flatMap((result) =>
    result.url === undefined || !/^https?:\/\//.test(result.url)
      ? []
      : [
          {
            title: stripTags(result.title ?? result.url),
            url: result.url,
            description: stripTags(result.description ?? ''),
          },
        ],
  );
};
