import { expect, it, vi } from 'vitest';
import { createOpenRouterModelCatalogue } from './openrouter-models.js';

const body = {
  data: [
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      architecture: { input_modalities: ['text'] },
      supported_parameters: ['tools', 'reasoning'],
    },
    {
      id: 'google/gemma-4-31b-it:free',
      architecture: { input_modalities: ['image', 'text'] },
      supported_parameters: ['tools'],
    },
  ],
};

it('reports listed models with capabilities and unlisted ones as not listed', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  const cat = createOpenRouterModelCatalogue({ fetchImpl, now: () => 0, log: { warn: vi.fn() } });
  await cat.refresh();
  expect(cat.peek('google/gemma-4-31b-it:free')).toEqual({
    listed: true,
    image: true,
    file: false,
    tools: true,
    reasoning: false,
  });
  expect(cat.peek('stealth/space-bunny-alpha')).toEqual({
    listed: false,
    image: false,
    file: false,
    tools: false,
    reasoning: false,
  });
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://openrouter.ai/api/v1/models',
    expect.objectContaining({ method: 'GET' }),
  );
});

it('sends no Authorization header to OpenRouter', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  const cat = createOpenRouterModelCatalogue({ fetchImpl, now: () => 0, log: { warn: vi.fn() } });
  await cat.refresh();
  for (const call of fetchImpl.mock.calls) {
    const init = (call.at(1) ?? {}) as { headers?: Record<string, unknown> };
    expect(init.headers?.['Authorization'] ?? init.headers?.['authorization']).toBeUndefined();
  }
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('returns undefined before the first fetch and never throws on a failed fetch', async () => {
  const warn = vi.fn();
  const cat = createOpenRouterModelCatalogue({
    fetchImpl: vi.fn(async () => {
      throw new Error('down');
    }),
    now: () => 0,
    log: { warn },
  });
  expect(cat.peek('x')).toBeUndefined();
  await expect(cat.refresh()).resolves.toBeUndefined();
  expect(cat.peek('x')).toBeUndefined();
  expect(warn).toHaveBeenCalledWith(
    { host: 'openrouter.ai', err: expect.anything() },
    expect.anything(),
  );
});

it('keeps the previous cache when a later fetch fails', async () => {
  let t = 0;
  const warn = vi.fn();
  const good = new Response(JSON.stringify(body), { status: 200 });
  const fetchImpl = vi.fn(async (): Promise<Response> => {
    if (t > 3_600_000) throw new Error('down');
    return good.clone();
  });
  const cat = createOpenRouterModelCatalogue({ fetchImpl, now: () => t, log: { warn } });
  await cat.refresh();
  expect(cat.peek('google/gemma-4-31b-it:free')).toMatchObject({ listed: true });
  t = 3_600_001;
  await cat.refresh();
  expect(cat.peek('google/gemma-4-31b-it:free')).toMatchObject({ listed: true, image: true });
  expect(warn).toHaveBeenCalled();
});

it('refetches only after the TTL', async () => {
  let t = 0;
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  const cat = createOpenRouterModelCatalogue({ fetchImpl, now: () => t, log: { warn: vi.fn() } });
  await cat.refresh();
  await cat.refresh();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  t = 3_600_001;
  await cat.refresh();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('keeps the previous cache when the next body has no data', async () => {
  let t = 0;
  const warn = vi.fn();
  const good = new Response(JSON.stringify(body), { status: 200 });
  const empty = new Response(JSON.stringify({}), { status: 200 });
  const fetchImpl = vi.fn(async (): Promise<Response> => {
    if (t > 3_600_000) return empty.clone();
    return good.clone();
  });
  const cat = createOpenRouterModelCatalogue({ fetchImpl, now: () => t, log: { warn } });
  await cat.refresh();
  expect(cat.peek('google/gemma-4-31b-it:free')).toMatchObject({ listed: true });
  t = 3_600_001;
  await cat.refresh();
  expect(cat.peek('google/gemma-4-31b-it:free')).toMatchObject({ listed: true, image: true });
  expect(warn).toHaveBeenCalled();
});

it('retries a failed fetch at most once per 60 s', async () => {
  let t = 0;
  const fetchImpl = vi.fn(async (): Promise<Response> => {
    throw new Error('down');
  });
  const cat = createOpenRouterModelCatalogue({ fetchImpl, now: () => t, log: { warn: vi.fn() } });
  await cat.refresh();
  await cat.refresh();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  t = 60_000;
  await cat.refresh();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
