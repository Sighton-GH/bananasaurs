import { describe, expect, it, vi } from 'vitest';
import type { GenerateTextRequest, GenerateTextResponse, TextProvider } from './contracts.js';
import { SafeProvider } from './safe-provider.js';

const setup = (): {
  provider: TextProvider;
  generateText: ReturnType<
    typeof vi.fn<(request: GenerateTextRequest) => Promise<GenerateTextResponse>>
  >;
} => {
  const generateText = vi
    .fn<(request: GenerateTextRequest) => Promise<GenerateTextResponse>>()
    .mockResolvedValue({ text: 'ok', model: 'test' });
  return { provider: { id: 'test', capabilities: new Set(['text']), generateText }, generateText };
};

describe('SafeProvider', () => {
  it('refuses sensitive content before calling the API', async () => {
    const { provider, generateText } = setup();
    const safe = new SafeProvider(provider, 'free', { monthlyCapUsdMicros: 0 });
    await expect(
      safe.generateText({
        model: 'test',
        messages: [{ role: 'user', text: 'email me at a@b.com' }],
      }),
    ).rejects.toMatchObject({ kind: 'safety-refusal' });
    expect(generateText).not.toHaveBeenCalled();
  });
  it('refuses a non-free profile before calling the API at the zero cap', async () => {
    const { provider, generateText } = setup();
    const safe = new SafeProvider(provider, 'unknown', { monthlyCapUsdMicros: 0 });
    await expect(
      safe.generateText({ model: 'test', messages: [{ role: 'user', text: 'hello' }] }),
    ).rejects.toMatchObject({ kind: 'quota' });
    expect(generateText).not.toHaveBeenCalled();
  });
  it('calls the provider only after both local gates pass', async () => {
    const { provider, generateText } = setup();
    const safe = new SafeProvider(provider, 'free', { monthlyCapUsdMicros: 0 });
    await expect(
      safe.generateText({ model: 'test', messages: [{ role: 'user', text: 'hello' }] }),
    ).resolves.toMatchObject({ text: 'ok' });
    expect(generateText).toHaveBeenCalledOnce();
  });
});
