import type { ReactNode } from 'react';
import { Icon, type LucideIcon } from './icons.js';

export type BadgeTone = 'neutral' | 'accent' | 'progress' | 'hold' | 'ok' | 'danger';
const TONE: Record<BadgeTone, string> = {
  neutral: 'border-tone-neutral bg-tone-neutral-bg text-tone-neutral-ink',
  accent: 'border-accent bg-accent-bg text-accent',
  progress: 'border-tone-progress bg-tone-progress-bg text-tone-progress-ink',
  hold: 'border-tone-hold bg-tone-hold-bg text-tone-hold-ink',
  ok: 'border-tone-ok bg-tone-ok-bg text-tone-ok-ink',
  danger: 'border-tone-danger bg-tone-danger-bg text-tone-danger-ink',
};

/** A small inline status chip; amber means held or waiting (docs/28 §4). */
export function Badge({
  tone = 'neutral',
  icon,
  wrap = false,
  children,
}: {
  readonly tone?: BadgeTone;
  readonly icon?: LucideIcon;
  /** Opt in for sentence-length statuses: wrap inside the container instead of overflowing. */
  readonly wrap?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-caption font-medium ${
        wrap ? 'max-w-full min-w-0 whitespace-normal [overflow-wrap:anywhere]' : 'whitespace-nowrap'
      } ${TONE[tone]}`}
    >
      {icon !== undefined && <Icon icon={icon} />}
      {children}
    </span>
  );
}
