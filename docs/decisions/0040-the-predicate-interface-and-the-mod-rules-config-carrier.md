# 0040 — The predicate interface and the `mod_rules.config` carrier

Status: accepted
Date: 2026-09-01
Precedes Slice 1 of
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`.
Depends on ADR 0035 (the rule engine and `keyword_filter`), ADR 0036 (what the
subscriber records), ADR 0037 (`jobs.payload` — the "JSON we wrote is still
untrusted" precedent), ADR 0039 (collapse thresholds derive from the word
list, which is why a stale compiled matcher is now worse than it was).
Constrained by `CLAUDE.md` rule 2 (guild scope is a mandatory partition key)
and rule 3 (every boundary gets a validator, not a cast).

## Context

Release 2 needs nine more predicates. Two things block all nine, and a third
was found while reading the code for this ADR.

### F1 — `mod_rules` has no configuration carrier

ADR 0035 claimed that adding a predicate is "a new predicate implementation
against the existing table, not a schema change." That is true only for
`keyword_filter`, whose configuration lives in three dedicated relational
tables (`word_categories`, `word_terms`, `word_allowlist`). The `mod_rules`
row itself is `(guild_id, rule_id, kind, name, mode, enabled, created_at,
updated_at)` with a CHECK pinning `kind` to `'keyword_filter'`. A regex
pattern, a domain list, a mention threshold, a window length and a caps ratio
have nowhere to live.

### F2 — there is no predicate abstraction

`packages/core/src/automod/subscriber.ts` declares `RuleWithWordList` and
imports `buildMatcher` / `stripZeroWidth` directly. The word-list shape and
the `obscenity` matcher are hard-wired into the decision logic. Adding
predicate #2 is an interface extraction, not a new `case`.

### F3 — the compiled-matcher cache has no invalidation, and ADR 0039 made
that worse

`subscriber.ts` holds a module-level `matcherCache: Map<string, AutomodMatcher>`
keyed `"<guildId>:<ruleId>"`. Nothing ever evicts an entry. A rule whose word
list changes keeps matching against the stale list until the daemon restarts.

ADR 0039 widened the blast radius of that gap without changing its nature: the
matcher's collapse-duplicate thresholds are now *derived* from the word list
at build time. So a term edit can now change a rule's matching behaviour for
terms it did not touch — adding `"spammer"` relaxes collapsing for `m`
rule-wide — and a cached matcher gets all of that wrong too, not just the one
added term.

The practical shape of the bug is the one this project has now hit twice: **a
rule that looks configured and silently does not fire.** An operator adds a
term through the dashboard, sees it listed, and it never matches. That is the
same failure ADR 0039 spent a slice fixing, and leaving a second path to it
open while building nine more predicates is not acceptable.

## Decision

### 1. Extract a `Predicate` interface; the subscriber keeps the decision logic

The split is: **the predicate answers "did this message match, and what is the
trace?" and nothing else.** Safety state, deletion, the escalation ladder,
case resolution and `mod_case_events` recording all stay in the subscriber,
unchanged. A predicate cannot delete a message, cannot open a case, cannot
reach the moderation gateway, and is not given them.

Two stages, not one, because every predicate has per-rule work that must not
be repeated per message:

```ts
/** Stage 1: rule → a reusable compiled artifact. Runs on a rule change. */
compile(rule: CompiledRuleInput): Compiled

