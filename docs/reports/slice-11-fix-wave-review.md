# Slice 11 fix-wave review — did the fixes close the findings?

**Branch:** `oc/slice-11-cutover` at `5624f8b`, merge-base `dc5cfcb` with
`main`. Fix-wave commits `dfebaa1..5624f8b` (5). Reviewed 2026-09-17 in the
worktree `.oc-worktrees/oc/slice-11-cutover`. Reviewer changed no file
except this one; two temporary probe tests were written, run, and deleted
(`git status` clean afterwards). Nothing was built in the main checkout.

Predecessor: `docs/reports/slice-11-whole-branch-review.md`
(SHIP-WITH-FIXES: I-1, I-2, M-1..M-7). Brief:
`.oc-runs/slice-11-cutover/fix-wave-brief.md`. Rulings S11-D3 and S11-D6 read
from `main`'s copy of the plan (the branch's copy is one commit stale, which
is expected and harmless — it is a docs file the merge will bring in).

## Verdict: APPROVED_WITH_NITS

All nine findings are closed, and every one of the load-bearing claims was
driven through the real command dispatcher or the real Fastify app against a
migrated database, not read. No third path to `enforce` exists. The fixes
disturbed nothing that already held. Three nits, none blocking.

## 1. I-2 / S11-D3 — driven

Probe: `createDispatcher` over the five real `OPERATOR_COMMANDS`, ports from
`opsPortsFor` with `setAutomodRuleCutoverMode` wrapped to count every call
whose `mode === 'enforce'`. Rule driven to `ready` via `automod observe` /
`legacy-ref` / `ready`, signed off with the production writer
`setEnforceSignOff`. Row assertions on `findRuleIncludingDisabled`.

The four wrong combinations, verbatim `data.reason | text`:

```
both     : contradictory-attestation | rule probe-rule cannot cut over with both --legacy-disabled and --no-legacy: they attest opposite facts — … Pass exactly one of the two, with --confirm
neither  : missing-attestation | rule probe-rule cannot cut over without an attestation: pass exactly one of --legacy-disabled (…) or --no-legacy (…), with --confirm
nolegacy+ref: legacy-ref-recorded | rule probe-rule records legacy rule carl-bot:caps, so --no-legacy contradicts the row — drop the flag to attest that rule disabled, or clear the ref first with `automod legacy-ref probe-rule --clear --confirm` if there is really nothing to disable
legdis+null : missing-legacy-ref | rule probe-rule records no legacy rule to disable (legacy_rule_ref is null) — … Set it with `automod legacy-ref probe-rule <ref> --confirm`, or pass --no-legacy …
PROBE port calls after 4 wrong combos: 0
PROBE refusal audits: ["missing-legacy-ref","legacy-ref-recorded","missing-attestation","contradictory-attestation"]
```

`enforce` port calls after all four: **0** — `setRuleMode` was never
reached. The row after the four (with the ref put back) `toEqual` its
before-image; the only column that moved was `legacy_rule_ref`, moved by
`automod legacy-ref --clear` on purpose. Zero `outcome: 'cutover'` audit
rows; four refusal rows, one per attempt.

The two right combinations:

```
ok no-legacy: rule probe-rule now enforces (cutover_state cutover); recorded as having no legacy rule (--no-legacy) | row: enforce cutover
audit: {"outcome":"cutover","legacyRuleRef":null,"legacyDisabledAttested":false,"noLegacy":true}

ok legacy-disabled: rule probe-rule now enforces (cutover_state cutover); legacy rule carl-bot:caps recorded as disabled by your --legacy-disabled attestation
audit: {"outcome":"cutover","legacyRuleRef":"carl-bot:caps","legacyDisabledAttested":true,"noLegacy":false}
```

`legacyDisabledAttested` is now `legacyDisabled` (the flag actually passed,
`automod.ts:1163`), so a `--no-legacy` cutover can never record `true`. The
check order in the command is: both-flags → neither → detail read →
already-cutover → disabled → `--no-legacy`+ref → `--legacy-disabled`+null →
port. Every refusal precedes the port call.

