import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { guildRepo, runRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createRunRecorder, createLiveRunRecorder, NOOP_RUN_RECORDER } from './run-recorder.js';

const GUILD = parseGuildId('111111111111111111');
const USER = '100000000000000001';
const NOW = 1_700_000_000_000;

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
});
afterEach(() => {
  vi.restoreAllMocks();
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

  it('model-progress bumps updatedAt without changing stage or storing text', () => {
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-progress',
      userId: USER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW - 100,
    });
    runRepo.updateRun(scope, 'run-progress', {
      state: 'running',
      stage: 'calling-model',
      model: 'fixture-model',
      updatedAt: NOW - 50,
    });
    const progress = {
      kind: 'model-progress' as const,
      round: 1,
      answerChars: 5,
      reasoningChars: 3,
      keepalives: 2,
      msSinceLastByte: 10,
    };
    recorderFor('run-progress').event(progress);
    expect(runRepo.getRun(scope, 'run-progress')).toMatchObject({
      updatedAt: NOW,
      state: 'running',
      stage: 'calling-model',
      model: 'fixture-model',
    });
    expect(runRepo.listRunEvents(scope, 'run-progress', 0, 10).map((row) => row.event)).toEqual([
      progress,
    ]);
  });

  it.each(['answered', 'refused', 'failed'] as const)(
    'drops live text on finished %s only',
    (outcome) => {
      const scope = t.scopes.forGuild(GUILD);
      runRepo.ensureRun(scope, {
        runId: 'run-finish',
        userId: USER,
        behaviourId: 'club',
        source: 'mention',
        queuedAt: NOW,
      });
      const drop = vi.fn();
      const recorder = createRunRecorder({
        scope,
        runId: 'run-finish',
        now: () => NOW,
        logger: { warn: vi.fn() },
        live: { drop },
      });
      recorder.event({ kind: 'started', attempt: 1, queueWaitMs: 0 });
      expect(drop).not.toHaveBeenCalled();
      recorder.event({ kind: 'finished', outcome, durationMs: 100 });
      expect(drop).toHaveBeenCalledExactlyOnceWith('run-finish');
      expect(runRepo.getRun(scope, 'run-finish')).toMatchObject({ state: outcome, stage: 'done' });
    },
  );

  it.each(['append', 'patch'] as const)(
    'drops live text when the %s ledger write fails',
    (failure) => {
      const scope = t.scopes.forGuild(GUILD);
      runRepo.ensureRun(scope, {
        runId: 'run-write-failure',
        userId: USER,
        behaviourId: 'club',
        source: 'mention',
        queuedAt: NOW,
      });
      vi.spyOn(runRepo, failure === 'append' ? 'appendRunEvent' : 'updateRun').mockImplementation(
        () => {
          throw new Error('fixture write failure');
        },
      );
      const drop = vi.fn();
      const warn = vi.fn();
      const recorder = createRunRecorder({
        scope,
        runId: 'run-write-failure',
        now: () => NOW,
        logger: { warn },
        live: { drop },
      });
      expect(() =>
        recorder.event({ kind: 'finished', outcome: 'failed', durationMs: 100 }),
      ).not.toThrow();
      expect(drop).toHaveBeenCalledExactlyOnceWith('run-write-failure');
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('a live drop failure never escapes the recorder', () => {
    const drop = vi.fn(() => {
      throw new Error('fixture cleanup failure');
    });
    const warn = vi.fn();
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-drop-failure',
      userId: USER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW,
    });
    const recorder = createRunRecorder({
      scope,
      runId: 'run-drop-failure',
      now: () => NOW,
      logger: { warn },
      live: { drop },
    });
    expect(() =>
      recorder.event({ kind: 'finished', outcome: 'failed', durationMs: 100 }),
    ).not.toThrow();
    expect(drop).toHaveBeenCalledExactlyOnceWith('run-drop-failure');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('T12c latches finish before writing and drops last exactly once', () => {
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-latch',
      userId: USER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW,
    });
    const order: string[] = [];
    const write = runRepo.appendRunEvent;
    vi.spyOn(runRepo, 'appendRunEvent').mockImplementation((...args) => {
      order.push(args[3].kind);
      return write(...args);
    });
    let reentered = false;
    const recorder = createRunRecorder({
      scope,
      runId: 'run-latch',
      now: () => NOW,
      logger: { warn: vi.fn() },
      live: {
        drop: () => {
          order.push('drop');
          if (!reentered) {
            reentered = true;
            recorder.event({ kind: 'finished', outcome: 'failed', durationMs: 0 });
          }
        },
      },
    });
    recorder.event({ kind: 'finished', outcome: 'answered', durationMs: 1 });
    recorder.event({ kind: 'finished', outcome: 'failed', durationMs: 2 });
    recorder.event({
      kind: 'model-progress',
      round: 1,
      answerChars: 1,
      reasoningChars: 1,
      keepalives: 0,
      msSinceLastByte: 0,
    });
    recorder.update({ stage: 'calling-model' });
    expect(order).toEqual(['finished', 'drop']);
    expect(runRepo.getRun(scope, 'run-latch')?.state).toBe('answered');
    expect(runRepo.getRun(scope, 'run-latch')?.stage).toBe('done');
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

  it('storage-free recorder drops once with its actual run id', () => {
    const drop = vi.fn();
    const recorder = createLiveRunRecorder('fixture-storage-free', { drop });
    expect(recorder.runId).toBe('fixture-storage-free');
    recorder.event({ kind: 'started', attempt: 1, queueWaitMs: 0 });
    expect(drop).not.toHaveBeenCalled();
    recorder.event({ kind: 'finished', outcome: 'answered', durationMs: 0 });
    recorder.event({ kind: 'finished', outcome: 'failed', durationMs: 1 });
    expect(drop).toHaveBeenCalledExactlyOnceWith('fixture-storage-free');
  });

  it('NOOP_RUN_RECORDER does nothing', () => {
    expect(NOOP_RUN_RECORDER.runId).toBe('');
    expect(() => {
      NOOP_RUN_RECORDER.event({ kind: 'delivering', parts: 1 });
      NOOP_RUN_RECORDER.update({ conversationId: 'conv-1' });
    }).not.toThrow();
  });
});
