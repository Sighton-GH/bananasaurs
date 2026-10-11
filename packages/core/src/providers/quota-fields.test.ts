import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterProvider } from './openai-compatible.js';
import { ProviderError } from './errors.js';

describe('ProviderError quota fields (contracts §3)', () => {
  it('carries the widened scope, retry delay and learned limit', () => {
    const error = new ProviderError('quota', 'Gemini request failed with HTTP 429', false, {
      status: 429,
      quotaScope: 'day',
      retryAfterMs: 37_000,
      learnedLimit: { perDay: 20 },
    });
    expect(error.quotaScope).toBe('day');
    expect(error.retryAfterMs).toBe(37_000);
    expect(error.learnedLimit).toEqual({ perDay: 20 });
    const legacy = new ProviderError('quota', 'x', false, {
      quotaScope: 'daily-free',
      resetAt: 123,
    });
    expect(legacy.quotaScope).toBe('daily-free');
    expect(legacy.resetAt).toBe(123);
  });
  it('reads Retry-After on a plain OpenRouter 429', async () => {
    const provider = createOpenRouterProvider({
      apiKey: 'sk-test-key',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'busy', type: 'rate_limit_exceeded' } }), {
          status: 429,
          headers: { 'retry-after': '45' },
        }),
      ),
    });
    const error = await provider
      .generateText({ model: 'some-model', messages: [{ role: 'user', text: 'hi' }] })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryAfterMs).toBe(45_000);
  });
  it.each([
    ['0', 0],
    ['7200', 3_600_000],
    [' 45 ', 45_000],
    ['', undefined],
    ['not-a-delay', undefined],
    ['Sun, 11 Oct 2026 15:30:45 GMT', 45_000],
    ['Sun, 11 Oct 2026 15:29:00 GMT', 0],
    ['Sun, 11 Oct 2026 18:30:00 GMT', 3_600_000],
  ] as const)('normalises Retry-After %s', async (header, expected) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-11T15:30:00Z'));
    try {
      const provider = createOpenRouterProvider({
        apiKey: 'sk-test-key',
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(
            new Response('{}', { status: 429, headers: { 'retry-after': header } }),
          ),
      });
      const error = await provider
        .generateText({ model: 'some-model', messages: [{ role: 'user', text: 'hi' }] })
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ kind: 'rate-limit', retryable: true, status: 429 });
      expect((error as ProviderError).retryAfterMs).toBe(expected);
    } finally {
      now.mockRestore();
    }
  });

  it('preserves daily-free classification while carrying Retry-After', async () => {
    const provider = createOpenRouterProvider({
      apiKey: 'sk-test-key',
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' },
            }),
            { status: 429, headers: { 'retry-after': '45' } },
          ),
        ),
    });
    const error = await provider
      .generateText({ model: 'some-model:free', messages: [{ role: 'user', text: 'hi' }] })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      kind: 'quota',
      retryable: false,
      quotaScope: 'daily-free',
      retryAfterMs: 45_000,
    });
  });

  it('does not add Retry-After to a non-429 error', async () => {
    const provider = createOpenRouterProvider({
      apiKey: 'sk-test-key',
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('{}', { status: 503, headers: { 'retry-after': '45' } })),
    });
    const error = await provider
      .generateText({ model: 'some-model', messages: [{ role: 'user', text: 'hi' }] })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: 'outage', retryable: true, status: 503 });
    expect((error as ProviderError).retryAfterMs).toBeUndefined();
  });
});
