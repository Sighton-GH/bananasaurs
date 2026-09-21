/**
 * The product mark is the owner-supplied banana-saur artwork
 * (`public/brand/logo.jpg`, byte-exact; `brand-mark.jpg` is the sized
 * display copy on its original light tile - see `branding/BRAND.md`). It
 * ships as an image, never a redrawn glyph, and stays on its light tile in
 * both schemes so no transparency is faked (ADR 0051 D5).
 */
export function Brand({ compact = false }: { readonly compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <img
        src="/brand/brand-mark.jpg"
        alt=""
        className="size-9 shrink-0 rounded-md border border-line"
      />
      {!compact && (
        <div className="min-w-0 leading-none">
          <p className="truncate text-base font-semibold tracking-[-0.02em]">Bananasaurs</p>
          <p className="mt-1 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-ink-muted">
            Operator console
          </p>
        </div>
      )}
    </div>
  );
}
