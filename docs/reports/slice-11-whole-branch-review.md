# Slice 11 whole-branch review — the cutover drivers

**Branch:** `oc/slice-11-cutover`, 8 commits off `main` at `dc5cfcb` (merge-base
confirmed; `main` has since added the Slice 12 plan, which is why a naive
`git diff --stat main..HEAD` shows one docs file "deleted" — it is not on this
branch). Reviewed 2026-09-17 in the worktree
`.oc-worktrees/oc/slice-11-cutover`. Reviewer changed no file except this one;
two temporary probe tests were written, run, and deleted (`git status` clean
afterwards).

## Verdict: SHIP-WITH-FIXES

The gate holds. I could not find a path to `mode = 'enforce'` that skips
`enforcementEligibility` — every path in the codebase goes through
`setRuleMode`, whose body is byte-identical to `main`'s, and all four refusals
are reachable and refusing through `automod cutover` against real rows.

What I did find is that the slice's **attestation is not a property of the
system** — it is a property of one of `setRuleMode`'s two production callers.
The other caller, Slice 8's dashboard mode dialog, has been on `main` since
2026-09-13 and reaches `enforce` with a fresh password and nothing else. The
plan's premise ("`setRuleMode` has no production caller") was already false
when it was written; `docs/STATE.md:121` says so. That is the finding to fix
before flip day, and it needs a brief amendment because the fix lives in files
this brief forbade.

Two Important findings, both with a small fix; seven Minor.

## Gates (worktree, one at a time)

| Gate | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | 0 `error TS` |
| `npm run lint` | 0 | 0 errors / warnings |
| `npm run test` | 0 | 175 files, 3,387 tests, all passed |

## Constraint check

- **Forbidden paths untouched:** `git diff --name-only main..HEAD` over
  `packages/core/src/mod`, `packages/core/src/automod`,
  `packages/core/src/effects/gateway.ts`, `packages/storage/src/schema.ts`,
  `drizzle`, `packages/dashboard` → 0 files. No migration.
- **`automod-rules.ts` is append-only:** one hunk, `@@ -824,3 +824,37 @@`,
  0 removed lines.
- **`setRuleMode` body byte-identical:** extracted the function (69 lines,
  `export const setRuleMode = …` through its closing `});`) from `main` and
  `HEAD`; `cmp` reports identical, SHA-256
  `1031db7f…5259b` on both.
- **Files changed vs merge-base:** 13, every one in the brief's Files list.
  `docs/STATE.md` and `docs/17` are the two docs.

## Findings

### Critical

None.

### Important

**I-1. A second production path to `enforce` bypasses the attestation and the
legacy-ref precondition — and the plan, STATE and S11-D6 all rest on the
premise that it does not exist.**

`POST /api/automod/rules/:ruleId/mode` (`packages/http/src/routes/automod.ts:189`)
accepts `{ mode: 'enforce' }` (`setModeBodySchema`, line 34), needs
`config.write` plus a fresh password, and calls `ports.setAutomodRuleMode` →
`automodRuleRepo.setRuleMode` (`apps/daemon/src/ops/wiring.ts:436`). The
dashboard's rule page offers the `enforce` radio, enabled whenever
`detail.eligibility.ok` (`packages/dashboard/src/pages/automod-rule.tsx:53,275`).

Evidence — probe through the real Fastify app and real repositories, rule
driven to `ready` + signed off with production writers, `legacy_rule_ref`
never set:

```
PROBE6 status: 200 {"ok":true}
PROBE6 row: enforce cutover legacyRuleRef= null
PROBE6 audit: automod_rule.mode_set after={"mode":"enforce"}
```

