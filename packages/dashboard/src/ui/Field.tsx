import {
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
} from 'react';
import { Icon, IconError } from './icons.js';

/**
 * A labelled form control. By default the label wraps its text and the control,
 * preserving existing callers. Opt into `htmlFor` for composite controls such
 * as counted Textareas: the child renders outside the label, keeping its counter
 * out of the accessible name. `htmlFor` overrides any id supplied on the child;
 * the child must forward that id to its labelable control. In both modes the
 * single child must forward `aria-describedby` and `aria-invalid`; hints and
 * errors stay outside the label and are linked through `aria-describedby`.
 */
export function Field({
  label,
  hint,
  error,
  optional = false,
  children,
  htmlFor,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly optional?: boolean;
  readonly children: ReactElement<{
    id?: string | undefined;
    'aria-describedby'?: string | undefined;
    'aria-invalid'?: boolean | undefined;
  }>;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [
    hint !== undefined ? hintId : undefined,
    error !== undefined ? errorId : undefined,
  ]
    .filter((x): x is string => x !== undefined)
    .join(' ');
  const control = isValidElement(children)
    ? cloneElement(children, {
        ...(htmlFor === undefined ? {} : { id: htmlFor }),
        'aria-describedby': describedBy === '' ? undefined : describedBy,
        'aria-invalid': error !== undefined ? true : undefined,
      })
    : children;
  return (
    <div className="text-sm">
      <label className="block" htmlFor={htmlFor}>
        <span className="mb-1 block text-ink-muted">
          {label}
          {optional ? ' (optional)' : ''}
        </span>
        {htmlFor === undefined && control}
      </label>
      {htmlFor !== undefined && control}
      {hint !== undefined && (
        <span id={hintId} className="mt-1 block text-xs text-ink-muted">
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span
          id={errorId}
          role="alert"
          className="mt-1 flex items-center gap-1 text-caption text-danger"
        >
          <Icon icon={IconError} />
          {error}
        </span>
      )}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const invalid =
    props['aria-invalid'] !== undefined &&
    props['aria-invalid'] !== false &&
    props['aria-invalid'] !== 'false';
  return (
    <input
      {...props}
      className={`block w-full rounded-control border ${invalid ? 'border-tone-danger' : 'border-line-strong'} bg-canvas px-2 py-1 text-ink placeholder:text-ink-muted ${props.className ?? ''}`}
    />
  );
}

export function Checkbox({
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { readonly label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        {...rest}
        className={`accent-[var(--color-accent)] size-4 ${rest.className ?? ''}`}
      />
      {label}
    </label>
  );
}
