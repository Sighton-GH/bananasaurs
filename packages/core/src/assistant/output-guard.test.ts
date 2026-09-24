import { describe, expect, it } from 'vitest';
import { guardAnswer } from './output-guard.js';

const P =
  'You are the Racerbot helper. Always cite the build guide before answering hardware questions about the chassis.';

describe('guardAnswer', () => {
  it('keeps a normal answer', () => {
    expect(guardAnswer({ text: 'The meeting is Tuesday.', protectedText: P, modelIds: [] })).toEqual({
      ok: true,
      text: 'The meeting is Tuesday.',
      removed: [],
    });
  });
  it('strips a tool_code block and keeps the prose', () => {
    const r = guardAnswer({
      text: 'Let me check.\n```tool_code\nprint(default_api.search_archive(query="x"))\n```\nThe meeting is Tuesday.',
      protectedText: P,
      modelIds: [],
    });
    expect(r).toEqual({
      ok: true,
      text: 'Let me check.\n\nThe meeting is Tuesday.',
      removed: ['tool-call-text'],
    });
  });
  it('fails when only a tool call remains', () => {
    expect(
      guardAnswer({
        text: 'print(default_api.search_sources(query="rules"))',
        protectedText: P,
        modelIds: [],
      }),
    ).toEqual({ ok: false, reason: 'empty-after-strip', removed: ['tool-call-text'] });
    expect(
      guardAnswer({
        text: '{"name":"search_sources","args":{"query":"x"}}',
        protectedText: P,
        modelIds: [],
      }).ok,
    ).toBe(false);
    expect(
      guardAnswer({ text: '<tool_call>{"name":"x"}</tool_call>', protectedText: P, modelIds: [] })
        .ok,
    ).toBe(false);
  });
  it('keeps JSON the member asked for when it is not tool-shaped', () => {
    expect(
      guardAnswer({ text: '```json\n{"wheels": 4}\n```', protectedText: P, modelIds: [] }).ok,
    ).toBe(true);
  });
  it('replaces configured model ids', () => {
    const r = guardAnswer({
      text: 'I am gemini-2.5-flash.',
      protectedText: P,
      modelIds: ['gemini-2.5-flash'],
    });
    expect(r).toEqual({
      ok: true,
      text: "I am the club's AI service.",
      removed: ['model-id'],
    });
  });
  it('blocks a verbatim prompt leak of 100+ characters, allows short overlap', () => {
    expect(guardAnswer({ text: `Sure: ${P}`, protectedText: P, modelIds: [] })).toEqual({
      ok: false,
      reason: 'prompt-leak',
      removed: [],
    });
    expect(
      guardAnswer({ text: 'Always cite the build guide.', protectedText: P, modelIds: [] }).ok,
    ).toBe(true);
  });
  it('leak check ignores whitespace and case differences', () => {
    expect(
      guardAnswer({ text: P.toUpperCase().replaceAll(' ', '\n'), protectedText: P, modelIds: [] })
        .ok,
    ).toBe(false);
  });
});
