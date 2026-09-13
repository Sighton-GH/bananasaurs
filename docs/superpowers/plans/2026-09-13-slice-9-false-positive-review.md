# Slice 9 — the false-positive review screen: implementation plan

> **For agentic workers:** executed with
> `opencode-delegate:opencode-driven-development`, one task per dispatch, a
> task review per task, an Opus whole-branch review at the end.

**Goal:** One queue that reviews Bananasaurs matches and native AutoMod hits
— message, trace, verdict (false positive / true positive / unclear) — with a
one-click suppression appropriate to the predicate that fired, a verdict that
writes back to the fixture corpus, the F3.2 measurement-bias warning, and the
number Release 2's gate is written against: reviewed matches per rule, split
by verdict.

**Architecture:** Storage gains three read queries in `automod-admin.ts`
(unreviewed native hits, verdict counts per rule, native-blocked count). The
port surface gains three members and the rule summary gains a `verdicts`
split. Two new routes and one extended route serve the page. The dashboard
gains `/review` — a queue table with verdict buttons and per-kind
suppression actions that reuse the Slice 8 write routes — and the cutover
board and rules list show the verdict split. **Nothing touches `setRuleMode`,
`setRuleConfig`, `recordVerdict`, the schema, or the subscriber.**

**Tech Stack:** as Slice 8.

