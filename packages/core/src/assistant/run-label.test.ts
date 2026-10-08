import { describe, expect, it } from 'vitest';
import { describeRun, RUN_STALLED_MS } from './run-label.js';
import type { RunEvent, RunRow } from './run-events.js';

const NOW = 1_700_000_000_000;

const baseRun = (over: Partial<RunRow> = {}): RunRow => ({
  runId: 'run-1',
  userId: '100000000000000001',
  behaviourId: 'club',
  source: 'mention',
  state: 'running',
  stage: 'starting',
  attempt: 1,
  queuedAt: NOW - 60_000,
  updatedAt: NOW,
  ...over,
});

describe('describeRun', () => {
  it('labels a queued run with nothing ahead as Queued', () => {
    const run = baseRun({ state: 'queued', stage: 'queued' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 })).toEqual({
      label: 'Queued',
      stalled: false,
    });
  });

  it('labels a queued run with one ahead as Queued (1 ahead)', () => {
    const run = baseRun({ state: 'queued', stage: 'queued' });
    expect(describeRun(run, { now: NOW, queueAhead: 1 })).toEqual({
      label: 'Queued (1 ahead)',
      stalled: false,
    });
  });

  it('labels stage starting as Starting', () => {
    const run = baseRun({ state: 'running', stage: 'starting' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe('Starting');
  });

  it('labels stage conversation as Reading the conversation', () => {
    const run = baseRun({ state: 'running', stage: 'conversation' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe('Reading the conversation');
  });

  it('labels stage context as Gathering context', () => {
    const run = baseRun({ state: 'running', stage: 'context' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe('Gathering context');
  });

  it('labels calling-model with a model-call event with position and count', () => {
    const run = baseRun({ state: 'running', stage: 'calling-model' });
    const lastEvent: RunEvent = {
      kind: 'model-call',
      position: 0,
      of: 2,
      provider: 'openrouter',
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      keyId: 'key-1',
      round: 0,
    };
    expect(describeRun(run, { now: NOW, queueAhead: 0, lastEvent }).label).toBe(
      'Asking nemotron-3-ultra-550b-a55b:free (model 1 of 2)',
    );
  });

  it('labels calling-model without an event from run.model', () => {
    const run = baseRun({
      state: 'running',
      stage: 'calling-model',
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe(
      'Asking nemotron-3-ultra-550b-a55b:free',
    );
  });

  it('labels calling-model without a model as Asking the model', () => {
    const run = baseRun({ state: 'running', stage: 'calling-model' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe('Asking the model');
  });

  it('labels running-tool with a tool-call event with the tool name', () => {
    const run = baseRun({ state: 'running', stage: 'running-tool' });
    const lastEvent: RunEvent = { kind: 'tool-call', round: 0, tool: 'search_messages' };
    expect(describeRun(run, { now: NOW, queueAhead: 0, lastEvent }).label).toBe(
      'Running tool: search_messages',
    );
  });

  it('labels running-tool without an event as Running a tool', () => {
    const run = baseRun({ state: 'running', stage: 'running-tool' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe('Running a tool');
  });

  it('labels retry-wait with the retry time and error code', () => {
    const retryAt = 1_700_000_100_000;
    const expected = new Date(retryAt).toISOString().slice(11, 19);
    const run = baseRun({
      state: 'retry-wait',
      stage: 'retry-wait',
      retryAt,
      errorCode: 'provider-connect-timeout',
    });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe(
      `Retrying at ${expected} UTC after provider-connect-timeout`,
    );
  });

  it('labels retry-wait without an error code with an error fallback', () => {
    const retryAt = 1_700_000_100_000;
    const expected = new Date(retryAt).toISOString().slice(11, 19);
    const run = baseRun({ state: 'retry-wait', stage: 'retry-wait', retryAt });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe(
      `Retrying at ${expected} UTC after an error`,
    );
  });

  it('labels stage delivering as Posting the answer', () => {
    const run = baseRun({ state: 'running', stage: 'delivering' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe('Posting the answer');
  });

  it('labels answered as Answered', () => {
    const run = baseRun({ state: 'answered', stage: 'done' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 })).toEqual({
      label: 'Answered',
      stalled: false,
    });
  });

  it('labels refused as Refused', () => {
    const run = baseRun({ state: 'refused', stage: 'done' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe('Refused');
  });

  it('labels failed as Failed', () => {
    const run = baseRun({ state: 'failed', stage: 'done' });
    expect(describeRun(run, { now: NOW, queueAhead: 0 }).label).toBe('Failed');
  });

  it('marks a running run with no update for 11 min as stalled', () => {
    expect(RUN_STALLED_MS).toBe(10 * 60 * 1000);
    const run = baseRun({ state: 'running', stage: 'calling-model', updatedAt: NOW - 11 * 60_000 });
    expect(describeRun(run, { now: NOW, queueAhead: 0 })).toEqual({
      label: 'Stalled (no progress for 11 min)',
      stalled: true,
    });
  });

  it('does not mark the same run at 9 min as stalled', () => {
    const run = baseRun({ state: 'running', stage: 'calling-model', updatedAt: NOW - 9 * 60_000 });
    const result = describeRun(run, { now: NOW, queueAhead: 0 });
    expect(result.stalled).toBe(false);
    expect(result.label).not.toContain('Stalled');
  });

  it('does not mark a finished failed run updated an hour ago as stalled', () => {
    const run = baseRun({ state: 'failed', stage: 'done', updatedAt: NOW - 60 * 60_000 });
    expect(describeRun(run, { now: NOW, queueAhead: 0 })).toEqual({
      label: 'Failed',
      stalled: false,
    });
  });
});
