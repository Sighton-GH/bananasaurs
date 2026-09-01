# Release 2 completion and Release 3 roadmap — design

> **STATUS: DRAFT — for review. Nothing here is approved for implementation.**
> Produced 2026-09-01 by a brainstorming session with the owner. On approval it
> becomes the input to `writing-plans` and to the ADRs listed in §9.
>
> **This is a roadmap, not a single implementation plan.** It spans two
> releases and roughly twenty slices. Each slice gets its own ADR (where §9
> names one) and its own implementation plan; nothing here is detailed enough
> to build from directly, and that is intentional — a plan written now for
> Slice 9 would be stale by the time Slice 9 starts.

Constrained by `CLAUDE.md`'s seven hard rules throughout — in particular rule 1
(AI never in the enforcement path), rule 2 (guild scope is a mandatory
partition key), rule 3 (model output and retrieved text are untrusted), rule 6
(durable idempotency keys) and rule 8 (no new outbound destinations without an
explicit instruction).

---

## 1. Where Release 2 actually stands

Two slices are merged to `main` and green:

- **The rule engine foundation** (ADR 0035, amended by ADR 0036) — `mod_rules`,
  `mod_rule_exemptions`, `word_categories`, `word_terms`, `word_allowlist`,
  `mod_cases`, `mod_case_events`; `test`/`observe`/`enforce` modes; the
  escalation ladder; a `MESSAGE_CREATE`/`MESSAGE_UPDATE` subscriber; the
  twelve-value `action_taken` vocabulary. **One predicate: `keyword_filter`.**
- **The `/mod` command surface** (ADR 0037) — timeout, untimeout, kick, ban,
  unban, warn, purge, note, evidence, history; confirm-then-execute on ban and
  purge; the bounded `mod_purge` background job; six more `action_taken` values.

Release 2's own "done when" clause is **not** met. It requires every legacy
automod rule to have a Bananasaurs equivalent that ran observe-only against
real traffic for an acceptable period, with cutover happening one rule at a
time. Nine predicates, the fixture and dry-run machinery, the false-positive
review surface, and per-rule cutover tracking all remain.

---

## 2. Five findings that shape this plan

These were established by reading the code, not the ADRs, and three of them
contradict what the ADRs claim.

### F1 — `mod_rules` has no configuration carrier

ADR 0035 states that adding a predicate is "a new predicate implementation
against the existing table, not a schema change." That is true only for
`keyword_filter`, whose configuration lives in three dedicated relational
tables. `mod_rules` itself is `(guild_id, rule_id, kind, name, mode, enabled,
created_at, updated_at)` with a CHECK pinning `kind` to `'keyword_filter'`.
A regex pattern, a domain list, a mention threshold, a window length and a caps
ratio have nowhere to live. **Every new predicate is blocked on this.**

### F2 — there is no predicate abstraction

`packages/core/src/automod/subscriber.ts` declares `RuleWithWordList` and
imports `buildMatcher` / `stripZeroWidth` directly. The word-list shape and the
`obscenity` matcher are hard-wired into the decision logic. Adding predicate #2
is an interface extraction, not a new `case`.

### F3 — native AutoMod blocks *before* `MESSAGE_CREATE`, which cuts both ways

The club runs Discord's native AutoMod with three defaults enabled: block
mention spam, block suspected spam content, block commonly flagged words. The
owner cannot inspect their algorithms; Discord does not publish them.

Because native AutoMod blocks a message before it is created, **the gateway
never dispatches `MESSAGE_CREATE` for it**, and the Bananasaurs subscriber
never sees it. Two consequences nobody has written down:

1. **The REVIEW §A4 double-punishment problem does not arise between native
   AutoMod and Bananasaurs.** It arises between Carl-bot and Bananasaurs, where
   both see the same message. With native AutoMod set to *block*, our rule
   physically cannot fire on the same message. A Bananasaurs mention-spam rule
   may therefore run in `enforce` alongside native's without double-punishing;
   it only ever sees what native let through — members native exempts
   (`Administrator` / `Manage Server` holders, unconditionally, per ADR 0035),
   and whatever native's algorithm missed.
2. **But the observe-only measurement is biased.** A two-week false-positive
   window measures a stream native has already filtered, and calling that "real
   traffic" is a lie the gate exists to prevent.

Both are addressed by the same mechanism: §3, Slice 0.

### F4 — there is no automod-scoped testing mode

