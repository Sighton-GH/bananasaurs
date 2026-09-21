import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'default' | 'primary' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  /** Disables the button and marks it busy for assistive tech while a request is in flight. */
  readonly busy?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  default: 'border-line bg-panel text-ink hover:border-ink-muted',
  primary: 'border-ink bg-ink text-canvas hover:opacity-90',
  danger: 'border-danger bg-transparent text-danger hover:bg-danger/15',
};

/**
 * Every button in the dashboard. `type` defaults to `button` so a button inside
 * a form never submits it by accident; pass `type="submit"` deliberately.
 */
export function Button({
  variant = 'default',
  busy = false,
  className = '',
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      aria-busy={busy || undefined}
      disabled={disabled === true || busy}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2.5 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
