import { describe, expect, it, vi } from 'vitest';
import { braveWebSearch } from './brave-search.js';
import { SearchHttpError } from './web-search.js';

const ok = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('braveWebSearch (ADR 0066)', () => {
  it('sends the key as a header, never in the URL, and maps results', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      ok({
        web: {
          results: [
            {
              title: 'Guide',
              url: 'https://a.example/',
              description: '<strong>LiPo</strong> care',
            },
            { title: 'No url' },
          ],
        },
      }),
    );
    const results = await braveWebSearch({ apiKey: 'brave-secret', fetch }, 'lipo storage');
    expect(results).toEqual([
      { title: 'Guide', url: 'https://a.example/', description: 'LiPo care' },
    ]);
    const url = fetch.mock.calls[0]?.[0] as string;
    const init = fetch.mock.calls[0]?.[1];
    expect(url).toBe(
      'https://api.search.brave.com/res/v1/web/search?q=lipo+storage&count=5&safesearch=strict',
    );
    expect(url).not.toContain('brave-secret');
    expect(new Headers(init?.headers).get('x-subscription-token')).toBe('brave-secret');
  });

  it('throws a SearchHttpError on a failed request without reading the body', async () => {
    const response = new Response('{}', { status: 429 });
    const jsonSpy = vi.spyOn(response, 'json');
    const textSpy = vi.spyOn(response, 'text');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const err = await braveWebSearch({ apiKey: 'k', fetch }, 'q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchHttpError);
    expect((err as SearchHttpError).status).toBe(429);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('treats a response without web results as no results', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(ok({ query: {} }));
    await expect(braveWebSearch({ apiKey: 'k', fetch }, 'q')).resolves.toEqual([]);
  });
});
