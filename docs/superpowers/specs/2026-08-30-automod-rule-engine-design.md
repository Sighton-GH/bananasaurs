# Automod rule engine foundation + fuzzy keyword filter — design

Status: approved by Bryan, 2026-08-30, ready for an implementation plan.
Decision record: `docs/decisions/0035-automod-rule-engine-foundation-and-fuzzy-keyword-filter.md`.
Roadmap scope: `docs/08_ROADMAP.md` Release 2.

## 1. Problem and scope

Native Discord AutoMod cannot enforce against `Administrator`/`Manage
Server`-holding members (unconditional platform exemption) and its
keyword/regex expressiveness (100 keywords, 10 regexes at 260 chars, no
lookaround/backreferences) can't express evasion-resistant matching at real
word-list scale. Both confirmed against current Discord documentation and
independent sources before this spec was written, not assumed. See ADR 0035
§Context for citations.

This slice builds:

1. The rule engine's core data model and action/escalation pipeline —
   guild-scoped rules, exemptions, cases, case events.
2. One predicate type against it: fuzzy keyword filtering, backed by
   `obscenity` (MIT).

Explicitly **not** in this slice: regex/invite/link/spam-rate/caps/etc.
predicate kinds (roadmap-named, later slices), username/nickname filtering
(message content only), alerting on non-owner Administrator abuse
(`STATE.md` item 4, a separate decision), and the dashboard/CLI surface for
configuring rules (a thin read/write layer over the same tables the CLI
already uses for panels — deferred to keep this slice about the engine, not
its UI, matching Release 1's own thinnest-slice-first pattern).

## 2. Data model

All tables carry `guild_id` per `CLAUDE.md` rule 2; every repository
function takes a `GuildScope`, per the existing `packages/storage` pattern
(`scope.only(table, ...)`).

```
mod_rules
  guild_id, rule_id (pk), kind ('keyword_filter'), name,
  mode ('test' | 'observe' | 'enforce'), enabled, created_at, updated_at

mod_rule_exemptions
  guild_id, rule_id (fk), exempt_type ('role' | 'channel'), exempt_id

word_categories
  guild_id, category_id (pk), rule_id (fk), name,
  default_action ('log_only' | 'delete' | 'delete_and_case'), enabled

word_terms
  guild_id, term_id (pk), category_id (fk), text,
  action_override (nullable, same enum as default_action), enabled

word_allowlist
  guild_id, rule_id (fk), phrase

mod_cases
  guild_id, case_id (pk), member_id, opened_at, violation_count,
  escalation_tier, status ('open' | 'closed')

mod_case_events
  guild_id, event_id (pk), case_id (fk), rule_id (fk), member_id,
  at, matched_category, matched_snippet (full content, see §5),
  action_taken (one value per real outcome — widened by ADR 0036 from the
  three values planned here to twelve, because three could not tell a
  dry-run, skipped or failed escalation apart from an applied one, nor a
  test-mode observation apart from a real deletion),
  escalation_action (nullable: 'timeout' | 'kick'),
  refusal_reason (nullable, same `RefusalReason` shape the effect gateway
  already uses where applicable, plus a moderation-specific reason for
  Discord's own owner/hierarchy refusal)
```

`escalation_ladder` (tier → action, duration) is per-guild config, not a
table with one row per guild per tier — a small JSON column on `mod_rules`
(or a guild-level settings row, matching how `role_rate_per_min` etc. already
live on `guilds`) is enough; exact shape decided during implementation
against existing config-storage conventions (`packages/core/src/config/`).

## 3. Matching engine

`obscenity`'s `RegExpMatcher`, built once per guild and cached, rebuilt
when `word_terms`/`word_allowlist` changes for that guild (invalidate on
write, rebuild lazily on next message — same pattern as any other
guild-scoped in-memory cache in this codebase, none currently exists so this
introduces the first one; keep it a plain `Map<GuildId, Matcher>` in the
subscriber's own module state, not a new abstraction).

Preprocessing before text reaches the matcher: strip zero-width/invisible
Unicode characters (`​`, `‌`, `‍`, `﻿`, and the Unicode
category `Cf` format characters generally) — `obscenity`'s transformers
handle leetspeak, homoglyphs, and spacing/stretching per its own
documentation; this is the one gap Bananasaurs' own code closes.

Word list seeds from `obscenity`'s bundled `englishDataset` on first
migration for a guild's `word_categories`/`word_terms` (one category per
`obscenity` dataset grouping, `default_action = 'delete_and_case'`), then is
fully editable — adding, removing, or re-categorizing a seeded word is no
different from adding a new one.

## 4. Data flow

```
MESSAGE_CREATE / MESSAGE_UPDATE
  -> subscriber (guild-scoped, same dedup/idempotency machinery as every
     other side effect: unique index on (guild_id, discord_event_id))
  -> for each enabled mod_rules row of kind 'keyword_filter' in this guild:
       - exemption check (author's roles / channel) -> skip if exempt
       - matcher.getAllMatches(normalized content)
       - no match -> done
       - match -> resolve action (category default, term override)
  -> rule mode is 'test': record what would have happened, no Discord call
  -> rule mode is 'observe': record 'would_delete' + log, no Discord call,
     and no increment of violation_count (ADR 0036)
  -> rule mode is 'enforce':
       - check the guild's safety state FIRST (kill switch, breaker, dry
         run) — the deletion is a Discord side effect like any other, and
         an unconfigured guild is in dry run. Blocked -> record
         'delete_blocked_*' and stop; no delete, no escalation. (ADR 0036)
       - delete the message (Manage Messages, not hierarchy-gated —
         succeeds regardless of the author's role). Already gone (10008)
         counts as success, per §6; any other failure records
         'delete_failed' and does not escalate.
       - open/resolve mod_cases row, increment violation_count — only in
         enforce mode, and only when the deletion was not blocked (ADR 0036)
       - resolve escalation tier from violation_count
       - if tier has a member action: attempt it through the existing
         effect-gateway-style pipeline (authorization, live hierarchy
         check, idempotency, dry-run, audit row)
       - refused (owner / hierarchy) -> mod_case_events records
         'escalation_refused' with reason, NOT log-only (this is the
         change from Release 1's role-effect refusal behavior — ADR 0035
         §"A moderation-action refusal is durably recorded")
       - applied -> mod_case_events records 'deleted_and_escalated'; a
         dry-run, skipped or failed outcome gets its own value rather than
         being recorded as an applied punishment (ADR 0036)
```

## 5. Message content in case events

`mod_case_events.matched_snippet` stores the triggering message content (or
a bounded excerpt around the match), the same way `message_delete` log
routing already includes content by default (`docs/SMOKE_TESTS.md` §B,
confirmed live 2026-08-30) — a moderator reviewing a case needs to see what
was actually said, the same as any existing mod-log. This is guild-internal
moderation data, not sent to any AI provider (rule 5 doesn't apply — no
provider is involved) and subject to the same retention/redaction posture
as other logged content once Release 3's retention tiers exist; Release 2
does not need to solve retention for this table specifically, since none of
Release 1's logged content solves it either yet.

## 6. Error handling

- `obscenity` throwing on malformed input: caught at the subscriber
  boundary, logged, message left unmatched for that rule (fail open on the
  matcher, not fail open on safety — a matcher bug should not become "no
  messages are ever filtered," so this is logged at `error` and worth a
  `doctor` line if it happens repeatedly, not silently swallowed).
- Message already deleted by the time Bananasaurs tries (race with a human
  moderator or another bot): treat as success, not a failure — the outcome
  (message gone) is what the rule wanted.
- `doctor` gains: for each enabled `keyword_filter` rule, confirm the bot
  holds `Manage Messages` in the rule's non-exempt channels; report and
  disable-with-reason the way a panel with a deleted message already is,
  rather than silently doing nothing (`docs/SESSION_LOG.md`'s "a panel that
  can no longer work says so" precedent, WP3).

## 7. Testing plan (TDD, per `CLAUDE.md`)

Write tests first, in this order:

1. **Matcher/normalization unit tests** — pure functions, no Discord: each
   evasion class (leetspeak, homoglyph, spacing, zero-width) against known
   fixtures, allowlist suppression, category/term action resolution
   (override beats default).
2. **`FakeDiscord` subscriber integration tests** — extend the harness the
   same way role panels did in WP1/WP3: a message matching a rule gets
   deleted; a message from an exempt role/channel does not; test/observe
   modes make no Discord call; an escalation attempt against a fake "owner"
   member is refused and the refusal is recorded in `mod_case_events`
   (this is the test that would have caught tonight's finding about
   refusals being log-only, had it existed for role effects).
3. **`doctor` check tests** — rule enabled without `Manage Messages`
   reports and disables, matching the existing panel-precondition tests'
   shape.

No live Discord in CI, per `npm run test`'s existing contract.

## 8. Rollout

New rules default to `mode: 'test'` on creation — nothing is deleted or
escalated until an operator explicitly moves a rule to `observe` then
`enforce`, mirroring the roadmap's own "per-rule test/observe/enforce, no
overlapping enforcement" design for the rest of Release 2. The seeded
word list from `obscenity`'s dataset ships as `test` mode rules by default,
not `enforce` — Bryan reviews and tunes categories before anything actually
deletes a real message, even though the underlying data was pre-populated.