**I-2: CLOSED. M-4: CLOSED.**

## 2. I-1 / S11-D6 — driven, and the third-path hunt

Probe through `createServer` + `registerAutomodRoutes` with the real
`testPortsFor` (real repositories), `setAutomodRuleMode` wrapped to count
calls. The rule was driven to `ready` + signed off with the production
writers, and the gate confirmed passing **before** the request — this is the
case the fix-wave's own route test does not cover (it uses a `not_started`
rule, which the gate would have refused anyway):

```
PROBE-HTTP eligibility before: {"ok":true}
PROBE-HTTP enforce: 409 {"error":"use-cli","message":"Enforcement is a cutover; run `bananasaurs automod cutover <ruleId> --legacy-disabled --confirm` on the host, which records the attestation the dashboard cannot."}
PROBE-HTTP audit actions after enforce: []
PROBE-HTTP enforce+enabled: 409 {"error":"use-cli", …}
PROBE-HTTP observe: 200 {"ok":true} row: {… "mode":"observe", "cutoverState":"ready" …}
PROBE-HTTP test: 200 {"ok":true} row mode: test
PROBE-HTTP enabled-only: 200 {"ok":true}
```

Port calls after both `enforce` requests: 0; row `toEqual` before; no
`automod_rule.mode_set` audit row. `observe` and `test` reach the port (2
calls) and land. An `enabled`-only body (the post-flip shape: the dialog only
sends `mode` when `modeSel !== detail.mode`, `automod-rule.tsx:91`) still
works, so the M-3 refusal's advice — enable it from the rule page — is a
path that exists.

**Third path.** `rg` over `packages/`, `apps/`, `scripts/` (tests and
`dist` excluded):

- `automodRuleRepo.setRuleMode(` — called from exactly two production sites,
  `apps/daemon/src/ops/wiring.ts:325` (`setAutomodRuleCutoverMode`) and
  `:441` (`setAutomodRuleMode`), plus their twins in
  `packages/http/src/test-support.ts:300,378`. `test-support` paths are
  banned outside `*.test.ts` by `no-restricted-imports` (its own comment
  records that rule being watched firing).
- `ports.setAutomodRuleMode(` — one caller, `packages/http/src/routes/automod.ts:223`,
  now behind the `enforce` refusal at `:200`.
- `ports.setAutomodRuleCutoverMode(` — three callers, all in
  `packages/core/src/ops/commands/automod.ts` (`cutover` with `'enforce'` at
  `:1119`; `rollback` and `observe` with `'observe'` at `:1222,1354`).
- Every other `update(modRules)` in storage (`:514` config, `:789` ready,
  `:818` sign-off, `:855` legacy-ref) sets no `mode`. No raw
  `UPDATE mod_rules` outside test files. `createRule` always inserts
  `mode: 'test'`. The MCP package touches no rule repository. No other
  HTTP route accepts a `mode` field (`createRuleBodySchema` has none). No
  job, scheduler or daemon startup path calls `setRuleMode` with a mode
  (`daemon.ts:539` only mentions `{ enabled: false }` in a comment).
- `makeRuleEnforceableForTest` (`packages/storage/src/test-support.ts`) sets
  `cutover_state` + sign-off, not `mode`, and is import-banned from
  production.

**None found.** The port member `setAutomodRuleMode` still accepts
`'enforce'` in its type (`ports.ts:897`) — the refusal is in the route, not
the port. That is where the brief put it and it is the only caller, but see
nit N-3.

**I-1: CLOSED.**

## 3. M-1..M-7