**Spec:** `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
§3 Slice 9 and §2 F3; ADR 0041 (fixtures, verdicts, the one-code-path
invariant); ADR 0042 §4 (what the verdict counts feed). Rulings PR-53..PR-58
in `docs/reports/release2-slices-7-12-ledger.md`.

## Global Constraints

- **Read `docs/reports/briefs/SANDBOX_RULES.md` before running any command.**
  Explicit paths on every `rg` and `git`; gates by exit code; `git restore`
  to undo experiments; never read `.env`, `data/**`, `backups/**`.
- **No new dependencies. No migration.**
- **Do not modify** `setRuleMode`, `setRuleConfig`, `createRule`,
  `recordVerdict`, `listUnreviewedMatches`, `enforcementEligibility`, any
  schema or migration, `packages/core/src/automod/subscriber.ts`,
  `native-subscriber.ts`, or `packages/core/src/effects/gateway.ts`. The
  observe window is running on two real guilds.
- **Guild scope (rule 2):** every new repository function takes `scope` and
  has a two-guild test that seeds the other guild with colliding ids; every
  route reads `session.scope` only.
- **Capabilities (PR-44, unchanged):** review reads need `config.read`;
  verdicts and suppressions need `config.write`. No new capability.
- **Re-auth:** none of Slice 9's writes need `requireFresh` — a verdict is
  evidence, and a suppression narrows a rule (PR-54).
- **Validation (rule 3):** every body and param passes Zod; `eventId` is
  `z.string().min(1).max(64)` (event ids are opaque strings, see
  `mod_case_events`); `verdict` is `z.enum(['false_positive','true_positive','unclear'])`;
  `note` is `z.string().max(500).optional()`.
- **Audit:** every write route records a row with `before`/`after`; no 4xx
  path records one. Verdicts audit as `automod_match.verdict_recorded`
  (subjectType `automod_match`, subjectId = eventId); suppressions as
  `automod_rule.suppression_added` (subjectType `automod_rule`, subjectId =
  ruleId, `after` naming the kind and value).
- **Ports are implemented in four literals:** `apps/daemon/src/ops/wiring.ts`,
  `packages/http/src/test-support.ts`, `packages/core/src/ops/test-fixtures.ts`,
  and `packages/storage/src/repos/automod-rule-lists.test.ts`. Every task that
  adds a member updates all four. Core may not import from
  `@bananasaurs/storage`; re-declare shapes in `ports.ts`.
- **Dashboard rules from Slices 7–8 carry over verbatim:** `*.test.tsx` start
  with `// @vitest-environment jsdom`, import `cleanup`, `afterEach(cleanup)`;
  `stubFetch`/`renderWithSession` from `test-support.tsx`; assert URLs,
  bodies and roles, never class names; `.ts` never imports `.tsx`; optional
  props use a conditional spread; hold colour for state only; every page
  through `DataState`; writes through `useSession().write`/`writeOrThrow`;
  every write that changes what a rule matches goes through `ConfirmDialog`
  with its exact scope stated; copy in sentence case, verbs on buttons.
- **Gates run alone, read by exit code:** `npm run typecheck`, `npm run lint`,
  `npm run test`.

---

## File structure

```
packages/storage/src/repos/automod-admin.ts            (Task 1) + listUnreviewedNativeHits, countVerdictsByRule, countNativeBlocked
packages/storage/src/repos/automod-admin.test.ts       (Task 1)
packages/core/src/ops/ports.ts                         (Task 2) OpsAutomodRuleSummary.verdicts; listUnreviewedNativeHits, nativeBlockedCount, addAutomodAllowlistPhrase
packages/core/src/ops/test-fixtures.ts                 (Task 2)
packages/http/src/test-support.ts                      (Task 2)
apps/daemon/src/ops/wiring.ts                          (Task 2)
packages/storage/src/repos/automod-rule-lists.test.ts  (Task 2) three notNeeded stubs
packages/http/src/routes/automod.ts                    (Task 2) review routes added here (same guard/capability/audit pattern)
packages/http/src/routes/automod.test.ts               (Task 2)
packages/dashboard/src/api/automod.ts                  (Task 3) RuleSummary.verdicts; ReviewQueue types; suppressionFor(kind)
packages/dashboard/src/app/routes.ts                   (Task 3) Review row
packages/dashboard/src/app/Shell.tsx                   (Task 3) /review route
packages/dashboard/src/app/Shell.test.tsx              (Task 3)
packages/dashboard/src/pages/review.tsx                (Task 3, 4)
packages/dashboard/src/pages/review.test.tsx           (Task 3, 4)
packages/dashboard/src/pages/cutover.tsx               (Task 4) verdict split columns
packages/dashboard/src/pages/cutover.test.tsx          (Task 4)
packages/dashboard/src/pages/automod-rules.tsx         (Task 4) Reviewed cell shows the split
packages/dashboard/src/pages/automod-rule.tsx          (Task 4) Lists note reworded
packages/dashboard/src/pages/member.tsx, cases.tsx, case.tsx  (Task 4) Slice 8 Minors
```

---

### Task 1: Storage — native hits, verdict counts, native-blocked count (tests first)

**Files:**
- Modify: `packages/storage/src/repos/automod-admin.ts`
- Modify: `packages/storage/src/repos/automod-admin.test.ts`

**Interfaces — Produces:**

```ts
/** Native AutoMod decisions (rule_id 'native:…') nobody has ruled on, oldest first. No trace, no fixture: the evidence is the snippet Discord sent. */
export interface NativeHit {
  readonly eventId: string;
  readonly ruleId: string;            // 'native:<discord rule id>'
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;   // Discord's trigger type
  readonly matchedSnippet: string;
  readonly actionTaken: string;       // one of the native_* values
}
export const listUnreviewedNativeHits = (scope: GuildScope, query: { readonly limit: number }): readonly NativeHit[];

export interface VerdictCounts { readonly falsePositive: number; readonly truePositive: number; readonly unclear: number }
/** Verdicts per rule, attributed through the event each verdict names — the numerator Release 2's gate is written against. Rules with no verdicts are absent. */
export const countVerdictsByRule = (scope: GuildScope): Readonly<Record<string, VerdictCounts>>;

