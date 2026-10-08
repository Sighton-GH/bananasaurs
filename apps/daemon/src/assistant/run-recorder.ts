import { safeLogFields, type Logger, type RunEvent } from '@bananasaurs/core';
import { runRepo, type GuildScope } from '@bananasaurs/storage';

/** ADR 0129 §6: one run's step log, bound to its guild and run id. Never throws. */
export interface RunRecorder {
  readonly runId: string;
  /** Appends the event and moves the run row's stage/state/summary fields (table below). */
  event(e: RunEvent): void;
  /** A direct run-row patch (conversationId once known, attempt, …). */
  update(patch: Omit<runRepo.RunPatch, 'updatedAt'>): void;
}

/**
 * ADR 0129 §6: what `event()` patches on the run row (`updatedAt` always).
 * `queued` needs no patch (`ensureRun` set it); the metadata-only events move
 * nothing but the timestamp.
 */
const patchFor = (e: RunEvent, now: number): runRepo.RunPatch | undefined => {
  switch (e.kind) {
    case 'queued':
      return undefined;
    case 'started':
      return {
        state: 'running',
        stage: 'starting',
        startedAt: now,
        attempt: e.attempt,
        updatedAt: now,
      };
    case 'conversation':
      return { stage: 'conversation', updatedAt: now };
    case 'context-built':
      return { stage: 'context', updatedAt: now };
    case 'model-call':
      return {
        stage: 'calling-model',
        model: e.model,
        ...(e.keyLabel === undefined ? {} : { keyLabel: e.keyLabel }),
        updatedAt: now,
      };
    case 'model-result':
    case 'model-skipped':
    case 'tool-result':
    case 'guard':
    case 'delivered':
      return { updatedAt: now };
    case 'tool-call':
      return { stage: 'running-tool', updatedAt: now };
    case 'retry-scheduled':
      return {
        state: 'retry-wait',
        stage: 'retry-wait',
        retryAt: e.retryAt,
        errorCode: e.code,
        updatedAt: now,
      };
    case 'delivering':
      return { stage: 'delivering', updatedAt: now };
    case 'finished':
      return {
        state: e.outcome,
        stage: 'done',
        finishedAt: now,
        ...(e.totalTokens === undefined ? {} : { totalTokens: e.totalTokens }),
        ...(e.code === undefined ? {} : { errorCode: e.code }),
        ...(e.traceId === undefined ? {} : { traceId: e.traceId }),
        updatedAt: now,
      };
  }
};

export const createRunRecorder: (deps: {
  readonly scope: GuildScope;
  readonly runId: string;
  readonly now: () => number;
  readonly logger: Pick<Logger, 'warn'>;
}) => RunRecorder = (deps) => {
  // Observability never changes behaviour: the first write failure warns
  // once (`assistant run ledger write failed`, with the run id) and every
  // later failure stays silent while the run continues.
  let warned = false;
  const warnOnce = (err: unknown): void => {
    if (warned) return;
    warned = true;
    deps.logger.warn(
      safeLogFields({ component: 'assistant', runId: deps.runId, err }),
      'assistant run ledger write failed',
    );
  };
  return {
    runId: deps.runId,
    event: (e) => {
      try {
        runRepo.appendRunEvent(deps.scope, deps.runId, deps.now(), e);
        const patch = patchFor(e, deps.now());
        if (patch !== undefined) runRepo.updateRun(deps.scope, deps.runId, patch);
      } catch (err) {
        warnOnce(err);
      }
    },
    update: (patch) => {
      try {
        runRepo.updateRun(deps.scope, deps.runId, { ...patch, updatedAt: deps.now() });
      } catch (err) {
        warnOnce(err);
      }
    },
  };
};

export const NOOP_RUN_RECORDER: RunRecorder = {
  runId: '',
  event: () => undefined,
  update: () => undefined,
};