| # | Status | Evidence |
| --- | --- | --- |
| M-1 | CLOSED | Driven: `not_started` → `… run \`automod observe\` first and wait out a new observe window before \`automod ready\` (cutover requires a ready rule)`; `observing` still → `run \`automod ready\` first`. Unit test per state added. |
| M-2 | CLOSED | Driven: second `cutover` on a `cutover` row → `already-cutover | … there is nothing to attest again. If this was wrong, run \`automod rollback\` first`; enforce port calls stayed at 1, success audit rows stayed at 1. |
| M-3 | CLOSED | Driven: rule `ready` + signed off, `setRuleMode({ enabled: false })` via the production path, then `cutover` → `rule-disabled | … Enable it on the rule page first (the mode dialog's Enabled checkbox) …`; port not called; row stayed `ready`/`observe`; no success audit row. `enabled` comes from the row (`automodAdminRepo.findRule` → `row.enabled === 1`), no port change was needed. |
| M-4 | CLOSED | See §1 — either flag alone is the attestation. |
| M-5 | CLOSED | Driven: `legacy-ref probe-rule x --clear` → `contradictory | automod legacy-ref takes either a <ref> or --clear, not both …`; row ref stayed `carl-bot:caps`. |
| M-6 | CLOSED | `git diff main..HEAD -- docs/17` no longer touches the three `provider review` continuation lines. |
| M-7 | CLOSED | `wiring.test.ts` now reads `effectRepo.tailAudit` after `cutover` (asserts `legacyRuleRef`, `legacyDisabledAttested: true`, `noLegacy: false`) and after `rollback`, and holds guild B's row `toEqual` its before-image after every one of the five commands. My probe repeated the cross-guild check independently: `guild B unchanged after 5 commands under A: true`. |

Every file changed by the fix wave (9) is in the brief's Files list.
Branch-side changes vs the merge-base: 17 files, all inside the original
brief plus the I-1 widening.

## 4. What already held, re-driven

Verbatim from the probe:

```
observe@observing : already-observing | rule probe-rule is already observing; the clock is untouched (started 2023-11-14T23:14:20.000Z)      (clock advanced 5,000 s; observe_started_at unchanged, asserted)
rollback@observing: not-cutover
rollback@ready    : not-cutover
rollback@rolled_back: not-cutover | … rollback only moves a cutover (enforcing) rule back to observing
cutover@rolled_back: cutover-state | … it is rolled_back, so a fresh observe window is owed — run `automod observe` and wait out a new window before `automod ready`   (row stayed rolled_back)
ready@rolled_back : not-observing | … must be observing (ADR 0042 …)   (row stayed rolled_back)
observe@rolled_back: rule probe-rule is now observing — clock reset; the observe floor elapses on 2023-11-28T23:14:20.000Z   (start + 14 d)
rollback(ref) line1: rule probe-rule rolled back to observing — the guild is unprotected until you re-enable the legacy rule (carl-bot:caps) by hand in the other bot
rollback(no ref) line1: rule probe-rule rolled back to observing — the guild is unprotected; no legacy rule was recorded (--no-legacy at cutover), so there is nothing to re-enable by hand
```

`rollback` from `cutover` landed `mode: 'observe'`, `cutover_state:
'rolled_back'`, `enforce_signed_off_by: null` (Amendment 2 still honoured).
Guild B's row was `toEqual` its before-image at the end of the full
sequence.

## 5. The dashboard

`automod-rule.tsx:285`: `disabled={mode === 'enforce'}` unconditionally;
`:292-294` renders `Enforce is unavailable here: <ENFORCE_CUTOVER_NOTE>`
unconditionally, naming `bananasaurs automod cutover`. The page test now
runs both eligibility shapes (`ok: true` and a refusal) and asserts the
radio is disabled, `test`/`observe` are not, and the note text renders.

Other affordances: the only write to `/mode` in `packages/dashboard/src` is
`applyMode` (`:103`), whose body carries `mode` only when `modeSel` differs
from `detail.mode`, and `modeSel` can only be set by the radios — so the page
can post `enforce` only if the rule is already `enforce`, in which case
`modeChanged` is false and `mode` is omitted. No list-page action, board or
bulk control posts a mode. A 409 without a `refusal` field surfaces as
`err.message`, which `ApiError` sets from the body's `message` (`api.ts:40`),
so the route's sentence is what the toast shows.

## 6. Gates and constraint

| Gate | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | 0 `error TS` |
| `npm run lint` | 0 | 0 errors/warnings; "All matched files use Prettier code style!" |
| `npm run test` | 0 | 175 files, 3,395 tests passed |

