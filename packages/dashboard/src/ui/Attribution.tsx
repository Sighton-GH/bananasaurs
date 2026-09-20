/**
 * "Bananasaurs by Sighton Media" with the owner-supplied Sighton mark
 * (`public/brand/sighton-mark.jpg`, byte-exact; the display copy is a sized
 * derivative on its original light tile - `branding/BRAND.md`). The credit
 * wording is the owner's 2026-09-20 decision: Sighton Media only, no
 * personal name, linking https://sighton.ca.
 */
export function Attribution({ className }: { readonly className?: string | undefined }) {
  return (
    <p className={className}>
      Bananasaurs by{' '}
      <a
        className="inline-flex items-center gap-1.5 underline decoration-line underline-offset-2 hover:text-ink"
        href="https://sighton.ca"
      >
        <img
          src="/brand/sighton-mark-display.jpg"
          alt=""
          className="h-4 w-auto rounded-sm border border-line"
        />
        Sighton Media
      </a>
    </p>
  );
}
