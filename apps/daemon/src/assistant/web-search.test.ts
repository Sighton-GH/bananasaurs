import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchKeysRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  createWebSearchRun,
  SearchHttpError,
  WebSearchLimitError,
  type WebSearchKey,
} from './web-search.js';

const GUILD = '123456789012345678';
const NOW = 1_800_000_000_000;
const RESULTS = [{ title: 'Guide', url: 'https://a.example/', description: 'LiPo care' }] as const;

let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
});
afterEach(() => t.close());

const addKey = (label: string, now = NOW): string =>
  searchKeysRepo.addSearchKey(t.scopes.instance(), {
    source: 'brave',
    label,
    apiKeyEnc: `sealed-${label}`,
    monthlyLimit: null,
    dailyLimit: null,
    now,
  });

const keysFor = (ids: readonly string[], apiKeys: readonly string[]): WebSearchKey[] =>
  ids.map((keyId, i) => ({
    keyId,
    apiKey: apiKeys[i]!,
    monthlyLimit: null,
    dailyLimit: null,
  }));

describe('createWebSearchRun (ADR 0120)', () => {
  it('uses the first key and returns { results, source }', async () => {
    const first = addKey('first');
    const second = addKey('second');
    const client = vi.fn().mockResolvedValue([...RESULTS]);
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: keysFor([first, second], ['api-first', 'api-second']),
      now: () => NOW,
      client,
    });
    await expect(run('lipo storage')).resolves.toEqual({ results: [...RESULTS], source: 'brave' });
    expect(client).toHaveBeenCalledTimes(1);
    expect(client).toHaveBeenCalledWith('api-first', 'lipo storage');
  });

  it('skips a key at its daily limit without calling the client', async () => {
    const first = searchKeysRepo.addSearchKey(t.scopes.instance(), {
      source: 'brave',
      label: 'first',
      apiKeyEnc: 'sealed-first',
      monthlyLimit: null,
      dailyLimit: 1,
      now: NOW,
    });
    const second = addKey('second');
    searchKeysRepo.reserveSearchCall(t.scopes.instance(), {
      keyId: first,
      guildId: GUILD,
      now: NOW - 1000,
      monthlyLimit: null,
      dailyLimit: 1,
    });
    const client = vi.fn().mockResolvedValue([...RESULTS]);
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: [
        { keyId: first, apiKey: 'api-first', monthlyLimit: null, dailyLimit: 1 },
        { keyId: second, apiKey: 'api-second', monthlyLimit: null, dailyLimit: null },
      ],
      now: () => NOW,
      client,
    });
    await expect(run('q')).resolves.toMatchObject({ source: 'brave' });
    expect(client).toHaveBeenCalledTimes(1);
    expect(client).toHaveBeenCalledWith('api-second', 'q');
  });

  it.each([429, 432, 401])('status %i from the first key falls through to the second key', async (status) => {
    const first = addKey('first');
    const second = addKey('second');
    const client = vi
      .fn()
      .mockRejectedValueOnce(new SearchHttpError(status))
      .mockResolvedValueOnce([...RESULTS]);
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: keysFor([first, second], ['api-first', 'api-second']),
      now: () => NOW,
      client,
    });
    await expect(run('q')).resolves.toEqual({ results: [...RESULTS], source: 'brave' });
    expect(client).toHaveBeenCalledTimes(2);
    expect(client.mock.calls[1]?.[0]).toBe('api-second');
    // The refused call still counts.
    expect(
      searchKeysRepo.searchKeyUsage(t.scopes.instance(), {
        keyId: first,
        now: NOW,
        monthlyLimit: null,
        dailyLimit: null,
      }).last24h,
    ).toBe(1);
  });

  it('status 500 rethrows and the second key is NOT called', async () => {
    const first = addKey('first');
    const second = addKey('second');
    const client = vi.fn().mockRejectedValue(new SearchHttpError(500));
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: keysFor([first, second], ['api-first', 'api-second']),
      now: () => NOW,
      client,
    });
    const err = await run('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchHttpError);
    expect((err as SearchHttpError).status).toBe(500);
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('a timeout rethrows and the second key is NOT called', async () => {
    const first = addKey('first');
    const second = addKey('second');
    const client = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: keysFor([first, second], ['api-first', 'api-second']),
      now: () => NOW,
      client,
    });
    await expect(run('q')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('all keys at their limits throws WebSearchLimitError with the earliest availableAt', async () => {
    const first = searchKeysRepo.addSearchKey(t.scopes.instance(), {
      source: 'brave',
      label: 'first',
      apiKeyEnc: 'sealed-first',
      monthlyLimit: null,
      dailyLimit: 1,
      now: NOW,
    });
    const second = searchKeysRepo.addSearchKey(t.scopes.instance(), {
      source: 'brave',
      label: 'second',
      apiKeyEnc: 'sealed-second',
      monthlyLimit: null,
      dailyLimit: 1,
      now: NOW,
    });
    searchKeysRepo.reserveSearchCall(t.scopes.instance(), {
      keyId: first,
      guildId: GUILD,
      now: NOW - 1000,
      monthlyLimit: null,
      dailyLimit: 1,
    });
    searchKeysRepo.reserveSearchCall(t.scopes.instance(), {
      keyId: second,
      guildId: GUILD,
      now: NOW - 2000,
      monthlyLimit: null,
      dailyLimit: 1,
    });
    const client = vi.fn().mockResolvedValue([...RESULTS]);
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: [
        { keyId: first, apiKey: 'api-first', monthlyLimit: null, dailyLimit: 1 },
        { keyId: second, apiKey: 'api-second', monthlyLimit: null, dailyLimit: 1 },
      ],
      now: () => NOW,
      client,
    });
    const err = await run('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebSearchLimitError);
    expect((err as WebSearchLimitError).availableAt).toBe(
      NOW - 2000 + searchKeysRepo.DAY_MS,
    );
    expect(client).not.toHaveBeenCalled();
  });

  it('the env seed (keyId null) is never recorded and never limited', async () => {
    const client = vi.fn().mockResolvedValue([...RESULTS]);
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: [{ keyId: null, apiKey: 'env-key', monthlyLimit: null, dailyLimit: null }],
      now: () => NOW,
      client,
    });
    await expect(run('q')).resolves.toEqual({ results: [...RESULTS], source: 'brave' });
    await expect(run('q')).resolves.toEqual({ results: [...RESULTS], source: 'brave' });
    expect(client).toHaveBeenCalledTimes(2);
    const row = t.raw.prepare('SELECT COUNT(*) AS n FROM assistant_search_calls').get() as {
      n: number;
    };
    expect(row.n).toBe(0);
  });

  it('skips a key deleted after the run was built and uses the second key', async () => {
    const first = addKey('first');
    const second = addKey('second');
    const client = vi.fn().mockResolvedValue([...RESULTS]);
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: keysFor([first, second], ['api-first', 'api-second']),
      now: () => NOW,
      client,
    });
    expect(searchKeysRepo.removeSearchKey(t.scopes.instance(), first)).toBe(true);
    await expect(run('q')).resolves.toEqual({ results: [...RESULTS], source: 'brave' });
    expect(client).toHaveBeenCalledTimes(1);
    expect(client).toHaveBeenCalledWith('api-second', 'q');
  });

  it('a refused key logs one warn with the key id, source and status — never the key', async () => {
    const first = addKey('first');
    const second = addKey('second');
    const client = vi
      .fn()
      .mockRejectedValueOnce(new SearchHttpError(429))
      .mockResolvedValueOnce([...RESULTS]);
    const warn = vi.fn();
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: keysFor([first, second], ['api-first-secret', 'api-second-secret']),
      now: () => NOW,
      client,
      logger: { warn },
    });
    await expect(run('q')).resolves.toEqual({ results: [...RESULTS], source: 'brave' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { component: 'web-search', keyId: first, source: 'brave', status: 429 },
      'web search key refused',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('api-first-secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('api-second-secret');
  });

  it("all keys refused throws Error('every web search key was refused')", async () => {
    const first = addKey('first');
    const second = addKey('second');
    const client = vi
      .fn()
      .mockRejectedValueOnce(new SearchHttpError(401))
      .mockRejectedValueOnce(new SearchHttpError(403));
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: keysFor([first, second], ['api-first', 'api-second']),
      now: () => NOW,
      client,
    });
    await expect(run('q')).rejects.toThrow('every web search key was refused');
  });

  it('empty keys throws the all-refused error without calling the client', async () => {
    const client = vi.fn().mockResolvedValue([...RESULTS]);
    const run = createWebSearchRun({
      instance: t.scopes.instance(),
      guildId: GUILD,
      source: 'brave',
      keys: [],
      now: () => NOW,
      client,
    });
    await expect(run('q')).rejects.toThrow('every web search key was refused');
    expect(client).not.toHaveBeenCalled();
  });
});
