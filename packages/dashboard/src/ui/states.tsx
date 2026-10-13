import type { ReactElement, ReactNode } from 'react';
import { ApiError } from '../api.js';
import { describeError } from '../api/describe-error.js';
import { useDelayedFlag } from '../hooks/useDelayedFlag.js';
import { relativeTime } from '../lib/relative-time.js';
import { Button } from './Button.js';
import { InlineAlert } from './InlineAlert.js';
import { IconRefresh } from './icons.js';
import { Link } from './Link.js';
import { Skeleton } from './Skeleton.js';
import { Spinner } from './Spinner.js';

/**
 * The states kit (docs/28 §7.7): one component per state a resource can be in.
 * `DataState` routes to these, so no page invents its own wording.
 */

/** Nothing for 1 s, then a skeleton or spinner; after 10 s it says so and offers a retry. */
export function Loading({
  label,
  variant = 'skeleton',
  lines = 3,
  onRetry,
  forceVisible = false,
}: {
  /** For the /kit page only. */
  readonly forceVisible?: boolean;
  readonly label?: string;
  readonly variant?: 'skeleton' | 'spinner';
  readonly lines?: number;
  readonly onRetry?: () => void;
}): ReactElement | null {
  const visible = useDelayedFlag(true, 1000);
  const slow = useDelayedFlag(true, 10_000);
  if (!visible && !forceVisible) return null;
  const name = label === undefined || label === '' ? 'Loading' : `Loading ${label}`;
  return (
    <div role="status" aria-label={name} className="flex flex-col gap-2">
      {variant === 'spinner' ? <Spinner /> : <Skeleton lines={lines} />}
      {slow && (
        <p className="flex flex-wrap items-center gap-2 text-body text-ink-muted">
          <span>Still loading. This is taking longer than usual.</span>
          {onRetry !== undefined && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
        </p>
      )}
    </div>
  );
}

export function Empty({
  title,
  detail,
  action,
  art = true,
}: {
  readonly title: string;
  readonly detail?: ReactNode;
  readonly action?: ReactNode;
  readonly art?: boolean;
}): ReactElement {
  return (
    <section
      className="max-w-2xl rounded-panel border border-dashed border-line-strong bg-panel/80 px-5 py-6"
      aria-label={title}
    >
      <div className="flex flex-wrap items-start gap-4">
        {art && (
          <img src="/brand/bananasaur.png" alt="" width={64} height={64} className="shrink-0" />
        )}
        <div className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
          <h2 className="text-base font-medium text-ink">{title}</h2>
          {detail !== undefined && <div className="mt-1 text-sm text-ink-muted">{detail}</div>}
          {action !== undefined && <div className="mt-4">{action}</div>}
        </div>
      </div>
    </section>
  );
}

export function Unavailable({
  what,
  error,
  onRetry,
  restIsSafe = false,
}: {
  readonly what: string;
  readonly error: unknown;
  readonly onRetry?: () => void;
  readonly restIsSafe?: boolean;
}): ReactElement {
  const described = describeError(error);
  return (
    <InlineAlert
      tone="danger"
      title={`Couldn't load ${what}`}
      {...(described.requestId !== undefined ? { reference: described.requestId } : {})}
      {...(onRetry !== undefined
        ? {
            action: (
              <Button size="sm" icon={IconRefresh} onClick={onRetry}>
                Try again
              </Button>
            ),
          }
        : {})}
    >
      {error instanceof ApiError && error.body.title !== undefined && (
        <p className="font-medium">{error.body.title}</p>
      )}
      <p>{described.message}</p>
      {described.hint !== undefined && <p>{described.hint}</p>}
      {restIsSafe && <p>The rest of this page is working.</p>}
    </InlineAlert>
  );
}

/** A 403 is an answer, not a failure: no retry, because retrying cannot change it. */
export function Forbidden({
  error,
  permission,
}: {
  readonly error?: unknown;
  readonly permission?: string;
}): ReactElement {
  const body = error instanceof ApiError ? error.body : undefined;
  return (
    <InlineAlert tone="hold" title={body?.title ?? "You don't have access to this"}>
      <p>{body?.message ?? "Your account doesn't include this."}</p>
      {permission !== undefined && <p className="font-mono text-caption">{permission}</p>}
      <p>Ask the owner to change your account in Accounts.</p>
    </InlineAlert>
  );
}

export function NotFound({
  what,
  backHref = '/',
  backLabel = 'Go back',
}: {
  readonly what: string;
  readonly backHref?: string;
  readonly backLabel?: string;
}): ReactElement {
  return (
    <InlineAlert tone="info" title={`${what} doesn't exist or was deleted`}>
      <Link href={backHref}>{backLabel}</Link>
    </InlineAlert>
  );
}

export function Stale({
  updatedAt,
  onRefresh,
  now = Date.now(),
}: {
  readonly updatedAt: number;
  readonly onRefresh: () => void;
  readonly now?: number;
}): ReactElement {
  return (
    <p className="flex items-center gap-2 text-small text-ink-muted">
      <span>Updated {relativeTime(updatedAt, now)}</span>
      <span aria-hidden="true">·</span>
      <Button size="sm" variant="subtle" icon={IconRefresh} onClick={onRefresh}>
        Refresh
      </Button>
    </p>
  );
}
