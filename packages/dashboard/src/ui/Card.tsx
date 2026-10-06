/**
 * The bordered section card the operator pages group their content into:
 * an uppercase small-caps title over arbitrary body. Introduced on Overview
 * (W4), promoted to a shared component for the moderation pages (W4b).
 */
export function Card({
  title,
  action,
  children,
}: {
  readonly title: string;
  /** An optional control on the right of the header, e.g. a "Clean up" button. */
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-line bg-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wider text-ink-muted uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