`guilds.killswitch` is the emergency disable and `guilds.dry_run` is the global
testing mode, but `dry_run` suppresses **every** side effect for the guild,
role panels included. Testing an automod rule today means turning off reaction
roles. `docs/06` and `REVIEW.md` §E both want a testing mode separate from
emergency disable *and* scoped to automod.

### F5 — the wall-clock critical path is the observe window, not the code

`docs/08` records the owner's own instruction: build the rule set up front and
flip every rule into `observe` on the same day so their clocks overlap. This
plan is therefore optimised to reach **flip day** as early as possible and to
do the dashboard work *during* the window, not before it.

---

## 3. Release 2 — remaining work

Twelve slices in five phases. Slice numbers are stable identifiers; the
implementation plan will expand each into tasks.

### Phase 1 — foundations (must precede every predicate)

#### Slice 0 — native AutoMod integration and its observability

The concrete answer to `REVIEW.md` §E's "native Discord AutoMod integration
where it blocks earlier — do not duplicate it blindly."

- Add the **`AutoModerationExecution`** gateway intent
  (`packages/discord/src/client.ts`). It is **not privileged** — no Developer
  Portal review, no threshold.
- Subscribe to `AUTO_MODERATION_ACTION_EXECUTION` and record every native
  action as a `mod_case_events` row under a reserved sentinel
  `rule_id = 'native:<discord_rule_id>'`, matching the `'manual'` sentinel
  precedent from ADR 0037. New `action_taken` values are additive, as ADR 0036
  and ADR 0037 both were.
- **Why this matters more than it looks.** The owner cannot read Discord's
  algorithm, but this observes *every decision it makes*. That is strictly
  better than documentation Discord will not publish, and it is the only way to
  know what native is actually catching before deciding what Bananasaurs still
  needs to catch.
- It also produces one unified moderation log, and feeds native's hits into the
  same false-positive review surface as ours.
- **Division of labour, recorded as a decision:** native keeps its three
  default rules and blocks first for non-exempt members, because blocking
  before the message posts is strictly better than deleting after. Bananasaurs
  builds equivalents anyway, because native exempts admins unconditionally and
  because native's decisions are otherwise unauditable. No `native_backstop`
  exemption flag is needed — event ordering makes the overlap impossible
  (F3.1) — and a test asserts this.
- **Measurement-bias note carried into the FP review screen:** any Bananasaurs
  rule whose category overlaps a *blocking* native rule is measured on a
  filtered stream. The review screen must say so on the rule, rather than let a
  clean-looking number be read as a clean rule.

This slice ships first because it starts collecting native's decisions on day
one, and that data is an input to how the remaining predicates are tuned.

#### Slice 1 — predicate abstraction and configuration carrier

Fixes F1 and F2 together. Two decisions, both recorded as an ADR (§9):

- **Extract a `Predicate` interface** from `subscriber.ts`. The subscriber
  keeps the decision logic (safety state, delete, escalate, record); the
  predicate answers only "does this message match, and what is the trace?"
  `keyword_filter` becomes the first implementation, unchanged in behaviour,
  with its existing tests proving that.
- **Add `mod_rules.config`** — a JSON column, Zod-validated per `kind` on read,
  exactly as `jobs.payload` is (ADR 0037: JSON we wrote is still untrusted).
  Widen the `mod_rules_kind` CHECK to the nine new kinds.
- **`keyword_filter`'s data stays relational.** A word list is not
  configuration: the false-positive workflow needs to allowlist an individual
  term, and rows are the right shape for that. Its `config` is minimal. The
  split — small scalar config in JSON, list-shaped data in tables — is stated
  explicitly so the next predicate does not have to guess.

#### Slice 2 — fixtures, the dry-run evaluator, match traces, and a CLI review

**This slice comes before the predicates, deliberately, and the reasoning is
the load-bearing part of this plan.** The owner asked whether it should; the
answer is yes, for four reasons:

1. It is the test harness all nine predicates are written against.
2. The trace format is what the false-positive review screen renders. Building
   it once here beats retrofitting it into nine implementations later.
3. It is what makes a two-week observe window *reviewable at all*. Without
   traces, the window produces a count, not evidence.
4. Building it afterwards means nine separate retrofits.

Contents:

- **A saved-message fixture corpus**, guild-scoped, seeded from real archived
  club messages plus hand-written adversarial cases. Fixtures are labelled
  (`should_match` / `should_not_match` / `unlabelled`) so the corpus doubles as
  a regression suite.
