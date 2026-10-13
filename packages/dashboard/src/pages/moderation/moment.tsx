import type { ReactElement } from 'react';
import { relativeTime } from '../../lib/relative-time.js';

/** A moderation timestamp: relative words, with the absolute local time on hover. */
export function Moment({ at }: { readonly at: number }): ReactElement {
  const date = new Date(at);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(undefined, { timeZoneName: 'short' })}
    >
      {relativeTime(at, Date.now())}
    </time>
  );
}
