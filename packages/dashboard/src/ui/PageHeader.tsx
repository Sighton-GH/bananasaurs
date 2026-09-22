import type { ReactNode } from 'react';

/** Every page opens with its name and one sentence saying what it is for (`docs/06`'s shared page pattern). */
export function PageHeader({
  title,
  purpose,
  actions,
}: {
  readonly title: string;
  readonly purpose: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col items-start justify-between gap-4 sm:flex-row">
      <div>
        <h1 className="text-xl">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">{purpose}</p>
      </div>
      {actions !== undefined && <div className="flex max-w-full gap-2 sm:shrink-0">{actions}</div>}
    </div>
  );
}
