import {
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
} from 'react';

/**
 * A labelled form control. The label wraps only its text and the control, so
 * the control's accessible name is exactly the label text; the hint and the
 * error sit outside the label with their own ids and are attached to the
 * control through `aria-describedby` (the child must be a single element —
 * an `<Input>` — for that to work).
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: ReactElement<{
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
        'aria-describedby': describedBy === '' ? undefined : describedBy,
        'aria-invalid': error !== undefined ? true : undefined,
      })
    : children;
  return (
    <div className="text-sm">
      <label className="block">
        <span className="mb-1 block text-ink-muted">{label}</span>
        {control}
      </label>
      {hint !== undefined && (
        <span id={hintId} className="mt-1 block text-xs text-ink-muted">
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span id={errorId} role="alert" className="mt-1 block text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink placeholder:text-ink-muted ${props.className ?? ''}`}
    />
  );
}

export function Checkbox({
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { readonly label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}