- **A dry-run evaluator** that runs a rule against the corpus and reports
  matches, misses, and a per-message trace.
- **Human-readable match traces**: which predicate, which term or pattern,
  which span of the message, what normalisation was applied (zero-width
  stripping, leetspeak folding), which exemption did or did not apply, and what
  action *would* have been taken.
- **A hard invariant, asserted in tests:** the dry-run evaluator and the live
  subscriber execute **the same predicate code path**. A parallel evaluator
  tests something other than production, and the entire Release 2 gate rests on
  the dry run being honest.
- **A minimal operator-CLI review command** shipped here, so false-positive
  review is possible from the first day of the observe window rather than only
  once the dashboard screen lands in Phase 4. The dashboard screen supersedes
  it; the CLI stays as the headless path.

### Phase 2 — the nine predicates

Owner-selected scope. **`account_age` and `join_age` are explicitly out** —
that also removes the need for a second evaluation entry point, since those
fire on member join rather than on message content. The subscriber stays
single-entry.

#### Slice 3 — precise tier: `regex`, `invite`, `link_domain`

Lowest false-positive risk. `docs/08` permits these to graduate from the
observe window earlier than the two-week floor, at the owner's discretion per
rule, because real traffic has little to teach a precise blocklist.

- `regex`: a guild-configured pattern with a compile-time validity check, a
  length cap, and an execution timeout. **ReDoS is the risk** — patterns come
  from the dashboard and later, in Release 3, from a model. A linear-time
  engine or a hard per-evaluation timeout is required, not optional.
- `invite`: **pattern matching only, no resolution.** Resolving an invite code
  to a guild is an outbound API call; CLAUDE.md rule 8 forbids new destinations
  without an explicit instruction, and this is not one. An allowlist of the
  club's own invite codes handles the legitimate case.
- `link_domain`: URL extraction plus an allow/deny list on the registrable
  domain. No fetching, no resolution, no DNS.

#### Slice 4 — window tier: `mention_spam`, `rapid_spam`, `duplicate_message`

These need sliding-window counters, which do not exist. `docs/08` says these
are exactly the rules that genuinely need the full two-week floor.

- **In-memory counters**, keyed `(guildId, memberId, ruleId)`, as a bounded
  ring buffer with an eviction sweep. **A restart resets the window, and that
  is accepted and documented**: a ten-second spam window losing state on a
  daemon restart is harmless, and a durable table would cost writes on every
  message for no behavioural gain.
- The key is guild-scoped in its own right, per CLAUDE.md rule 2 — cache keys
  are named in that rule explicitly.
- `duplicate_message` compares normalised content across a window; the
  normalisation is the same code the keyword matcher uses, not a second copy.

#### Slice 5 — shape tier: `caps`, `attachment_type`, `emoji`

Cheapest to build. `caps` carries the tier's false-positive risk (acronyms,
short messages, code snippets) and needs a minimum-length floor.
`attachment_type` matches on declared content type **and** file extension,
since either alone is trivially spoofed.

### Phase 3 — making the gate structural

#### Slice 6 — cutover tracking, observe-window gating, automod testing mode

This is where `REVIEW.md` §A4 and Release 2's "done when" clause stop being
procedure and become constraints the code enforces.

- `mod_rules` gains `legacy_rule_ref` (which Carl-bot / Dyno / native rule this
  replaces), `cutover_state` (`not_started` | `observing` | `ready` |
  `cutover` | `rolled_back`), and `observe_started_at`.
- **The engine refuses to accept `mode = 'enforce'` unless `cutover_state`
  permits it.** `REVIEW.md` §E's "before enforcement is even offerable" becomes
  a validation error rather than a habit. This is the single highest-value line
  in Release 2, and it pays off again in Release 3 (§6, R3-4).
- `guilds.automod_testing_mode` — a third lever, separate from `killswitch`
  (emergency disable) and `dry_run` (guild-wide), fixing F4 so that testing an
  automod rule does not disable the role panels.
- `doctor` grows a check for rules in `enforce` whose `cutover_state` does not
  permit it, and for rules in `observe` past their window with an unreviewed
  match backlog.

### → **Flip day.** Every rule to `observe`. The clock starts.

Nothing after this point blocks the window. Everything below runs during it.

### Phase 4 — the dashboard (built during the observe window)

#### Slice 7 — the application shell

The current dashboard is a single 455-line `App.tsx` with 70 lines of CSS and
five stacked `<section class="panel">` blocks. It works. It is not a UI.

