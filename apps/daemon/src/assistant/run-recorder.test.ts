import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { guildRepo, runRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createRunRecorder, NOOP_RUN_RECORDER } from './run-recorder.js';

const GUILD = parseGuildId('111111111111111111');
const USER = '100000000000000001';
const NOW = 1_700_000_000_000;

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
});
afterEach(() => {
  t.close();
});

const recorderFor = (runId: string, warn = vi.fn()) =>
  createRunRecorder({
     scope: t.scopes.forGuild(GUILD),
     guildId: GUILD,
     runId,

    now: () => NOW,
    logger: { warn },
  });

/** ADR 0129 §6: one run's step log, bound to its guild and run id. Never throws. */
describe('createRunRecorder', () => {
  it('event(started) moves a queued run to running/starting', () => {
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-1',
      userId: USER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW,
    });
    recorderFor('run-1').event({ kind: 'started', attempt: 1, queueWaitMs: 12 });
    expect(runRepo.getRun(scope, 'run-1')).toMatchObject({
      state: 'running',
      stage: 'starting',
      attempt: 1,
    });
    expect(runRepo.listRunEvents(scope, 'run-1', 0, 10).map((r) => r.event.kind)).toEqual([
      'started',
    ]);
  });

  it('event(model-call) moves the stage to calling-model with the model', () => {
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-1',
      userId: USER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW,
    });
    recorderFor('run-1').event({ kind: 'started', attempt: 1, queueWaitMs: 0 });
    recorderFor('run-1').event({
      kind: 'model-call',
      position: 0,
      of: 2,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      keyId: 'key_a',
      round: 1,
    });
    expect(runRepo.getRun(scope, 'run-1')).toMatchObject({
      stage: 'calling-model',
      model: 'gemini-2.5-flash',
    });
  });

  it('event(finished failed) ends the run failed/done with the code and trace id', () => {
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-1',
      userId: USER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW,
    });
    recorderFor('run-1').event({ kind: 'started', attempt: 1, queueWaitMs: 0 });
    recorderFor('run-1').event({
      kind: 'finished',
      outcome: 'failed',
      durationMs: 900,
      code: 'provider-bad-model',
      traceId: 't',
    });
    expect(runRepo.getRun(scope, 'run-1')).toMatchObject({
      state: 'failed',
      stage: 'done',
      errorCode: 'provider-bad-model',
      traceId: 't',
    });
  });

  it('update() writes a direct run-row patch', () => {
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-1',
      userId: USER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW,
    });
    recorderFor('run-1').update({ conversationId: 'conv-1' });
    expect(runRepo.getRun(scope, 'run-1')).toMatchObject({ conversationId: 'conv-1' });
  });

  it('a recorder on a never-ensured run never throws and warns exactly once', () => {
    const warn = vi.fn();
    const recorder = recorderFor('missing-run', warn);
    expect(() => {
      recorder.event({ kind: 'started', attempt: 1, queueWaitMs: 0 });
      recorder.event({ kind: 'delivering', parts: 1 });
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe('assistant run ledger write failed');
  });

  it('an event with an extra field never throws out of event(); it logs', () => {
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-1',
      userId: USER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW,
    });
    const warn = vi.fn();
    const recorder = recorderFor('run-1', warn);
    expect(() =>
      recorder.event({
        kind: 'queued',
        via: 'mention',
        question: 'hi',
      } as unknown as { kind: 'queued'; via: 'mention' }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(runRepo.listRunEvents(scope, 'run-1', 0, 10)).toEqual([]);
  });

  it('NOOP_RUN_RECORDER does nothing', () => {
    expect(NOOP_RUN_RECORDER.runId).toBe('');
    expect(() => {
      NOOP_RUN_RECORDER.event({ kind: 'delivering', parts: 1 });
      NOOP_RUN_RECORDER.update({ conversationId: 'conv-1' });
    }).not.toThrow();
  });
});
