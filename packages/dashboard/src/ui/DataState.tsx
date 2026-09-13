import type { ReactNode } from 'react';
import type { Resource } from '../hooks/useResource.js';
import { Button } from './Button.js';

export type { Resource };

/**
 * The four states `docs/06` requires every page to make explicit. A page
 * renders its data only through this boundary, so omitting a state is harder
 * than including one.
 */

export function DataState<T>({
  resource,
  isEmpty,
  empty = <p className="text-sm text-ink-muted">Nothing here yet.</p>,
  children,
}: {
  readonly resource: Resource<T>;
  readonly isEmpty?: (data: T) => boolean;
  readonly empty?: ReactNode;
  readonly children: (data: T) => ReactNode;
}) {
  if (resource.state === 'loading') {
    return (
      <p role="status" className="text-sm text-ink-muted">
        Loading…
      </p>
    );
  }
  if (resource.state === 'error') {
    return (
      <div role="alert" className="rounded-sm border border-danger px-3 py-2 text-sm">
        <p>
          Could not load {resource.request}: {resource.message}
        </p>
        <Button className="mt-2" onClick={resource.retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (isEmpty?.(resource.data) === true) return <>{empty}</>;
  return (
    <>
      {resource.degraded !== undefined && (
        <p role="status" className="mb-2 rounded-sm border border-hold px-3 py-1.5 text-sm">
          {resource.degraded}
        </p>
      )}
      {children(resource.data)}
    </>
  );
}