Routing, design tokens, layout, navigation, and the shared component set
(tables, forms, dialogs, toasts, badges, and empty / loading / degraded / error
states). The five existing sections — health, kill switch, log routing, panels,
audit — migrate into it with no behaviour change, and their existing tests
staying green is the proof.

#### Slice 8 — Release 2 pages

Automod rules (list, edit, exemptions, mode, dry-run against fixtures), cases
and member history, and a cutover board showing every rule's
`legacy_rule_ref`, `cutover_state`, days observed, and match count.

#### Slice 9 — the false-positive review screen

The one that matters, and the one Release 2's gate depends on. Reviews
Bananasaurs matches **and** native AutoMod hits in one queue: message, trace,
verdict (`false positive` / `true positive` / `unclear`), and a one-click
suppression appropriate to the predicate that fired — an allowlisted term for
`keyword_filter`, a narrowed pattern or domain for the precise tier, a raised
threshold or a role/channel exemption for the window and shape tiers. A
reviewed verdict writes back to the Slice 2 fixture corpus, so review work
becomes regression tests rather than evaporating.

Carries the F3.2 measurement-bias warning on any rule overlapping a blocking
native rule.

**It also has to report the number the gate is written against.** Release 2's
"done when" clause says "an acceptable false-positive rate" without defining
either the numerator or the threshold. This screen defines the numerator —
reviewed matches per rule, split by verdict — and the threshold is an owner
decision per rule, recorded on the rule alongside `cutover_state` rather than
left as a judgement made once and forgotten. See §8.6.

#### Slice 10 — Release 3 route stubs

Clearly-labelled empty routes for the Release 3 areas — Archive, Search,
**Resources**, Providers, Memory, AI workspace, Proposals — so Release 3 adds a
page rather than triggering a rebuild. Each stub states plainly that the
feature does not exist yet; `docs/06`'s own UX requirement is that the UI never
pretends an unbuilt module is available.

### Phase 5 — close-out

#### Slice 11 — cutover, one rule at a time, atomic

Disable the legacy rule, then enable the Bananasaurs one. Never both. Each
cutover is its own change with its own record, and `cutover_state` moves
`observing` → `ready` → `cutover` under owner decision, not a timer.

#### Slice 12 — Release 2 gate sign-off

Live smoke tests in the test guild, `doctor` clean, `docs/SMOKE_TESTS.md`
extended for the automod surface, `STATE.md` updated, ADR tidy, and the "done
when" clause checked line by line.

### Dependency order

```
Slice 0 (native automod) ─┐
Slice 1 (abstraction)  ───┼─→ Slice 2 (fixtures / evaluator / traces)
                          │        │
                          │        ├─→ Slice 3 (precise tier)
                          │        ├─→ Slice 4 (window tier)
                          │        └─→ Slice 5 (shape tier)
                          │                  │
                          └──────────────────┴─→ Slice 6 (cutover gating)
                                                      │
                                                 [FLIP DAY]
                                                      │
                                    Slice 7 → Slice 8 → Slice 9 → Slice 10
                                                      │
                                            Slice 11 → Slice 12
```

Slices 3, 4 and 5 are independent of one another once Slice 2 lands, and may be
built in any order.

---

## 4. Self-review checkpoints

The owner asked for proper checkpoints for AI to review its own work. Three
levels, each designed to catch a different failure.

### Per slice

1. **Tests first** for anything touching permissions, hierarchy, idempotency,
   retention or guild scope — CLAUDE.md's working-style rule, not a preference.
2. `npm run typecheck && npm run lint && npm run test`, all clean. **No
   completion claim on code that has not been run.**
3. `/code-review` on the slice diff.
4. A **hard-rules checklist** answered explicitly in the slice's PR
   description, one line each:
   - every new query signature takes an explicit guild scope (rule 2);
   - every new Discord side effect has a durable idempotency key **and** a
     unique constraint making double execution impossible (rule 6);
   - no provider call, and nothing in this path degrades if every provider is
     unreachable (rule 1);
   - every boundary — job payload, HTTP body, JSON config column, model output
     — passes a Zod validator (rule 3);
   - nothing new reaches a log, config export or diagnostics bundle that the
     Pino allowlist has not been extended to permit (rule 4);
   - any new dependency has a one-line justification and, if source was copied
     rather than depended on, a `docs/PROVENANCE.md` entry (rule 7).

### Per phase

