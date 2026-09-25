import { describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  type GenerateTextRequest,
  type GenerateTextResponse,
  type GenerationMessage,
  type TextProvider,
  type ToolCall,
  type ToolDeclaration,
} from '@bananasaurs/core';
import type { ChainEntry } from './model-chain.js';
import { QuotaLedger } from './quota-ledger.js';
import { ID_TOOL_ARGS, runToolLoop, type LoopTools } from './tool-loop.js';
import type { AssistantToolResult } from './tools.js';

const NOW = 1_800_000_000_000;
const ANSWER_INSTRUCTION = 'Answer now using the results above. Do not call tools.';

const decl = (name: string): ToolDeclaration => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
});

/** A provider fed from a queue, recording every request. */
const scripted = (
  responses: (GenerateTextResponse | Error)[],
  capabilities: readonly ('text' | 'tools')[] = ['text', 'tools'],
): { provider: TextProvider; calls: GenerateTextRequest[] } => {
  const calls: GenerateTextRequest[] = [];
  const queue = [...responses];
  const provider: TextProvider = {
    id: 'fake',
    capabilities: new Set(capabilities),
    generateText: async (request: GenerateTextRequest) => {
      calls.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error('no scripted response');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { provider, calls };
};

const entry = (over: Partial<ChainEntry> & { provider: ChainEntry['provider'] }): ChainEntry => ({
  providerId: 'gemini',
  model: 'model-a',
  keyId: 'key_a',
  keyLabel: 'Key A',
  mayTrain: false,
  ...over,
});

const textAnswer = (text: string, model = 'model-a'): GenerateTextResponse => ({ text, model });
const toolAnswer = (
  toolCalls: readonly ToolCall[],
  over: Partial<GenerateTextResponse> = {},
): GenerateTextResponse => ({ text: '', model: 'model-a', toolCalls, ...over });

const loopTools = (
  run: (call: ToolCall) => Promise<AssistantToolResult>,
): LoopTools => ({
  firstRound: [decl('search_sources'), decl('open_resource')],
  idRound: [decl('read_chunk'), decl('outline'), decl('open_resource')],
  run,
});

const okResult = (name: string, text = 'result text'): AssistantToolResult => ({
  name,
  ok: true,
  text,
  sources: [],
});

const baseInput = (
  chain: readonly ChainEntry[],
  over: Partial<Parameters<typeof runToolLoop>[0]> = {},
): Parameters<typeof runToolLoop>[0] => ({
  chain,
  systemInstruction: 'Be helpful.',
  protectedText: 'short behaviour prompt',
  history: [],
  userText: 'When is the meeting?',
  initialHandles: [],
  now: () => NOW,
  ...over,
});

describe('ID_TOOL_ARGS', () => {
  it('names the id argument of every follow-up tool', () => {
    expect(ID_TOOL_ARGS).toEqual({
      read_chunk: 'chunk_id',
      outline: 'doc_id',
      open_resource: 'resource_id',
    });
  });
});

describe('runToolLoop direct answers', () => {
  it('answers directly with no tools: one call, no tool declarations sent when tools undefined', async () => {
    const { provider, calls } = scripted([textAnswer('Hello.')]);
    const result = await runToolLoop(baseInput([entry({ provider })]));
    expect(result.outcome).toBe('answered');
    expect(result.text).toBe('Hello.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toBeUndefined();
    expect(result.attempts).toMatchObject([{ outcome: 'ok' }]);
    expect(result.toolCalls).toEqual([]);
  });

  it('offers no tools to a provider without the tools capability', async () => {
    const { provider, calls } = scripted([textAnswer('plain') ], ['text']);
    const run = vi.fn(async (call: ToolCall) => okResult(call.name));
    const result = await runToolLoop(baseInput([entry({ provider })], { tools: loopTools(run) }));
    expect(result.text).toBe('plain');
    expect(calls[0]?.tools).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('history messages appear before the user message in every request', async () => {
    const history: readonly GenerationMessage[] = [{ role: 'user', text: 'earlier question' }];
    const { provider, calls } = scripted([
      toolAnswer([{ name: 'search_sources', args: { query: 'x' } }]),
      textAnswer('done'),
    ]);
    await runToolLoop(
      baseInput([entry({ provider })], {
        history,
        tools: loopTools(async (call) => okResult(call.name)),
      }),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const request of calls) {
      expect(request.messages[0]).toMatchObject({ role: 'user', text: 'earlier question' });
      expect(request.messages[1]).toMatchObject({ role: 'user', text: 'When is the meeting?' });
    }
  });

  it('sends maxOutputTokens 2,048 on every request', async () => {
    const { provider, calls } = scripted([textAnswer('hi')]);
    await runToolLoop(baseInput([entry({ provider })]));
    expect(calls[0]?.maxOutputTokens).toBe(2_048);
  });
});

describe('runToolLoop follow-up rounds (ADR 0071)', () => {
  it('round 1 calls search_sources, round 2 calls read_chunk with a returned handle', async () => {
    const { provider, calls } = scripted([
      toolAnswer([{ name: 'search_sources', args: { query: 'handbook' } }]),
      toolAnswer([{ name: 'read_chunk', args: { chunk_id: 'chunk-1' } }]),
      textAnswer('Found it.'),
    ]);
    const run = vi.fn(async (call: ToolCall): Promise<AssistantToolResult> => {
      if (call.name === 'search_sources')
        return { ...okResult(call.name, 'see chunk-1'), handles: ['chunk-1'] };
      return okResult(call.name, 'chunk text');
    });
    const result = await runToolLoop(
      baseInput([entry({ provider })], { tools: loopTools(run) }),
    );
    expect(result.outcome).toBe('answered');
    expect(result.text).toBe('Found it.');
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(3);
    // The round-2 request offers only ID tools.
    const round2Tools = (calls[1]?.tools ?? []).map((d) => d.name);
    expect(round2Tools.length).toBeGreaterThan(0);
    expect(round2Tools.every((name) => name in ID_TOOL_ARGS)).toBe(true);
    expect(result.toolCalls).toMatchObject([
      { round: 1, name: 'search_sources', ok: true },
      { round: 2, name: 'read_chunk', ok: true },
    ]);
  });

  it('round 2 calling search_sources is refused as not allowed after reading results', async () => {
    const { provider, calls } = scripted([
      toolAnswer([{ name: 'search_sources', args: { query: 'x' } }]),
      toolAnswer([{ name: 'search_sources', args: { query: 'y' } }]),
      textAnswer('Answered anyway.'),
    ]);
    const run = vi.fn(async (call: ToolCall) => okResult(call.name));
    const result = await runToolLoop(
      baseInput([entry({ provider })], { tools: loopTools(run) }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('answered');
    expect(result.toolCalls).toMatchObject([
      { round: 1, name: 'search_sources', ok: true },
      { round: 2, name: 'search_sources', ok: false, refused: 'not allowed after reading results' },
    ]);
    // The refusal still gets a tool message so the provider sees an answer for every call.
    const toolTexts = (calls[2]?.messages ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => m.text);
    expect(toolTexts).toHaveLength(2);
    expect(toolTexts[1]).toBe('Refused: not allowed after reading results');
  });

  it('round 2 calling read_chunk with an id not in handles is refused as unknown id', async () => {
    const { provider } = scripted([
      toolAnswer([{ name: 'search_sources', args: { query: 'x' } }]),
      toolAnswer([{ name: 'read_chunk', args: { chunk_id: 'nope' } }]),
      textAnswer('Answered anyway.'),
    ]);
    const run = vi.fn(async (call: ToolCall) => okResult(call.name));
    const result = await runToolLoop(
      baseInput([entry({ provider })], { tools: loopTools(run) }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[1]).toMatchObject({
      round: 2,
      name: 'read_chunk',
      ok: false,
      refused: 'unknown id',
    });
  });

  it('8 parallel calls in round 1: 6 run, 2 refused', async () => {
    const calls8 = Array.from({ length: 8 }, () => ({ name: 'search_sources', args: { query: 'x' } }));
    const { provider } = scripted([toolAnswer(calls8), textAnswer('done')]);
    const run = vi.fn(async (call: ToolCall) => okResult(call.name));
    const result = await runToolLoop(
      baseInput([entry({ provider })], { tools: loopTools(run) }),
    );
    expect(run).toHaveBeenCalledTimes(6);
    expect(result.toolCalls.filter((c) => c.ok)).toHaveLength(6);
    expect(result.toolCalls.filter((c) => !c.ok)).toHaveLength(2);
  });

  it('still calling tools after 4 rounds: one final call with no declarations and the instruction', async () => {
    const responses: GenerateTextResponse[] = Array.from({ length: 4 }, () =>
      toolAnswer([{ name: 'open_resource', args: { resourceId: 'handbook' } }]),
    );
    responses.push(textAnswer('Final answer.'));
    const { provider, calls } = scripted(responses);
    const run = vi.fn(async (call: ToolCall): Promise<AssistantToolResult> => ({
      ...okResult(call.name),
      handles: ['handbook'],
    }));
    const result = await runToolLoop(
      baseInput([entry({ provider })], {
        initialHandles: ['handbook'],
        tools: loopTools(run),
      }),
    );
    expect(result.text).toBe('Final answer.');
    expect(calls).toHaveLength(5);
    const final = calls[4]!;
    expect(final.tools).toBeUndefined();
    expect(final.messages.at(-1)).toMatchObject({ role: 'user', text: ANSWER_INSTRUCTION });
  });

  it('collects sources and marks web results without executing text-shaped calls', async () => {
    const { provider } = scripted([
      toolAnswer([{ name: 'search_sources', args: { query: 'lipo' } }]),
      textAnswer('Store them half charged.'),
    ]);
    const result = await runToolLoop(
      baseInput([entry({ provider })], {
        tools: loopTools(async () => ({
          name: 'search_sources',
          ok: true,
          text: 'r',
          sources: [{ title: 'Guide', url: 'https://a.example/' }],
          web: true,
        })),
      }),
    );
    expect(result.web).toBe(true);
    expect(result.sources).toEqual([{ title: 'Guide', url: 'https://a.example/' }]);
    expect(result.text).toBe('Store them half charged.');
  });
});

describe('runToolLoop output guard', () => {
  it('a final text that is only a tool call retries once, then fails with the fixed text', async () => {
    const toolShaped = '{"name":"search_sources","args":{"query":"x"}}';
    const { provider, calls } = scripted([textAnswer(toolShaped), textAnswer(toolShaped)]);
    const result = await runToolLoop(baseInput([entry({ provider })]));
    expect(result.outcome).toBe('failed');
    expect(result.text).toBe("I couldn't finish that answer — please try again.");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.tools).toBeUndefined();
    expect(calls[1]?.messages.at(-1)).toMatchObject({ role: 'user', text: ANSWER_INSTRUCTION });
  });

  it('a prompt leak answers with the fixed refusal', async () => {
    const protectedText =
      'You are the Racerbot helper. Always cite the build guide before answering hardware questions about the chassis.';
    const { provider } = scripted([textAnswer(`Sure: ${protectedText}`)]);
    const result = await runToolLoop(baseInput([entry({ provider })], { protectedText }));
    expect(result.outcome).toBe('answered');
    expect(result.text).toBe("I can't share that.");
    expect(result.guard).toMatchObject({ blocked: 'prompt-leak' });
  });
});

describe('runToolLoop chain walking', () => {
  it('skipped, then busy, then answers: attempts [skipped, rate-limit, ok]', async () => {
    const busy = scripted([new ProviderError('rate-limit', 'HTTP 429', true)]);
    const answering = scripted([textAnswer('From entry 2.', 'model-c')]);
    const result = await runToolLoop(
      baseInput([
        entry({ provider: undefined, skip: 'no-key', model: 'model-a', keyLabel: 'Key A' }),
        entry({ provider: busy.provider, model: 'model-b', keyLabel: 'Key B' }),
        entry({ provider: answering.provider, model: 'model-c', keyLabel: 'Key C' }),
      ]),
    );
    expect(result.outcome).toBe('answered');
    expect(result.text).toBe('From entry 2.');
    expect(result.model).toBe('model-c');
    expect(result.attempts).toMatchObject([
      { model: 'model-a', outcome: 'skipped', reason: 'no-key', keyLabel: 'Key A' },
      { model: 'model-b', outcome: 'rate-limit' },
      { model: 'model-c', outcome: 'ok', keyLabel: 'Key C' },
    ]);
    expect(busy.calls).toHaveLength(1);
  });

  it('a non-retryable error moves on without trying the same entry again', async () => {
    const failing = scripted([new ProviderError('invalid-request', 'HTTP 400', false)]);
    const answering = scripted([textAnswer('From entry 2.')]);
    const result = await runToolLoop(
      baseInput([
        entry({ provider: failing.provider, model: 'model-a' }),
        entry({ provider: answering.provider, model: 'model-b' }),
      ]),
    );
    expect(result.outcome).toBe('answered');
    expect(failing.calls).toHaveLength(1);
    expect(result.attempts).toMatchObject([{ outcome: 'error' }, { outcome: 'ok' }]);
  });

  it('mid-loop failure restarts the next entry from round 1 with no tool messages', async () => {
    const history: readonly GenerationMessage[] = [{ role: 'user', text: 'earlier' }];
    const failing = scripted([
      toolAnswer([{ name: 'search_sources', args: { query: 'x' } }]),
      new ProviderError('outage', 'HTTP 503', true),
    ]);
    const next = scripted([textAnswer('Fresh answer.')]);
    const result = await runToolLoop(
      baseInput(
        [
          entry({ provider: failing.provider, model: 'model-a' }),
          entry({ provider: next.provider, model: 'model-b' }),
        ],
        { history, tools: loopTools(async (call) => okResult(call.name)) },
      ),
    );
    expect(result.outcome).toBe('answered');
    expect(next.calls).toHaveLength(1);
    expect(next.calls[0]?.messages).toEqual([
      { role: 'user', text: 'earlier' },
      { role: 'user', text: 'When is the meeting?' },
    ]);
  });

  it('every entry unusable fails without throwing', async () => {
    const result = await runToolLoop(
      baseInput([
        entry({ provider: undefined, skip: 'no-key', model: 'model-a' }),
        entry({ provider: undefined, skip: 'disabled', model: 'model-b' }),
      ]),
    );
    expect(result.outcome).toBe('failed');
  });

  it('providerParts are echoed within one entry but never passed to a different entry', async () => {
    const parts = [{ functionCall: { name: 'search_sources', args: {} }, thoughtSignature: 's' }];
    const failing = scripted([
      toolAnswer([{ name: 'search_sources', args: { query: 'x' } }], { providerParts: parts }),
      new ProviderError('outage', 'HTTP 503', true),
    ]);
    const next = scripted([textAnswer('ok')]);
    await runToolLoop(
      baseInput(
        [
          entry({ provider: failing.provider, model: 'model-a' }),
          entry({ provider: next.provider, model: 'model-b' }),
        ],
        { tools: loopTools(async (call) => okResult(call.name)) },
      ),
    );
    expect(failing.calls[1]?.messages[1]).toMatchObject({ providerParts: parts });
    for (const request of next.calls) {
      for (const message of request.messages) {
        expect(message).not.toHaveProperty('providerParts');
      }
    }
  });

  it('tool rounds send thinking budget 512, the no-tools final call sends 1,024', async () => {
    const responses: GenerateTextResponse[] = Array.from({ length: 4 }, () =>
      toolAnswer([{ name: 'open_resource', args: { resourceId: 'handbook' } }]),
    );
    responses.push(textAnswer('Final.'));
    const { provider, calls } = scripted(responses);
    await runToolLoop(
      baseInput([entry({ provider })], {
        initialHandles: ['handbook'],
        tools: loopTools(async (call) => ({ ...okResult(call.name), handles: ['handbook'] })),
      }),
    );
    expect(calls).toHaveLength(5);
    for (const request of calls.slice(0, 4)) expect(request.thinkingBudget).toBe(512);
    expect(calls[4]?.thinkingBudget).toBe(1_024);
  });
});

describe('runToolLoop daily quota (Task Q)', () => {
  const dailyCap = (resetAt?: number): ProviderError =>
    new ProviderError('quota', 'free-models-per-day limit reached', false, {
      quotaScope: 'daily-free',
      ...(resetAt === undefined ? {} : { resetAt }),
    });

  it('daily cap on key A :free skips the next key A :free entry but tries key B :free', async () => {
    const capped = scripted([dailyCap(NOW + 3_600_000)]);
    const sameKey = scripted([textAnswer('must not run')]);
    const otherKey = scripted([textAnswer('From key B.')]);
    const result = await runToolLoop(
      baseInput([
        entry({ provider: capped.provider, model: 'm:free', keyId: 'key_a' }),
        entry({ provider: sameKey.provider, model: 'm2:free', keyId: 'key_a' }),
        entry({ provider: otherKey.provider, model: 'm3:free', keyId: 'key_b' }),
      ]),
    );
    expect(result.outcome).toBe('answered');
    expect(result.text).toBe('From key B.');
    expect(sameKey.calls).toHaveLength(0);
    expect(otherKey.calls).toHaveLength(1);
    expect(result.attempts).toMatchObject([
      { outcome: 'error' },
      { outcome: 'skipped', reason: 'daily-allowance-used' },
      { outcome: 'ok' },
    ]);
  });

  it('a paid model on the capped key is still tried', async () => {
    const capped = scripted([dailyCap(NOW + 3_600_000)]);
    const paid = scripted([textAnswer('From paid.')]);
    const result = await runToolLoop(
      baseInput([
        entry({ provider: capped.provider, model: 'm:free', keyId: 'key_a' }),
        entry({ provider: paid.provider, model: 'm-paid', keyId: 'key_a' }),
      ]),
    );
    expect(result.outcome).toBe('answered');
    expect(paid.calls).toHaveLength(1);
  });

  it('a ledger skip on the next request makes no provider call', async () => {
    const ledger = new QuotaLedger();
    const capped = scripted([dailyCap(NOW + 3_600_000)]);
    const first = await runToolLoop(
      baseInput([entry({ provider: capped.provider, model: 'm:free', keyId: 'key_a' })], {
        quotaLedger: ledger,
      }),
    );
    expect(first.outcome).toBe('failed');
    const nextProvider = scripted([textAnswer('must not run')]);
    const second = await runToolLoop(
      baseInput([entry({ provider: nextProvider.provider, model: 'm:free', keyId: 'key_a' })], {
        quotaLedger: ledger,
      }),
    );
    expect(second.outcome).toBe('failed');
    expect(nextProvider.calls).toHaveLength(0);
    expect(second.attempts).toMatchObject([
      { outcome: 'skipped', reason: 'daily-allowance-used' },
    ]);
  });

  it('an expired ledger entry no longer skips', async () => {
    const ledger = new QuotaLedger();
    ledger.markExhausted('key_a', NOW);
    const provider = scripted([textAnswer('Answer.')]);
    const result = await runToolLoop(
      baseInput([entry({ provider: provider.provider, model: 'm:free', keyId: 'key_a' })], {
        quotaLedger: ledger,
      }),
    );
    expect(result.outcome).toBe('answered');
    expect(provider.calls).toHaveLength(1);
  });

  it('all daily caps fail with the earliest known reset', async () => {
    const first = scripted([dailyCap(NOW + 3_600_000)]);
    const second = scripted([dailyCap(NOW + 1_800_000)]);
    const result = await runToolLoop(
      baseInput([
        entry({ provider: first.provider, model: 'm:free', keyId: 'key_a' }),
        entry({ provider: second.provider, model: 'm2:free', keyId: 'key_b' }),
      ]),
    );
    expect(result.outcome).toBe('failed');
    expect(result.dailyQuota).toEqual({ resetAt: NOW + 1_800_000 });
  });

  it('an all-daily-cap failure without a known reset still carries the daily cap', async () => {
    const first = scripted([dailyCap()]);
    const result = await runToolLoop(
      baseInput([entry({ provider: first.provider, model: 'm:free', keyId: 'key_a' })]),
    );
    expect(result.outcome).toBe('failed');
    expect(result.dailyQuota).toEqual({ resetAt: undefined });
  });
});
