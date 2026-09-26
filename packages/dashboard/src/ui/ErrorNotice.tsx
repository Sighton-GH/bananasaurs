import type { ReactElement } from 'react';
import { describeError, type DescribedError } from '../api/describe-error.js';

/**
 * One `role="alert"` block for an already-described error: the title, the
 * message, the hint ("What to do: …") and a small `code · HTTP n · request id`
 * meta line. `compact` drops the hint. `detail` parts are appended to the meta
 * line after the existing parts (empty strings dropped). The error tokens
 * match `Field.tsx` (`text-danger` for the title, `text-ink-muted` for the
 * hint and the meta line).
 */
export function DescribedNotice({
  described,
  compact = false,
  detail = [],
}: {
  readonly described: DescribedError;
  readonly compact?: boolean;
  readonly detail?: readonly string[];
}): ReactElement {
  const meta = [
    described.code,
    described.status !== undefined ? `HTTP ${described.status}` : undefined,
    described.requestId !== undefined ? `request ${described.requestId}` : undefined,
    ...detail,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
  return (
    <div role="alert" className="text-sm">
      <p className="font-medium text-danger">{described.title}</p>
      <p className="mt-1">{described.message}</p>
      {!compact && described.hint !== undefined && (
        <p className="mt-1 text-xs text-ink-muted">What to do: {described.hint}</p>
      )}
      <p className="mt-1 text-xs text-ink-muted">{meta}</p>
      {described.requestId !== undefined && (
        <button
          type="button"
          className="mt-1 text-xs text-ink-muted underline"
          onClick={() => void navigator.clipboard?.writeText(described.requestId as string)}
        >
          Copy request id
        </button>
      )}
    </div>
  );
}

/**
 * One `role="alert"` block for any thrown error: the title, the message, the
 * hint ("What to do: …") and a small `code · HTTP n · request id` meta line.
 * `compact` drops the hint. The error tokens match `Field.tsx` (`text-danger`
 * for the title, `text-ink-muted` for the hint and the meta line).
 */
export function ErrorNotice({
  error,
  compact = false,
}: {
  readonly error: unknown;
  readonly compact?: boolean;
}): ReactElement {
  return <DescribedNotice described={describeError(error)} compact={compact} />;
}