**A whole-branch review by a fresh agent that did not write the code.** This is
not ceremony: ADR 0036 exists *because* a whole-branch review of the automod
slice found three defects that twelve individual per-task reviews had each
missed — including a guild in dry run really deleting real members' messages.
That is direct evidence from this repository that per-slice review is not
sufficient, and this checkpoint is priced accordingly.

### Slice-specific gates

- **Slice 2:** an assertion that the dry-run evaluator and the live subscriber
  share one predicate code path. If they diverge, the entire Release 2 gate is
  measuring a fiction.
- **Before flip day:** a rehearsal in which every rule's trace is rendered and
  read. A trace nobody can read produces an observe window that yields nothing.
- **Slice 6:** a test that `mode = 'enforce'` is *refused* for a rule whose
  `cutover_state` does not permit it — written before the feature, since it is
  the mechanism the release gate rests on.
- **Slice 3:** a ReDoS test with a catastrophic-backtracking pattern, asserting
  the timeout or the linear-time engine holds.

---

## 5. The dashboard: stack, direction, architecture

### Stack

**Tailwind v4 + hand-written components + Radix primitives only where
accessibility is genuinely hard + `wouter` for routing.** Chosen for longevity
and continual development, which is what the owner asked to optimise for.

- **Tailwind v4** configures in CSS (`@theme`), so the framework's
  configuration is a stylesheet and the design tokens survive as plain custom
  properties if Tailwind ever became a liability. It is one Vite plugin line.
  The real argument is drift: a hand-rolled CSS system decays as fifteen pages
  accrete, and there is no cascade to debug years later. Since Claude Code
  writes most of this code, a system it cannot silently drift from is a
  longevity property, not a fashion one.
- **Radix** for dialog, dropdown menu, tabs, tooltip and select **only**. Focus
  traps, ARIA wiring and keyboard navigation are fiddly and easy to get subtly
  wrong — precisely the argument ADR 0035 used to justify `obscenity` over a
  hand-rolled normaliser, applied consistently. `docs/06` lists accessibility
  as part of done. Buttons, tables, cards, badges and inputs are hand-written;
  they are trivial and carry no a11y machinery.
- **Not the shadcn CLI.** It vendors code into the repository, which means
  `docs/PROVENANCE.md` entries and code the project did not write but must
  maintain. Plain npm dependencies are cleaner under rule 7 and match the
  `obscenity` precedent, where the lockfile is the record.
- **`wouter` over React Router** — roughly 2 kB, hooks-only, and React Router
  has broken its API three times across v5, v6 and v7.

Eight new dependencies, all MIT: `tailwindcss`, `@tailwindcss/vite`, `wouter`,
and five `@radix-ui/react-*` packages. Each gets its one-line justification in
the PR description per CLAUDE.md.

The existing `api.ts` stays. Its CSRF handling and transparent reauth retry
(ADR 0029) are bespoke and correct; no data-fetching library is added.

### Design direction

The framework does not make it attractive; the design system does. Tailwind
makes it *consistent*, which is most of what reads as designed. The
`frontend-design` skill is invoked when Slice 7 is built, not now.

Direction: a dense, information-first operator console. Dark-first, because it
sits on a monitor next to a terminal. One accent colour reserved for **state** —
dry run, killswitch, breaker open, observe window active — never for decoration.
Tabular numerals throughout. No card-soup: tables where the data is tabular, and
detail panes rather than modals for anything the operator needs to read while
doing something else. Every dangerous action states its exact scope before
confirming, per `docs/06`.

### Information architecture

Navigation is the `docs/06` target-state area list, filtered to what exists,
with unbuilt areas visibly stubbed rather than hidden — hiding them makes the
roadmap invisible, faking them breaks the UX rule against pretending. Shared
page pattern per `docs/06`: purpose, health, enablement, configuration,
test/preview, recent activity.

---

## 6. Release 3 — roadmap

**Not to be built during Release 2.** This exists so that Slice 10's stubs land
in the right places, and so the owner can see the whole arc.

The ordering below differs from `REVIEW.md` §E in one deliberate way: the tool
registry and proposed-action pipeline move **ahead of** the provider layer,
because they can be built and fully tested with no model at all.

### R3-0 — decisions before code

- **A monthly AI spend ceiling, as a number.** It becomes a config value that
  fails closed. Still open (`STATE.md` item 2).
- Which provider clears the ADR 0010 no-training gate, with the cited ToS
  clause and a review date.
