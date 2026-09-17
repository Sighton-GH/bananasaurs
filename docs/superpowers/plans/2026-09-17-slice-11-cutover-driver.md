# Slice 11 — driving the cutover, one rule at a time

**Status: DRAFT.** Written 2026-09-17. **Branch:** `oc/slice-11-cutover`.
**ADR:** none new — ADR 0042 (the state machine, the gate, PR-27's arrows)
already decides everything this slice drives.

**Owner decision, 2026-09-17: build on the branch now; do not merge until
the club's observe floor has elapsed (2026-09-27T02:49:57.656Z).** Nothing
reaches the live daemon before then — build-is-a-deploy applies to `main`
only — and the cutover itself remains the owner's command on the owner's
day. The standing constraint on the live system is honoured absolutely; this
slice is the first permitted to give `setRuleMode` a production caller, "and
only under owner decision".

## What already exists, and what does not

`packages/storage/src/repos/automod-rules.ts` `setRuleMode` owns four of
PR-27's five arrows and is gated: `mode: 'enforce'` is refused by
`enforcementEligibility` unless `cutover_state` is `ready` (or already
`cutover`) and the false-positive gate passes, and a refusal writes nothing.
`automod ready` drives the fifth arrow (`observing → ready`). `automod
signoff` records the low-volume sign-off. `doctor` reports rules past their
floor and rules enforcing from a bad state.

**What does not exist is any production caller of `setRuleMode`.** Nothing
can move a rule to `enforce`, to `rolled_back`, or back to `observing`. The
2026-09-12 `not_started → observing` transition was a hand-run UPDATE. That
is the whole gap, and it is why "flip day needs Slice 11 before it can
finish" (`docs/STATE.md`).

## The design question, settled by reading

The roadmap says: *"Disable the legacy rule, then enable the Bananasaurs
one. Never both."* `legacy_rule_ref` is "nullable text naming which
Carl-bot, Dyno or native rule this replaces" (ADR 0042 §1). Those are rules
in **other bots**, and Bananasaurs has no API to disable them — the
`DiscordPort` has no automod-rule method, and Slice 0 was observability
only. So disabling the legacy rule is the owner's act in the other bot's
dashboard, and Bananasaurs' part is to **refuse to enforce until the owner
attests to it, and to record the attestation.** No Discord write. No
effect-gateway path. Hard rules 1 and 6 are not engaged.

## Rulings

**S11-D1 — three named commands, not one generic `automod mode`.** Each
PR-27 arrow the owner drives has its own preconditions and its own
consequences, and a generic mode-setter would make the operator supply both
from memory:

| Command | Arrow | Precondition | After |
|---|---|---|---|
| `automod cutover <ruleId> --legacy-disabled --confirm` | `ready → cutover`, `mode = 'enforce'` | `enforcementEligibility` ok; `legacy_rule_ref` set; the flag present | the rule enforces; the legacy rule is recorded as disabled by the owner |
| `automod rollback <ruleId> --confirm` | `cutover → rolled_back`, `mode = 'observe'` | `cutover_state = 'cutover'` | the rule observes; the owner is told to re-enable the legacy rule now |
| `automod observe <ruleId> --confirm` | `not_started → observing` or `rolled_back → observing` | one of those two states | the clock starts (or restarts — and the command says which) |

`automod ready` and `automod signoff` are unchanged. Together the five
commands are the five arrows.

**S11-D2 — the attestation is a required flag and an audit row, not a
column.** `--legacy-disabled` is required on `automod cutover`; without it
the command refuses before touching anything, and the refusal says what the
flag attests. The audit row (`automod.rule.cutover`) records
`legacy_rule_ref` and that the owner attested it disabled. A column
(`legacy_disabled_at`) would make the attestation queryable, and it is
rejected for this slice: drizzle-kit rebuilds `mod_rules` for any added
column (ADR 0042 Amendment 1), which is a migration on the moderation table
during an observe window — the one thing this whole run avoids — for an
invariant the database cannot actually enforce, because the legacy rule's
real state lives in another bot. The audit trail is the record. Release 3
may add the column once the window is closed.

**S11-D3 — `cutover` requires exactly one of two attestations, and they
must agree with the row.** Corrected after review (I-2, M-4). The two flags
are the owner stating one of two facts:

- `--legacy-disabled` — "this rule replaces `legacy_rule_ref`, and I have
  disabled that rule in the other bot." Requires `legacy_rule_ref` to be
  non-null; refused otherwise, pointing at `automod legacy-ref`.
- `--no-legacy` — "this rule replaces nothing; there is nothing to
  disable." Requires `legacy_rule_ref` to be **null**; refused otherwise,
  because a recorded ref with `--no-legacy` is the owner contradicting the
  row, and the first draft let it through and wrote an audit row saying
  both things at once.

Exactly one flag; both or neither is refused before any port call. The first
draft required `--legacy-disabled` alongside `--no-legacy`, which is attesting
to disabling a rule that does not exist — that was wrong. Either flag is
the attestation, and the audit row records which.

**S11-D4 — every refusal from `enforcementEligibility` renders in the
operator's words.** The gate returns four structured refusals
(`cutover-state`, `false-positive`, `rate-too-high`,
`low-volume-unsigned`); the command turns each into one sentence naming the
number and the command that would change it (`automod ready`, `automod
review`, `automod signoff`). An operator refused on flip day must be told
what to do next, not what state enum they hit.

**S11-D5 — `rollback` tells the owner what to do by hand, and `observe` says
whether the clock reset.** After `rollback`, the Bananasaurs rule observes
and the legacy rule is still disabled in the other bot — the guild is
unprotected until the owner re-enables it. The command's output says that in
its first line. After `observe` from `rolled_back`, `observe_started_at` is
reset (PR-27: "a rule pulled back from enforcement has to earn a fresh
window"); the output says the floor now elapses on a new date, and prints
it.

**S11-D6 — the dashboard cannot move a rule to `enforce`; that is the CLI's
alone, because the CLI is where the attestation lives.** Corrected after
review (I-1): the first draft said "the dashboard's cutover board stays
read-only", which described a state that did not exist. Slice 8 already
wired `POST /api/automod/rules/:ruleId/mode` to `setRuleMode` with `'enforce'`
in its schema, and the rule page offers an `enforce` radio whenever the gate
would pass. So `setRuleMode` has had a production caller since Slice 8 —
`docs/STATE.md`'s "no production caller" was written before it merged — and
that path reaches `enforce` with **no attestation and no legacy-ref check**.
The database gate holds on it, so this is not a hole in ADR 0042; it is a
hole in S11-D2, which only means anything if there is one path.

So: the route refuses `mode: 'enforce'` with `409 { error: 'use-cli' }` and
a message naming `automod cutover`; the dialog disables the radio and says
why; the other modes are unchanged, because pausing or observing from the
dashboard is not the transition that ends an observe window. This is a
restriction on the held branch, not a widening, and it lands with the rest
of the slice after the floor. ADR 0042 §3 predicted exactly this shape —
"placing the check at the write path means every future caller inherits
it" — and it was right about the gate and silent about the attestation,
because the attestation did not exist yet.

**S11-D7 — one rule per command, one transaction per rule.** "One rule at a
time, atomic" (roadmap). Every command takes exactly one `ruleId`;
`setRuleMode` is one `write(scope, …)`; there is no `--all`.

## Global constraints (copy verbatim into every brief)

1. **This branch is not merged until the owner says so, after
   2026-09-27T02:49:57.656Z.** Nothing in it may be built on `main`.
2. **Do not touch `packages/core/src/mod/`, `packages/core/src/automod/`,
   `packages/core/src/effects/gateway.ts`, `packages/storage/src/schema.ts`,
   or `drizzle/`.** `setRuleMode` itself is **not edited** — this slice
   calls it; it does not change it. If a transition seems to need a change
   inside `setRuleMode`, stop and report.
3. **No migration** (S11-D2).
4. **Guild scope is a mandatory partition key.** Every command resolves a
   guild before it runs; every `setRuleMode` call carries the `GuildScope`.
5. **Every write is `--confirm`-gated and writes an audit row.**
6. **Break every guard and watch it fail.**
7. Gates: `npm run typecheck && npm run lint && npm run test` pass by exit
   code, in the worktree.

## The one task

`OpsPorts` gains `setAutomodRuleMode(ruleId, input)` wrapping `setRuleMode`
(and, if `legacy_rule_ref` has no write path, a `setAutomodRuleLegacyRef`).
The three commands, registered beside `automod ready`. Tests for every arrow
in both directions, every eligibility refusal rendered, the attestation flag
required, `rollback`'s hand-act line, `observe`'s clock-reset line with the
computed date, and the audit rows. `docs/17` gains the three commands with
the flip-day sequence written out; `docs/STATE.md` gains the branch and its
hold date.
