import type { ReactNode } from 'react';

export function EmptyState({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section
      className="max-w-2xl rounded-md border border-dashed border-line bg-panel/80 px-5 py-6"
      aria-label={title}
    >
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full border border-line bg-canvas text-lg text-ink-muted"
        >
          ·
        </span>
        <div>
          <h2 className="text-base font-medium text-ink">{title}</h2>
          <div className="mt-1 text-sm text-ink-muted">{detail}</div>
          {action !== undefined && <div className="mt-4">{action}</div>}
        </div>
      </div>
    </section>
  );
}
