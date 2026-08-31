# 0036 — Automod records what actually happened, and only counts what it enforced

Status: accepted
Date: 2026-08-31
Amends ADR 0035 (automod rule engine foundation) and the schema and subscriber
it specifies. Constrained by `CLAUDE.md` rule 2 (guild scope, cache keys
included), rule 6 (durable idempotency), and `docs/18_SAFETY_AND_BLAST_RADIUS.md`.

## Context

A whole-branch review of the Release 2 automod rule engine — after all twelve
tasks were individually implemented and reviewed — found defects that only
became visible once the pieces sat together. Three of them are decisions
rather than bug fixes, and are recorded here.

## Decision 1 — the message deletion goes through the safety layers

`ModerationActionGateway` owns the kill switch, the circuit breaker and dry
run, but only the *escalation* goes through that gateway. The enforce-mode
message deletion is a direct `DiscordPort.deleteMessage` call, so it had no
safety layer in front of it at all. Since an unconfigured guild defaults to
dry run (docs/18 Layer 4), a guild "performing no writes at all" would have
had real members' messages really deleted.

The subscriber therefore reads the guild's safety state itself, through the
**same** `guildRepo.readSafetyState(scope)` call the gateway's `state.read()`
uses — one function referenced twice, not two reads of two different things,
so the deletion and the escalation can never disagree about a guild-level
setting. When the guild is stopped, breaker-open, dry-run or unknown, the
whole enforcement path is skipped: no delete, and no escalation either, since
the kill switch stops *every* side effect.

The gateway keeps its own independent check. That is deliberate defence in
depth, not redundancy: the gateway is the chokepoint for member actions and
must not depend on a caller having checked first.

## Decision 2 — one `action_taken` value per real outcome

`mod_case_events.action_taken` had three values —
`deleted`/`deleted_and_escalated`/`escalation_refused` — for five
`ModerationOutcome` variants plus two states in which nothing was deleted at
all. The subscriber therefore recorded `deleted_and_escalated` for a
`dry-run`, `skipped` or `failed` escalation (a punishment that never
happened), and reused `deleted` for a `test`/`observe` match (a deletion that
never happened). Both are lies in the table ADR 0035 exists to make truthful.

The vocabulary is now twelve values, enforced by a widened CHECK constraint
(migration `0006`, STRICT):

| value | what really happened |
| --- | --- |
| `deleted` | deleted; no escalation tier crossed |
| `deleted_and_escalated` | deleted; escalation `applied` |
| `escalation_refused` | deleted; escalation `refused` (reason recorded) |
| `escalation_failed` | deleted; escalation attempted, Discord errored |
| `escalation_dry_run` | deleted; escalation not executed, gateway dry run |
| `escalation_skipped` | deleted; escalation was an idempotency no-op |
| `would_delete` | not deleted: the rule is in `test`/`observe` mode |
| `delete_failed` | not deleted: Discord refused the deletion |
| `delete_blocked_killswitch` | not deleted: kill switch |
| `delete_blocked_breaker` | not deleted: circuit breaker open |
| `delete_blocked_dry_run` | not deleted: guild in dry run |
| `delete_blocked_guild_unknown` | not deleted: guild not in the database |

Two judgement calls inside that table:

- **`escalation_skipped` is its own value, not folded into "applied".**
  `skipped` means the gateway's idempotency claim found the identical action
  already recorded, so *this* event applied nothing. A moderator counting
  timeouts out of case history would otherwise count the same timeout twice,
  and a replayed gateway event — which CLAUDE.md rule 6 tells us to assume —
  is exactly how that arises.
- **The blocked reason lives in `action_taken`, not in `refusal_reason`.**
  `refusal_reason` is documented as "why the *escalation* was refused" and its
  vocabulary is `ModerationRefusalReason`, which has no `dry-run` member.
  Four distinct `delete_blocked_*` values keep one column telling the whole
  story and leave `refusal_reason`'s meaning intact.

## Decision 3 — the violation counter only counts enforced violations

`openOrResolveCase` incremented the per-member violation counter for every
mode. The documented rollout (design spec §8) is "ship in test mode, review
and tune, then flip to enforce" — so ordinary members' counts climbed through
the entire observation period, and the first real match after the flip could
read a high count and go straight to a kick.

`openOrResolveCase` now takes `countsAsViolation`. A non-counting call still
resolves — or opens, at zero — the member's case, so the observation stays
durably visible in case history, but leaves `violation_count` alone. The
subscriber counts only a match it actually enforced against.

A match blocked by a safety layer is also non-counting, on the same
reasoning: lifting the kill switch or turning dry run off must not release a
backlog of accrued violations that then escalates on the next message.

## Consequences

- `mod_case_events` rows written before migration `0006` keep their meaning;
  the three original values are all still in the vocabulary. Nothing is
  rewritten.
- A `test`-mode rule now leaves `mod_cases.violation_count` at zero. "How many
  times has this member tripped a rule" is answered by counting case *events*,
  not by reading the counter, which answers the narrower "how far up the
  escalation ladder is this member".
- A future per-category action (ADR 0035 leaves `word_categories.default_action`
  for it) will add values here rather than reinterpret existing ones.
