# Assistant web UI: first-run setup that actually works

Status: executed 2026-09-23 (owner decisions in ADR 0061)
Base: `origin/oc/assistant-pages` (1bc147b) · Work branch: `oc/assistant-webui-setup`
Source: the 2026-09-23 audit of `oc/assistant-pages`.

## Goal

A server owner who has never used Bananasaurs opens `/assistant` and can get the AI
answering members **from the web UI alone**, as far as the owner decisions below allow. At
every step, the page tells them the truth about what is and isn't working.

## Owner decisions (2026-09-23, ADR 0061)

- Provider terms records are created in the dashboard by the instance owner. The form has
  trains-on-input, a quoted clause, an https URL and production use; it sets the review
  date and is audited. Rule 5 is unchanged.
- The cost class (free / paid / not sure) is set in the dashboard and stored with the
  provider config. The cap stays $0.
- The key-encryption secret is auto-generated to `<DATA_DIR>/assistant-provider.key`
  (mode 0600) when the env var is unset. The env var still wins.
- Execution: opencode for UI and routes. The controller implements key-store, secret-file
  and audit code itself.

Out of scope: new pages (Evaluation, test scenarios) and an in-dashboard "send a test
question".

## Design direction (frontend-design pass)

This is an operator console with an established system: Tailwind tokens (`canvas`, `line`,
`ink-muted`, `accent`), the `Card`/`Badge`/`Field`/`HelpTip` kit, the banana illustration and
ADR 0059's plain-language bar. **No restyle, no new palette, no new fonts.** The existing
system is the brief.

**Spend the boldness in one place: the setup tracker on `/assistant`.** Today it is four
static tips in a grid. It becomes an honest, ordered checklist. It really is a sequence, so
numbering is earned. Each step:

```
┌ Set up the assistant ───────────────────────────── 3 of 5 done ┐
│ ✓ Connect an AI service        Gemini · gemini-2.5-flash       │
│ ! Confirm the service's terms  Needs the host: no terms record │
│                                 for Gemini yet. What this means ▸│
│ ✓ Choose who can ask it        Members, Execs                  │
│ ○ Choose what it can do        [Let these roles use the        │
│                                  everyday skills]  or Skills ▸  │
│ ○ Turn it on                   [Turn on Default assistant]      │
└────────────────────────────────────────────────────────────────┘
```

- States are computed on the server from real data, never inferred in the browser:
  done / needs you / needs the host / not started.
- The single action that finishes a step sits on that step's row. Anything larger links to
  the page that owns it.
- When every step is done, the tracker collapses to one line: "The assistant is answering
  members. Try it in Discord: @bananasaurs <question>".
- Quiet everywhere else: pages lose jargon, not gain chrome. No all-caps eyebrows added, no
  arrows appended to buttons, no new cards for decoration.
- Copy rules: sentence case; buttons say what happens ("Save AI setup" gives the toast "AI
  setup saved"); errors say what went wrong and how to fix it.

## Tasks

Global constraints for every task: the CLAUDE.md hard rules. In particular: guild scope on
every guild query; never log, return or audit the API key; a failing test before each fix;
and `npm run typecheck && npm run lint && npm run test` green.

### Task 1 — Secrets, wiring, schema (controller implements)
- Fix `buildDashboardApp` so it carries `assistantProviderConfig`. Add a daemon wiring test
  through `buildDashboardApp` that saves and reads back.
- Auto-generate the key file (ADR 0061 §3). `status()` gains `secretSource`
  (`env`/`file`/`missing`), `keyReadable`, `model` and `costClass`.
- Re-saving without a model keeps the saved one.
- One migration adds `assistant_provider_config.cost_class` (default `unknown`) and
  `provider_eligibility.evidence_clause` (nullable). `effective()` applies the cost class.
- Audit the provider PUT (never the key), server-card, memory-preferences and
  forget-member.

### Task 2 — Terms record and honest readiness (server)
- `PUT /api/providers/:provider/terms`, owner-only and audited. It writes the eligibility
  row including `evidence_clause`. `isEligible` also requires a non-empty clause for rows
  that have the column set; migration-seeded rows without a clause keep their behaviour.
- Eligibility warnings use the effective provider (store row, else env).
- `GET /api/assistant` returns `setup: { steps, answering }`. Steps: connected
  (provider+model+readable key), terms verified (eligible, production, not stale), cost
  class free, who can ask, what it can do, turned on. Each step has `state`
  (`done`|`todo`|`blocked`) and a plain `detail`.

### Task 3 — One-click starter grants (server)
- `POST /api/assistant/skill-grants/starter` with `{ roleIds }` grants every skill that is
  not owner-only and needs no confirmation. One transaction, one audit record, idempotent.

### Task 4 — AI setup page
- The form loads the saved state and never resets.
- Cost-class choice with a warning.
- Owner-only terms form (links to the provider's terms), with existing values prefilled.
- Plain errors. Remove the dead "Test connection" button.
- The eligibility card reflects the effective provider.

### Task 5 — `/assistant` first run
- The setup tracker, with inline actions and links.
- "Create a behaviour" works with zero behaviours.
- The default behaviour is created disabled, with the chosen roles.
- The AI status card is replaced by the tracker.

### Task 6 — Plain language and small fixes
- Skills copy, the prompt card intro and the Memory header.
- The Tag vs Mention role line; remove owner-only skills from the picker.
- Ticket sections only on IT behaviours.
- A compact grant list on mobile.

### Task 7 — Verification (controller)
- Gates, then drive the production `buildDashboardApp` harness from an empty database to
  `answering: true`, with screenshots at 1366 and 390.

## Execution

opencode-driven development: free models implement and review, and the controller writes
briefs, rules and verifies. Tasks 1 and 2 touch secret handling (the API key store and
audit) and need an explicit yes before dispatch.
