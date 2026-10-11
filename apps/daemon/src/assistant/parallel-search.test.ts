import { describe, expect, it, vi } from 'vitest';
import { SearchHttpError } from './web-search.js';
import { parallelWebSearch } from './parallel-search.js';

const fetchOk = (body: unknown) =>
  vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

describe('parallelWebSearch (ADR 0147)', () => {
  it('posts the fixed fast-mode body with the x-api-key header and maps excerpts', async () => {
    const fetchImpl = fetchOk({
      results: [
        {
          title: 'TRIUMF <b>tours</b>',
          url: 'https://triumf.example/visit',
          excerpts: ['Grade 9 <i>welcome</i>', 'second line'],
        },
        { title: 'Other', url: 'https://other.example/', content: 'plain content here' },
        { title: 'Nope', url: 'ftp://nope.example/' },
      ],
    });
    const results = await parallelWebSearch(
      { apiKey: 'p-key', fetch: fetchImpl },
      'TRIUMF tour grade 9',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0]?.[0];
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe('https://api.parallel.ai/v1/search');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-api-key')).toBe('p-key');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      objective: 'TRIUMF tour grade 9',
      search_queries: ['TRIUMF tour grade 9'],
      mode: 'fast',
    });
    expect(results).toEqual([
      {
        title: 'TRIUMF tours',
        url: 'https://triumf.example/visit',
        description: 'Grade 9 welcome second line',
      },
      { title: 'Other', url: 'https://other.example/', description: 'plain content here' },
    ]);
  });

  it('caps each excerpt at 1,000 characters and keeps the first 5 results', async () => {
    const fetchImpl = fetchOk({
      results: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
        title: `t${i}`,
        url: `https://e.example/${i}`,
        content: 'x'.repeat(2000),
      })),
    });
    const results = await parallelWebSearch({ apiKey: 'p-key', fetch: fetchImpl }, 'q');
    expect(results.map((r) => r.title)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    for (const r of results) expect(r.description).toHaveLength(1000);
  });

  it('throws SearchHttpError on a refused status without reading the provider body', async () => {
    const response = new Response('no', { status: 429 });
    const jsonSpy = vi.spyOn(response, 'json');
    const textSpy = vi.spyOn(response, 'text');
    const refused = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const error = await parallelWebSearch({ apiKey: 'k', fetch: refused }, 'q').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SearchHttpError);
    expect(error).toMatchObject({ name: 'SearchHttpError', status: 429 });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('throws the fixed error on a bad response shape', async () => {
    await expect(
      parallelWebSearch({ apiKey: 'k', fetch: fetchOk({ results: 'nope' }) }, 'q'),
    ).rejects.toThrow('Parallel returned an invalid response');
  });

  it('accepts an absent results array as empty results', async () => {
    await expect(
      parallelWebSearch({ apiKey: 'k', fetch: fetchOk({ nope: true }) }, 'q'),
    ).resolves.toEqual([]);
  });

  it('rejects non-JSON bodies with the fixed error', async () => {
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('not JSON', { status: 200 }));
    await expect(parallelWebSearch({ apiKey: 'k', fetch: fetchImpl }, 'q')).rejects.toThrow(
      'Parallel returned an invalid response',
    );
  });

  it('uses snippet and URL fallbacks and drops missing or non-http URLs', async () => {
    const fetchImpl = fetchOk({
      results: [
        { url: 'http://e.example/', snippet: '<b>snippet</b>' },
        { url: 'https://e.example/' },
        { title: 'Missing URL' },
        { url: 'notaurl' },
      ],
    });
    await expect(parallelWebSearch({ apiKey: 'k', fetch: fetchImpl }, 'q')).resolves.toEqual([
      { title: 'http://e.example/', url: 'http://e.example/', description: 'snippet' },
      { title: 'https://e.example/', url: 'https://e.example/', description: '' },
    ]);
  });

  it('keeps the key in the header, not the URL, body, results or error messages', async () => {
    const key = 'invented-parallel-test-key';
    const fetchImpl = fetchOk({ results: [] });
    const results = await parallelWebSearch({ apiKey: key, fetch: fetchImpl }, 'q');
    const url = fetchImpl.mock.calls[0]?.[0] as string;
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('x-api-key')).toBe(key);
    expect(url).not.toContain(key);
    expect(init.body).not.toContain(key);
    expect(JSON.stringify(results)).not.toContain(key);
    for (const response of [
      new Response(key, { status: 429 }),
      new Response(JSON.stringify({ results: key }), { status: 200 }),
      new Response(key, { status: 200 }),
    ]) {
      const fetchError = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      const error = await parallelWebSearch({ apiKey: key, fetch: fetchError }, 'q').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(key);
    }
  });
});
