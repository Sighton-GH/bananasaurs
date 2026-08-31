# 0035 — Automod rule engine foundation, with fuzzy keyword filtering as its first predicate

Status: accepted
Date: 2026-08-30
Depends on `docs/08_ROADMAP.md`'s Release 2 scope, ADR 0012 (Administrator
grants nothing), ADR 0013 (no AI in the enforcement path — CLAUDE.md rule 1).
Constrained by `CLAUDE.md` rule 2 (guild scope), rule 6 (durable idempotency
keys), rule 7 (licensing — permissive sources only).

## Context

Native Discord AutoMod was checked first, per the roadmap's own instruction,
rather than assumed insufficient. Two confirmed, platform-level facts settle
that it cannot be the whole answer:

1. **Members with `Administrator` or `Manage Server` are automatically exempt
   from every native AutoMod rule, unconditionally, and this is not
   configurable.** Corroborated across independent sources; Discord's own
   FAQ page blocks automated fetching, so this is not a primary-source quote,
   but it is consistent enough to design around. This alone rules out native
   AutoMod for "enforce against every role including admins," which is the
   actual requirement.
2. **Native AutoMod's keyword/regex expressiveness is real but bounded**: 100
   keywords per rule (prefix/suffix wildcards only), 10 regex patterns per
   rule at 260 characters each, Rust-flavored regex with no lookahead,
   lookbehind, or backreferences. Not enough to express evasion-resistant
   matching (leetspeak, homoglyphs, spacing tricks) at the scale of a
   comprehensive word list.

Separately, two Discord API facts bound what any bot — this one included —
can ever do, regardless of configuration: the guild owner can never be
kicked, banned, or timed out by any bot, and nobody can act on a member whose
role sits at or above the bot's own role position. Both are hierarchy checks
enforced by Discord itself, not a Bananasaurs choice, and match the
role-mutation protection already found live during the Release 1 smoke test
(`docs/reports/release1-smoke-tests-live-run.md` §1e,
`packages/core/src/effects/gateway.ts:266`). **Message deletion is not
hierarchy-gated** — a bot with `Manage Messages` can delete any message from
any member, including the owner's.

Nothing in Release 2's rule model, cases, exemptions, or escalation exists
yet. Building only a standalone word filter would mean re-deriving that
shape again for the next predicate type the roadmap names (regex, invite,
spam-rate, ...). Building the full engine with every predicate type now
would be building ahead of a concrete need — the roadmap explicitly warns
against this ("a rule that has never fired does not need reimplementing at
all").

## Decision

### The rule engine's core is built now; only one predicate type is implemented

A guild-scoped `mod_rules` table (kind, mode: `test` | `observe` | `enforce`,
enabled) is the foundation every predicate type plugs into, alongside
`mod_rule_exemptions` (role/channel) and `mod_cases`/`mod_case_events`
(per-member violation history, which is what escalation reads). Only `kind =
'keyword_filter'` is implemented in this slice. Every other predicate the
roadmap names gets the same slot later, not a rewrite.

### The matching engine is `obscenity` (MIT), not a hand-rolled normalizer

Evasion-resistant matching — leetspeak, Unicode homoglyphs, stretched and
spaced-out letters — is genuinely fiddly to get right (confusables tables
are large and shift over time; word-boundary logic to avoid false positives
is easy to get subtly wrong). `obscenity` (jo3-l/obscenity, MIT, 173 stars,
292 commits, active) is purpose-built for exactly this, with a
transformer-based matcher and a built-in allowlist mechanism for
false-positive suppression. Reusing it is the "boring, small, justified
dependency" CLAUDE.md prefers over reinventing something a maintained
library already does well. It is an ordinary npm dependency, not adapted
source — `package.json` and the lockfile are its record, per
`docs/PROVENANCE.md`'s own stated scope (that ledger is for code copied into
our own files, not for dependencies).

One thing `obscenity` is not confirmed to handle is stripped separately:
zero-width/invisible Unicode characters inserted mid-word to break substring
matching are stripped by Bananasaurs' own code before text reaches the
matcher — cheap and simple enough to own directly rather than depend on the
library covering it.

### The word list seeds from `obscenity`'s own bundled dataset, not a second source

`obscenity` ships `englishDataset` under the same MIT license as the matcher
itself, tuned to work with its transformers. Seeding from it rather than a
separate third-party list keeps this to one dependency's license to track
instead of two, and avoids importing a word list whose own license is
unclear (rule 7: unclear license means do not copy).

### Word list configuration: categories, with per-word overrides

`word_categories` (name, default action) and `word_terms` (text, category,
optional action override) — tune broadly by category, override precisely
per word. `word_allowlist` holds explicit exceptions, wired into
`obscenity`'s own allowlist mechanism rather than reimplemented.

### A hit always deletes the message; escalation past that is member-action, and can be refused by Discord itself

Deletion is not hierarchy-gated, so it applies uniformly regardless of role
— this is what actually answers "works for all levels of roles including
admin roles," since Discord's own platform makes the member-action side
(timeout/kick/ban) structurally incomplete for the owner and anyone at or
above the bot's role, and no amount of Bananasaurs code changes that. Every
hit: delete the message, record a `mod_case_events` row, resolve or open a
`mod_cases` row for the member, increment its violation count. The
escalation ladder (tier → action, thresholds/durations guild-configured)
resolves the next action for that count and attempts it through the same
safety pipeline already proven for role effects: authorization, live
hierarchy check immediately before acting, idempotency, dry-run, audit row.

### A moderation-action refusal is durably recorded, not log-only

The Release 1 smoke test found that a role-effect refusal (killswitch,
protected-target) produces only a `logger.warn` line — nothing in
`role_effects` or `audit_events` (`docs/reports/
release1-smoke-tests-live-run.md` §1d, `STATE.md` item 6). For moderation
actions specifically, a refusal is operationally important to see in case
history — "the bot tried to timeout the owner and correctly couldn't" is
exactly the kind of thing a human reviewing a case needs, not a detail
buried in the journal. `mod_case_events` therefore records a refused
escalation attempt as its own event, with the refusal reason, rather than
silently stopping at "deleted the message and nothing else." This does not
change the existing role-effect refusal behavior from Release 1 — it is a
new, separate call for this new subsystem, made once, deliberately, rather
than inherited by default.

## Consequences

- New tables, all guild-scoped: `mod_rules`, `mod_rule_exemptions`,
  `word_categories`, `word_terms`, `word_allowlist`, `mod_cases`,
  `mod_case_events`.
- New runtime dependency: `obscenity` (MIT), recorded via `package.json` and
  the lockfile per `docs/PROVENANCE.md`'s own scope — no adapted source, so
  no ledger entry.
- A new `MESSAGE_CREATE`/`MESSAGE_UPDATE` subscriber, guild-scoped, through
  the existing dedup/idempotency machinery every other side effect uses. No
  AI, no external call — matching is synchronous, in-process, deterministic.
- `doctor` grows a check for `kind = 'keyword_filter'` rules enabled without
  `Manage Messages` held, failing closed the way panel/role checks already
  do.
- Regex, invite/link, spam-rate, and the roadmap's other predicate kinds are
  not built in this slice. `mod_rules.kind` is the extension point; adding
  one is a new predicate implementation against the existing table, not a
  schema change.
- Whether non-owner Administrator-holding members should additionally
  trigger an *alert* (not just be subject to the same rules as everyone
  else) stays open — `STATE.md` item 4 — this ADR answers enforcement, not
  alerting.
