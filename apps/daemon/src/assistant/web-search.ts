import { searchKeysRepo, type InstanceScope } from '@bananasaurs/storage';
import type { WebResult } from './tools.js';

export type WebSearchSource = 'brave' | 'tavily';

/** `keyId: null` is the `.env` Brave seed: never limited, never recorded. */
export interface WebSearchKey {
  readonly keyId: string | null;
  readonly apiKey: string;
  readonly monthlyLimit: number | null;
  readonly dailyLimit: number | null;
}

export interface WebSearchOutcome {
  readonly results: readonly WebResult[];
  readonly source: WebSearchSource;
}

export type WebSearchRun = (query: string) => Promise<WebSearchOutcome>;

/** Only the HTTP status: a provider's error body is never read into a message (ADR 0120 §6). */
export class SearchHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${String(status)}`);
    this.name = 'SearchHttpError';
  }
}

export class WebSearchLimitError extends Error {
  constructor(readonly availableAt: number) {
    super('every web search key is at its limit');
    this.name = 'WebSearchLimitError';
  }
}

export const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 429, 432, 433]);

export type SearchClient = (apiKey: string, query: string) => Promise<readonly WebResult[]>;

/**
 * Tries each key in order (ADR 0120 §5): a key at its limit is skipped, a
 * key the provider refuses is skipped to the next one, and anything else
 * ends the search. A reservation counts even when the call then fails.
 */
export const createWebSearchRun = (deps: {
  readonly instance: InstanceScope;
  readonly guildId: string;
  readonly source: WebSearchSource;
  readonly keys: readonly WebSearchKey[];
  readonly now: () => number;
  readonly client: SearchClient;
}): WebSearchRun => {
  const { instance, guildId, source, keys, now, client } = deps;
  return async (query: string): Promise<WebSearchOutcome> => {
    const limitedAt: number[] = [];
    for (const key of keys) {
      if (key.keyId !== null) {
        const reserved = searchKeysRepo.reserveSearchCall(instance, {
          keyId: key.keyId,
          guildId,
          now: now(),
          monthlyLimit: key.monthlyLimit,
          dailyLimit: key.dailyLimit,
        });
        if (!reserved.ok) {
          // A key deleted mid-request is skipped like a refused one, but it
          // is not a limit: it must not count toward the all-limited case.
          if (reserved.limit === 'missing') continue;
          limitedAt.push(reserved.availableAt);
          continue;
        }
      }
      let results: readonly WebResult[];
      try {
        results = await client(key.apiKey, query);
      } catch (err) {
        if (err instanceof SearchHttpError && REFUSED_STATUSES.has(err.status)) {
          continue;
        }
        throw err;
      }
      return { results, source };
    }
    if (limitedAt.length === keys.length && keys.length > 0)
      throw new WebSearchLimitError(Math.min(...limitedAt));
    throw new Error('every web search key was refused');
  };
};
