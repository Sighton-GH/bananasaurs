# Bananasaurs brand assets

Origin and usage rules for the files in `packages/dashboard/public/brand/`.
ADR 0051 D5 is the governing decision; this file is the provenance record
it points to.

## The assets

| File               | Origin                                                       | Notes                                                                                                                                           |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `logo.jpg`         | Owner-supplied banana-saur mark (2026-09-20).                | The product mark. Preserved byte-exact: no pixel of the mark is edited, and derived uses are sized/compressed copies placed on a light tile so no transparency is faked. |
| `sighton-mark.jpg` | Owner-supplied Sighton Media mark (2026-09-20).              | Rides next to the attribution line only.                                                                                                         |
| `favicon.png`      | Derived from `logo.jpg` for this project.                    | Sized down from the mark; the source stays untouched.                                                                                            |
| `bg-dark.jpg`      | Generated for this project (2026-09-20).                     | Shell/login backdrop, dark scheme.                                                                                                               |
| `bg-light.jpg`     | Generated for this project (2026-09-20).                     | Shell/login backdrop, light scheme.                                                                                                              |

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