- `setRuleMode` body (69 lines, `export const setRuleMode = …` through its
  closing `});`) extracted from `main` and `HEAD`: `cmp` identical, SHA-256
  `1031db7f84eff2df78b4a87d076c4dca2e84f001405c661b6c22b1a2fa55259b` on
  both — matches the predecessor's `1031db7f…5259b`.
- `git diff --name-only main..HEAD` over `packages/core/src/mod`,
  `packages/core/src/automod`, `packages/core/src/effects/gateway.ts`,
  `packages/storage/src/schema.ts`, `drizzle` → **0 files**. The fix wave
  touched nothing under `packages/storage`.
- Worktree `git status` clean after probe deletion.

## New findings

None at Important or above. Three nits:

**N-1 (nit).** The `use-cli` refusal sits before `guard.requireFresh`
(`routes/automod.ts:200` vs `:215`), so an anonymous
`POST …/mode { mode: 'enforce' }` answers 409 rather than 401 — driven:
`PROBE-HTTP anonymous enforce: 409`. Nothing is read or written and no
capability is consulted, and the existing 400 `bad-request` already sits in
the same pre-auth position, so this is consistent with the file; it only
discloses that the route exists. Moving the block below `requireCapability`
would make every 409 from this route post-auth. Owner's call.

**N-2 (nit).** The route message and `ENFORCE_CUTOVER_NOTE` both give the
example as `--legacy-disabled --confirm`. Under corrected S11-D3 the flag is
`(--legacy-disabled | --no-legacy)`; an operator following the note on a
new rule gets `missing-legacy-ref`, whose text does name `--no-legacy`, so
the path self-corrects in one step. Wording only.

**N-3 (nit).** `packages/dashboard/src/api/automod.ts:144`
(`modeScopeSentence`'s `request.mode === 'enforce'` branch) is now
unreachable from the page. Harmless dead text; out of the brief's Files
list, so correctly left alone.

Not a finding, for the record: the fix-wave route test proves the 409 on a
`not_started` rule; the gate-passing case was proven only by my probe. A
one-line strengthening (drive the rule to `ready` + sign-off first, as the
`wiring.test.ts` composed test does) would pin the property the brief
actually asked for. Optional.

## RESULT
Status: APPROVED_WITH_NITS
Findings closed: 9 of 9, no exceptions (I-1, I-2, M-1, M-2, M-3, M-4, M-5, M-6, M-7 all CLOSED with driven evidence)
Third path to enforce: none found — `setRuleMode` has two production callers (`wiring.ts:325` CLI cutover port, `wiring.ts:441` dashboard mode port); the only caller of the latter is the route, which now refuses `enforce` before the port; no other write to `mod_rules.mode` exists in storage, HTTP, MCP, jobs or daemon startup; test-support helpers are import-banned from production
New findings: N-1 nit — `use-cli` 409 answers before auth (anonymous request gets 409 not 401; nothing read or written); N-2 nit — route/page example command shows only `--legacy-disabled`, not the either-flag form; N-3 nit — dead `enforce` branch in dashboard `modeScopeSentence`
Gates: typecheck 0, lint 0, test 0, 175/3395
Constraint: clean — forbidden paths 0 files vs main; setRuleMode SHA 1031db7f84eff2df78b4a87d076c4dca2e84f001405c661b6c22b1a2fa55259b identical on main and HEAD; git status clean
Concerns or questions: (1) The fix-wave's own route test uses a `not_started` rule, so the repo's tests do not pin "gate-passing rule still gets 409"; my probe did, and the code makes it structurally true (refusal precedes the port), but a one-line test strengthening would be cheap. (2) The port type `setAutomodRuleMode` still admits `'enforce'`; the restriction lives in its one caller. Acceptable while it has one caller — if a second dashboard route ever calls it, the refusal must travel with it (the same shape ADR 0042 §3 warned about, one layer up). (3) The branch's copy of the Slice 11 plan is one commit behind `main`'s corrected rulings; the merge resolves it, nothing to do on the branch.
