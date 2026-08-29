# ADR 0021: Reconciliation excludes a blocked adoption backlog, not every pending panel

Status: accepted (2026-08-29)

## Context

`docs/reports/WP5-slice-6-live-test.md` finding 3, reproduced live: a panel is
seeded with one pre-existing reaction and adoption queued
(`seed-test-panel.mjs --adopt`). On the daemon's own restart, two jobs run
back to back on the same gateway-gap reconnect:

1. `adopt_panel` computes the change list (one grant) and correctly refuses —
   no standing allowance covers it (`docs/19` §6.4, collision 2). Nothing
   applied. `panels.adoption_pass_state` stays `'pending'`.
2. Two seconds later, `reconcile_guild` — the same reconnect — visits the same
   panel, computes the identical missing grant as ordinary drift, checks it
   against `checkReconcileBudget` (a plain count ceiling, default 25, wholly
   unrelated to the adoption allowance), and **applies it**.

`docs/18`'s whole point is that no surface reachable without a human decision
performs a bulk role change. `runAdoptionPass`'s allowance gate is that
decision point for a panel's pre-existing backlog; `reconcileGuild` bypassed
it by computing the same missing grant through a different code path and
checking it against a gate that was never meant to authorise adoption-sourced
changes.

### The naive fix does not work

The report's own suggested direction was "exclude panels whose
`adoptionPassState` is `'pending'` from `reconcileGuild`'s selection." This is
wrong, and would have been a bigger regression than the bug it fixes.

`panels.adoption_pass_state` defaults to `'pending'` for **every** adopted
panel at creation (`packages/storage/src/repos/panels.ts` `createPanel`,
`docs/19_RELEASE_0_1_PLAN.md`'s schema) — not only for one that has been
through an adoption pass and found blocked. `docs/21_TESTING_THE_BOT.md`'s
exercises 1-4, including the outage-repair flagship demonstrable this session
verified live and passing (`docs/reports/WP5-slice-6-live-test.md` §1), all
seed a panel **without** `--adopt`. Nothing ever moves those panels'
`adoption_pass_state` off the passive default — `runAdoptionPass` is never
invoked for them. If `reconcileGuild` excluded every `'pending'` panel, it
would stop doing the one thing slice 11 exists for: repairing drift, and the
30-minute-outage exercise, on any panel that was never explicitly run through
adoption. That is the common case, not the rare one — an adopted panel used
the ordinary way (react while the bot is live, or after a reconnect) never
touches `runAdoptionPass` at all.

So `adoption_pass_state = 'pending'` is genuinely overloaded: it means both
"never examined" (harmless, reconciliation must proceed) and "examined, found
a backlog, explicitly awaiting an owner's allowance" (the thing that must be
protected). The state alone cannot distinguish them, and guessing which one a
given `'pending'` row means — by assumption, rather than by evidence — is
exactly what this ADR exists to avoid doing.

## Decision

Add `panels.adoption_blocked_count` (`INTEGER NOT NULL DEFAULT 0`, `CHECK
(adoption_blocked_count >= 0)`): the size of the change list the most recent
`runAdoptionPass` computed and could not apply because the standing allowance
did not cover it. Set to `0` at panel creation (every panel starts owing
nothing to a decision that has not happened yet) and cleared back to `0`
whenever a pass completes — `'done'`, applied or found nothing to do.

`runAdoptionPass` sets it alongside `adoption_pass_state` at every
transition, atomically, through one port call
(`setAdoptionPassState(panelId, state, blockedCount)` — the count is now a
required parameter, not optional, so a caller cannot update one without the
other and leave them inconsistent):

| Transition | `adoption_pass_state` | `adoption_blocked_count` |
|---|---|---|
| Pass starts | `'running'` | `0` (moot — see below) |
| Nothing to converge | `'done'` | `0` |
| Blocked on the allowance | `'pending'` | `changes.length` (> 0) |
| Applied in full | `'done'` | `0` |