- Per-channel attachment policy: `none`, `metadata` or `bytes`.
- Embeddings stay **off by default** per `REVIEW.md` §C11 — the 512 MB budget
  and a MiniLM-class model cannot both be true on this box. Lexical search
  first; embeddings only after measurement shows FTS5 insufficient.

### R3-1 — archive ingestion

Default-deny channel scope (ADR 0009). A resumable **single** throttled worker
with a persisted per-channel cursor (§C10) — not parallel fetches. Attachments
downloaded at ingest where policy says `bytes`, because Discord CDN URLs expire
in roughly 24 hours (§C1), with content-hash deduplication. Tiered retention,
deletion tombstones, and the scheduled expiry job.

### R3-2 — search

SQLite FTS5. `/find` with **permission-filtered citations** — the citation list
is filtered, not merely the content, or a citation reveals that a message exists
in a channel the asker cannot see (§C16).

**Useful with no AI whatsoever.** Searchable club history is worth shipping on
its own merits, and it de-risks everything after it.

### R3-3 — resources and club documents

The owner authorised four sources explicitly, which satisfies rule 8's
"explicit instruction" requirement for the outbound destinations involved.

- **Allowlisted web URLs** — the club website and other registered origins,
  fetched with SSRF defence (no private address ranges, no redirects off the
  allowlist, no DNS rebinding), on a re-fetch schedule, extracted and indexed
  into the same FTS5 index as the Discord archive.
- **Files uploaded through the dashboard** — PDFs, Markdown, documents. No
  outbound network, no expiry, no SSRF surface. The cheapest and safest path,
  and the one to build first.
- **Discord-attached documents** — text extraction over attachments already
  archived under the ADR 0009 scope. No new destination.
- **Drive / external document URLs — Phase A only.** Link-shared Drive and Docs
  URLs fetched through the public export endpoint, treated exactly like an
  allowlisted web URL: no OAuth, no stored credential, no permission model to
  mirror. **Phase B — a full OAuth integration — is deferred** past Release 3
  unless link-sharing proves insufficient. Recorded as a documented choice, not
  an oversight: the owner asked for Drive URLs and this delivers them at a
  fraction of the cost.
- **A dashboard Resources page**, named explicitly by the owner: add and
  authorise documents, website URLs and Drive URLs, with title, description,
  tags, scope, status, last-checked and notes; URL validation and
  deduplication.

Also useful with no AI: an indexed, searchable resource registry is a club wiki
that maintains itself.

### R3-4 — the tool registry and the proposed-action pipeline

**The keystone of Release 3, and the thing that makes "the AI can use any part
of the bot, including future features" both true and safe.**

CLAUDE.md rule 1 says a model may draft a proposed action or a configuration,
and only deterministic, validated, authorised code executes anything. That
bounds *who pulls the trigger*, not *what the AI can reach*. The pipeline
`docs/10` already specifies — resolve → authorise → validate → preview →
idempotency key → execute → record → audit — is the mechanism, and `REVIEW.md`
§D lists it as one of the decisions worth protecting through any rewrite.

**A tool registry as a first-class subsystem.** Every bot capability, present
and future, registers:

- a Zod tool schema;
- the capability required to invoke it, checked against **the invoking human's**
  grants, never against the model;
- a blast-radius class (below);
- a preview renderer.

This registry is the "and any future features" requirement made structural,
exactly as `mod_rules.kind` is the extension point for predicates. A Release 4
module gains AI access by registering, not by anyone rewriting the AI layer.

**Three tool classes**, per the owner's decision:

| Class | Behaviour | Examples |
| --- | --- | --- |
| **Read** | Executes immediately | search the archive, read a case, list automod rules, read a registered resource, check panel state |
| **Write, auto-execute** | Zod-validated, then executed by deterministic code with no tap. Bounded to **reversible and self-scoped** actions affecting nobody else | a reminder for the asker or the current channel, saving a resource, appending a draft note |
| **Write, human tap required** | Model produces a draft; a human approves a rendered preview; deterministic code then executes with an idempotency key and an audit row | automod rules, moderation actions, role changes, panels — anything touching the enforcement path or a third party |

**Build it before the provider exists.** The whole pipeline is testable with
hand-written proposals as fixtures and no model at all. Proving the safety spine
before anything can reach it is the correct order, and it means the provider
slice adds a caller rather than a capability.

**Three properties worth stating explicitly:**

