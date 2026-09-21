# 0055 — Mobile navigation is a labelled jump sheet, not a ported rail

2026-09-20, part of the web UI overhaul (ADR 0051).

## Context

ADR 0051 D6 collapsed the desktop rail into a hamburger drawer on mobile.
That drawer was the desktop rail verbatim: server identity and the credit
first, then all 23 areas in five groups. On a phone it had three problems:

- **Orientation was free only once.** The sticky header showed the mark and
  a hamburger; the moment the operator scrolled, nothing on screen said
  which area they were in without opening the drawer to look.
- **Jumping cost a scroll.** Reaching Backups or Providers meant open,
  scroll past the server block and most of the rail, then tap — the full
  drawer is taller than a phone viewport.
- **The affordance was an icon.** A bare hamburger communicates nothing to
  a first-time operator about what is behind it.

## Decision

Mobile navigation is a **jump sheet**, separate from the desktop rail,
which is unchanged.

- The sticky header's navigation control is a labelled button naming the
  **current area** with a chevron — it answers "where am I" at a glance and
  reads as tappable without prior knowledge. Detail routes (a case, a
  rule, a member) name their list area; an unknown route falls back to
  "Jump to".
- The control opens a **bottom-anchored sheet** (Radix `Dialog`, the same
  primitive as `ConfirmDialog`): thumb-sized targets, the same group order
  as the rail, and the current area marked with a "Current" badge. The
  sheet opens scrolled to the current area, and the destination groups
  come first in its scroll region - server identity, sign-out and the
  Sighton Media credit sit at the foot of that scroll, present but never
  in the way of a jump. Focus trap, Escape, backdrop dismissal and scroll
  lock come from Radix.
- The sheet rises 180ms from the bottom edge; `prefers-reduced-motion`
  disables the animation through the existing global rule.
- The desktop rail keeps its compact `min-h-9` density. `GuildIdentity` and
  `ShellFooter` are shared components so the two layouts cannot drift, and
  `GROUPS` moves into `routes.ts` — navigation stays data.

## Consequences

- The hamburger drawer is gone; below `lg` the rail does not render at all.
- An in-page "jump to section" control for long pages (Doctor, Config) was
  considered and deferred: it belongs to the pages' own section work, not
  the shell, and the pages are being edited in parallel.
