import { useId, useState, type ReactElement, type TextareaHTMLAttributes } from 'react';
/** Long text, optionally with a polite character count linked to the control. */
export function Textarea({
  showCount = false,
  maxLength,
  value,
  defaultValue,
  onInput,
  className = '',
  'aria-describedby': describedBy,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { readonly showCount?: boolean }): ReactElement {
  const countId = `${useId()}-count`;
  const [inputLength, setInputLength] = useState(String(defaultValue ?? '').length);
  const length = value === undefined ? inputLength : String(value).length;
  const counted = showCount && maxLength !== undefined;
  const invalid =
    props['aria-invalid'] !== undefined &&
    props['aria-invalid'] !== false &&
    props['aria-invalid'] !== 'false';
  return (
    <>
      <textarea
        {...props}
        value={value}
        defaultValue={defaultValue}
        maxLength={maxLength}
        aria-describedby={
          [describedBy, counted ? countId : undefined].filter(Boolean).join(' ') || undefined
        }
        onInput={(event) => {
          setInputLength(event.currentTarget.value.length);
          onInput?.(event);
        }}
        className={`block min-h-24 w-full rounded-control border ${invalid ? 'border-tone-danger' : 'border-line-strong'} bg-canvas px-2 py-2 text-ink placeholder:text-ink-muted focus-visible:outline-accent ${className}`}
      />
      {counted && (
        <span
          id={countId}
          aria-live="polite"
          className={`mt-1 block text-caption ${length > maxLength * 0.9 ? 'text-tone-hold-ink' : 'text-ink-muted'}`}
        >
          {length} / {maxLength}
        </span>
      )}
    </>
  );
}
