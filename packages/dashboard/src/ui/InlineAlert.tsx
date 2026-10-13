import type { ReactElement, ReactNode } from 'react';
import {
  Icon,
  IconCopy,
  IconError,
  IconInfo,
  IconSuccess,
  IconWarning,
  type LucideIcon,
} from './icons.js';
import { Tooltip, TooltipProvider } from './Tooltip.js';

export type AlertTone = 'info' | 'hold' | 'danger' | 'ok';

interface AlertToneStyle {
  readonly classes: string;
  readonly icon: LucideIcon;
  readonly role: 'status' | 'alert';
}

/**
 * Tone table for InlineAlert and Banner (ADR 0142). `info` borrows the
 * progress tint. `hold` and `danger` are assertive; `info` and `ok` are polite.
 */
export const ALERT_TONE: Record<AlertTone, AlertToneStyle> = {
  info: {
    classes: 'border-tone-progress bg-tone-progress-bg text-tone-progress-ink',
    icon: IconInfo,
    role: 'status',
  },
  ok: {
    classes: 'border-tone-ok bg-tone-ok-bg text-tone-ok-ink',
    icon: IconSuccess,
    role: 'status',
  },
  hold: {
    classes: 'border-tone-hold bg-tone-hold-bg text-tone-hold-ink',
    icon: IconWarning,
    role: 'alert',
  },
  danger: {
    classes: 'border-tone-danger bg-tone-danger-bg text-tone-danger-ink',
    icon: IconError,
    role: 'alert',
  },
};

/**
 * Inline feedback inside a page (docs/28 §7.6). `reference` is a request id or
 * error code shown as `Ref <id>` with a copy button, so a report can quote it.
 */
export function InlineAlert({
  tone,
  title,
  children,
  action,
  reference,
}: {
  readonly tone: AlertTone;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly reference?: string;
}): ReactElement {
  const style = ALERT_TONE[tone];
  return (
    <TooltipProvider>
      <div
        role={style.role}
        className={`flex flex-wrap gap-2 rounded-control border px-3 py-2 ${style.classes}`}
      >
        <Icon icon={style.icon} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 basis-48 text-body [overflow-wrap:anywhere]">
          <p className="font-medium">{title}</p>
          {children !== undefined && <div className="mt-0.5">{children}</div>}
          {action !== undefined && <div className="mt-2">{action}</div>}
          {reference !== undefined && (
            <p className="mt-1 flex flex-wrap items-center gap-1">
              <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-caption">
                Ref {reference}
              </span>
              <Tooltip content="Copy reference">
                <button
                  type="button"
                  aria-label="Copy reference"
                  className="inline-flex items-center rounded-sm p-0.5 hover:bg-sunk focus-visible:outline-accent"
                  onClick={() => {
                    // Best effort: clipboard is unavailable or denied in
                    // non-secure contexts; a rejected write is not operator noise.
                    navigator.clipboard?.writeText(reference)?.catch(() => undefined);
                  }}
                >
                  <Icon icon={IconCopy} />
                </button>
              </Tooltip>
            </p>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
