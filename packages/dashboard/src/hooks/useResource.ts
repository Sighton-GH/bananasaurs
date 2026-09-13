import { useCallback, useEffect, useState } from 'react';
import type { Resource } from '../ui/DataState.js';

export interface UseResource<T> {
  readonly resource: Resource<T>;
  readonly reload: () => void;
}

/**
 * Loads once on mount and again on `reload()`. `request` is the human name
 * used in the error state ("the audit log"), not the URL. A result that
 * arrives after the component re-requested is dropped, so a slow first
 * response cannot overwrite a fresh one.
 */
export function useResource<T>(request: string, load: () => Promise<T>): UseResource<T> {
  const [generation, setGeneration] = useState(0);
  const [resource, setResource] = useState<Resource<T>>({ state: 'loading' });
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    let cancelled = false;
    setResource({ state: 'loading' });
    load().then(
      (data) => {
        if (!cancelled) setResource({ state: 'ready', data });
      },
      (err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setResource({ state: 'error', request, message, retry: reload });
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is expected to be stable (wrap it in useCallback at the call site).
  }, [generation, load, request, reload]);

  return { resource, reload };
}