1. **AI-authored automod rules inherit Release 2's gate for free.** A drafted
   rule is Zod-validated, then automatically dry-run against the Slice 2 fixture
   corpus, so the owner sees the match trace **on real saved messages** before
   approving. And because Slice 6 refuses `enforce` without a permitting
   `cutover_state`, an AI-authored rule structurally cannot skip its observe
   window. No new safety mechanism is required. This is the largest single
   payoff in the plan, and it is why Slice 2 is sequenced where it is.
2. **Reading the club website is bounded by rule 3.** A fetched page can carry
   injected instructions. Retrieved content is wrapped in a delimited, labelled
   envelope, and **a turn whose only new input is retrieved text may not emit a
   tool call.** Already law; external resources make it load-bearing.
3. **Every proposal is durable and auditable** — who proposed, what the model
   emitted verbatim, what the validator accepted, who approved, what executed,
   and the idempotency key that makes a double-approve a no-op.

### R3-5 — the provider layer

The ADR 0010 eligibility gate enforced in the router: no archive excerpt, memory
capsule, resource text or attachment content reaches a provider unless
`trainsOnInput === "no"`, with `"unknown"` treated as `"yes"`. One generic
OpenAI-compatible adapter. Explicit routing. A hard monthly ceiling that fails
closed. Routing reason and disclosure class recorded per call, without copying
sensitive prompt bodies into logs.

### R3-6 — the context compiler

Per-section budgets and a recorded disclosure plan. Retrieved content in the
delimited labelled envelope from R3-4. **Plus a self-knowledge section**: the
capability catalogue from the tool registry and a budgeted summary of current
configuration — which automod rules exist and in what mode, which cases are
open, which panels are live, which resources are registered. Without it the
model cannot reason about the bot it is operating.

### R3-7 — `/ask`

Defer within three seconds, then throttled progressive edits, with citations on
the final edit (§C7). Not true token streaming — Discord does not offer it.

### R3-8 — memory

Server card plus a small **hand-curated** set. Catalogue → capsule → evidence
progressive disclosure (ADR 0003). No automatic extraction in Release 3.

### R3-9 — `/remind`, `/decision`, `/review-plan`

**The reminder engine is built first as a plain slash command plus a durable
job**, and only then registered as a tool. CLAUDE.md rule 1 names *schedules*
among the things that must work with every provider unreachable, so the
scheduler cannot depend on the AI layer existing. Once it exists,
`create_reminder` is registered as a **write, auto-execute** tool per R3-4 —
reversible and self-scoped, which is exactly the class the owner drew the line
at.

### R3-10 — the privacy surface

`/mydata`, `/forgetme`, and a per-member opt-out from memory extraction.

### R3-11 — golden questions

Prompt-injection cases, inaccessible-channel traps, and citation-leak cases.
**Any unauthorised retrieval or disclosure is release-blocking**, per
`docs/14`.

### Dashboard pages in Release 3

The Slice 10 stubs fill in: Archive, Search, Resources, Providers, Memory, the
AI workspace, and a **Proposals** queue — the approval surface for the
human-tap tool class, which has no equivalent in any earlier release.

### Release 3 dependency order

```
R3-0 (decisions)
  ├─→ R3-1 (archive) ──→ R3-2 (search) ──┐
  │                                       ├─→ R3-6 (context compiler) ─→ R3-7 (/ask)
  ├─→ R3-3 (resources) ───────────────────┤                                  │
  │                                       │                                  ├─→ R3-8 (memory)
  ├─→ R3-4 (tool registry + proposals) ───┤                                  │
  │              └─→ R3-5 (provider layer)┘                                  └─→ R3-11 (golden questions)
  ├─→ R3-9 (reminder engine, no AI) ──→ registered as a tool in R3-4
  └─→ R3-10 (privacy surface) — independent
```

R3-1, R3-2, R3-3, R3-4 and R3-9 all deliver value with **zero AI configured**.
That is deliberate: a provider outage, a failed eligibility review or a blown
budget ceiling then degrades the assistant without taking the club's tools with
it — which is the Release 3 gate's own requirement.

---

## 7. Decisions taken in this session