So on flip day the owner has two buttons that end the observe window: the CLI
one refuses without `--legacy-disabled` and a recorded ref and writes
`legacyDisabledAttested: true` plus the ref to the audit trail; the browser one
asks for neither and records neither. ADR 0042 §3 predicted this shape exactly
("a check a caller must remember to make will eventually be forgotten by the
dashboard") — the slice put its precondition in the caller, and the other
caller forgot it.

This is **pre-existing on `main`, not introduced by the branch**, which is why
it is Important rather than Critical — the actual safety invariant
(`enforcementEligibility`) holds on both paths, and the attestation is an
owner's note the database cannot verify anyway (S11-D2 says as much). But the
branch is the one that makes the attestation *the* mechanism and documents it
as such, and three claims in the branch are false as a result:

- Plan: "What does not exist is any production caller of `setRuleMode`."
- `docs/STATE.md` (this branch's paragraph): "give `setRuleMode` its first
  production callers" — contradicted by `docs/STATE.md:121`, which records
  Slice 8 wiring "their first production callers".
- S11-D6: "The dashboard's cutover board stays read-only … Driving the
  transition from a browser is a larger surface — CSRF, reauth, a button that
  ends an observe window … Not this slice." The *board* is read-only; the
  *mode dialog* already drives every arrow from a browser, with exactly that
  button.

**Fix (needs a brief amendment; touches `packages/http/src/routes/automod.ts`
and `packages/dashboard`, both forbidden here):** the route refuses
`mode: 'enforce'` with 409 `{ error: 'use-cli' }` and the dialog disables the
`enforce` radio with a sentence pointing at `automod cutover`. `observe`,
`test` and `enabled` stay in the dashboard. One route test (enforce → 409,
row unchanged, no audit row) and one dialog test. Then rewrite the STATE
paragraph and S11-D6 to say what is true: the dashboard *was* the first
caller, and this slice makes the CLI the only caller that may cut over.
Alternatively the dialog collects the attestation itself — larger, and the
CSRF/reauth surface S11-D6 worried about is already there, so I would not.

**I-2. `--no-legacy` silently overrides a recorded `legacy_rule_ref`, and the
audit row records both facts at once.**

`automod.ts` cutover: the check is
`if (detail.legacyRuleRef === null && !noLegacy)`. When the ref is set and
`--no-legacy` is passed, nothing refuses.

Evidence — composed probe through `opsPortsFor` and the real repositories,
rule `ready` + signed off, ref `carl-bot:caps` recorded via
`automod legacy-ref`:

```
PROBE1 text: rule probe-rule now enforces (cutover_state cutover); recorded as having no legacy rule (--no-legacy)
PROBE1 row: enforce cutover carl-bot:caps
PROBE1 audit after: {"outcome":"cutover","legacyRuleRef":"carl-bot:caps","legacyDisabledAttested":true,"noLegacy":true}
```

The command's text says the rule has no legacy rule; the row says it does; the
audit row says it was attested disabled *and* that there was nothing to
disable. `automod rollback` afterwards would name `carl-bot:caps` as the thing
to re-enable. This is the S11-D3 escape hatch being too easy: `--no-legacy` is
meant for "a genuinely new rule with nothing to disable", and a recorded ref is
the row saying otherwise.

**Fix (in scope: `automod.ts` + one test):** refuse when
`detail.legacyRuleRef !== null && noLegacy` — "rule X records legacy rule
`carl-bot:caps`; drop `--no-legacy`, or clear the ref first with
`automod legacy-ref X --clear --confirm` if it is wrong". Usage answer, port
never called, audited like the other refusals.

### Minor

**M-1. The `cutover-state` refusal from `not_started` names a command that
will itself refuse.** `renderCutoverRefusal` says "run `automod ready` first"
for every state but `rolled_back`; `setRuleReady` refuses from `not_started`.
Probe output: `PROBE3 not_started: … run \`automod ready\` first (cutover
requires a ready rule)`. S11-D4's promise is "the command that would change
it"; for `not_started` that is `automod observe`, then the floor, then
`ready`. One more branch in the switch.

**M-2. `cutover` on an already-`cutover` rule succeeds again.** The gate
permits `cutover` (by design — it is what lets `enabled` be toggled), so the
command writes a second `automod.rule.cutover` attestation row and prints
"now enforces". Probe: `PROBE3 cutover@cutover: rule probe-rule now enforces
(cutover_state cutover); legacy rule carl-bot:caps recorded as disabled…`.
Harmless to the row; misleading in the trail. A usage answer
(`already-cutover`) before the port call, like `observe` from `observing`,
would keep one attestation per cutover.

**M-3. `cutover` does not look at `enabled`.** (By reading, not run.) A rule
with `enabled = 0` passes the gate, lands on `mode = 'enforce'`, and the
command says "now enforces" while the engine ignores it. The pre-existing
hazard `enforcement-gate.ts:241` documents then applies: re-enabling later via
the dashboard passes no `mode`, so the gate is not consulted. The command
should at least say "(rule is disabled; it enforces once enabled)" — or refuse.

**M-4. `--legacy-disabled` is required even with `--no-legacy`** (the brief
specified this; contesting S11-D3): for a new rule the operator attests to
having disabled a rule that does not exist. The two flags are alternatives —
"I disabled it" / "there is nothing to disable" — and one-of-two required
would read more honestly than both-required. Low priority; the brief's shape
is at least not permissive.

**M-5. `automod legacy-ref` has no state precondition and `--clear` wins over
a supplied `<ref>` silently.** The ref of a `cutover` rule can be changed or
cleared after the attestation, so the `automod.rule.cutover` row and the later
`rollback` first line can name different rules. Acceptable — the trail has
both — but `ref` + `--clear` together should be a usage answer.

**M-6. `docs/17_OPERATOR_ACCESS.md` re-indents three unrelated lines.** The
`provider review` continuation comments gained one leading space (47 → 48),
now misaligned with every other continuation line in the block. Stray edit;
revert.

**M-7. The composed test asserts `mod_rules` rows but not `audit_events`
rows, and has no cross-guild case.** The unit tests cover audit via the stub
and the repo test covers `setRuleLegacyRef`'s partition; my probe covered the
five commands cross-guild (below). Acceptable as is; one `tailAudit`
assertion in `wiring.test.ts` would close the "audited in a stub only" gap
M4 taught.

## What I attacked and what held

**Paths to `enforce`.** `rg` over production code: `setRuleMode(` is called
from `wiring.ts:325` (this slice), `wiring.ts:441` (Slice 8 dashboard port),
and their `packages/http/src/test-support.ts` twins. Nothing else writes
`mod_rules.mode`. Both callers pass through the gate. `setRuleLegacyRef` is a
plain `UPDATE` of `legacy_rule_ref` + `updated_at` under `scope.only`; it
cannot touch `mode` or `cutover_state`.

**The four refusals through the command, real verdict rows** (composed probe,
`opsPortsFor` + real repositories, `mod_case_events` + `mod_match_reviews`
seeded via `modCaseRepo` / `modMatchReviewRepo`): 

```
cutover-state       : rule probe-rule cannot cut over from cutover_state observing; run `automod ready` first …   (row stayed observing)
low-volume-unsigned : … only 0 of 20 required matches reviewed and no sign-off recorded; run `automod signoff` …  (row stayed observe)
false-positive      : … 1 of 25 reviewed matches are false positives (unclear counts as one); review them with `automod review`  (counts_as_violation=1, one unclear; row stayed observe)
rate-too-high       : … false-positive rate 0.08 is above its threshold 0.05; review more matches with `automod review` …  (delete-only, 2 of 25; row stayed observe)
```

**The attestation flag.** Raw requests with `'legacy-disabled'` as `"true"`,
`1`, `"yes"`, `null` → `bad-request: legacy-disabled: Expected boolean,
received …`; absent → `missing-attestation`, port never called; `--confirm`
absent → `needs-confirm` before argument validation. The CLI parser
(`packages/cli/src/args.ts`) sets a boolean flag to literal `true` only when
the token is present and takes no value. The order of checks in `cutover` is
flag → detail read → ref check → port; the port is not reached before the flag
is verified (unit test proves it by leaving the port unstubbed).

**The arrows, both directions** (composed probe, row assertions):

- `observe` from `observing`: refused, `observe_started_at` unchanged after
  advancing the clock 5,000 s — `doctor`'s past-floor check keeps its
  reference point.
- `observe` from `ready`: refused ("already past observing"), row stays
  `ready`, clock unchanged.
- `rollback` from `ready` (and, by unit test, `not_started`, `observing`,
  `rolled_back`): refused, row unchanged.
- `rollback` from `cutover`: row → `rolled_back`, `mode = 'observe'`,
  `enforce_signed_off_by = null` (Amendment 2 honoured by `setRuleMode`).
- `cutover` from `rolled_back`: gate refusal `cutover-state rolled_back`,
  text says run `automod observe` and wait out a new window; row unchanged.
- `ready` from `rolled_back`: refused (the retry-undo defence, PR-27).
- `observe` from `rolled_back`: row → `observing`, `observe_started_at` =
  the new clock, text `clock reset; the observe floor elapses on
  2023-11-28T22:13:28.000Z` — start + 14 d exactly.

**`rollback`'s first line** (verbatim from the probe):
`rule probe-rule rolled back to observing — the guild is unprotected until you
re-enable the legacy rule (carl-bot:caps) by hand in the other bot`. First
line, names the ref. The `--no-legacy` variant says there is nothing to
re-enable.

**Audit.** Every command returns an audit record on every branch, including
refusals; the dispatcher throws if a write returns none. `subjectType:
'mod_rule'` matches `ready`/`signoff`. Row contents: `legacyRuleRef` is
operator-typed text (≤200 chars, Zod-bounded), refusals are numbers and a
state enum, `floorElapsesAt` a timestamp. Nothing sensitive. The attestation
is recorded: `{"outcome":"cutover","legacyRuleRef":"carl-bot:caps",
"legacyDisabledAttested":true,"noLegacy":false}`. On S11-D2's durability:
`rg` finds no `delete(auditEvents)` / `DELETE FROM audit_events` anywhere, so
the audit row is not subject to retention pruning — the "audit trail is the
record" ruling stands.

**Guild scope.** A rule created in guild B, named under a dispatcher scoped to
guild A: `observe`, `legacy-ref`, `cutover`, `rollback` → `no-such-rule`;
`ready` → `not-observing` (pre-existing: a missing row reads as
`not_started`). Guild B's row `toEqual` its before-image after all five. The
new repo function is `scope.only` on its one statement; the port reads back
through the scoped `findRuleIncludingDisabled`.

**Composition.** `wiring.test.ts`'s new suite dispatches real
`OPERATOR_COMMANDS` through `createDispatcher` with `opsPortsFor` over a
migrated database, and every state assertion is on
`findRuleIncludingDisabled(...)`, not on text. It reaches `setRuleMode` for
real: the refusal in the middle is the gate's own `low-volume-unsigned`, and
the row is asserted unchanged after it, then `mode: 'enforce'` after the
sign-off. This is the test that would have caught the M4-shaped defect, and
the probe above re-ran the same path with the other three refusals.

## Rulings, contested

- **S11-D1** (three named commands) — right. Each refusal names its own next
  step; a generic `automod mode` could not.
- **S11-D2** (attestation as audit row, no column) — stands. No migration on
  the moderation table mid-window is the correct trade, the row is durable
  (no pruning path), and a column could not be verified either. But note I-1:
  the ruling assumes the CLI is the only writer, and it is not.
- **S11-D3** (`--no-legacy` escape hatch) — **too easy** in one specific way
  (I-2): it should be refused when a ref is recorded. M-4 is the smaller
  oddity that both flags are required together.
- **S11-D4** (refusals in the operator's words) — delivered for four of five
  cases; M-1 is the `not_started` sentence naming a command that refuses.
- **S11-D5** — verified verbatim above; both the first line and the reset
  date are right.
- **S11-D6** (dashboard stays read-only) — **premise false** (I-1). The board
  is read-only; the dialog is a full driver.
- **S11-D7** (one rule, one transaction) — holds; no `--all`, one `write(...)`
  per command.

**The port-name deviation** (`setAutomodRuleCutoverMode` beside Slice 8's
`setAutomodRuleMode`): the implementer's reasoning is correct — narrowing the
existing member would have broken the dashboard route test that pins
`toEqual({ ok: true })`, in files this brief forbade. But answering the
question asked: **yes, the existing member is a second path to `enforce` that
bypasses this slice's checks.** That is I-1.

## Fix list, in order

1. **I-2** — refuse `--no-legacy` when a ref is recorded; test. (This branch,
   in scope.)
2. **M-1, M-2, M-6** — the `not_started` sentence, `already-cutover`, the
   docs/17 whitespace. (This branch, in scope.)
3. **I-1** — dashboard route refuses `mode: 'enforce'`; dialog says use the
   CLI; STATE paragraph and S11-D6 rewritten. (Brief amendment: needs
   `packages/http/src/routes/automod.ts`, `packages/dashboard`; can be a
   Slice 11b on the same held branch, before flip day.)
4. **M-3, M-4, M-5, M-7** — owner's call; none blocks merge.
