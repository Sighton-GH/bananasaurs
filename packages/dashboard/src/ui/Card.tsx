/**
 * The bordered section card the operator pages group their content into:
 * an uppercase small-caps title over arbitrary body. Introduced on Overview
 * (W4), promoted to a shared component for the moderation pages (W4b).
 */
export function Card({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-line bg-panel p-3">
      <h2 className="mb-2 text-xs font-semibold tracking-wider text-ink-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}
