import type { ReactNode } from 'react';
import { Link } from 'wouter';

export interface Crumb {
  readonly label: string;
  readonly href: string;
}

/**
 * Every page opens with its name and one sentence saying what it is for
 * (`docs/06`'s shared page pattern). Detail pages pass `crumbs` (ordered
 * ancestors); the current title closes the trail as plain text. `status`
 * sits after the header row, before the page content.
 */
export function PageHeader({
  title,
  purpose,
  actions,
  crumbs,
  status,
}: {
  readonly title: string;
  readonly purpose: string;
  readonly actions?: ReactNode;
  readonly crumbs?: readonly Crumb[];
  readonly status?: ReactNode;
}) {
  return (
    <div className="mb-4 min-w-0 max-w-full">
      {crumbs !== undefined && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1 min-w-0 max-w-full text-small text-ink-muted">
          <ol className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {crumbs.map((crumb) => (
              <li key={crumb.href} className="flex min-w-0 items-center gap-1.5">
                <Link
                  href={crumb.href}
                  className="break-words underline underline-offset-2 hover:text-ink"
                >
                  {crumb.label}
                </Link>
                <span aria-hidden="true">/</span>
              </li>
            ))}
            <li aria-current="page" title={title} className="min-w-0 max-w-full truncate text-ink">
              {title}
            </li>
          </ol>
        </nav>
      )}
      <div className="flex min-w-0 max-w-full flex-col items-stretch justify-between gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 max-w-full">
          <h1 className="min-w-0 max-w-full break-words text-title font-semibold">{title}</h1>
          <p className="mt-1 text-small text-ink-muted">{purpose}</p>
        </div>
        {actions !== undefined && (
          <div className="flex max-w-full flex-wrap gap-2 sm:shrink-0">{actions}</div>
        )}
      </div>
      {status !== undefined && <div className="mt-3">{status}</div>}
    </div>
  );
}
