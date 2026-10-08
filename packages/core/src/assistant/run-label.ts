import { ACTIVE_RUN_STATES, type RunEvent, type RunRow } from './run-events.js';

/** ADR 0129: an active run with no update for this long shows as stalled (a crash mid-run). */
export const RUN_STALLED_MS = 10 * 60 * 1000;

export interface RunLabel {
  readonly label: string;
  readonly stalled: boolean;
}

/** The model id after its last `/`, so a registry prefix never reaches the dashboard. */
const shortModelOf = (model: string): string => model.split('/').pop() ?? model;

/**
 * Plain-English "what is it doing now" for one run. Pure. `lastEvent` is the run's newest
 * `model-call` or `tool-call` event when the caller has it.
 */
export const describeRun: (
  run: RunRow,
  ctx: { readonly now: number; readonly queueAhead: number; readonly lastEvent?: RunEvent },
) => RunLabel = (run, ctx) => {
  // ADR 0129: stalled replaces any other label — the run is in flight on paper
  // but nothing has updated it since before the threshold.
  if (
    (ACTIVE_RUN_STATES as readonly string[]).includes(run.state) &&
    ctx.now - run.updatedAt > RUN_STALLED_MS
  ) {
    const mins = Math.floor((ctx.now - run.updatedAt) / 60000);
    return { label: `Stalled (no progress for ${String(mins)} min)`, stalled: true };
  }
  if (run.state === 'queued') {
    return {
      label: ctx.queueAhead > 0 ? `Queued (${String(ctx.queueAhead)} ahead)` : 'Queued',
      stalled: false,
    };
  }
  if (run.state === 'retry-wait') {
    const at = new Date(run.retryAt ?? ctx.now).toISOString().slice(11, 19);
    return { label: `Retrying at ${at} UTC after ${run.errorCode ?? 'an error'}`, stalled: false };
  }
  if (run.state === 'answered') return { label: 'Answered', stalled: false };
  if (run.state === 'refused') return { label: 'Refused', stalled: false };
  if (run.state === 'failed') return { label: 'Failed', stalled: false };
  switch (run.stage) {
    case 'starting':
      return { label: 'Starting', stalled: false };
    case 'conversation':
      return { label: 'Reading the conversation', stalled: false };
    case 'context':
      return { label: 'Gathering context', stalled: false };
    case 'calling-model': {
      if (ctx.lastEvent !== undefined && ctx.lastEvent.kind === 'model-call') {
        return {
          label: `Asking ${shortModelOf(ctx.lastEvent.model)} (model ${String(ctx.lastEvent.position + 1)} of ${String(ctx.lastEvent.of)})`,
          stalled: false,
        };
      }
      return {
        label: run.model === undefined ? 'Asking the model' : `Asking ${shortModelOf(run.model)}`,
        stalled: false,
      };
    }
    case 'running-tool': {
      if (ctx.lastEvent !== undefined && ctx.lastEvent.kind === 'tool-call') {
        return { label: `Running tool: ${ctx.lastEvent.tool}`, stalled: false };
      }
      return { label: 'Running a tool', stalled: false };
    }
    case 'delivering':
      return { label: 'Posting the answer', stalled: false };
    // Defensive: a stage without its usual state (never written by the
    // recorder, but the row shape allows it). Mirror the state labels above
    // rather than inventing new text.
    case 'queued':
      return {
        label: ctx.queueAhead > 0 ? `Queued (${String(ctx.queueAhead)} ahead)` : 'Queued',
        stalled: false,
      };
    case 'retry-wait': {
      const at = new Date(run.retryAt ?? ctx.now).toISOString().slice(11, 19);
      return {
        label: `Retrying at ${at} UTC after ${run.errorCode ?? 'an error'}`,
        stalled: false,
      };
    }
    case 'done':
      return { label: 'Posting the answer', stalled: false };
  }
};
