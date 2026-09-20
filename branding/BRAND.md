# Bananasaurs brand assets

Origin and usage rules for the files in `packages/dashboard/public/brand/`.
ADR 0051 D5 is the governing decision; this file is the provenance record
it points to.

## The assets

| File               | Origin                                                       | Notes                                                                                                                                           |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `logo.jpg`         | Owner-supplied banana-saur mark (2026-09-20, re-sent 2026-09-20 after a sandbox loss). | The product mark, in `packages/dashboard/public/brand/`. Preserved byte-exact: no pixel of the mark is edited, and derived uses are sized/compressed copies placed on its original light tile so no transparency is faked. The earlier PNG export of the same mark also lives at `branding/logo.png` (planning baseline). |
| `brand-mark.jpg`   | Derived from `logo.jpg` (512px).                             | The display copy the rail header and login screen load.                                                                                          |
| `favicon.png`      | Derived from `logo.jpg` (48px) for this project.             | Sized down from the mark; the source stays untouched.                                                                                            |

Still owed: the Sighton Media mark (owner to send; rides next to the
attribution line only) and the dark/light shell backdrop art from ADR 0051
D5 (lost with the sandbox, not yet regenerated).

## Usage rules (ADR 0051 D5)

- The mark appears in the rail header, the login and bootstrap screens, the
  favicon, and empty-state art. Nowhere else.
- The background art sits behind content at low contrast with a scrim,
  ships as static optimized files, carries no animation beyond what
  `prefers-reduced-motion` disables, and never pushes text contrast below
  4.5:1.
- Amber `#F2B441` stays reserved for state (ADR 0043). Brand warmth comes
  from the artwork and the mark; no second yellow enters the component
  palette.
- Attribution reads "Bananasaurs by Sighton Media" with
  `https://sighton.ca` linked and the Sighton Media mark alongside, on the
  shell and the login screen. Owner decision, 2026-09-20: the credit is
  "just sighton media" - no personal name appears in the product.

## Replacing an asset

Replace the file in place, keep the name, and re-derive `favicon.png` from
the new mark. Do not edit `logo.jpg` itself; if the mark changes, the new
file becomes the new byte-exact source.
