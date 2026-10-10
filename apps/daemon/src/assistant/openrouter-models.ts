import { z } from 'zod';

/**
 * Task 10: the OpenRouter model catalogue. The public model list tells the AI
 * setup page when a chain model is no longer listed (requests to it will
 * fail) and what each listed model can do (capability chips). The endpoint is
 * public — no key is ever sent.
 */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface ModelListing {
  readonly listed: boolean;
  readonly image: boolean;
  readonly file: boolean;
  readonly tools: boolean;
  readonly reasoning: boolean;
}

export interface OpenRouterModelCatalogue {
  /** Cached answer, or undefined when never fetched; a stale or missing cache triggers a background refresh. */
  peek(model: string): ModelListing | undefined;
  refresh(): Promise<void>;
}

const openRouterModelsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      architecture: z
        .object({
          input_modalities: z.array(z.string()).optional(),
        })
        .optional(),
      supported_parameters: z.array(z.string()).optional(),
    }),
  ),
});

const NOT_LISTED: ModelListing = {
  listed: false,
  image: false,
  file: false,
  tools: false,
  reasoning: false,
};

export const createOpenRouterModelCatalogue = (deps: {
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly ttlMs?: number;
  readonly log: { warn(obj: object, msg: string): void };
}): OpenRouterModelCatalogue => {
  const ttlMs = deps.ttlMs ?? 3_600_000;
  let cache = new Map<string, ModelListing>();
  let fetchedAt: number | undefined = undefined;
  let lastFailureAt: number | undefined = undefined;
  let inFlight: Promise<void> | undefined = undefined;

  const recordFailure = (): void => {
    lastFailureAt = deps.now();
  };

  const doFetch = async (): Promise<void> => {
    let response: Response;
    try {
      response = await deps.fetchImpl(OPENROUTER_MODELS_URL, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      deps.log.warn({ host: 'openrouter.ai', err }, 'OpenRouter model list fetch failed');
      recordFailure();
      return;
    }
    if (!response.ok) {
      deps.log.warn(
        { host: 'openrouter.ai', status: response.status },
        'OpenRouter model list fetch failed',
      );
      recordFailure();
      return;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      deps.log.warn({ host: 'openrouter.ai', err }, 'OpenRouter model list fetch failed');
      recordFailure();
      return;
    }
    const parsed = openRouterModelsResponse.safeParse(body);
    if (!parsed.success) {
      deps.log.warn({ host: 'openrouter.ai' }, 'OpenRouter model list fetch failed');
      recordFailure();
      return;
    }
    const next = new Map<string, ModelListing>();
    for (const entry of parsed.data.data) {
      const modalities = entry.architecture?.input_modalities ?? [];
      const params = entry.supported_parameters ?? [];
      next.set(entry.id, {
        listed: true,
        image: modalities.includes('image'),
        file: modalities.includes('file'),
        tools: params.includes('tools'),
        reasoning: params.includes('reasoning'),
      });
    }
    cache = next;
    fetchedAt = deps.now();
    lastFailureAt = undefined;
  };

  const refresh = async (): Promise<void> => {
    const at = fetchedAt;
    if (at !== undefined && deps.now() - at < ttlMs) return;
    if (lastFailureAt !== undefined && deps.now() - lastFailureAt < 60_000) return;
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    inFlight = doFetch();
    try {
      await inFlight;
    } finally {
      inFlight = undefined;
    }
  };

  return {
    peek(model) {
      void refresh();
      if (fetchedAt === undefined) return undefined;
      return cache.get(model) ?? { ...NOT_LISTED };
    },
    refresh,
  };
};
