/**
 * "Bananasaurs by Sighton Media" with the owner-supplied Sighton mark
 * (`public/brand/sighton-mark.jpg`, byte-exact source; the display copies
 * are sized PNG derivatives keyed off the white tile so the mark floats on
 * either theme - owner request 2026-09-20). The credit wording is the
 * owner's 2026-09-20 decision: Sighton Media only, no personal name,
 * linking https://sighton.ca.
 */
export function Attribution({ className }: { readonly className?: string | undefined }) {
  // One flex line with every item centred on the same axis: the mark image,
  // the words and the link text share a cross-axis, so nothing floats above
  // or below the text baseline. `text-center` from the caller cannot split
  // the line because the whole credit is a single centred row.
  return (
    <p className={`flex items-center justify-center gap-1 ${className ?? ''}`}>
      <span>Bananasaurs by</span>
      <a
        className="flex items-center gap-1.5 underline decoration-line underline-offset-2 hover:text-ink"
        href="https://sighton.ca"
      >
        <img
          src="/brand/sighton-mark-display.png"
          alt=""
          className="h-3.5 w-auto"
        />
        <span>Sighton Media</span>
      </a>
    </p>
  );
}
