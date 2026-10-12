import { describe, expect, it, vi } from 'vitest';
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

    it('redacts a nested Bearer cause and preserves name and code', async () => {
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
      const nested = cause.cause as Error & { code?: string };
      expect(nested.message).not.toContain(key);
      expect(nested.message).toContain('Bearer (redacted)');
      expect(nested.name).toBe('Error');
      expect(nested.code).toBe('EAUTH');
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
      let seenSignal: AbortSignal | null = null;
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
