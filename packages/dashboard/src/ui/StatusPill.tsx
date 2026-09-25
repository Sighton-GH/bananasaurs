import type { ReactNode } from 'react';
import { Badge, type BadgeTone } from './Badge.js';

export type StatusPillTone = 'ready' | 'attention' | 'off';

const TONE: Record<StatusPillTone, BadgeTone> = {
  ready: 'ok',
  attention: 'hold',
  off: 'neutral',
};

/**
 * One status pill for the AI setup page (ADR 0075): the tone comes from the
 * prop, the words come from the caller, so nothing here can drift out of
 * plain Canadian English on its own.
 */
export function StatusPill({
  tone,
  children,
}: {
  readonly tone: StatusPillTone;
  readonly children: ReactNode;
}) {
  return <Badge tone={TONE[tone]}>{children}</Badge>;
}
