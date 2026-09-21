# Release 3 assistant scope

Reconciled 2026-09-20 against `docs/08_ROADMAP.md`, the Release 2/MCP pull-forward and the current repository.

## Already in Release 2 or MCP

- Owner-enabled Discord archive ingestion, attachment policy and retention.
- SQLite full-text search and the owner-only MCP read surface.
- Audit, permission and job infrastructure that Release 3 reuses.

Release 3 does not duplicate these. It adds the member-facing, permission-filtered assistant layer and gives every assistant control a dashboard home.

## Invocation behaviours

Each guild can configure reviewed behaviours selected by one invocation surface. Initial surfaces are `@bananasaurs`, `@it-services` and explicit commands. A behaviour owns its system prompt, resource set and skill allowlist. Owners edit system prompts in the dashboard with validation, visible revisions and conflict-safe writes. If one message invokes several configured tags, the request fails closed rather than merging personas.

The default club behaviour answers sourced questions in Canadian English. The IT services behaviour prioritises exact diagnostics, access steps and escalation, and cannot invent credentials or claim an access change occurred.

## Skills

The initial permission-aware catalogue is:

- search club knowledge with permission-filtered citations;
- link reviewed club resources;
- create and cancel reminders;
- deliver due reminders through a durable, idempotent job;
- draft decision records for review; and
- review plans against club sources;
- guide onboarding with sourced next steps;
- draft meeting agendas, summaries, announcements and handoffs; and
- draft event checklists with owners, dependencies and deadlines.

The model receives only the intersection of the behaviour allowlist and the invoking member's permissions. Read, draft, schedule and send effects stay distinct. Confirmation is required before a new schedule or durable record is created. Skill attempts and outcomes belong in the dashboard activity view.

## Context and resources

The compiler uses a reviewed server card, enabled guild resources and accessible retrieved evidence. Evidence is delimited and labelled untrusted. Inaccessible evidence is removed before prompt compilation; its existence is not disclosed. A disclosure plan records the source identifiers selected for the response.

The resource registry supports reviewed websites, documents, Discord channels, repositories and notes. URLs require HTTPS and reject credentials, private addresses and local hosts before fetch; the production fetcher must also pin public DNS results through the request. The SFU Racerbot website is the first reviewed club resource.

## Reminders and schedules

A reminder records creator, guild, destination, text, due time, state and a stable dedupe key. Delivery claims due reminders, sends once through the Discord effect boundary, and records success or failure. The dashboard shows pending deliveries, destination and state and supports creation, cancellation and review.

## Dashboard ownership

- **Assistant**: invocation behaviours, tag mapping, system prompts and test scenarios.
- **Skills**: catalogue, per-behaviour allowlists, required permissions, confirmation class and recent activity.
- **Schedules**: reminders, destinations, next run, status, failures and cancellation.
- **Resources**: sources, freshness, scope and fetch health.
- **Context**: server card, reviewed memory and disclosure traces.
- **Providers**: free-only profile eligibility, privacy scan result, usage and degraded state.
- **Evaluation**: golden questions, inaccessible-channel traps, prompt injection and citation leakage.

No AI control is terminal-only. The current branch includes the first dashboard assistant workspace and activity view. Persistence/API wiring, Discord interaction routing, resource fetching, provider execution, `/ask`, `/find`, `/remind`, `/decision`, `/review-plan`, privacy commands and golden evaluations remain required before the release gate can be claimed.

## Release gate

Release 3 is complete only when all original roadmap bullets are implemented, every new capability has a dashboard path, the golden suite finds no permission leak, provider failure leaves Releases 1 and 2 working, and actual desktop/mobile pixels plus end-to-end Discord behaviour are reviewed. Provider adapters alone are a foundation, not Release 3.
