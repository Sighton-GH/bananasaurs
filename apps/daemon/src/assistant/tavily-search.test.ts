import { describe, expect, it, vi } from 'vitest';
import { SearchHttpError } from './web-search.js';
import { tavilyWebSearch } from './tavily-search.js';

const ok = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('tavilyWebSearch (ADR 0120)', () => {
  it('sends exactly the specified request and maps results', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      ok({
        results: [
          { title: 'Guide', url: 'https://a.example/', content: 'LiPo care' },
          { title: 'Skipped', url: 'ftp://b.example/', content: 'nope' },
          { url: 'https://c.example/' },
        ],
      }),
    );
    const results = await tavilyWebSearch({ apiKey: 'tavily-secret', fetch }, 'lipo storage');
    expect(results).toEqual([
      { title: 'Guide', url: 'https://a.example/', description: 'LiPo care' },
      { title: 'https://c.example/', url: 'https://c.example/', description: '' },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0]?.[0] as string;
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe('https://api.tavily.com/search');
    expect(url).not.toContain('tavily-secret');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tavily-secret');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(init.body).toBe(
      JSON.stringify({
        query: 'lipo storage',
        search_depth: 'basic',
        max_results: 5,
        chunks_per_source: 2,
        safe_search: true,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    );
  });

  it('drops non-http URLs and falls back for missing title/content', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      ok({
        results: [
          { title: 'Good', url: 'http://d.example/', content: 'text' },
          { url: 'notaurl' },
          {},
        ],
      }),
    );
    const results = await tavilyWebSearch({ apiKey: 'k', fetch }, 'q');
    expect(results).toEqual([
      { title: 'Good', url: 'http://d.example/', description: 'text' },
    ]);
  });

  it('non-ok throws SearchHttpError without reading the body', async () => {
    const response = new Response('overloaded-natural-language-body', { status: 432 });
    const jsonSpy = vi.spyOn(response, 'json');
    const textSpy = vi.spyOn(response, 'text');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const err = await tavilyWebSearch({ apiKey: 'k', fetch }, 'q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchHttpError);
    expect((err as SearchHttpError).status).toBe(432);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('a 200 with a non-JSON body throws the fixed message', async () => {
    const response = new Response('You have exceeded your plan limit', { status: 200 });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(tavilyWebSearch({ apiKey: 'k', fetch }, 'q')).rejects.toThrow(
      'Tavily returned an invalid response',
    );
  });

  it('an invalid JSON shape throws without the provider body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(ok({ results: 'nope' }));
    await expect(tavilyWebSearch({ apiKey: 'k', fetch }, 'q')).rejects.toThrow(
      'Tavily returned an invalid response',
    );
  });
});
