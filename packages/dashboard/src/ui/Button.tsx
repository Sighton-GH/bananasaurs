import type { ButtonHTMLAttributes } from 'react';
import { Icon, type LucideIcon } from './icons.js';
import { Spinner } from './Spinner.js';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'subtle';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: 'sm' | 'md';
  readonly icon?: LucideIcon;
  /** Disables the button and marks it busy for assistive tech while a request is in flight. */
  readonly busy?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  default: 'border-line-strong bg-panel text-ink hover:bg-sunk active:bg-line',
  primary: 'border-accent bg-accent text-accent-ink hover:brightness-110 active:brightness-95',
  danger: 'border-tone-danger bg-panel text-danger hover:bg-tone-danger-bg',
  subtle: 'border-transparent bg-transparent text-ink hover:bg-sunk',
};
const SIZE = { sm: 'min-h-7 px-2 py-1 text-small', md: 'min-h-9 px-3 py-1.5 text-body' } as const;

/**
 * Every button in the dashboard. `type` defaults to `button` so a button inside
 * a form never submits it by accident; pass `type="submit"` deliberately.
 */
export function Button({
  variant = 'default',
  size = 'md',
  icon,
  busy = false,
  className = '',
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-busy={busy || undefined}
      disabled={disabled === true || busy}
      className={`relative inline-flex min-w-0 max-w-full h-fit items-center justify-center gap-1.5 whitespace-normal rounded-control border font-medium transition-colors duration-150 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
    >
      {icon !== undefined && (
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          {busy ? <Spinner size="sm" /> : <Icon icon={icon} />}
        </span>
      )}
      {/* Opacity keeps the same label in flow and in the accessible name. */}
      <span
        className={`min-w-0 [overflow-wrap:anywhere] ${busy && icon === undefined ? 'opacity-0' : ''}`}
      >
        {children}
      </span>
      {busy && icon === undefined && (
        <span
          className="absolute inset-0 inline-flex items-center justify-center"
          aria-hidden="true"
        >
          <Spinner size="sm" />
        </span>
      )}
    </button>
  );
}
