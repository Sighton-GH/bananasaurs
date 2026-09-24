import { describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  type GenerateTextRequest,
  type GenerateTextResponse,
  type TextProvider,
} from '@bananasaurs/core';
import { generateAnswer } from './generate.js';
import type { AssistantToolResult } from './tools.js';

const provider = (
  ...responses: (GenerateTextResponse | Error)[]
): TextProvider & { calls: GenerateTextRequest[] } => {
  const calls: GenerateTextRequest[] = [];
  return {
    id: 'fake',
    capabilities: new Set(['text', 'tools']),
    calls,
    generateText: vi.fn(async (request: GenerateTextRequest) => {
      calls.push(request);
      const next = responses.shift();
      if (next === undefined) throw new Error('no scripted response');
      if (next instanceof Error) throw next;
      return next;
    }),
  };
};

const declarations = [
  { name: 'current_time', description: 'd', parameters: { type: 'object', properties: {} } },
];

describe('generateAnswer (ADR 0067)', () => {
  it('answers in one call when the model needs no tools', async () => {
    const p = provider({ text: 'Hello.', model: 'm-1' });
    const result = await generateAnswer({
      provider: p,
      model: 'm',
      systemInstruction: 'sys',
      userText: 'hi',
      tools: { declarations, run: vi.fn() },
    });
    expect(result).toEqual({
      text: 'Hello.',
      trace: { model: 'm-1', tools: [], sources: [], web: false, usedFallback: false },
    });
    expect(p.calls[0]?.tools).toEqual(declarations);
  });

  it('runs one tool round, then answers with tools switched off', async () => {
    const modelParts = [
      { functionCall: { name: 'current_time', args: {} }, thoughtSignature: 's' },
    ];
    const p = provider(
      {
        text: '',
        model: 'm',
        toolCalls: [{ name: 'current_time', args: {} }],
        providerParts: modelParts,
      },
      { text: 'It is noon.', model: 'm' },
    );
    const run = vi.fn(async (): Promise<AssistantToolResult> => ({
      name: 'current_time',
      ok: true,
      text: '12:00',
      sources: [],
    }));
    const result = await generateAnswer({
      provider: p,
      model: 'm',
      systemInstruction: 'sys',
      userText: 'what time is it?',
      tools: { declarations, run },
    });
    expect(result.text).toBe('It is noon.');
    expect(result.trace.tools).toEqual([{ name: 'current_time', ok: true }]);
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]?.tools).toBeUndefined();
    expect(p.calls[1]?.messages).toEqual([
      { role: 'user', text: 'what time is it?' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ name: 'current_time', args: {} }],
        providerParts: modelParts,
      },
      {
        role: 'tool',
        toolName: 'current_time',
        text: '[UNTRUSTED TOOL RESULT tool=current_time]\n12:00\n[/UNTRUSTED TOOL RESULT]',
      },
    ]);
  });

  it('caps the calls in the round and refuses the rest without running them', async () => {
    const calls = Array.from({ length: 8 }, () => ({ name: 'current_time', args: {} }));
    const p = provider({ text: '', model: 'm', toolCalls: calls }, { text: 'done', model: 'm' });
    const run = vi.fn(async (): Promise<AssistantToolResult> => ({
      name: 'current_time',
      ok: true,
      text: 't',
      sources: [],
    }));
    const result = await generateAnswer({
      provider: p,
      model: 'm',
      systemInstruction: 's',
      userText: 'q',
      tools: { declarations, run },
    });
    expect(run).toHaveBeenCalledTimes(6);
    expect(result.trace.tools.filter((t) => !t.ok)).toHaveLength(2);
    expect(p.calls[1]?.messages.filter((m) => m.role === 'tool')).toHaveLength(8);
  });

  it('collects sources, and appends the Brave attribution when web results were used', async () => {
    const p = provider(
      { text: '', model: 'm', toolCalls: [{ name: 'web_search', args: { query: 'lipo' } }] },
      { text: 'Store them half charged.', model: 'm' },
    );
    const result = await generateAnswer({
      provider: p,
      model: 'm',
      systemInstruction: 's',
      userText: 'q',
      tools: {
        declarations,
        run: async () => ({
          name: 'web_search',
          ok: true,
          text: 'r',
          sources: [{ title: 'Guide', url: 'https://a.example/' }],
          web: true,
        }),
      },
    });
    expect(result.text).toBe('Store them half charged.\n\n-# Powered by Brave Search');
    expect(result.trace).toMatchObject({
      web: true,
      sources: [{ title: 'Guide', url: 'https://a.example/' }],
    });
  });

  it('tries the next model in order when one is overloaded (ADR 0068)', async () => {
    const p = provider(
      new ProviderError('outage', 'HTTP 503', true),
      new ProviderError('rate-limit', 'HTTP 429', true),
      { text: 'From the third.', model: 'third' },
    );
    const result = await generateAnswer({
      provider: p,
      model: 'first',
      fallbackModels: ['second', 'third'],
      systemInstruction: 's',
      userText: 'q',
    });
    expect(result.text).toBe('From the third.');
    expect(result.trace).toMatchObject({ model: 'third', usedFallback: true });
    expect(p.calls.map((c) => c.model)).toEqual(['first', 'second', 'third']);
  });

  it('stays on the model that worked for the answer after a tool round', async () => {
    const p = provider(
      new ProviderError('outage', 'HTTP 503', true),
      { text: '', model: 'second', toolCalls: [{ name: 'current_time', args: {} }] },
      { text: 'Noon.', model: 'second' },
    );
    await generateAnswer({
      provider: p,
      model: 'first',
      fallbackModels: ['second'],
      systemInstruction: 's',
      userText: 'q',
      tools: {
        declarations,
        run: async () => ({ name: 'current_time', ok: true, text: '12:00', sources: [] }),
      },
    });
    expect(p.calls.map((c) => c.model)).toEqual(['first', 'second', 'second']);
  });

  it('rethrows the last error when every model is busy', async () => {
    const p = provider(
      new ProviderError('outage', 'HTTP 503', true),
      new ProviderError('outage', 'HTTP 503 again', true),
    );
    await expect(
      generateAnswer({
        provider: p,
        model: 'first',
        fallbackModels: ['second'],
        systemInstruction: 's',
        userText: 'q',
      }),
    ).rejects.toMatchObject({ message: 'HTTP 503 again', retryable: true });
  });

  it('does not use a backup for a non-retryable error, and rethrows', async () => {
    const p = provider(new ProviderError('invalid-request', 'HTTP 400', false));
    await expect(
      generateAnswer({
        provider: p,
        model: 'main',
        fallbackModels: ['lite'],
        systemInstruction: 's',
        userText: 'q',
      }),
    ).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(p.calls).toHaveLength(1);
  });

  it('offers no tools to a provider without the tools capability', async () => {
    const p = {
      ...provider({ text: 'plain', model: 'm' }),
      capabilities: new Set(['text'] as const),
    };
    await generateAnswer({
      provider: p,
      model: 'm',
      systemInstruction: 's',
      userText: 'q',
      tools: { declarations, run: vi.fn() },
    });
    expect(p.calls[0]?.tools).toBeUndefined();
  });
});
