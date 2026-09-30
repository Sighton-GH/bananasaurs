import { describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  TASK_EVALUATION_INSTRUCTION,
  type GenerateTextRequest,
  type TextProvider,
} from '@bananasaurs/core';
import type { ChainEntry } from '../assistant/model-chain.js';
import { createTaskUpdateEvaluator } from './task-evaluate.js';

const textProvider = (text: string | Error): TextProvider => ({
  id: 'fixture',
  capabilities: new Set(['text']),
  generateText: async () => {
    if (text instanceof Error) throw text;
    return { text, model: 'fixture-model' };
  },
});

const entry = (over: Partial<ChainEntry> & { name: string }): ChainEntry => ({
  providerId: 'gemini',
  model: `model-${over.name}`,
  keyId: `key-${over.name}`,
  keyLabel: `Key ${over.name}`,
  provider: textProvider('{"clear": true}'),
  skip: undefined,
  mayTrain: false,
  rpmLimit: null,
  rpdLimit: null,
  ...over,
});

const evaluator = (
  entries: readonly ChainEntry[],
  reserve: (entry: ChainEntry) => boolean = () => true,
) =>
  createTaskUpdateEvaluator({
    chain: () => entries,
    reserve: (candidate) => ({ ok: reserve(candidate) }),
    now: () => 1,
  });

const req = {
  guildId: '111111111111111111',
  title: 'Build',
  description: 'Wire the arm',
  update: 'finished the wiring',
};

describe('createTaskUpdateEvaluator', () => {
  it('returns no-model when the chain is empty', async () => {
    await expect(evaluator([])(req)).resolves.toEqual({ ok: false, reason: 'no-model' });
  });

  it('returns a clear verdict without posting anything', async () => {
    const generateText = vi.fn(async (_request: GenerateTextRequest) => ({
      text: '{"clear": true}',
      model: 'm',
    }));
    const provider: TextProvider = { id: 'f', capabilities: new Set(['text']), generateText };
    await expect(evaluator([entry({ name: 'a', provider })])(req)).resolves.toEqual({
      ok: true,
      clear: true,
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    const call = generateText.mock.calls[0]?.[0];
    expect(call?.systemInstruction).toBe(TASK_EVALUATION_INSTRUCTION);
    expect(call?.maxOutputTokens).toBe(300);
    expect(call?.temperature).toBe(0);
  });

  it('returns the unclear question', async () => {
    const provider = textProvider('{"clear": false, "question": "What did you finish?"}');
    await expect(evaluator([entry({ name: 'a', provider })])(req)).resolves.toEqual({
      ok: true,
      clear: false,
      question: 'What did you finish?',
    });
  });

  it('tries the next entry when the first throws a ProviderError', async () => {
    const first = textProvider(new ProviderError('outage', 'down', true));
    const second = textProvider('{"clear": true}');
    await expect(
      evaluator([entry({ name: 'a', provider: first }), entry({ name: 'b', provider: second })])(
        req,
      ),
    ).resolves.toEqual({ ok: true, clear: true });
  });

  it('ignores skipped entries', async () => {
    const skipped = entry({ name: 'a', provider: undefined, skip: 'disabled' });
    const generateText = vi.fn(async () => ({ text: '{"clear": true}', model: 'm' }));
    const provider: TextProvider = { id: 'f', capabilities: new Set(['text']), generateText };
    await expect(evaluator([skipped, entry({ name: 'b', provider })])(req)).resolves.toEqual({
      ok: true,
      clear: true,
    });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('ignores entries whose reservation is refused', async () => {
    const generateText = vi.fn(async () => ({ text: '{"clear": true}', model: 'm' }));
    const provider: TextProvider = { id: 'f', capabilities: new Set(['text']), generateText };
    const refused = entry({ name: 'a', provider });
    const used = entry({ name: 'b', provider });
    await expect(
      evaluator([refused, used], (candidate) => candidate !== refused)(req),
    ).resolves.toEqual({ ok: true, clear: true });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('reports invalid-json when the reply does not parse', async () => {
    const provider = textProvider('Looks clear to me!');
    await expect(evaluator([entry({ name: 'a', provider })])(req)).resolves.toEqual({
      ok: false,
      reason: 'invalid-json',
    });
  });

  it('reports guard when the question leaks the protected instruction', async () => {
    const leaked = TASK_EVALUATION_INSTRUCTION.slice(0, 100);
    const provider = textProvider(JSON.stringify({ clear: false, question: leaked }));
    await expect(evaluator([entry({ name: 'a', provider })])(req)).resolves.toEqual({
      ok: false,
      reason: 'guard',
    });
  });
});
