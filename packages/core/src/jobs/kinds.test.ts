import { describe, expect, it } from 'vitest';
import {
  CONTINUE_RULES,
  JOIN_RULES,
  NEW_RULES,
  type ContinueRule,
  type NewRule,
} from '../assistant/conversation.js';
import {
  assistantInvokeCursor,
  pruneJobsDedupeKey,
  pruneJobsPayload,
  sweepDedupeKey,
} from './kinds.js';

const base = {
  stage: 'invoke-done',
  result: { ok: true, content: 'answer' },
} as const;

const continueCursor = (rule: ContinueRule) => ({
  ...base,
  resolution: { kind: 'continue', conversationId: 'conv-1', rule },
});

const newCursor = (rule: NewRule) => ({
  ...base,
  resolution: { kind: 'new', rule },
});

describe('assistantInvokeCursor resolution', () => {
  it('carries answeredBy through the cursor detail', () => {
    const parsed = assistantInvokeCursor.safeParse({
      ...base,
      result: {
        ok: true,
        content: 'answer',
        detail: {
          sections: [],
          history: [],
          attempts: [],
          toolCalls: [],
          usage: {},
          guard: { removed: [] },
          answeredBy: { providerId: 'gemini', model: 'm', keyId: 'k' },
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const detail = parsed.data.result;
      expect(detail.ok && detail.detail?.answeredBy).toEqual({
        providerId: 'gemini',
        model: 'm',
        keyId: 'k',
      });
    }
  });

  it('carries recalled conversation ids through the cursor detail', () => {
    const parsed = assistantInvokeCursor.safeParse({
      ...base,
      result: {
        ok: true,
        content: 'answer',
        detail: {
          sections: [],
          history: [],
          attempts: [],
          toolCalls: [],
          usage: {},
          guard: { removed: [] },
          recalled: ['conv-2', 'conv-3'],
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const detail = parsed.data.result;
      expect(detail.ok && detail.detail?.recalled).toEqual(['conv-2', 'conv-3']);
    }
  });

  it('parses a cursor for every continue rule', () => {
    for (const rule of CONTINUE_RULES) {
      const parsed = assistantInvokeCursor.safeParse(continueCursor(rule));
      expect(parsed.success, rule).toBe(true);
    }
  });

  it('parses a cursor for every new rule', () => {
    for (const rule of NEW_RULES) {
      const parsed = assistantInvokeCursor.safeParse(newCursor(rule));
      expect(parsed.success, rule).toBe(true);
    }
  });

  it('parses thread and channel-follow-up resolutions with their conversation', () => {
    for (const rule of ['thread', 'channel-follow-up'] as const) {
      const parsed = assistantInvokeCursor.safeParse(continueCursor(rule));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.resolution).toEqual({
          kind: 'continue',
          conversationId: 'conv-1',
          rule,
        });
      }
    }
  });

  it('stays in lockstep with the conversation module: every join rule parses', () => {
    for (const rule of JOIN_RULES) {
      const cursor = (CONTINUE_RULES as readonly string[]).includes(rule)
        ? continueCursor(rule as ContinueRule)
        : newCursor(rule as NewRule);
      expect(assistantInvokeCursor.safeParse(cursor).success, rule).toBe(true);
    }
  });

  it('still rejects an unknown rule', () => {
    const parsed = assistantInvokeCursor.safeParse({
      ...base,
      resolution: { kind: 'continue', conversationId: 'conv-1', rule: 'not-a-rule' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an ok:false cursor with every documented outcome', () => {
    for (const outcome of ['failed', 'refused', 'not-configured', 'quota', 'local-limit'] as const) {
      const parsed = assistantInvokeCursor.safeParse({
        stage: 'invoke-done',
        result: { ok: false, content: 'text', outcome },
      });
      expect(parsed.success, outcome).toBe(true);
    }
  });

  it('still parses an old ok:false cursor without an outcome', () => {
    const parsed = assistantInvokeCursor.safeParse({
      stage: 'invoke-done',
      result: { ok: false, content: 'text' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('housekeeping dedupe keys and payload (ADR 0127)', () => {
  it('keys the prune job by UTC day', () => {
    expect(pruneJobsDedupeKey('2026-10-04')).toBe('prune_jobs:2026-10-04');
  });

  it('keys the sweep job by UTC day', () => {
    expect(sweepDedupeKey('2026-10-04')).toBe('sweep_event_dedupe:2026-10-04');
  });

  it('pruneJobsPayload rejects a negative olderThanMs', () => {
    expect(pruneJobsPayload.safeParse({ olderThanMs: -1 }).success).toBe(false);
    expect(pruneJobsPayload.safeParse({ olderThanMs: 0 }).success).toBe(true);
  });
});
