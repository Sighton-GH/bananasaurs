import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'hold' | 'danger' | 'ok';

const TONE: Record<BadgeTone, string> = {
  neutral: 'border-line text-ink-muted',
  hold: 'border-hold bg-hold text-hold-ink',
  danger: 'border-danger text-danger',
  ok: 'border-ok text-ok',
};

/** A small inline status chip. `hold` is the one accent and means the bot is holding back. */
export function Badge({
  tone = 'neutral',
  children,
}: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}