/** Stage 2: compiled artifact + one message → a match or nothing. */
Compiled.evaluate(input: PredicateInput): PredicateMatch | undefined
```

`keyword_filter` becomes the first implementation with **no behaviour
change** — `buildMatcher` moves behind `compile`, `matcher.match` behind
`evaluate` — and its existing tests, unmodified, are the proof.

`evaluate` is synchronous and pure with respect to Discord. It gets the
message and the rule's compiled configuration; it does not get a
`DiscordPort`, a database handle, or a clock it did not receive as input.
This is what makes Slice 2's central invariant — that the dry-run evaluator
and the live subscriber run the same code — achievable rather than aspirational.

**The window tier is the one exception, and it is handled by shape, not by
exemption.** `mention_spam`, `rapid_spam` and `duplicate_message` need
mutable sliding-window state. That state lives on the *compiled artifact*,
which is per `(guildId, ruleId)` and therefore guild-scoped by construction
(rule 2 names cache keys explicitly). Slice 4 fills that in; Slice 1 only has
to not preclude it, and a two-stage interface does not.

### 2. Add `mod_rules.config` — JSON, validated per `kind`, on write **and** on read

A `text` column, `NOT NULL DEFAULT '{}'`, holding a JSON object. Each
predicate kind owns a Zod schema for its own config, in
`packages/core/src/automod/predicates/`, and the schemas are keyed by kind in
one registry so a producer and a consumer cannot disagree — exactly the
arrangement `packages/core/src/jobs/kinds.ts` already uses for job payloads.

Validated in **both** directions, deliberately:

- **On write**, so an invalid config is rejected at the boundary that created
  it rather than discovered at match time.
- **On read**, because ADR 0037 already settled that JSON this process wrote
  is still untrusted input on the way back in (rule 3). A row written by an
  older version of the schema, or by hand in `sqlite3`, is exactly the case
  the read-side validator exists for.

The `mod_rules_kind` CHECK widens from one value to ten:
`keyword_filter`, `regex`, `invite`, `link_domain`, `mention_spam`,
`rapid_spam`, `duplicate_message`, `caps`, `attachment_type`, `emoji`.
The CHECK is widened **once, now**, rather than per predicate slice, so
Slices 3–5 are pure code.

### 3. `keyword_filter`'s data stays relational; the split is stated as a rule

**Small, scalar, whole-rule configuration goes in `config`. List-shaped data
an operator edits item by item stays in tables.**

A word list is not configuration. The false-positive review workflow
(Slice 9) needs to allowlist an *individual term* and to record when a term
last matched; rows are the right shape for that and a JSON array is not.
`keyword_filter`'s `config` is therefore `{}` and stays that way.

By the same rule, Slice 3's `invite` allowlist — labelled partner codes with
a last-matched timestamp, per the spec's decision 7 — is **relational**, not
config. `link_domain`'s allow/deny lists are relational for the same reason.
`regex`'s pattern, `caps`'s ratio and floor, and the window tier's thresholds
and window lengths are scalars and live in `config`. Slices 3–5 do not get to
re-decide this per predicate.

### 4. A rule whose config fails validation is inert **and loud**

Skipping the rule is the only safe behaviour — a predicate cannot be
constructed from a config it cannot parse, and taking down the whole
subscriber would stop every *other* rule in the guild from matching. But an
inert rule that only writes a log line is the exact failure mode of ADR 0039,
and this project does not get to walk into it a third time.

So all three of:

1. The rule is skipped for that message and every other rule still runs.
2. It is logged once per `(guildId, ruleId, fingerprint)`, at `error`, not
   once per message — an unparseable config on a busy guild would otherwise
   emit a log line per message per rule.
3. **`doctor` reports it**, in Slice 1, as a failing check naming the rule
   and the validation error. `doctor` is where "configured but not actually
   working" is supposed to surface, and it is cheap to add here.

### 5. The compiled-artifact cache is keyed by a content fingerprint

The cache becomes `Map<"<guildId>:<ruleId>", { fingerprint, compiled }>`. On
every lookup the fingerprint of the rule as just read is compared with the
cached one; a mismatch recompiles. The fingerprint is a SHA-256 over a
canonical serialisation of everything `compile` reads — `kind`, `config`, and
for `keyword_filter` the sorted terms and sorted allowlist.

This costs nothing that was not already being paid. The subscriber already
calls `listRules()` **on every message**, and that call already hydrates the
full word list from three tables. The cache never saved the read; it saved
the `obscenity` compilation. Fingerprinting data already in hand adds a hash
over a few hundred bytes and removes an entire class of "why isn't my rule
firing".

Storing the fingerprint *beside* the entry rather than *in the key* is
deliberate: it keeps the map bounded by the number of rules, where putting a
version in the key would grow it by one entry per edit for the life of the
process.

## Consequences

- Adding predicate #2 through #10 becomes: write a Zod config schema, write a
  `compile`/`evaluate` pair, register it. No subscriber change, no schema
  change. That is what ADR 0035 promised and did not deliver.
- **A term edit takes effect on the next message, with no daemon restart.**
  This closes the gap `subscriber.ts` has carried since ADR 0035 and that
  ADR 0039 made sharper.
- One migration (0010) for the `config` column and the widened `kind` CHECK.
  Additive and defaulted, so it needs no backfill and no downtime.
- `RuleWithWordList` stops being the subscriber's currency. The repository
  keeps returning it for `keyword_filter`, but the subscriber now sees a
  kind-agnostic rule shape with an optional word list attached.
- **The trace is designed here and filled in in Slice 2.** `PredicateMatch`
  carries a `trace` field from day one, even though only Slice 2 renders it,
  because retrofitting a trace into ten predicates is exactly the cost
  Slice 2 is sequenced early to avoid.
- **Cost if the "scalar in JSON, lists in tables" split is wrong:** a later
  predicate wants an editable list and has to be migrated out of `config`
  into a table — one migration and one repository function, contained to that
  predicate. Cheap, and cheaper than the reverse (discovering at Slice 9 that
  the review screen cannot suppress an individual item because it is buried
  in a JSON blob).
- **Cost if two-stage compile is wrong:** a predicate with no per-rule work
  pays an extra object allocation per rule change. Negligible.
- Native AutoMod events (ADR 0038) are unaffected: `native-subscriber.ts`
  records decisions Discord made and never evaluates a predicate.

## Alternatives rejected

- **A discriminated-union column set instead of JSON** (a nullable column per
  predicate setting). Thirty-odd mostly-NULL columns, a migration per
  predicate, and no way for the CHECK to express "this column is required for
  *that* kind". JSON plus a per-kind Zod schema puts the constraint where it
  can actually be expressed.
- **Validating config only on write.** Rejected by rule 3 and by ADR 0037's
  existing precedent for `jobs.payload`. The database is a boundary in both
  directions.
- **A single-stage `evaluate(rule, message)` with no compile step.** Simpler
  interface, but it either recompiles the `obscenity` matcher on every message
  or hides a cache inside each predicate — and a cache inside each predicate
  is nine more chances to reproduce F3.
- **Fixing the cache with a `rules.version` column bumped by every writer.**
  Correct only as long as every current and future writer remembers to bump
  it, which is caller discipline — the thing rule 2 explicitly says to
  replace with structure. A fingerprint derived from the data cannot be
  forgotten.
- **Keeping `matcherCache` and adding invalidation later.** Rejected: the
  owner named this as carried-forward work for whichever slice touched
  `subscriber.ts` first, and this slice rewrites that file.
