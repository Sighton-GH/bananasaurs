import { useCallback, useEffect, useRef, useState } from 'react';
import type { Resource, UseResource } from './useResource.js';

export interface UseLiveResource<T> extends UseResource<T> {
  /** ADR 0129: true while the last poll failed; the last good data stays in `resource`. */
  readonly stale: boolean;
}

/**
 * Loads like `useResource`, then polls: every `fastMs` while `isFast(data)`,
 * else every `slowMs` (ADR 0129 §7: 2 s in flight, 15 s otherwise, paused
 * while the tab is hidden).
 *
 * After the first load, a poll replaces the data without returning to
 * `loading`, and a failed poll keeps the data and sets `stale`. `reload()`
 * behaves like `useResource`'s (a fresh load with `loading`).
 *
 * `opts` rides a ref so an inline options object does not restart the loop;
 * only a new `load`/`request`/`reload()` starts over.
 */
export function useLiveResource<T>(
  request: string,
  load: () => Promise<T>,
  opts: { readonly fastMs: number; readonly slowMs: number; readonly isFast: (data: T) => boolean },
): UseLiveResource<T> {
  const [generation, setGeneration] = useState(0);
  const [resource, setResource] = useState<Resource<T>>({ state: 'loading' });
  const [stale, setStale] = useState(false);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: T | undefined;

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    function schedule(): void {
      clearTimer();
      if (cancelled || latest === undefined) return;
      const { fastMs, slowMs, isFast } = optsRef.current;
      timer = setTimeout(tick, isFast(latest) ? fastMs : slowMs);
    }

    function tick(): void {
      timer = undefined;
      if (cancelled || document.visibilityState === 'hidden') return;
      load().then(
        (data) => {
          if (cancelled) return;
          latest = data;
          setResource({ state: 'ready', data });
          setStale(false);
          schedule();
        },
        () => {
          if (cancelled || latest === undefined) return;
          // A failed poll keeps the last good data and marks it stale;
          // the next delay still comes from that data.
          setStale(true);
          schedule();
        },
      );
    }

    const onVisibility = () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') {
        clearTimer();
        return;
      }
      // Back in view: poll at once when data exists, then resume the cadence.
      if (latest !== undefined) {
        clearTimer();
        tick();
      }
    };

    setResource({ state: 'loading' });
    setStale(false);
    load().then(
      (data) => {
        if (cancelled) return;
        latest = data;
        setResource({ state: 'ready', data });
        schedule();
      },
      (err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setResource({ state: 'error', request, message, error: err, retry: reload });
      },
    );
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // `load` is expected to be stable (wrap it in useCallback at the call site).
  }, [generation, load, request, reload]);

  return { resource, reload, stale };
}
