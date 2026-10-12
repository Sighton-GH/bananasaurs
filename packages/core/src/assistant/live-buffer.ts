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

export const createLiveBuffer = (): LiveBuffer => {
  const runs = new Map<string, { answer: string; thinking: string }>();
  const cap = (text: string, limit: number): string =>
    text.length <= limit ? text : text.slice(text.length - limit);
  return {
    append(runId, answerDelta, reasoningDelta) {
      const current = runs.get(runId) ?? { answer: '', thinking: '' };
      runs.set(runId, {
        answer: cap(current.answer + answerDelta, ANSWER_CAP),
        thinking: cap(current.thinking + reasoningDelta, THINKING_CAP),
      });
    },
    read(runId) {
      const current = runs.get(runId);
      return current === undefined ? undefined : { ...current };
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
