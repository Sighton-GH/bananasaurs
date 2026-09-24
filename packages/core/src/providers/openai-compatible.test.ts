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
  it('refuses tool turns and tool offers rather than sending them malformed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
    await expect(
      provider.generateText({
        model: 'free-model',
        messages: [{ role: 'user', text: 'q' }],
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      }),
    ).rejects.toMatchObject({ kind: 'capability-mismatch' });
    await expect(
      provider.generateText({
        model: 'free-model',
        messages: [
          { role: 'user', text: 'q' },
          { role: 'tool', text: 'result', toolName: 't' },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'capability-mismatch' });
    expect(fetch).not.toHaveBeenCalled();
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
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).messages).toEqual([
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
