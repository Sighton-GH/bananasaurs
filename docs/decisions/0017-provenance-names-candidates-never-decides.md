# 0017 — Provenance names the candidates; it never decides the change

Status: accepted · 2026-08-23 · supersedes nothing · refines Release 0.1 amendment 4

## Context

Amendment 4 says convergence diffs against **live Discord roles**, never against
`managed_role_assignments`. The reason is concrete: that table records which
panel granted which role under which effect, and it keeps saying so after a
moderator removes the role by hand. Diff against it and the bot computes an
empty change set for exactly the member whose state has drifted — the drift is
never repaired, and the table's confidence is the thing that hides it.

Reconciliation then hit the mirror-image problem. A pass driven by the reaction
sets can only visit members who are reacting **now**. A member who withdrew
their reaction while the bot was offline is in no reaction set at all, so the
pass never looks at them and the role they no longer want stays for good. That
is half the slice-11 demonstrable — "a 30-minute outage with offline reactions
leaves the state correct on return" — and it failed on the first run.

There is no other record of that member. Discord does not report a reaction that
was removed while we were disconnected, and after a fresh IDENTIFY the dispatch
is gone permanently.

## Decision

`managed_role_assignments` supplies **the list of members worth looking at**. It
supplies nothing else.

`reconcileGuild` builds its candidate set as the union of

- everyone currently in one of the panel's reaction sets, and
- everyone the panel is recorded as having granted a role to
  (`effectRepo.listAssignedUsers`).

Having chosen a member, **both sides of the comparison are read live**: the
member's Discord roles from `fetchMember`, and the message's reactions from
`fetchReactionUsers`. The provenance row contributes a user id and is then
discarded.

## Why this is not the thing amendment 4 forbids

The failure amendment 4 names is *believing the table about the present*. The
symptom is a change that should have happened and did not, because the table
said the world already matched.

Naming a candidate cannot produce that failure. A stale row causes one extra
member to be examined; the diff then reads live state and finds nothing to do,
which the gateway's no-op check absorbs before the rate cap and before the
idempotency claim, so it costs no budget and writes no row. A missing row causes
a member to be skipped this pass — the same outcome as before this change, and
the timer pass sees them again as soon as they touch the panel.

In short: the table can make the pass look at the wrong person. It cannot make
the pass do the wrong thing.

`packages/core/src/panels/reconcile.ts` carries this reasoning at the point of
use, and `reconcile.integration.test.ts` pins both halves — that a withdrawn
reaction is repaired, and that a role removed by hand while the reaction stands
is re-granted rather than believed away.

## Consequences

- Rows must be deleted when the role is revoked, or the candidate list grows
  with the panel's history rather than its membership. `forgetGranted` already
  does this; `listAssignedUsers` has a test asserting it.
- The candidate list is per panel, so an adopted panel's pass does not walk an
  unrelated panel's members.
- Managed panels are unaffected: they are not reconciled at all, for the reason
  in `docs/reports/WP3.md` §4 — there is no independent record of member intent
  to converge towards.
- A member who left the guild is skipped rather than failing the pass; their
  provenance row is cleaned up by the member-remove path, not here.

## Alternatives rejected

**Walk every guild member.** Correct and unaffordable: it is a member fetch per
member per pass on a schedule, for a table that already knows the answer.

**Store a per-panel snapshot of the last known reaction set.** A second belief
about the world, with its own staleness and its own way of being wrong — and it
would have to be diffed against, which is the failure mode amendment 4 exists to
prevent. The provenance table is already exactly the set we need.

**Accept the gap and rely on members re-clicking.** Silent, and wrong in the
direction that matters: a role nobody asked for that nobody can remove is worse
than a role that takes a pass to arrive.
