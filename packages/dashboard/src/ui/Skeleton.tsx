import type { ReactElement } from 'react';

/**
 * Pulsing placeholder blocks while a region loads (docs/28 §7.7: a skeleton
 * for anything over 3 s). Purely decorative, so hidden from assistive tech.
 * The last line runs at 60 % width, which reads as a paragraph's final line.
 */
export function Skeleton({
  lines = 3,
  className = '',
}: {
  readonly lines?: number;
  readonly className?: string;
}): ReactElement {
  return (
    <div aria-hidden="true" className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={`h-3 animate-pulse rounded-sm bg-sunk motion-reduce:animate-none ${
            i === lines - 1 ? 'w-3/5' : 'w-full'
          }`}
        />
      ))}
    </div>
  );
}
