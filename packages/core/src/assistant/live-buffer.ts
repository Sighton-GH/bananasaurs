/** One run's live text: streamed answer plus thinking, each capped. */
export interface LiveText {
  readonly answer: string;
  readonly thinking: string;
}

const ANSWER_CAP = 8_000;
const THINKING_CAP = 8_000;

/** In-memory per-run streaming text (ADR 0148). Never persisted, never logged. */
export interface LiveBuffer {
  append(runId: string, answerDelta: string, reasoningDelta: string): void;
  read(runId: string): LiveText | undefined;
  drop(runId: string): void;
}

export const createLiveBuffer = (deps?: {
  readonly now?: () => number;
}): LiveBuffer => {
  const now = deps?.now ?? Date.now;
  const runs = new Map<string, { answer: string; thinking: string; lastWrite: number }>();
  const cap = (text: string, limit: number): string =>
    text.length <= limit ? text : text.slice(text.length - limit);
  const MAX_RUNS = 50;
  const IDLE_TTL_MS = 30 * 60 * 1000;
  const prune = (): void => {
    const t = now();
    for (const [runId, entry] of runs) {
      if (t - entry.lastWrite >= IDLE_TTL_MS) runs.delete(runId);
    }
    while (runs.size > MAX_RUNS) {
      const oldest = runs.keys().next();
      if (oldest.done) break;
      runs.delete(oldest.value);
    }
  };
  return {
    append(runId, answerDelta, reasoningDelta) {
      const current = runs.get(runId) ?? { answer: '', thinking: '', lastWrite: 0 };
      // Re-insert so map order tracks write recency for eviction.
      runs.delete(runId);
      runs.set(runId, {
        answer: cap(current.answer + answerDelta, ANSWER_CAP),
        thinking: cap(current.thinking + reasoningDelta, THINKING_CAP),
        lastWrite: now(),
      });
      prune();
    },
    read(runId) {
      prune();
      const current = runs.get(runId);
      return current === undefined ? undefined : { answer: current.answer, thinking: current.thinking };
    },
    drop(runId) {
      runs.delete(runId);
    },
  };
};

/**
 * The process-wide buffer the tool loop appends to and the HTTP route
 * reads. Tests use `createLiveBuffer()` for isolation and touch this only
 * for the route test.
 */
let shared: LiveBuffer | undefined;
export const getLiveBuffer = (): LiveBuffer => {
  if (shared === undefined) shared = createLiveBuffer();
  return shared;
};
