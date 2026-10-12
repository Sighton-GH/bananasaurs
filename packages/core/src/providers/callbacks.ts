/**
 * Fire-and-forget invocation for provider progress callbacks (Slice 3 round 2
 * fix item 1).
 *
 * `GenerateTextRequest.onProgress` and `onChunk` are typed `void`, but at
 * runtime a callback can still throw synchronously or return a rejected
 * promise. A progress callback must never fail the provider call, must never
 * become a `ProviderError`, and must never trigger failover — so the call
 * runs synchronously inside a try/catch, any returned promise is observed
 * (never awaited) so its rejection cannot surface as an unhandled rejection,
 * and every error is swallowed.
 */
export const invokeStreamCallback = (call: () => unknown): void => {
  let returned: unknown;
  try {
    returned = call();
  } catch {
    return;
  }
  try {
    // A hostile `then` getter throws here and is swallowed below; a genuine
    // promise is assimilated without awaiting so a slow or never-settling
    // callback cannot hold the stream open.
    if (
      (typeof returned === 'object' && returned !== null) ||
      typeof returned === 'function'
    ) {
      const then = (returned as { then?: unknown }).then;
      if (typeof then === 'function')
        void Promise.resolve(returned as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // A hostile thenable never fails the call either.
  }
};
