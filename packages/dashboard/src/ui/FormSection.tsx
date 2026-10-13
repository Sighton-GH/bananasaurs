import { useId, type ReactElement, type ReactNode } from 'react';

/** A named group of fields, bounded to the form reading width (docs/28). */
export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): ReactElement {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 id={titleId} className="text-section font-semibold">
          {title}
        </h2>
        {description !== undefined && <p className="text-small text-ink-muted">{description}</p>}
      </div>
      <div className="grid gap-4 max-w-[720px] min-w-0">{children}</div>
    </section>
  );
}
