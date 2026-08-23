# WP3 plan — role panels (slices 7–11)

Status: **DRAFT**, written at the start of WP3 and kept current as slices land.
Superseded at the WP3 boundary by `docs/reports/WP3.md`.

Read with `docs/19_RELEASE_0_1_PLAN.md` §6.3–6.6 and `docs/20_AUTONOMOUS_EXECUTION.md`.

---

## 0. One prerequisite, found by measuring before planning

`jobs_dedupe` is `UNIQUE (guild_id, dedupe_key)` over **every** state, and job
rows are never deleted. So a dedupe key is single-use for the life of the
database. Measured:

```
first enqueue                  : {"enqueued":true,"jobId":1}
job state after completion     : done
second enqueue after completion: {"enqueued":false}
```

Slice 11 lands on this directly: `createConnectionSubscriber` enqueues with
`reconcileDedupeKey('gateway-gap')`, so the **second** gateway gap ever
silently enqueues nothing and the drift it caused is never repaired. The
periodic timer pass has the same problem, and so would the adoption pass.

Fixed first, as slice 7a, with ADR 0016: the dedupe key collapses *pending*
work, not history — a partial unique index over `state IN ('queued','running')`.

---

## 1. Where the code goes

| Layer | Path | Holds |
|---|---|---|
| Domain | `packages/core/src/panels/` | panel model + Zod, convergence, subscribers over ports |
| Storage | `packages/storage/src/repos/panels.ts` | guild-scoped panel repository |
| Composition | `apps/daemon/src/panels/`, `apps/daemon/src/jobs/` | wiring, job handlers, integration tests |

`core` may not import `@bananasaurs/storage` (ADR 0014), so every panel
subscriber takes a `PanelStore` port and an apply function, and the daemon binds
them to a `GuildScope`.

## 2. Convergence, once

One pure function serves live events, the adoption pass and reconciliation, so
drift repair is not separate code with separate bugs (docs/19 §4).

```
planConvergence({ panel, selectedOptionIds, currentRoleIds }) -> {
  desiredRoleIds, grants, revokes, refusals
}
```

- **`currentRoleIds` is the member's LIVE Discord roles** (amendment 4), never
  `managed_role_assignments`. That table is provenance.
- `revokes` is restricted to roles this panel offers. A panel never touches a
  role outside its own options.
- Gate order: panel status → required role → blocked roles → behaviour →
  `max_roles` clamp → diff.

**`max_roles` clamp rule.** When the selection exceeds the ceiling: roles the
member already holds *and* still selects win first, then the remaining
selections in `position` order. Stable across passes (a second pass over the
same state computes the same set) and it avoids revoking something the member
already had in order to honour a newer reaction.

**Idempotency without a reaction fingerprint.** Reactions are level-triggered
and carry no fingerprint, so a replayed reaction produces a *new* convergence
pass id and therefore a new `dedupe_key`. That is safe because the gateway's
no-op check against live roles runs **before** the rate cap and before the
idempotency claim (`gateway.ts` layers 7→8→9): a replay costs no budget and
writes no row. Interactions use the interaction id as `trigger_ref`, so a replay
collides on the unique index instead.

**Amendment 6 — when reaction state is fetched.**

| Case | Fetch |
|---|---|
| `toggle` / `add_only` / `remove_only`, no `max_roles` | none; decidable from the single emoji the event carried |
| any behaviour **with** `max_roles` | all mapped emoji, memoised per pass |
| `single_choice` | never — managed-only by CHECK, the interaction carries the choice |

## 3. Slices

| # | Slice | Lands |
|---|---|---|
| 7a | Job dedupe collapses pending work (ADR 0016) | partial unique index + migration + tests |
| 7 | Adopted panels | panel repo, panel model + Zod, `planConvergence`, emoji seeding, reaction subscriber, end-to-end react→role |
| 8 | Adoption pass | `adopt_panel` job, paged `fetchReactionUsers`, full change list, refuses without an allowance |
| 9 | Managed panels | port additions for interactions, components, `customId` parsing, ephemeral confirm, edit |
| 10 | Behaviours | toggle / add_only / remove_only / single_choice, `max_roles`, required + blocked, each refusal path |
| 11 | Reconciliation | `reconcile_guild` handler, budget refusal, deleted message, deleted role, `memberUpdate` self-mutation filter |

## 4. Authorization for a panel-driven change

A member who reacts holds no `roles.mutate` grant and must not need one. The
actor is `system`: the change is authorized by the panel existing, being
enabled, and offering that role — configuration an owner with `panels.manage`
created — not by the member's own capability. The member is the **subject** of
the audit row, so nothing about who acted is lost.

Everything the gateway enforces still applies: allowlist, protected target,
live hierarchy, rate cap, idempotency, dry run.

## 5. Not in WP3, deliberately

- The real Discord adapter (slice 6, WP5). Everything here runs on the fake.
- A Discord-side adoption confirmation. The pass refuses without an allowance
  and that is the finished behaviour; the CLI that grants it is slice 13 (WP5).
- Daemon runtime wiring — timer loop, worker scheduling (WP5).