/** How many native AutoMod *block* decisions this guild has recorded — nonzero means the observe window measures a stream native already filtered (spec F3.2). */
export const countNativeBlocked = (scope: GuildScope): number;
```

- [ ] **Step 1: Tests first**, in the existing `automod-admin.test.ts`, one
  `describe` per function, each with a second guild seeded with **the same
  event ids** and asserting isolation:
  1. `listUnreviewedNativeHits` returns only events whose `ruleId` starts
     with `native:` and which have no `mod_match_reviews` row, oldest first,
     honouring `limit`; a Bananasaurs event (with a trace) is excluded; a
     native event with a verdict is excluded; guild B's native event with the
     same `eventId` does not appear for guild A. Seed native events with
     `modCaseRepo.recordCaseEvent` using `ruleId: 'native:123'` and
     `actionTaken: 'native_blocked'`; look at `native-subscriber.test.ts` for
     the exact shape `recordCaseEvent` needs for a native event.
  2. `countVerdictsByRule`: seed rule A with two `false_positive`, one
     `true_positive`, one `unclear`; rule B with none; assert
     `{ A: { falsePositive: 2, truePositive: 1, unclear: 1 } }` and no key
     for B; guild B seeded with a colliding `eventId` and a verdict does not
     change A's counts.
  3. `countNativeBlocked`: two `native_blocked`, one `native_alerted` → 2;
     guild B's `native_blocked` not counted.
- [ ] **Step 2: Implement.** `listUnreviewedNativeHits`: `from(modCaseEvents)`
  `leftJoin(modMatchReviews, and(eq(guildId), eq(eventId)))`
  `where(scope.only(modCaseEvents, like(modCaseEvents.ruleId, 'native:%'), isNull(modMatchReviews.eventId)))`
  `orderBy(asc(modCaseEvents.at), sql\`mod_case_events.rowid\`)` `.limit(...)`.
  `countVerdictsByRule`: `from(modMatchReviews).innerJoin(modCaseEvents, …)`
  grouped by `(ruleId, verdict)`, folded into the record.
  `countNativeBlocked`: `count(*)` where `actionTaken = 'native_blocked'`.
  Import `like` from `drizzle-orm`.
- [ ] **Step 3: Run tests, gates, commit** —
  `git commit -m "feat(storage): native hits, verdict counts, native-blocked count (Slice 9 task 1)"`.

---

### Task 2: Ports (×4) and the review routes

**Files:**
- Modify: `packages/core/src/ops/ports.ts`, `packages/core/src/ops/test-fixtures.ts`, `packages/http/src/test-support.ts`, `apps/daemon/src/ops/wiring.ts`, `packages/storage/src/repos/automod-rule-lists.test.ts`
- Modify: `packages/http/src/routes/automod.ts`, `packages/http/src/routes/automod.test.ts`
- Modify: `packages/core/src/index.ts` (export the new type names)

**Interfaces — Produces:**

```ts
// ports.ts
export interface OpsVerdictCounts { readonly falsePositive: number; readonly truePositive: number; readonly unclear: number }
// OpsAutomodRuleSummary gains:
  readonly verdicts: OpsVerdictCounts;     // zeros when the rule has none
export interface OpsNativeHit { /* mirror NativeHit field by field */ }
listUnreviewedNativeHits(query: { readonly limit: number }): readonly OpsNativeHit[];
nativeBlockedCount(): number;
addAutomodAllowlistPhrase(input: { readonly ruleId: string; readonly phrase: string }): 'added' | 'already-present' | 'no-such-rule' | 'wrong-kind';
```

Routes added to `registerAutomodRoutes`:

| Method | Path | Guard | Capability | Body | 200 |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/automod/review` | require | config.read | query `ruleId?` (rule-id regex), `limit?` (1..200, default 50) | `{ matches: OpsReviewableMatch[], nativeHits: OpsNativeHit[], nativeBlocked: number, verdicts: Record<ruleId, OpsVerdictCounts> }` — `matches` from `listUnreviewedMatches({ ruleId, limit })`, `nativeHits` from `listUnreviewedNativeHits({ limit })` (ignores `ruleId`), `verdicts` from the summary list |
| POST | `/api/automod/review/:eventId/verdict` | require | config.write | `{ verdict, note? }` | `{ ok: true, outcome: 'recorded' \| 'recorded-with-label-conflict' }`; 404 on `'no-such-event'` |
| POST | `/api/automod/rules/:ruleId/suppress` | require | config.write | `{ kind: z.enum(['allowlist_phrase','invite_code','link_domain','channel_exemption']), value: z.string().min(1).max(200) }` — `value` additionally validated per kind: `invite_code` `/^[A-Za-z0-9-]{2,32}$/`, `link_domain` `/^[a-z0-9.-]{1,253}$/`, `channel_exemption` `snowflakeIdSchema` | `{ ok: true, outcome }` where `outcome` is the port's outcome string; 404 on `no-such-rule`; 409 `{ error: 'wrong-kind' }` when the rule's kind does not take that suppression |

`reviewedBy` for the verdict is the session's `accountId` (the same
attribution `dashboardAuditBase` uses). `link_domain` suppression calls
`addLinkDomain({ ruleId, domain: value, listType: 'allow' })`; `invite_code`
calls `addInviteAllowlistEntry({ ruleId, code: value, label: 'added from review' })`;
`channel_exemption` calls `addAutomodExemption({ ruleId, exemptType: 'channel', exemptId: value })`;
`allowlist_phrase` calls `addAutomodAllowlistPhrase`.

- [ ] **Step 1: Ports** — add the members and types; wire in the daemon
  (`addAutomodAllowlistPhrase` checks `findRuleKindAndConfig` for kind
  `keyword_filter` → else `'wrong-kind'`; pre-checks the phrase against the
  hydrated rule's `allowlist` for `'already-present'`); test-support (real
  repos); core fake (`unstubbed`); rule-lists test literal (`notNeeded`).
  `listAutomodRules` now merges `countVerdictsByRule` into each summary.
- [ ] **Step 2: Route tests first** in `automod.test.ts`, then the three
  routes. Tests: the review GET returns matches, native hits and the verdict
  split for this guild only (seed both guilds); a verdict records and the
  audit row names the event; a second verdict on the same event by the same
  account records (revision) and the counts move; 404 for an unknown event;
  suppression of each of the four kinds against a rule of the right kind
  returns 200 and the list/exemption shows it; `allowlist_phrase` against an
  `invite` rule → 409 `wrong-kind`; a malformed `value` → 400; 403 without
  `config.write`; guild B's session cannot record a verdict on guild A's
  event (404).
- [ ] **Step 3: Gates, commit** — `git commit -m "feat(http): review queue, verdict and suppression routes; ports x4 (Slice 9 task 2)"`.

---

### Task 3: Dashboard — the review page, its queue, verdicts, the tally and the bias warning

**Files:**
- Modify: `packages/dashboard/src/api/automod.ts`
- Modify: `packages/dashboard/src/app/routes.ts`, `packages/dashboard/src/app/Shell.tsx`, `packages/dashboard/src/app/Shell.test.tsx`
- Create: `packages/dashboard/src/pages/review.tsx`, `packages/dashboard/src/pages/review.test.tsx`

**Interfaces — Produces (in `api/automod.ts`):**

```ts
export interface VerdictCounts { falsePositive: number; truePositive: number; unclear: number }
// RuleSummary gains: verdicts: VerdictCounts
export type Verdict = 'false_positive' | 'true_positive' | 'unclear';
export interface ReviewableMatch { eventId; ruleId; memberId; at; matchedCategory; matchedSnippet; actionTaken; trace: string | undefined; fixtureContent: string | undefined }
export interface NativeHit { eventId; ruleId; memberId; at; matchedCategory; matchedSnippet; actionTaken }
export interface ReviewQueue { matches: ReviewableMatch[]; nativeHits: NativeHit[]; nativeBlocked: number; verdicts: Record<string, VerdictCounts> }
/** Kinds whose observe stream native AutoMod's three default rules filter first (spec F3, PR-56). */
export const NATIVE_OVERLAP_KINDS: readonly RuleKind[] = ['keyword_filter', 'mention_spam', 'rapid_spam', 'duplicate_message'];
export type SuppressionKind = 'allowlist_phrase' | 'invite_code' | 'link_domain' | 'channel_exemption';
/** The one-click suppression appropriate to a predicate kind (spec Slice 9), or undefined when the honest answer is "edit the configuration". */
export const suppressionFor = (kind: RuleKind): { readonly kind: SuppressionKind; readonly label: string; readonly prefillFromSnippet: boolean } | undefined;
//   keyword_filter → allowlist_phrase "Allow this phrase" (prefill)
//   invite         → invite_code     "Allow this invite code" (prefill)
//   link_domain    → link_domain     "Allow this domain" (prefill)
//   caps | emoji | attachment_type | mention_spam | rapid_spam | duplicate_message → channel_exemption "Exempt a channel" (no prefill)
//   regex          → undefined (narrow the pattern in the configuration)
```

- [ ] **Step 1: NAV and route.** Add `{ path: '/review', label: 'Review', status: 'built' }` after Automod; route `/review` → `ReviewPage`; extend `Shell.test.tsx`'s `it.each`.
- [ ] **Step 2: The page.** `PageHeader` title "Review", purpose "Every match
  nobody has ruled on yet. A verdict here is the evidence the release gate
  counts, and it labels the fixture the match came from." Loads
  `GET /api/automod/review?limit=50` (plus `&ruleId=` when the `?rule=`
  search param is set — `useSearch` from `wouter`) through `useResource`.
  Sections:
  1. **Tally** — a `DataTable` "Reviewed matches per rule": Rule (link to
     `/automod/:ruleId`), False positive, True positive, Unclear, Reviewed
     (sum), all numeric; one row per rule in `verdicts` **plus** any rule
     present in `matches` with no verdicts (zeros). Above it one sentence:
     "Release 2's gate is measured from these numbers (ADR 0042 §4): zero
     false-positive or unclear verdicts for a rule that feeds the escalation
     counter; at most 5% for a delete-only rule; at least 20 reviewed or a
     sign-off." Below it, when `nativeBlocked > 0`, the F3.2 warning as a
     `role="note"` paragraph with the hold border: "Native AutoMod has blocked
     {n} messages before any rule here could see them. For keyword, mention,
     rapid-message and duplicate rules the false-positive rate is measured on
     what native let through, not on real traffic." Rendered only when
     `nativeBlocked > 0` **and** at least one rule of a `NATIVE_OVERLAP_KINDS`
     kind appears in the queue or the tally (the page knows a rule's kind
     from `GET /api/automod/rules`; load it alongside).
  2. **Queue** — one `DataTable` "Unreviewed matches", oldest first: When,
     Rule (link), Member (link to `/members/:memberId`), Category, Evidence
     (the `fixtureContent` when present, else the `matchedSnippet` with a
     muted "(snippet only — the message is no longer held)" when absent),
     Trace (a native `<details>` with the raw JSON in a `<p>`, as
     `case.tsx` does), Verdict (three `Button`s: "False positive", "True
     positive", "Unclear"), Suppress (Task 4 — leave an empty cell now).
     Empty state: "Nothing to review. Matches recorded during the observe
     window appear here."
  3. **Native AutoMod hits** — a second `DataTable`, same columns minus Trace
     and Suppress, header note "Discord blocked these before any rule here
     saw them; a verdict records whether native was right." Empty state
     omitted when the section is empty (render nothing).
  A verdict click → `session.write('/api/automod/review/{eventId}/verdict', { verdict })`;
  success → toast "Verdict recorded" (or, on `recorded-with-label-conflict`,
  a `hold` toast "Verdict recorded — the fixture's label was reset because
  another rule's verdict on the same message disagrees") and reload. Buttons
  are `busy` while the request runs; no confirmation dialog (a verdict is
  reversible by re-verdict and changes no rule).
- [ ] **Step 3: Tests** (`review.test.tsx`): the tally renders one row per
  rule with the sums; the warning renders only when `nativeBlocked > 0`
  **and** an overlap-kind rule is present (three stubs: both true; blocked
  but only `regex` rules; not blocked); a match row shows fixture content
  when present and the snippet note when absent; clicking "False positive"
  posts `{ verdict: 'false_positive' }` to the right URL and reloads; native
  hits render in their own table with verdict buttons; `?rule=x` adds
  `&ruleId=x` to the request URL; empty queue text.
- [ ] **Step 4: Gates, commit** — `git commit -m "feat(dashboard): the review page — queue, verdicts, tally, bias warning (Slice 9 task 3)"`.

---

### Task 4: Dashboard — suppression actions, the verdict split elsewhere, and the Slice 8 residue

**Files:**
- Modify: `packages/dashboard/src/pages/review.tsx`, `packages/dashboard/src/pages/review.test.tsx`
- Modify: `packages/dashboard/src/pages/cutover.tsx`, `packages/dashboard/src/pages/cutover.test.tsx`
- Modify: `packages/dashboard/src/pages/automod-rules.tsx`, `packages/dashboard/src/pages/automod-rules.test.tsx`
- Modify: `packages/dashboard/src/pages/automod-rule.tsx`
- Modify: `packages/dashboard/src/pages/cases.tsx`, `packages/dashboard/src/pages/case.tsx`, `packages/dashboard/src/pages/member.tsx`

- [ ] **Step 1: Suppression per row.** The Suppress cell renders, from
  `suppressionFor(kindOf(ruleId))` (kind looked up from the rules list the
  page already loads): a `Button` with the action's label, or for `regex` a
  `Link` "Narrow the pattern" to `/automod/:ruleId`. Clicking opens
  `ConfirmDialog` with a `Field` for the value (prefilled from
  `matchedSnippet` when `prefillFromSnippet`, otherwise empty with the hint
  "channel ID") and a scope sentence per kind: allowlist_phrase → "Adds
  '{value}' to {ruleId}'s allowlist. Messages containing it will no longer
  match this rule, in every mode."; invite_code → "Allows invite code
  {value} for {ruleId}."; link_domain → "Allows domain {value} for
  {ruleId}."; channel_exemption → "Exempts channel {value} from {ruleId}
  entirely." `confirmLabel` is the action's label. Confirm →
  `writeOrThrow('/api/automod/rules/{ruleId}/suppress', { kind, value })`;
  409 `wrong-kind` → danger toast "That suppression does not apply to this
  rule's kind"; `already-present` → neutral toast "Already allowed";
  success → toast repeating the verb ("Phrase allowed", …) and reload.
- [ ] **Step 2: The split elsewhere.** `cutover.tsx`: replace the Reviewed
  column with three numeric columns False positive / True positive /
  Unclear (from `verdicts`) and keep Matches; `automod-rules.tsx`: the
  Reviewed cell reads "{sum} ({fp} fp)" and links to `/review?rule={ruleId}`.
  Tests updated.
- [ ] **Step 3: Slice 8 residue.** `automod-rule.tsx`: the Lists note becomes
  "The keyword word list is seeded and has no editor; the Review page adds
  allowlist phrases from real matches." `member.tsx`: one `wouter` import;
  import `statusBadge` from `./cases.js` (export it there) instead of
  duplicating; `case.tsx`: remove the unused `ModCase` re-export and the
  unrendered `fixtureId` field.
- [ ] **Step 4: Tests** (`review.test.tsx`): for a `keyword_filter` match the
  Suppress button reads "Allow this phrase", the dialog's input is prefilled
  with the snippet, and confirming posts `{ kind: 'allowlist_phrase', value }`
  to the rule's suppress URL; for a `regex` match the cell is a link to the
  rule; for a `caps` match the dialog input is empty and confirming posts
  `channel_exemption`; a 409 shows the wrong-kind toast.
- [ ] **Step 5: Gates, commit** — `git commit -m "feat(dashboard): one-click suppression, verdict split on the board, Slice 8 residue (Slice 9 task 4)"`.

---

## Self-review

- **Spec coverage.** One queue with both sources (Task 1–3); message, trace,
  verdict (Task 3); one-click suppression per predicate (Task 4) — the
  precise tier's "narrowed pattern" is a configuration edit and is linked,
  not faked; verdict writes back to fixtures (`recordVerdict`, unchanged);
  F3.2 warning (Task 3, PR-56); the numerator per rule split by verdict
  (Tasks 1–3), and surfaced on the board (Task 4).
- **Deferred with reasons (ledger):** `invite.last_matched_at` (PR-14) and
  the handwritten-fixture synthetic author — see PR-57 and PR-58.
- **Type consistency.** `VerdictCounts` is declared in storage (Task 1),
  re-declared as `OpsVerdictCounts` in core (Task 2), and mirrored as
  `VerdictCounts` in the dashboard (Task 3); `SuppressionKind`'s four values
  are the route's `z.enum` (Task 2).
