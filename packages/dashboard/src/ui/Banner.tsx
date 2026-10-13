import type { ReactElement, ReactNode } from 'react';
import { Icon, IconClose } from './icons.js';
import { ALERT_TONE, type AlertTone } from './InlineAlert.js';
import { Tooltip, TooltipProvider } from './Tooltip.js';

/**
 * A full-width strip at the top of a page for page-level feedback ("Sync is
 * paused"). No radius and a bottom border only, so it reads as part of the
 * page edge rather than a card. Role follows the tone table (ADR 0142) unless live is explicitly set.
 */
export function Banner({
  tone,
  live,
  children,
  action,
  onDismiss,
}: {
  readonly tone: AlertTone;
  readonly live?: 'polite' | 'assertive';
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly onDismiss?: () => void;
}): ReactElement {
  const style = ALERT_TONE[tone];
  return (
    <TooltipProvider>
      <div
        role={live === undefined ? style.role : live === 'polite' ? 'status' : 'alert'}
        className={`flex w-full items-center gap-2 border-b px-3 py-2 ${style.classes}`}
      >
        <Icon icon={style.icon} className="shrink-0" />
        <div className="min-w-0 flex-1 text-body">{children}</div>
        {action}
        {onDismiss !== undefined && (
          <Tooltip content="Dismiss">
            <button
              type="button"
              aria-label="Dismiss"
              className="inline-flex shrink-0 items-center rounded-sm p-0.5 hover:bg-sunk focus-visible:outline-accent"
              onClick={onDismiss}
            >
              <Icon icon={IconClose} />
            </button>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
