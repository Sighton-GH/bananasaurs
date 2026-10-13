# P5 parallel unit 5c

Base: d318fb292577a15c56a506e490e0f77e87a35d5c. Branch: oc/p5-u5c.

## Source choices

- Installed Zod 3.25.76 inspected. Form uses actual object shapes and number checks. Optional/default wrappers are unwrapped for display only. No parse, default injection, unknown-key stripping or server validator replacement on field edits. Empty numeric edits remain empty strings, never zero. Explicit optional clear deletes only that key.
- Core additions are runtime exports, not type-only as the old plan claimed. Only caps, rapid spam, invite, link domain, mention spam and emoji schemas added; keyword's empty strict schema was already exported.
- Regex and duplicate-message schemas share modules with node:vm/node:crypto. Honest JSON fallback instead of exposing them, accepted by lead. Attachment type uses object refinement (ZodEffects), so also falls back instead of discarding refinement or copying server validation.
- Every RuleKind uses a supported existing schema or opens Advanced with the JSON fallback explanation. Empty keyword schema uses the plan's Lists message. Lists/exemptions stay separate unchanged operations.
- Existing page needs no move-only commit. No shared kit, Shell, common notes or ledger edits.
- Example uses kit CodeBlock/Button. Copy adds a status region, so existing success test finds the same toast text in its status ancestor rather than assuming one global status. No request/guard assertion weakened.
- New 400 fixture corrected to include required API error key; otherwise API intentionally maps it to unreadable-response.

## Request audit

URLs/methods/bodies, confirmation scope, enabled asymmetry, session reauthentication, CSRF and server configuration validation unchanged. Tests cover structured/Advanced round trip preserving hidden keys, parse failure no-write/input retention, server 400 retention and exact confirmed PUT { config }. Exemption paths/values remain unchanged; type selector uses RadioGroup.

## Red/green and gates

- Baseline npm ci exit 0, Node 22.23.3. Baseline force/all typecheck exit 0. Baseline browser build exit 0 with 13 existing externalizations (11 crypto, one net, one vm). Baseline full lint/root exceeded per-call limit: NOT PASS. Lead routed continuation test-first and will run a fresh final-candidate root suite.
- Red: serial Vitest schema-form.test.tsx + automod-rule.test.tsx exit 1, missing form and five new page failures; nine existing page tests passed.
- Implementation round 1: exit 1, 18/20 tests. Fixed exactOptional labels typing, status lookup and malformed 400 fixture. Focused round 2 exit 0, 2 files / 20 tests.
- Final gates tracked in raw logs/exit sidecars and final handoff report; no inferred PASS.
- Native physical 360/1440, actual 100/200% light/dark, pixels, keyboard and screen-reader speech pending on composition. No visual/native accessibility/live Discord/phase-completion claim.

## Repair round 1

Whole Dashboard run exposed a consumer regression: example CodeBlock's status region existed even inside a closed disclosure, so automod-rules' unchanged success assertion found two status regions. Render CodeBlock only once the example disclosure opens. Do not edit the other unit's consumer test. Fresh focused and whole Dashboard gates required on this repair; initial run is evidence only, not PASS.

Repair also scopes the word-list empty-schema message to keyword rules only; invite's empty schema says it has no settings without implying a word list. Added exact CSRF header, parse-error summary focus, Advanced-open and hidden-form assertions. No request assertions removed.

Initial exact ESLint run found four owned-code/test typing issues (Zod unwrap return, unnecessary array/input assertions, test URL stringification). Fixed without suppressions. Fresh repair focused run includes the unchanged automod-rules consumer: exit 0, 3 files / 26 tests. Initial whole Dashboard exit 1, 122 files passed/1 failed, 1347 tests passed/1 failed; fresh whole package rerun required.

Fresh repair whole Dashboard exit 0: 123 files / 1,348 tests. Fresh repair force/all typecheck exit 0. Repair build/full lint still awaited when saving this reversible checkpoint; do not accept the repair commit until fresh build/lint and parent root pass. This checkpoint is explicitly unfinished under the contract's before-repair-commit gate rule, preserved to continue safely across the run boundary.

## Coordinated dependency declaration fix

Independent source review found the runtime form imports Zod but Dashboard did not declare it. Lead approved the minimal ownership exception: declare the existing ^3.24.1 in Dashboard and its workspace lock entry, retaining locked 3.25.76 without a duplicate copy or upgrade. Zod is needed to introspect the actual core schema instances, rather than copying validation or relying on an undeclared hoisted dependency. Fresh npm ci/typecheck/Dashboard lint/pages+form tests/build/dependent gates and npm ls zod required for this separate fix commit.