| # | Decision | Made by |
| --- | --- | --- |
| 1 | Native AutoMod keeps its three default rules and blocks first; Bananasaurs builds equivalents for the admin-exemption gap and for auditability | Claude, from F3 |
| 2 | Ingest `AUTO_MODERATION_ACTION_EXECUTION` into `mod_case_events` under a `native:` sentinel | Claude |
| 3 | No `native_backstop` exemption flag — event ordering makes native/Bananasaurs double-punishment impossible | Claude, from F3.1 |
| 4 | `mod_rules.config` JSON carrier for scalar predicate config; list-shaped data stays relational | Claude |
| 5 | Fixtures and the dry-run evaluator precede all predicates | Claude, in answer to the owner's question |
| 6 | Nine predicates; `account_age` and `join_age` out of Release 2 | **Owner** |
| 7 | Invite matching is pattern-only, no resolution (rule 8) | Claude |
| 8 | Sliding windows are in-memory and reset on restart | Claude |
| 9 | `enforce` is refused unless `cutover_state` permits it | Claude |
| 10 | Dashboard: real shell + Release 2 pages + Release 3 stubs | **Owner** |
| 11 | Tailwind v4 + hand-written components + selective Radix + `wouter`; no shadcn CLI | Claude, owner asked for a recommendation |
| 12 | AI auto-executes reversible, self-scoped writes; everything touching enforcement or a third party needs a human tap | **Owner** |
| 13 | Resources: allowlisted URLs, dashboard uploads, Discord attachments, and Drive URLs, with a dashboard page to authorise them | **Owner** |
| 14 | Drive is Phase A (link-shared, public export endpoint, no OAuth); Phase B OAuth deferred | Claude, stated as an assumption |
| 15 | The tool registry and proposal pipeline are built and tested before the provider layer exists | Claude |

---

## 8. Assumptions to challenge on review

1. **Invite matching without resolution** is enough for the club's needs. If the
   real requirement is "block invites to servers that are not ours," an
   allowlist of our own codes covers it; if it is "block invites to servers
   matching some property," that needs resolution and therefore a rule 8
   instruction.
2. **In-memory sliding windows** are acceptable. A daemon restart during an
   active spam burst loses that burst's accumulated count.
3. **Drive Phase A** (link-shared URLs) covers the club's documents. If the
   documents are permission-restricted rather than link-shared, Phase A cannot
   read them and Phase B becomes necessary.
4. **The two-week observe floor** applies to the window tier; the precise tier
   may graduate sooner at owner discretion, per `docs/08`.
5. **Eight new dashboard dependencies** are within CLAUDE.md's "boring and
   small" bar. If not, the fallback is hand-rolled CSS plus `wouter` alone, at
   the cost of accessibility work and long-term consistency.
6. **"An acceptable false-positive rate" is still undefined**, in `REVIEW.md`
   §E, in `docs/08`, and here. It is the literal condition Release 2 ends on,
   and it currently has no numerator and no threshold. This plan proposes that
   Slice 9 supplies the numerator (reviewed matches per rule, split by verdict)
   and that the threshold is set per rule by the owner and recorded on the rule.
   **The owner has not agreed to that yet** — it is the one gap in the release
   gate this plan does not close on its own authority, because deciding how
   wrong an enforcement rule may be before it is allowed to punish members is
   not a call to make by default.

---

## 9. ADRs this plan requires

Written **before** the implementation they describe, per CLAUDE.md's working
style, numbered sequentially from 0038:

| ADR | Subject | Precedes |
| --- | --- | --- |
| 0038 | Native AutoMod is a first-class collaborator, and its decisions are recorded | Slice 0 |
| 0039 | The predicate interface and the `mod_rules.config` carrier | Slice 1 |
| 0040 | Fixtures, the dry-run evaluator, and the one-code-path invariant | Slice 2 |
| 0041 | Cutover state gates enforcement; automod testing mode is a third lever | Slice 6 |
| 0042 | The dashboard's stack, design system, and information architecture | Slice 7 |
| 0043 | AI proposes, deterministic code disposes: the tool registry and the proposed-action pipeline | R3-4 |
| 0044 | Resource and document ingestion, and the outbound destinations it authorises | R3-3 |

---

## 10. Explicitly out of scope

- Everything in `REVIEW.md` §E's "After Release 3" list.
- `account_age` and `join_age` predicates (owner-cut from Release 2).
- Rule versioning and rollback — named in `docs/08` but not required by the
  Release 2 gate; deferred, and noted here so the omission is deliberate.
- Reconciliation of moderation actions taken directly in Discord — named in
  `docs/08` Release 2, but ADR 0037 already places it out of scope, and it is
  eventually-consistent inferred data (§C5) rather than a gate requirement.
- Violation expiry — ADR 0037 records that none exists, and that building it for
  one source only would make the two sources diverge. When it lands it applies
  to both or neither.
- Drive OAuth (Phase B).
- Automatic memory extraction.
- Embeddings.
