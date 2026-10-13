import { useEffect, useRef, type ReactElement } from 'react';

/** The Link classes (ADR 0142) on plain anchors; these jump to fields, not routes. */
const LINK_CLASS =
  'text-accent underline underline-offset-2 hover:no-underline focus-visible:outline-accent';

/**
 * The GOV.UK error summary (docs/28 §7.5): on submit failure, one anchor per
 * problem at the top of the form. It takes focus on mount so the errors are
 * announced, and each anchor moves focus to its field.
 */
export function ErrorSummary({
  errors,
  title = "There's a problem",
}: {
  readonly errors: readonly { fieldId: string; message: string }[];
  readonly title?: string;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const hasErrors = errors.length > 0;
  useEffect(() => {
    if (hasErrors) ref.current?.focus();
  }, [hasErrors]);
  if (!hasErrors) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="rounded-control border-2 border-tone-danger bg-panel p-3 focus:outline-accent"
    >
      <h2 className="text-section font-medium">{title}</h2>
      <ul className="mt-2 flex flex-col gap-1">
        {errors.map((error) => (
          <li key={error.fieldId}>
            <a
              href={`#${error.fieldId}`}
              className={LINK_CLASS}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(error.fieldId)?.focus();
              }}
            >
              {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
