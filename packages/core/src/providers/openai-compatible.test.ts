import { describe, expect, it, vi } from 'vitest';
import type { GenerateTextRequest } from './contracts.js';
import { ProviderError } from './errors.js';
import { createNvidiaNimProvider, createOpenRouterProvider } from './openai-compatible.js';

const sse = (...payloads: unknown[]): Response =>
  new Response(
    `${payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const response = (): Response =>
  sse({
    model: 'served',
    choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });

describe('OpenAI-compatible providers', () => {
  it.each([
    ['openrouter', createOpenRouterProvider, 'https://openrouter.ai/api/v1/chat/completions'],
    ['nvidia-nim', createNvidiaNimProvider, 'https://integrate.api.nvidia.com/v1/chat/completions'],
  ] as const)(
    'adapts %s without putting the key in the URL',
    async (_name, factory, expectedUrl) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
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
      sse({
        model: 'served',
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
      }),
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
      sse({
        model: 'served',
        choices: [
          {
            delta: {
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
      sse({
        choices: [
          {
            delta: {
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
    );
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await expect(
      provider.generateText({ model: 'free-model', messages: [{ role: 'user', text: 'q' }] }),
    ).resolves.toMatchObject({
      toolCalls: [{ id: 'c1', name: 'search_sources', args: {} }],
    });
  });

  it('sends assistant tool turns and tool results in wire format', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
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

  it('ADR 0129 §8: the OpenRouter request asks for usage, NIM does not', async () => {
    const openRouterFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await createOpenRouterProvider({ apiKey: 'secret', fetch: openRouterFetch }).generateText({
      model: 'free-model',
      messages: [{ role: 'user', text: 'q' }],
    });
    expect(JSON.parse(openRouterFetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      usage: { include: true },
    });
    const nimFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await createNvidiaNimProvider({ apiKey: 'secret', fetch: nimFetch }).generateText({
      model: 'free-model',
      messages: [{ role: 'user', text: 'q' }],
    });
    expect(JSON.parse(nimFetch.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty('usage');
  });

  it('ADR 0129 §8: a response usage.cost maps to usage.costUsd', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      sse({
        model: 'served',
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0.0012 },
      }),
    );
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await expect(
      provider.generateText({ model: 'free-model', messages: [{ role: 'user', text: 'q' }] }),
    ).resolves.toMatchObject({ usage: { costUsd: 0.0012 } });
  });

  it('streams deltas, ignores keepalives, and joins fragmented tool args', async () => {
    const body =
      ': OPENROUTER PROCESSING\n\n' +
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo","reasoning":"why","tool_calls":[{"index":0,"id":"c1","function":{"name":"search_sources","arguments":"{\\"q"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ue\\":1}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n' +
      'data: [DONE]\n\n';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    const seen: Array<{ answerChars: number; keepalives: number }> = [];
    const chunks: Array<{ text: string; reasoning: string }> = [];
    const res = await provider.generateText({
      model: 'm',
      messages: [{ role: 'user', text: 'hi Sam L' }],
      capabilities: { tools: true, image: false, pdf: false, reasoning: true, thinking: 'budget' },
      onProgress: (p) => {
        seen.push({ answerChars: p.answerChars, keepalives: p.keepalives });
      },
      onChunk: (c) => {
        chunks.push({ ...c });
      },
    });
    expect(res.text).toBe('hello');
    expect(res.reasoning).toBe('why');
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'search_sources', args: { que: 1 } }]);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.some((s) => s.keepalives >= 1)).toBe(true);
    expect(chunks.map((c) => c.text).join('')).toBe('hello');
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      reasoning: { exclude: false },
    });
  });

  it('omits the reasoning request without capabilities or without reasoning support', async () => {
    const payload = { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] };
    const fetchNoCaps = vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(payload));
    await createOpenRouterProvider({ apiKey: 'secret', fetch: fetchNoCaps }).generateText({
      model: 'm',
      messages: [{ role: 'user', text: 'hi' }],
    });
    expect(
      'reasoning' in
        (JSON.parse(fetchNoCaps.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>),
    ).toBe(false);
    const fetchDenied = vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(payload));
    await createOpenRouterProvider({ apiKey: 'secret', fetch: fetchDenied }).generateText({
      model: 'm',
      messages: [{ role: 'user', text: 'hi' }],
      capabilities: { tools: true, image: false, pdf: false, reasoning: false, thinking: 'none' },
    });
    expect(
      'reasoning' in
        (JSON.parse(fetchDenied.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>),
    ).toBe(false);
  });

  it('nim never sends a reasoning request field', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }));
    const provider = createNvidiaNimProvider({ apiKey: 'secret', fetch });
    await provider.generateText({
      model: 'm',
      messages: [{ role: 'user', text: 'hi' }],
      capabilities: { tools: true, image: false, pdf: false, reasoning: true, thinking: 'budget' },
    });
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect('reasoning' in body).toBe(false);
    expect(body).toMatchObject({ stream: true });
    expect('stream_options' in body).toBe(false);
  });

  it('turns mid-stream finish_reason error into a retryable ProviderError', async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"part"},"finish_reason":"error","error":{"message":"upstream broke"}}]}\n\n';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    const err = await provider
      .generateText({ model: 'm', messages: [{ role: 'user', text: 'hi' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'outage', retryable: true, finishReason: 'error' });
  });

  it('delivers length text with reasoning and usage', async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"half","reasoning":"why"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":2,"completion_tokens":9,"total_tokens":11}}\n\n' +
      'data: [DONE]\n\n';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    const res = await provider.generateText({
      model: 'm',
      messages: [{ role: 'user', text: 'hi Sam L' }],
      capabilities: { tools: true, image: false, pdf: false, reasoning: true, thinking: 'budget' },
    });
    expect(res.text).toBe('half');
    expect(res.reasoning).toBe('why');
    expect(res.finishReason).toBe('length');
    expect(res.usage).toMatchObject({ promptTokens: 2, completionTokens: 9, totalTokens: 11 });
  });

  it('an idle stream throws a retryable timeout', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch, timeoutMs: 50 });
    const err = await provider
      .generateText({ model: 'm', messages: [{ role: 'user', text: 'hi Car Team A' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('a stalled mid-stream body hits the idle timer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch, idleTimeoutMs: 50 });
    const err = await provider
      .generateText({ model: 'm', messages: [{ role: 'user', text: 'hi' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'timeout', retryable: true });
  });

  describe('success body reads', () => {
    it('a timeout while reading the response body is a retryable timeout', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const signal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener('abort', () => controller.error(signal.reason));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch, idleTimeoutMs: 20 });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind: 'timeout', retryable: true });
    });

    it('a body stream failure becomes a retryable outage', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind: 'outage', retryable: true });
    });

    it('malformed JSON becomes a non-retryable invalid-response', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response('{not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind: 'invalid-response', retryable: false });
    });
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

    it('does not read an empty X-RateLimit-Remaining as zero', async () => {
      const body = JSON.stringify({
        error: {
          code: 429,
          message: 'You have hit the per-day cap for this key.',
          metadata: { headers: { 'X-RateLimit-Remaining': ' ' } },
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
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
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

  describe('empty-answer evidence (ADR 0129 §4)', () => {
    it('throws an empty answer with finishReason, upstream and emptyAnswer', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        sse({
          provider: 'Nebius',
          choices: [{ delta: { content: null, reasoning: 'thinking…' }, finish_reason: 'length' }],
          usage: {
            completion_tokens: 2048,
            completion_tokens_details: { reasoning_tokens: 2048 },
          },
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({
        kind: 'invalid-response',
        finishReason: 'length',
        upstream: 'Nebius',
      });
      expect((err as Error).message).toBe('openrouter returned no text');
      expect((err as ProviderError).emptyAnswer).toEqual({
        completionTokens: 2048,
        reasoningTokens: 2048,
        reasoningOnly: true,
      });
    });

    it('attaches upstream from the error body provider_name', async () => {
      const body = JSON.stringify({
        error: { code: 404, message: 'No endpoints found', metadata: { provider_name: 'X' } },
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(body, { status: 404 }));
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ upstream: 'X' });
    });

    it('caps success metadata fields', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        sse({
          provider: 'p'.repeat(100),
          choices: [{ delta: { content: 'answer' }, finish_reason: 'f'.repeat(100) }],
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const result = await provider.generateText({
        model: 'm',
        messages: [{ role: 'user', text: 'q' }],
      });
      expect(result.upstream).toHaveLength(60);
      expect(result.finishReason).toHaveLength(40);
    });

    it('reports upstream and thinkingTokens on success', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        sse({
          provider: 'Nebius',
          choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 3,
            total_tokens: 5,
            completion_tokens_details: { reasoning_tokens: 12 },
          },
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      await expect(
        provider.generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] }),
      ).resolves.toMatchObject({ upstream: 'Nebius', usage: { thinkingTokens: 12 } });
    });
  });

  describe('error fields (ADR 0079)', () => {
    const connectTimeout = (): TypeError =>
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('Connect Timeout Error'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      });

    it('attaches netCode and host when fetch fails to connect', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(connectTimeout());
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ netCode: 'UND_ERR_CONNECT_TIMEOUT', host: 'openrouter.ai' });
    });

    it.each([429, 401])('attaches status and host on HTTP %s', async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('{}', { status }));
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ status, host: 'openrouter.ai' });
    });
  });

  describe('S3 review fix round 1', () => {
    const errorOf = (err: unknown): { message: string; cause?: unknown } =>
      err as { message: string; cause?: unknown };

    it('redacts the API key from a fetch failure cause that echoes a URL', async () => {
      const key = 'sk-or-testkey123';
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(
          new TypeError(`fetch failed: https://openrouter.ai/api/v1/chat/completions?key=${key}`),
        );
      const provider = createOpenRouterProvider({ apiKey: key, fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'outage', retryable: true });
      expect(JSON.stringify(err)).not.toContain(key);
      const cause = errorOf(err).cause as Error;
      expect(cause.message).not.toContain(key);
      expect(cause.message).toContain('(redacted)');
    });

    it('discards the original nested cause and preserves the outer diagnostic code', async () => {
      const key = 'sk-or-nested';
      const inner = Object.assign(new Error(`invalid token Bearer ${key}`), { code: 'EAUTH' });
      const outer = Object.assign(new Error('request failed', { cause: inner }), {
        code: 'EOUTER',
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(outer);
      const provider = createOpenRouterProvider({ apiKey: key, fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      const cause = errorOf(err).cause as Error & { code?: string };
      expect(cause.message).toBe('request failed');
      expect(cause.code).toBe('EOUTER');
      expect(cause.cause).toBeUndefined();
      expect(inner.message).toContain(key);
    });

    it('redacts a short key from a stream SyntaxError cause', async () => {
      const key = 'sk-x9';
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(`data: ${key}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: key, fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'invalid-response', retryable: false });
      const cause = errorOf(err).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).not.toContain(key);
    });

    it('redacts a key echoed in a 401 error body without changing the mapping', async () => {
      const key = 'sk-or-401echo';
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: 401, message: `invalid credentials Bearer ${key}` } }),
            { status: 401 },
          ),
        );
      const provider = createOpenRouterProvider({ apiKey: key, fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        kind: 'authentication',
        retryable: false,
        status: 401,
        host: 'openrouter.ai',
      });
      expect(errorOf(err).message).not.toContain(key);
      expect(errorOf(err).message).toContain('(redacted)');
    });

    it('redacts the key from a mid-stream body failure cause', async () => {
      const key = 'sk-or-streambody';
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`upstream reset for Bearer ${key}`));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
      const provider = createOpenRouterProvider({ apiKey: key, fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'outage', retryable: true });
      const cause = errorOf(err).cause as Error;
      expect(cause.message).not.toContain(key);
      expect(cause.message).toContain('(redacted)');
    });

    it('a top-level stream error after partial text throws a retryable outage', async () => {
      const body =
        'data: {"choices":[{"delta":{"content":"part"}}]}\n\n' +
        'data: {"error":{"message":"upstream broke","code":502}}\n\n' +
        'data: [DONE]\n\n';
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind: 'outage', retryable: true, finishReason: 'error' });
    });

    it('an abort during a non-cooperative error-body read keeps the status mapping and frees the reader', async () => {
      const cancelSpy = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start() {},
        cancel(reason) {
          cancelSpy(reason);
        },
      });
      const httpResponse = new Response(body, { status: 429, headers: { 'retry-after': '1' } });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(httpResponse);
      // timeoutMs (not idleTimeoutMs): the first-byte timer is still armed
      // during the error-body read. The abort unblocks the read; the 429
      // mapping is byte-identical to a complete body read.
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch, timeoutMs: 30 });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        kind: 'rate-limit',
        retryable: true,
        status: 429,
        retryAfterMs: 1000,
      });
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(httpResponse.body?.locked).toBe(false);
    });

    it('a 429 error body keeps its exact mapping when read through the raced reader', async () => {
      const httpResponse = new Response(
        JSON.stringify({ error: { code: 429, message: 'slow down' } }),
        { status: 429, headers: { 'retry-after': '1' } },
      );
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(httpResponse);
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        kind: 'rate-limit',
        retryable: true,
        status: 429,
        retryAfterMs: 1000,
      });
      expect(httpResponse.body?.locked).toBe(false);
    });

    it('accepts a usage: null chunk', async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          sse(
            { model: 'served', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
            { usage: null },
          ),
        );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      await expect(
        provider.generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] }),
      ).resolves.toEqual({ text: 'answer', model: 'served', finishReason: 'stop' });
    });

    it('a pre-aborted caller signal never reaches fetch and forwards the reason', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const caller = new AbortController();
      caller.abort(new Error('caller gave up'));
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({
          model: 'm',
          messages: [{ role: 'user', text: 'q' }],
          signal: caller.signal,
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'outage', retryable: true });
      expect(fetch).not.toHaveBeenCalled();
      expect((errorOf(err).cause as Error).message).toBe('caller gave up');
    });

    it('removes the caller abort listener once the call settles', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
      const caller = new AbortController();
      const removeSpy = vi.spyOn(caller.signal, 'removeEventListener');
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      await provider.generateText({
        model: 'm',
        messages: [{ role: 'user', text: 'q' }],
        signal: caller.signal,
      });
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('aborts the fetch signal on an error exit', async () => {
      let seenSignal = null as AbortSignal | null;
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
        seenSignal = init?.signal ?? null;
        return Promise.resolve(
          new Response('data: {bad json\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      });
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch(() => undefined);
      expect(seenSignal?.aborted).toBe(true);
    });

    it('cancels a late fetch response body after a timeout', async () => {
      const cancelSpy = vi.fn();
      let resolveFetch: ((value: Response) => void) | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch, timeoutMs: 30 });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'timeout', retryable: true });
      resolveFetch?.(
        new Response(new ReadableStream({ start() {}, cancel: cancelSpy }), { status: 200 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it('cancels the stream reader and releases the lock on a mid-stream error exit', async () => {
      const cancelSpy = vi.fn();
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"part"},"finish_reason":"error"}]}\n\n',
            ),
          );
        },
        cancel(reason) {
          cancelSpy(reason);
        },
      });
      const httpResponse = new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(httpResponse);
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'outage', retryable: true, finishReason: 'error' });
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(httpResponse.body?.locked).toBe(false);
    });

    it('opens a new slot when index 0 is reused with a different id', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'a',
                    type: 'function',
                    function: { name: 'f', arguments: '{"x"' },
                  },
                ],
              },
            },
            { delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } },
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'b',
                    type: 'function',
                    function: { name: 'g', arguments: '{"y":2}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const res = await provider.generateText({
        model: 'm',
        messages: [{ role: 'user', text: 'q' }],
      });
      expect(res.toolCalls).toEqual([
        { id: 'a', name: 'f', args: { x: 1 } },
        { id: 'b', name: 'g', args: { y: 2 } },
      ]);
    });

    it('opens a new slot for no-index calls when a second name arrives', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        sse({
          choices: [
            { delta: { tool_calls: [{ function: { name: 'f', arguments: '{"x"' } }] } },
            { delta: { tool_calls: [{ function: { arguments: ':1}' } }] } },
            {
              delta: { tool_calls: [{ function: { name: 'g', arguments: '{"y":2}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const res = await provider.generateText({
        model: 'm',
        messages: [{ role: 'user', text: 'q' }],
      });
      expect(res.toolCalls).toEqual([
        { name: 'f', args: { x: 1 } },
        { name: 'g', args: { y: 2 } },
      ]);
    });

    it('joins interleaved indexed fragments across parallel calls', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'a', function: { name: 'f', arguments: '{"x"' } },
                  { index: 1, id: 'b', function: { name: 'g', arguments: '{"y"' } },
                ],
              },
            },
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: ':1}' } },
                  { index: 1, function: { arguments: ':2}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const res = await provider.generateText({
        model: 'm',
        messages: [{ role: 'user', text: 'q' }],
      });
      expect(res.toolCalls).toEqual([
        { id: 'a', name: 'f', args: { x: 1 } },
        { id: 'b', name: 'g', args: { y: 2 } },
      ]);
    });

    it('a clean EOF without finish_reason and partial text throws a retryable outage', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response('data: {"choices":[{"delta":{"content":"part"}}]}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'outage', retryable: true });
    });

    it('a clean EOF without finish_reason and a partial tool call throws a retryable outage', async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(
            'data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"f","arguments":"{\\"x\\":1}"}}]}}]}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
      const err = await provider
        .generateText({ model: 'm', messages: [{ role: 'user', text: 'q' }] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'outage', retryable: true });
    });
  });
});

describe('round 2 adversarial regressions', () => {
  const key = 'sk-hostile-key123';
  const req = { model: 'm', messages: [{ role: 'user' as const, text: 'q' }] };
  const generate = (res: Response) =>
    createOpenRouterProvider({
      apiKey: key,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(res),
    }).generateText(req);
  it.each(['string', 'stack', 'frozen', 'object', 'getter'])(
    'copies and sanitizes %s rejection without mutating the original',
    async (kind) => {
      const hostileGetter = vi.fn(() => {
        throw new Error(key);
      });
      const original =
        kind === 'string'
          ? key
          : kind === 'object'
            ? { message: key, cause: key }
            : kind === 'getter'
              ? Object.defineProperty({}, 'message', {
                  get: hostileGetter,
                })
              : new Error(key, { cause: new Error(key) });
      if (original instanceof Error) {
        void original.stack;
        if (kind === 'frozen') Object.freeze(original);
      }
      const error = await createOpenRouterProvider({
        apiKey: key,
        fetch: vi.fn<typeof fetch>().mockRejectedValue(original),
      })
        .generateText(req)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      const cause = (error as Error).cause as Error;
      expect(cause).toBeInstanceOf(Error);
      expect(cause).not.toBe(original);
      expect(String(cause)).not.toContain(key);
      expect(cause.stack).not.toContain(key);
      expect(JSON.stringify(error)).not.toContain(key);
      expect(cause.cause).toBeUndefined();
      if (original instanceof Error) expect(original.message).toBe(key);
      if (kind === 'string' || kind === 'object') expect(cause.message).toBe('(redacted)');
      if (kind === 'getter') {
        expect(cause.message).toBe('request failed');
        expect(hostileGetter).not.toHaveBeenCalled();
      }
    },
  );
  it('sanitizes Zod diagnostics before exposing their message or stack', async () => {
    const diagnosticKey = 'Expected number';
    const e = (await createOpenRouterProvider({
      apiKey: diagnosticKey,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(sse({ choices: [{ delta: { tool_calls: [{ index: 'bad' }] } }] })),
    })
      .generateText(req)
      .catch((e: unknown) => e)) as Error;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.cause).toBeInstanceOf(Error);
    expect(String(e.cause)).not.toContain(diagnosticKey);
    expect((e.cause as Error).stack).not.toContain(diagnosticKey);
    expect(JSON.stringify(e.cause)).not.toContain(diagnosticKey);
  });
  it('redacts success model, upstream and finish metadata at ingestion', async () => {
    const res = await generate(
      sse({
        model: key,
        provider: key,
        choices: [{ delta: { content: 'ok' }, finish_reason: key }],
      }),
    );
    expect(res.model).toBe('(redacted)');
    expect(res.upstream).toBe('(redacted)');
    expect(res.finishReason).toBe('(redacted)');
  });
  it.each(['error', 'empty'])('redacts %s-path upstream and finish metadata', async (path) => {
    const e = await generate(
      sse({
        provider: key,
        model: key,
        ...(path === 'error'
          ? { error: { message: 'bad' } }
          : { choices: [{ finish_reason: key }] }),
      }),
    ).catch((e: unknown) => e);
    expect(JSON.stringify(e)).not.toContain(key);
    expect(e).toMatchObject({ upstream: '(redacted)' });
    if (path === 'empty') expect(e).toMatchObject({ finishReason: '(redacted)' });
  });
  it('sanitizes caller TimeoutError and cancels a non-cooperative body', async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = createOpenRouterProvider({
      apiKey: key,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    }).generateText({ ...req, signal: abort.signal });
    setTimeout(() => abort.abort(new DOMException(key, 'TimeoutError')), 5);
    const e = (await pending.catch((e: unknown) => e)) as ProviderError;
    expect(e.kind).toBe('timeout');
    expect(String(e.cause)).not.toContain(key);
    expect((e.cause as Error).stack).not.toContain(key);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
  it('sanitizes callback ProviderError and preserves classification', async () => {
    const original = new ProviderError('outage', key, true, {
      cause: new Error(key),
      upstream: key,
      finishReason: key,
    });
    void original.stack;
    const e = (await createOpenRouterProvider({
      apiKey: key,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
    })
      .generateText({
        ...req,
        onChunk() {
          throw original;
        },
      })
      .catch((e: unknown) => e)) as ProviderError;
    expect(e).not.toBe(original);
    expect(e.kind).toBe('outage');
    expect(e.retryable).toBe(true);
    expect(e.message).toBe('(redacted)');
    expect(e.stack).not.toContain(key);
    expect(JSON.stringify(e)).not.toContain(key);
    expect(original.message).toBe(key);
  });
  it('idle timeout cancels and unlocks a never-yielding body and aborts fetch', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    let signal: AbortSignal | null | undefined;
    const e = await createOpenRouterProvider({
      apiKey: key,
      idleTimeoutMs: 15,
      fetch: vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        signal = init?.signal;
        return new Response(body);
      }),
    })
      .generateText(req)
      .catch((e: unknown) => e);
    expect(e).toMatchObject({ kind: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
  it('fragmented bytes rearm idle before a complete event exists', async () => {
    const frame =
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        let i = 0;
        timer = setInterval(() => {
          c.enqueue(new TextEncoder().encode(frame.slice(i, i + 10)));
          i += 10;
          if (i >= frame.length) {
            clearInterval(timer);
            c.close();
          }
        }, 10);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    await expect(
      createOpenRouterProvider({
        apiKey: key,
        timeoutMs: 20,
        idleTimeoutMs: 25,
        maxCallMs: 500,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
      }).generateText(req),
    ).resolves.toMatchObject({ text: 'ok' });
  });
  it('first-byte deadline remains active after headers and ignores empty chunks', async () => {
    const started = Date.now();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array());
      },
      cancel,
    });
    const e = await createOpenRouterProvider({
      apiKey: key,
      timeoutMs: 10,
      idleTimeoutMs: 100,
      maxCallMs: 150,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    })
      .generateText(req)
      .catch((e: unknown) => e);
    expect(e).toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(80);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
  it('accepts null errors and missing tool function fragments', async () => {
    const res = await generate(
      sse({
        error: null,
        choices: [
          {
            error: null,
            delta: {
              tool_calls: [
                { index: 0, id: 'a' },
                { index: 0, function: { name: 'f', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    expect(res.toolCalls).toEqual([{ id: 'a', name: 'f', args: {} }]);
  });
  it('joins repeated no-index id/name continuations even when interleaved', async () => {
    const res = await generate(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { id: 'a', function: { name: 'f', arguments: '{"x"' } },
                { id: 'b', function: { name: 'f', arguments: '{"y":2}' } },
                { id: 'a', function: { name: 'f', arguments: ':1}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    expect(res.toolCalls).toEqual([
      { id: 'a', name: 'f', args: { x: 1 } },
      { id: 'b', name: 'f', args: { y: 2 } },
    ]);
  });
  it('keeps reused indexed same-name calls with different ids distinct', async () => {
    const res = await generate(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'f', arguments: '{"x":1}' } },
                { index: 0, id: 'b', function: { name: 'f', arguments: '{"x":2}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    expect(res.toolCalls).toEqual([
      { id: 'a', name: 'f', args: { x: 1 } },
      { id: 'b', name: 'f', args: { x: 2 } },
    ]);
  });
  it('keeps two no-index same-name calls without ids distinct', async () => {
    const res = await generate(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { function: { name: 'f', arguments: '{"x":1}' } },
                { function: { name: 'f', arguments: '{"x":2}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    expect(res.toolCalls).toEqual([
      { name: 'f', args: { x: 1 } },
      { name: 'f', args: { x: 2 } },
    ]);
  });
  it('redacts before shortReason truncation', async () => {
    const prefix = 'x'.repeat(155);
    const e = (await generate(
      new Response(JSON.stringify({ error: { message: prefix + key } }), { status: 401 }),
    ).catch((e: unknown) => e)) as Error;
    expect(e.message).toContain(prefix + '(reda');
    expect(e.message).not.toContain('sk-ho');
  });
  it('does not abort the fetch signal on success and releases the body', async () => {
    let signal: AbortSignal | null | undefined;
    const res = response();
    await createOpenRouterProvider({
      apiKey: key,
      fetch: vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        signal = init?.signal;
        return res;
      }),
    }).generateText(req);
    expect(signal?.aborted).toBe(false);
    expect(res.body?.locked).toBe(false);
  });
  it('throttles ten one-second chunks to four progress emissions', async () => {
    vi.useFakeTimers();
    try {
      const onProgress = vi.fn<NonNullable<GenerateTextRequest['onProgress']>>();
      let timer: ReturnType<typeof setInterval>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          let i = 0;
          timer = setInterval(() => {
            i++;
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' }, ...(i === 10 ? { finish_reason: 'stop' } : {}) }] })}\n\n`,
              ),
            );
            if (i === 10) {
              clearInterval(timer);
              c.close();
            }
          }, 1000);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      const pending = createOpenRouterProvider({
        apiKey: key,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
      }).generateText({ ...req, onProgress });
      await vi.advanceTimersByTimeAsync(10000);
      await pending;
      expect(onProgress).toHaveBeenCalledTimes(4);
      expect(onProgress.mock.calls.map(([p]) => p.msSinceLastByte)).toEqual([0, 0, 0, 0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hostile error inputs never leak the key (S3-T6 round 2 lead repair)', () => {
  const key = 'sk-hostile-key123';
  const req: GenerateTextRequest = { model: 'm', messages: [{ role: 'user', text: 'hi' }] };

  /** Everything observable on an error and its cause chain, decoded as well as raw. */
  const observable = (error: unknown): string => {
    const seen: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
      seen.push(
        current.message,
        current.stack ?? '',
        JSON.stringify(Object.fromEntries(Object.entries(current))),
      );
      current = current.cause;
    }
    const joined = seen.join('\n');
    let decoded = joined;
    try {
      decoded = decodeURIComponent(joined);
    } catch {
      // keep raw
    }
    return `${joined}\n${decoded}`;
  };
  const failure = async (provider: ReturnType<typeof createOpenRouterProvider>): Promise<Error> => {
    try {
      await provider.generateText(req);
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected a failure');
  };

  it('does not pass a ProviderError from the body reader through unchanged', async () => {
    const original = new ProviderError('outage', key, true, {
      cause: new Error(key),
      upstream: key,
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(original);
      },
    });
    const err = await failure(
      createOpenRouterProvider({ apiKey: key, fetch: async () => new Response(body) }),
    );
    expect(err).not.toBe(original);
    expect(observable(err)).not.toContain(key);
    expect(err).toMatchObject({ kind: 'outage', retryable: true });
  });

  it('does not let a throwing code or cause getter escape raw', async () => {
    for (const name of ['code', 'cause'] as const) {
      const hostile = new Error('network down');
      Object.defineProperty(hostile, name, {
        get() {
          throw new Error(key);
        },
      });
      const err = await failure(
        createOpenRouterProvider({
          apiKey: key,
          fetch: async () => {
            throw hostile;
          },
        }),
      );
      expect(observable(err)).not.toContain(key);
      expect(err).toMatchObject({ kind: 'outage', retryable: true });
    }
  });

  it('does not let throwing ProviderError field getters or a trapping cause proxy escape', async () => {
    const getterError = new ProviderError('outage', 'safe', true);
    for (const name of ['kind', 'retryable', 'status', 'quotaScope'])
      Object.defineProperty(getterError, name, {
        get() {
          throw new Error(key);
        },
      });
    const trapped = new ProviderError('outage', 'safe', true, {
      cause: new Proxy(new Error('x'), {
        getOwnPropertyDescriptor() {
          throw new Error(key);
        },
      }),
    });
    for (const hostile of [getterError, trapped]) {
      const err = await failure(
        createOpenRouterProvider({
          apiKey: key,
          fetch: async () => {
            throw hostile;
          },
        }),
      );
      expect(observable(err)).not.toContain(key);
    }
  });

  it('copies only typed diagnostics from a callback ProviderError', async () => {
    const original = new ProviderError('outage', 'safe', true);
    const loose = original as unknown as Record<string, unknown>;
    loose['quotaScope'] = key;
    loose['status'] = key;
    loose['retryAfterMs'] = key;
    loose['kind'] = key;
    const fetch = async (): Promise<Response> =>
      sse({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] });
    let err: Error | undefined;
    try {
      await createOpenRouterProvider({ apiKey: key, fetch }).generateText({
        ...req,
        onChunk: () => {
          throw original;
        },
      });
    } catch (error) {
      err = error as Error;
    }
    expect(err).toBeDefined();
    expect(observable(err)).not.toContain(key);
    expect(JSON.stringify(Object.entries(err as object))).not.toContain(key);
    expect(err).toMatchObject({ kind: 'outage' });
  });

  it('redacts percent-encoded copies of the key', async () => {
    const allEncoded = [...key]
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('');
    for (const echoed of [allEncoded, allEncoded.toUpperCase(), encodeURIComponent('sk/key+123')]) {
      const useKey = echoed === encodeURIComponent('sk/key+123') ? 'sk/key+123' : key;
      const err = await failure(
        createOpenRouterProvider({
          apiKey: useKey,
          fetch: async () => {
            throw new TypeError(`https://example.invalid/?token=${echoed}`);
          },
        }),
      );
      expect(observable(err)).not.toContain(useKey);
      expect(observable(err).toLowerCase()).not.toContain(echoed.toLowerCase());
    }
  });

  it.each(['onChunk', 'onProgress'] as const)(
    'sanitises an async %s rejection and raises no unhandled rejection',
    async (name) => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', listener);
      try {
        const fetch = async (): Promise<Response> =>
          sse({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] });
        let err: Error | undefined;
        try {
          await createOpenRouterProvider({ apiKey: key, fetch }).generateText({
            ...req,
            [name]: () => Promise.reject(new Error(key)),
          });
        } catch (error) {
          err = error as Error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(err).toBeDefined();
        expect(observable(err)).not.toContain(key);
        expect(err).toMatchObject({ kind: 'outage', retryable: true });
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', listener);
      }
    },
  );

  it('sanitises a synchronous onProgress throw', async () => {
    const fetch = async (): Promise<Response> =>
      sse({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] });
    const err = await createOpenRouterProvider({ apiKey: key, fetch })
      .generateText({
        ...req,
        onProgress: () => {
          throw new Error(key);
        },
      })
      .catch((error: unknown) => error as Error);
    expect(observable(err)).not.toContain(key);
  });

  it('stops a never-ending byte trickle at the absolute maxCallMs ceiling', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`,
            ),
          );
        }, 5);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    const err = await createOpenRouterProvider({
      apiKey: key,
      maxCallMs: 60,
      idleTimeoutMs: 10_000,
      timeoutMs: 10_000,
      fetch: async () => new Response(body),
    })
      .generateText(req)
      .catch((error: unknown) => error as Error);
    clearInterval(timer);
    expect(err).toMatchObject({ kind: 'timeout', retryable: true });
  });

  describe('hostile abort reasons and error shapes', () => {
    const trap = (): Error =>
      new Proxy(new Error('x'), {
        getPrototypeOf() {
          throw new Error(key);
        },
        get() {
          throw new Error(key);
        },
      });
    const okFetch = async (): Promise<Response> =>
      sse({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] });

    it('survives a trapping Proxy as a fetch rejection', async () => {
      const err = await failure(
        createOpenRouterProvider({
          apiKey: key,
          fetch: async () => {
            throw trap();
          },
        }),
      );
      expect(observable(err)).not.toContain(key);
      expect(err).toMatchObject({ kind: 'outage', retryable: true });
    });

    it('survives a trapping Proxy as the reason of an already-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort(trap());
      const err = await createOpenRouterProvider({ apiKey: key, fetch: okFetch })
        .generateText({ ...req, signal: controller.signal })
        .catch((error: unknown) => error as Error);
      expect(observable(err)).not.toContain(key);
      expect(err).toMatchObject({ kind: 'outage' });
    });

    it('survives a DOMException lookalike whose name getter throws', async () => {
      const lookalike = Object.create(DOMException.prototype) as Error;
      Object.defineProperty(lookalike, 'name', {
        get() {
          throw new Error(key);
        },
      });
      const err = await failure(
        createOpenRouterProvider({
          apiKey: key,
          fetch: async () => {
            throw lookalike;
          },
        }),
      );
      expect(observable(err)).not.toContain(key);
      expect(err).toMatchObject({ kind: 'outage' });
    });

    it('survives a trapping Proxy that errors the body mid-stream', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(trap());
        },
      });
      const err = await failure(
        createOpenRouterProvider({ apiKey: key, fetch: async () => new Response(body) }),
      );
      expect(observable(err)).not.toContain(key);
      expect(err).toMatchObject({ kind: 'outage', retryable: true });
    });

    it('does not hang or throw from the abort listener when a caller aborts with a Proxy', async () => {
      const uncaught: unknown[] = [];
      const listener = (reason: unknown): void => {
        uncaught.push(reason);
      };
      process.on('uncaughtException', listener);
      try {
        const controller = new AbortController();
        const pending = createOpenRouterProvider({
          apiKey: key,
          maxCallMs: 500,
          fetch: () => new Promise<Response>(() => undefined),
        })
          .generateText({ ...req, signal: controller.signal })
          .catch((error: unknown) => error as Error);
        setTimeout(() => {
          controller.abort(trap());
        }, 10);
        const started = Date.now();
        const err = await pending;
        expect(Date.now() - started).toBeLessThan(400);
        expect(observable(err)).not.toContain(key);
        expect(uncaught).toEqual([]);
      } finally {
        process.off('uncaughtException', listener);
      }
    });
  });

  it.each(['onChunk', 'onProgress'] as const)(
    'a never-settling %s still ends at the call ceiling',
    async (name) => {
      const err = await createOpenRouterProvider({
        apiKey: key,
        maxCallMs: 60,
        idleTimeoutMs: 10_000,
        timeoutMs: 10_000,
        fetch: async () => sse({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }),
      })
        .generateText({ ...req, [name]: () => new Promise<void>(() => undefined) })
        .catch((error: unknown) => error as Error);
      expect(err).toMatchObject({ kind: 'timeout', retryable: true });
    },
  );

  it('redacts an encoded key even when another part of the text is malformed', async () => {
    const mixed = [...key].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');
    const spaced = ` ${key} `;
    for (const [useKey, echoed] of [
      [key, `https://x.invalid/?t=${mixed.toUpperCase()}&bad=%zz`],
      [spaced, `https://x.invalid/?t=${key}`],
    ] as const) {
      const err = await failure(
        createOpenRouterProvider({
          apiKey: useKey,
          fetch: async () => {
            throw new TypeError(echoed);
          },
        }),
      );
      expect(observable(err)).not.toContain(key);
    }
  });

  it('redacts a key spelled half literal and half percent-encoded next to a malformed escape', async () => {
    const hexOf = (c: string): string => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
    const spellings = [
      `sk-${hexOf('h')}ostile-key123%zz`,
      [...key].map((c) => hexOf(c).replace(/[a-f]/g, (h) => h.toUpperCase())).join('') + '%zz',
      [...key].map((c) => hexOf(c)).join('') + '%zz',
    ];
    for (const echoed of spellings) {
      const err = await failure(
        createOpenRouterProvider({
          apiKey: key,
          fetch: async () => {
            throw new Error(echoed);
          },
        }),
      );
      expect(observable(err)).not.toContain(key);
      expect(observable(err)).not.toContain(echoed);
    }
  });

  it('keeps a validated netCode when cloning a callback ProviderError', async () => {
    const fetch = async (): Promise<Response> =>
      sse({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] });
    const err = await createOpenRouterProvider({ apiKey: key, fetch })
      .generateText({
        ...req,
        onChunk: () => {
          throw new ProviderError('outage', 'reset', true, { netCode: 'ECONNRESET' });
        },
      })
      .catch((error: unknown) => error as Error);
    expect(err).toMatchObject({ kind: 'outage', netCode: 'ECONNRESET' });
  });

  it('survives an object that inherits a trapping Proxy prototype and a descriptor-trapping Proxy', async () => {
    const protoTrap = new Proxy(
      {},
      {
        get() {
          throw new Error(key);
        },
        getOwnPropertyDescriptor() {
          throw new Error(key);
        },
        has() {
          throw new Error(key);
        },
      },
    );
    const inherited = Object.create(protoTrap) as Error;
    const descriptorTrap = new Proxy(new Error('x'), {
      getOwnPropertyDescriptor() {
        throw new Error(key);
      },
    });
    for (const hostile of [inherited, descriptorTrap]) {
      const err = await failure(
        createOpenRouterProvider({
          apiKey: key,
          fetch: async () => {
            throw hostile;
          },
        }),
      );
      expect(observable(err)).not.toContain(key);
      const controller = new AbortController();
      controller.abort(hostile);
      const pre = await createOpenRouterProvider({
        apiKey: key,
        fetch: async () => sse({ choices: [{ delta: { content: 'a' } }] }),
      })
        .generateText({ ...req, signal: controller.signal })
        .catch((error: unknown) => error as Error);
      expect(observable(pre)).not.toContain(key);
    }
  });

  it('never reads data from a Proxy, even when its descriptor trap answers politely', async () => {
    const polite = new Proxy(new Error('x'), {
      getOwnPropertyDescriptor(_target, name) {
        return name === 'code'
          ? { value: 'ECONNRESET', configurable: true, enumerable: true, writable: true }
          : undefined;
      },
    });
    const err = await failure(
      createOpenRouterProvider({
        apiKey: key,
        fetch: async () => {
          throw polite;
        },
      }),
    );
    expect(err).toMatchObject({ kind: 'outage' });
    expect((err as ProviderError).netCode).toBeUndefined();
  });
});
