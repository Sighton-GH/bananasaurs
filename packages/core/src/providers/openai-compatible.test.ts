import { describe, expect, it, vi } from 'vitest';
import { createNvidiaNimProvider, createOpenRouterProvider } from './openai-compatible.js';

const response = new Response(
  JSON.stringify({
    model: 'served',
    choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  }),
  { status: 200 },
);

describe('OpenAI-compatible providers', () => {
  it.each([
    ['openrouter', createOpenRouterProvider, 'https://openrouter.ai/api/v1/chat/completions'],
    ['nvidia-nim', createNvidiaNimProvider, 'https://integrate.api.nvidia.com/v1/chat/completions'],
  ] as const)(
    'adapts %s without putting the key in the URL',
    async (_name, factory, expectedUrl) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response.clone());
      const provider = factory({ apiKey: 'secret', fetch });
      await expect(
        provider.generateText({
          model: 'free-model',
          systemInstruction: 'Be concise.',
          messages: [{ role: 'user', text: 'hello' }],
        }),
      ).resolves.toEqual({
        text: 'answer',
        model: 'served',
        finishReason: 'stop',
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      });
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(url).toBe(expectedUrl);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      expect(JSON.parse(init?.body as string)).toMatchObject({
        model: 'free-model',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'hello' },
        ],
      });
    },
  );
  it('declares the tools capability', () => {
    expect(createOpenRouterProvider({ apiKey: 'secret' }).capabilities.has('tools')).toBe(true);
    expect(createNvidiaNimProvider({ apiKey: 'secret' }).capabilities.has('tools')).toBe(true);
  });

  it('runs the local outbound scan before fetch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await expect(
      provider.generateText({
        model: 'free-model',
        messages: [{ role: 'user', text: 'password=abc123456789secret' }],
      }),
    ).rejects.toMatchObject({ kind: 'safety-refusal' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps tool declarations to function tools', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'served',
          choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      ),
    );
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await provider.generateText({
      model: 'free-model',
      messages: [{ role: 'user', text: 'q' }],
      tools: [{ name: 'search_sources', description: 'Search.', parameters: { type: 'object' } }],
    });
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_sources',
            description: 'Search.',
            parameters: { type: 'object' },
          },
        },
      ],
    });
  });

  it('returns native tool calls from the response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'served',
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'search_sources', arguments: '{"query":"x"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await expect(
      provider.generateText({ model: 'free-model', messages: [{ role: 'user', text: 'q' }] }),
    ).resolves.toEqual({
      text: '',
      model: 'served',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'search_sources', args: { query: 'x' } }],
    });
  });

  it('keeps a call with malformed arguments as empty args', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'search_sources', arguments: 'not-json{' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await expect(
      provider.generateText({ model: 'free-model', messages: [{ role: 'user', text: 'q' }] }),
    ).resolves.toMatchObject({
      toolCalls: [{ id: 'c1', name: 'search_sources', args: {} }],
    });
  });

  it('sends assistant tool turns and tool results in wire format', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response.clone());
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await provider.generateText({
      model: 'free-model',
      messages: [
        { role: 'user', text: 'q' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'c1', name: 'search_sources', args: { query: 'x' } }],
        },
        { role: 'tool', text: 'result', toolName: 'search_sources', toolCallId: 'c1' },
      ],
    });
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {
      messages: unknown;
    };
    expect(body.messages).toEqual([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'search_sources', arguments: '{"query":"x"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ]);
  });

  it('refuses a tool result without a call id', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await expect(
      provider.generateText({
        model: 'free-model',
        messages: [
          { role: 'user', text: 'q' },
          { role: 'tool', text: 'result', toolName: 't' },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('non-2xx error detail (ADR 0077)', () => {
    const dailyCapBody = JSON.stringify({
      error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' },
    });

    it('classifies a free-model daily cap 429 as a non-retryable quota error with resetAt', async () => {
      const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(dailyCapBody, {
          status: 429,
          headers: { 'x-ratelimit-reset': String(resetSeconds) },
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({
          model: 'nvidia/nemotron:free',
          messages: [{ role: 'user', text: 'q' }],
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        kind: 'quota',
        retryable: false,
        quotaScope: 'daily-free',
        resetAt: resetSeconds * 1000,
      });
      expect((err as Error).message).toContain('free-model daily limit reached');
      expect((err as Error).message).toContain('free-models-per-day');
    });

    it('treats a 429 on a :free model with no day-scoped message as an ordinary rate limit', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded' } }), {
          status: 429,
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      await expect(
        provider.generateText({
          model: 'nvidia/nemotron:free',
          messages: [{ role: 'user', text: 'q' }],
        }),
      ).rejects.toMatchObject({ kind: 'rate-limit', retryable: true, quotaScope: undefined });
    });

    it('treats a daily-cap-worded 429 on a paid model as an ordinary rate limit', async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(dailyCapBody, { status: 429 }));
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      await expect(
        provider.generateText({
          model: 'nvidia/nemotron',
          messages: [{ role: 'user', text: 'q' }],
        }),
      ).rejects.toMatchObject({ kind: 'rate-limit', retryable: true });
    });

    it('does not throw from parsing a malformed, empty, or oversized error body', async () => {
      const bodies = ['not-json{', '', `{"error":${'x'.repeat(5000)}`];
      for (const body of bodies) {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(new Response(body, { status: 429 }));
        const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
        await expect(
          provider.generateText({
            model: 'nvidia/nemotron:free',
            messages: [{ role: 'user', text: 'q' }],
          }),
        ).rejects.toMatchObject({ kind: 'rate-limit', retryable: true });
      }
    });

    it('never puts the API key in the error message', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 401, message: 'bad key' } }), {
          status: 401,
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'super-secret-key', fetch });
      const err = await provider
        .generateText({ model: 'free-model', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect((err as Error).message).not.toContain('super-secret-key');
    });

    it('ignores an invalid X-RateLimit-Reset header', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(dailyCapBody, {
          status: 429,
          headers: { 'x-ratelimit-reset': 'not-a-number' },
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm:free', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect((err as { resetAt?: number }).resetAt).toBeUndefined();
    });

    it('reads resetAt from error.metadata.headers in the JSON body (fix round 1, ADR 0077)', async () => {
      // The exact shape OpenRouter's platform 429 actually sends (issues
      // #936, #664): the rate-limit headers travel INSIDE the JSON body, not
      // on the HTTP response. Values are strings; Reset is Unix ms. The
      // literal example reset (1777420800000, 2026-04-29) is already in the
      // past by the time this suite runs, so it is swapped for an
      // equivalently-shaped future value; everything else matches exactly.
      const futureResetMs = Date.now() + 3_600_000;
      const body = JSON.stringify({
        error: {
          code: 429,
          message: 'Rate limit exceeded: free-models-per-day. …',
          metadata: {
            headers: {
              'X-RateLimit-Limit': '50',
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(futureResetMs),
            },
          },
        },
      });
      // No HTTP-level rate-limit headers at all: resetAt must come from the body.
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(body, { status: 429 }));
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({
          model: 'nvidia/nemotron:free',
          messages: [{ role: 'user', text: 'q' }],
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        kind: 'quota',
        retryable: false,
        quotaScope: 'daily-free',
        resetAt: futureResetMs,
      });
    });

    it('falls back to the HTTP header, or undefined, when metadata.headers is absent', async () => {
      const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(dailyCapBody, {
          status: 429,
          headers: { 'x-ratelimit-reset': String(resetSeconds) },
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const withHeader = await provider
        .generateText({ model: 'm:free', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(withHeader).toMatchObject({
        kind: 'quota',
        quotaScope: 'daily-free',
        resetAt: resetSeconds * 1000,
      });

      const fetchNoReset = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(dailyCapBody, { status: 429 }));
      const providerNoReset = createOpenRouterProvider({ apiKey: 'secret', fetch: fetchNoReset });
      const withoutHeader = await providerNoReset
        .generateText({ model: 'm:free', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(withoutHeader).toMatchObject({ kind: 'quota', quotaScope: 'daily-free' });
      expect((withoutHeader as { resetAt?: number }).resetAt).toBeUndefined();
    });

    it('treats X-RateLimit-Remaining 0 plus a per-day message as the daily cap (fix round 1)', async () => {
      const body = JSON.stringify({
        error: {
          code: 429,
          message: 'You have hit the per-day cap for this key.',
          metadata: { headers: { 'X-RateLimit-Remaining': '0' } },
        },
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(body, { status: 429 }));
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      await expect(
        provider.generateText({
          model: 'nvidia/nemotron:free',
          messages: [{ role: 'user', text: 'q' }],
        }),
      ).rejects.toMatchObject({ kind: 'quota', quotaScope: 'daily-free' });
    });

    it('does not treat X-RateLimit-Remaining 0 alone as the daily cap (the per-minute limit reports it too)', async () => {
      const body = JSON.stringify({
        error: {
          code: 429,
          message: 'Rate limit exceeded',
          metadata: { headers: { 'X-RateLimit-Remaining': '0' } },
        },
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(body, { status: 429 }));
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      await expect(
        provider.generateText({
          model: 'nvidia/nemotron:free',
          messages: [{ role: 'user', text: 'q' }],
        }),
      ).rejects.toMatchObject({ kind: 'rate-limit', retryable: true, quotaScope: undefined });
    });
  });

  it('ignores thinkingBudget instead of sending it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response.clone());
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await provider.generateText({
      model: 'free-model',
      messages: [{ role: 'user', text: 'q' }],
      thinkingBudget: 512,
    });
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect('thinkingBudget' in body).toBe(false);
    expect('thinking_budget' in body).toBe(false);
    expect('thinkingConfig' in body).toBe(false);
    expect('thinking_config' in body).toBe(false);
  });
});
