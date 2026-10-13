import type { ReactNode } from 'react';
import { ApiError } from '../api.js';
import type { Resource } from '../hooks/useResource.js';
import { InlineAlert } from './InlineAlert.js';
import { Empty, Forbidden, Loading, NotFound, Unavailable } from './states.js';

export type { Resource };

/**
 * The four states `docs/06` requires every page to make explicit. A page
 * renders its data only through this boundary, so omitting a state is harder
 * than including one. Each state is a component from the states kit.
 */

export function DataState<T>({
  resource,
  isEmpty,
  empty,
  emptyTitle = 'Nothing here yet.',
  emptyAction,
  notFound,
  children,
}: {
  readonly resource: Resource<T>;
  readonly isEmpty?: (data: T) => boolean;
  readonly empty?: ReactNode;
  readonly emptyTitle?: string;
  readonly emptyAction?: ReactNode;
  readonly notFound?: ReactNode;
  readonly children: (data: T) => ReactNode;
}) {
  if (resource.state === 'loading') {
    return <Loading {...(resource.retry !== undefined ? { onRetry: resource.retry } : {})} />;
  }
  if (resource.state === 'error') {
    const status = resource.error instanceof ApiError ? resource.error.status : undefined;
    if (status === 403) return <Forbidden error={resource.error} />;
    if (status === 404) return <>{notFound ?? <NotFound what={resource.request} />}</>;
    return <Unavailable what={resource.request} error={resource.error} onRetry={resource.retry} />;
  }
  if (isEmpty?.(resource.data) === true) {
    return <>{empty ?? <Empty title={emptyTitle} action={emptyAction} />}</>;
  }
  return (
    <>
      {resource.degraded !== undefined && (
        <div className="mb-2">
          <InlineAlert tone="hold" title={resource.degraded} />
        </div>
      )}
      {children(resource.data)}
    </>
  );
}
