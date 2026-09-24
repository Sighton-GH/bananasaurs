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
});
