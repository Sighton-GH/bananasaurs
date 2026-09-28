import { describe, expect, it } from 'vitest';
import {
  CONTINUE_RULES,
  JOIN_RULES,
  NEW_RULES,
  type ContinueRule,
  type NewRule,
} from '../assistant/conversation.js';
import { assistantInvokeCursor } from './kinds.js';

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
});
