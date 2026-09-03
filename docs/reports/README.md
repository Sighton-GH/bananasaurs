# `docs/reports/` — per-work-unit artifacts

Everything tied to **one unit of work** — a work package, a release phase, a
slice — rather than to the project as a whole. The numbered `docs/NN_*.md` files
are permanent design documents and do not belong here; these do.

Written down because the convention was already established by Release 1 and
then broken in Release 2: `LEDGER_RELEASE2_SLICES_1_6.md` sat at `docs/` top
level beside the permanent design docs for the length of two slices before
anyone noticed. One paragraph here is cheaper than noticing again.

## The four kinds, and how to name them

| Kind | Name | What it is |
| --- | --- | --- |
| **Plan** | `<unit>-plan.md`, or `WP<n>_PLAN.md` (Release 1) | Forward-looking, written before the work. Superseded by `docs/superpowers/plans/` for anything executed by the SDD skill — put those there, not here. |
| **Handoff** | `<unit>-handoff.md` | What the *next* session needs: scope, obligations, what is settled, what will bite, protocol, and any decision the owner owes. Written once, finished when that unit starts. |
| **Ledger** | `<unit>-ledger.md` | The running record *during* a multi-slice run: rulings with what each costs if wrong, per-task commit SHAs, findings. Appended to as work proceeds. Survives compaction — `docs/22` calls it the recovery map. |
| **Report** | `<unit>.md`, or `<unit>-live-run.md` | Backward-looking: what was built, what was found, what is still true. A boundary report between work packages, or the account of a live test. |

Release 1 used `WP<n>`; Release 2 onwards uses `release<n>-slice-<n>` and
`release<n>-slices-<a>-<b>`. Lowercase, hyphenated.

## Ledger and handoff are not the same file

The distinction is worth keeping even though both look like "notes about the
work in progress":

- A **handoff** answers *what should happen next*. It is read once, by whoever
  picks the work up, and is dead the moment they start.
- A **ledger** answers *what happened, and what was decided on the owner's
  behalf*. It is read whenever someone asks "why is it like this", including
  months later, and it is the thing a compacted session recovers from.

Put an obligation in exactly one of them and link to it from the other. Copying
it into both is how the two copies drift and the wrong one gets believed.

## What does not go here

- Permanent design docs → `docs/NN_*.md`
- Architecture decisions → `docs/decisions/NNNN-*.md`
- Append-only history → `docs/SESSION_LOG.md`
- Where things stand right now → `docs/STATE.md`
- Plans executed by the SDD skill → `docs/superpowers/plans/`
- Scratch working files for an in-flight SDD run → `.superpowers/sdd/<plan>/`
  (git-ignored; not durable, and not a substitute for a ledger)
