import { useId, type ReactElement } from 'react';
/** Native radios keep the browser's keyboard model and form semantics. */
export function RadioGroup({
  legend,
  name,
  value,
  onChange,
  options,
  orientation = 'vertical',
  id: groupId,
  error,
}: {
  readonly legend: string;
  readonly name: string;
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly hint?: string;
  }[];
  readonly orientation?: 'vertical' | 'horizontal';
  /** Put on the first radio, so an error summary link can focus the group. */
  readonly id?: string;
  /** Inline problem text for the group. */
  readonly error?: string;
}): ReactElement {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <fieldset aria-describedby={error === undefined ? undefined : errorId}>
      <legend className="mb-1 text-small text-ink-muted">{legend}</legend>
      <div
        className={`flex gap-2 ${orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap'}`}
      >
        {options.map((o, index) => {
          const hintId = `${id}-${index}-hint`;
          return (
            <div key={o.value}>
              <label className="inline-flex items-center gap-2 text-body text-ink">
                <input
                  type="radio"
                  name={name}
                  id={index === 0 ? groupId : undefined}
                  aria-invalid={error === undefined ? undefined : true}
                  value={o.value}
                  checked={value === o.value}
                  onChange={() => onChange(o.value)}
                  aria-describedby={o.hint === undefined ? undefined : hintId}
                  className="size-4 accent-[var(--color-accent)] focus-visible:outline-accent"
                />
                {o.label}
              </label>
              {o.hint !== undefined && (
                <span id={hintId} className="ml-6 block text-caption text-ink-muted">
                  {o.hint}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {error !== undefined && (
        <p id={errorId} role="alert" className="mt-1 text-small text-tone-danger-ink">
          {error}
        </p>
      )}
    </fieldset>
  );
}
