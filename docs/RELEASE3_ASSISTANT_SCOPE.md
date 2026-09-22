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

The model receives only the intersection of the behaviour allowlist and the invoking member's permissions. Read, draft, schedule and send effects stay distinct. `requiresConfirmation` marks the skills the model may never trigger on its own discretion; model output is text and drafts only, so every durable write today comes from a deterministic path the member explicitly invoked - the typed slash command is the confirmation. An interactive confirm step does not exist yet and is not promised here. Skill attempts and outcomes belong in the dashboard activity view.

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

No AI control is terminal-only.

## Live wiring on this branch (reconciled 2026-09-21)

Exactly what is live, so the release gate is measured against reality:

- **Persistence/API**: behaviours, resources, reminders, skill grants, activity, tickets and decisions persist per guild and are read/written through the dashboard API (`/api/assistant`, capability-gated and audited).
- **Discord routing**: `createAssistantCommandSubscriber` is wired into the guild runtime's subscribers, so slash commands and `@bananasaurs`/`@it-services` mentions reach the assistant service. The mention router resolves the behaviour, enforces its caller roles and fails closed on ambiguity; the slash path applies the same caller-role gate. Only that cheap routing runs on the serial per-guild dispatch chain: the subscriber defers the interaction (slash) and enqueues an `assistant_invoke` job, and the job handler performs the resource fetches and provider call, so a slow `/ask` cannot stall reaction roles, automod or `/mod`. The behaviour is re-resolved from storage when the job runs - a prompt edit or disable between enqueue and run takes effect, and a deleted behaviour fails closed.
- **Commands**: `RELEASE_3_COMMANDS` is registered in every allowlisted guild at startup: `/status`, `/mod`, `/ask`, `/find`, `/remind`, `/decision`, `/review-plan`, `/onboard`, `/agenda`, `/summarise`, `/announce`, `/checklist` and `/handoff`. Privacy commands are intentionally **not** registered: Release 3 keeps privacy controls in the dashboard.
- **Provider execution**: `createAssistantService` is constructed per guild in the runtime. Every provider — configured or test-injected — runs behind the SafeProvider spend and outbound-scan boundary, and the request path consults the instance-level `provider_eligibility` table, failing closed when the row is missing or ineligible (hard rule 5). `AI_PROVIDER=off` answers with a configured-refusal, never a 500.
  Gemini, OpenRouter, and NVIDIA NIM deliberately ship with no seeded eligibility row: an owner must review current provider terms and record the decision before production use. Until then they appear as `unverified` and fail closed.
- **Resource fetching**: reviewed website/document/repository resources are fetched per invocation with HTTPS-only, credential-free, non-private-host validation; fetch outcomes are recorded per resource.
- **Reminders**: `/remind` validates time and text, requires a real destination channel, dedupes on the Discord interaction id, and records skill activity. Delivery runs through the durable job with atomic claims, backoff retries and a terminal window measured from the due time. Cancellation is a dashboard action.
- **Decisions and IT escalation**: `/decision` and `/review-plan` store drafts marked as analysis, never club policy; an IT `ESCALATE:` response opens a deduped ticket and notifies the reviewer channel with mentions restricted to reviewer roles.
- **Known live limits**: `/find` fails closed until Discord channel visibility is verified for the request; `requiresConfirmation` is enforced structurally, not interactively — no model-discretion execution path exists, the model is instructed to state drafts are unsaved, and durable records are only created by the deterministic paths above; golden evaluations run as a test suite, not a live gate.

## Release gate

Release 3 is complete only when all original roadmap bullets are implemented, every new capability has a dashboard path, the golden suite finds no permission leak, provider failure leaves Releases 1 and 2 working, and actual desktop/mobile pixels plus end-to-end Discord behaviour are reviewed. Provider adapters alone are a foundation, not Release 3.