`reconcileGuild`'s panel selection
(`packages/core/src/panels/reconcile.ts`, was line 97) becomes:

```ts
const panels = ports.store
  .listAdoptedPanels()
  .filter((p) => p.status === 'enabled' && p.adoptionPassState !== 'running' && p.adoptionBlockedCount === 0);
```

`'running'` is excluded too, defensively: an adoption pass owns that panel's
convergence while it is actually in flight. The single-writer job queue and
per-guild dispatch ordering (ADR 0020) make a literal overlap with
`reconcileGuild` for the same guild effectively impossible today, since jobs
for one guild are drained one at a time — but excluding it costs nothing and
does not depend on that staying true if a future scheduler (slice 11's
periodic timer) changes how these two passes are invoked relative to each
other.

A panel that has never been through `runAdoptionPass` keeps
`adoption_blocked_count = 0` forever and is untouched by this change:
`reconcileGuild` continues to select it exactly as before. Only a panel with
a live, unresolved, explicitly-computed backlog is excluded — precisely the
case the report reproduced.

### Rejected: reuse the existing `'refused'` state for this

`ADOPTION_PASS_STATES` already includes a fourth value, `'refused'`, defined
in the schema and the type but set by no code path found in a repo-wide grep.
Repurposing it to mean "blocked awaiting an allowance" was considered — it
would need no migration. Rejected: `'refused'` reads as an owner's explicit,
durable decline of a proposed batch (the future `docs/19` slice 13 CLI
action), which is a different fact than "the pass ran, was not covered, and
is waiting to be asked again." Conflating them would make a future explicit
refusal indistinguishable from an ordinary today's-allowance-was-empty
outcome, and `docs/20`'s "a missing actor degrades to 'unknown', never to a
guess presented as fact" is the same discipline applied to state, not just to
attribution: guessing what an unused enum value was reserved for is exactly
the kind of assumption this ADR is written to avoid making twice in one fix.

### Rejected: change the default `adoption_pass_state` to `'done'`

Would make the passive default indistinguishable from "an adoption pass ran
and found nothing," which is a claim nobody has actually verified for a
freshly-created panel. `packages/storage/src/repos/panels.test.ts` already
asserts the current default, and `docs/19`'s schema states it explicitly —
changing it is unrelated surface a safety fix should not disturb.

### Rejected: give `reconcileGuild` access to the job table instead

The alternative to a panel-level field is asking whether a panel has a
currently-blocked `adopt_panel` job, by reading `jobs` directly. Rejected: a
job that hits the allowance gate completes *successfully* (the worker records
`status: 'completed'`, not `'failed'` — refusing is the correct, finished
outcome, not an error) so there is no job-table state that means "blocked."
Recovering that would mean parsing the job's cursor JSON from
`reconcileGuild`, coupling the panel and job repositories in a new direction
for one boolean. A panel-scoped column is the fact reconciliation actually
needs, stored where the rest of a panel's adoption state already lives.

## Consequences

**Reconciliation still covers adopted panels only** (`docs/STATE.md`,
2026-08-23) — this changes which adopted panels it covers on a given pass,
not that scope.

**A panel stuck at a nonzero `adoption_blocked_count` stays unrepaired by the
timer or gap-driven pass until an owner grants an allowance and the pass
reruns to completion (slice 13) — by design.** That is the point: an
unresolved bulk-grant decision is not drift, it is a decision not yet made,
and reconciliation must leave it alone rather than deciding it by default.

**A migration.** `npm run db:generate` after this schema change, applied via
`npm run db:migrate` as usual.

## Related

`docs/decisions/0018-rest-port-refuses-rather-than-waits.md` — the sibling
principle for REST: a refusal the caller can see and act on beats an action
taken silently on its behalf. This ADR is the same principle applied to two
in-process functions reading the same store instead of to a REST call.
