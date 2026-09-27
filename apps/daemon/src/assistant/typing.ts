export interface TypingOptions {
  readonly intervalMs?: number;
  readonly maxMs?: number;
  readonly onError: (err: unknown) => void;
}

/**
 * Shows the typing indicator now and refreshes it every `intervalMs` until
 * the returned stop function is called or `maxMs` has passed. Best-effort:
 * a failed send is reported to `onError` once and never throws.
 */
export const startTyping = (
  send: () => Promise<void>,
  options: TypingOptions,
): (() => void) => {
  const intervalMs = options.intervalMs ?? 8_000;
  const maxMs = options.maxMs ?? 180_000;
  let stopped = false;
  let errorReported = false;

  const attempt = (): void => {
    let result: Promise<void>;
    try {
      result = send();
    } catch (err) {
      if (!errorReported) {
        errorReported = true;
        options.onError(err);
      }
      return;
    }
    result.catch((err: unknown) => {
      if (!errorReported) {
        errorReported = true;
        options.onError(err);
      }
    });
  };

  // The first send happens synchronously within the call (not awaited).
  attempt();

  const interval = setInterval(() => {
    if (stopped) return;
    attempt();
  }, intervalMs);
  const timeout = setTimeout(() => {
    stopped = true;
    clearInterval(interval);
  }, maxMs);
  // A long keepalive must not hold the process open on its own.
  if (typeof interval.unref === 'function') interval.unref();
  if (typeof timeout.unref === 'function') timeout.unref();

  let called = false;
  return () => {
    if (called) return;
    called = true;
    stopped = true;
    clearInterval(interval);
    clearTimeout(timeout);
  };
};
