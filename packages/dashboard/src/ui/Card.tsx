import type { ReactNode } from 'react';

/** A bordered panel with an optional title, description and header actions. */
export function Card({
  title,
  description,
  actions,
  action,
  padding = 'md',
  children,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  /** Legacy alias retained for existing pages; actions takes precedence. */
  readonly action?: ReactNode;
  readonly padding?: 'md' | 'none';
  readonly children: ReactNode;
}) {
  return (
    <section
      className={`rounded-panel border border-line bg-panel ${padding === 'md' ? 'p-3' : ''}`}
    >
      {title !== undefined && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-section font-semibold">{title}</h2>
            {description !== undefined && (
              <p className="text-small text-ink-muted">{description}</p>
            )}
          </div>
          {actions ?? action}
        </div>
      )}
      {children}
    </section>
  );
}
