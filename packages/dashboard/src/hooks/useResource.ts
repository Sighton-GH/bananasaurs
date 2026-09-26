import { useCallback, useEffect, useState } from 'react';

/**
 * The four states `docs/06` requires every page to make explicit. A page
 * renders its data only through the `DataState` boundary, so omitting a state
 * is harder than including one.
 *
 * Defined here rather than in `ui/DataState.tsx` because `tsconfig.all.json`
 * type-checks `*.ts` without `jsx`, so a `.ts` file cannot import a type from
 * a `.tsx` module (TS6142); `DataState.tsx` re-exports this canonical
 * definition, so both import paths name the same type.
 */
export type Resource<T> =
  | { readonly state: 'loading' }
  | {
      readonly state: 'error';
      readonly request: string;
      readonly message: string;
      /** The thrown value, so `DataState` can render the server's answer, not just its message. */
      readonly error: unknown;
      readonly retry: () => void;
    }
  | { readonly state: 'ready'; readonly data: T; readonly degraded?: string };

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
        setResource({ state: 'error', request, message, error: err, retry: reload });
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is expected to be stable (wrap it in useCallback at the call site).
  }, [generation, load, request, reload]);

  return { resource, reload };
}
