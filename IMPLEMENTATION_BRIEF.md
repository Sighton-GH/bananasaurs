# Implementation brief

Build Bananasaurs as a self-hosted, single-server engineering-club assistant and server-management platform. The long-term target is practical replacement of general-purpose bots such as Carl-bot or Dyno, delivered as staged modules rather than attempted in one release.

## Product outcome

An authorized member can mention Bananasaurs or invoke a command in an allowed guild channel and receive a context-aware response. Authorized staff can run moderation and management commands backed by cases, policy, and audit records. The owner can inspect activity, configure providers and deterministic server modules, curate resources, manage authorization, review/purge memory, and chat with the same assistant through a dashboard.

## Architectural invariants

- One assistant core; Discord and dashboard are adapters.
- Deterministic moderation, automation, and permissions remain independent of LLM availability.
- Discord events enter a shared event pipeline that can feed archive, logging, automod, workflows, and AI context without coupling those modules together.
- Provider-neutral internal request, response, tool, usage, and error representations.
- Local database is authoritative. Provider-side threads are caches at most.
- Permission checks happen server-side before context retrieval and every tool execution.
- Background archive ingestion and interactive responses are separate workloads.
- Retrieval is scoped by guild, channel, user authorization, and data class.
- Privacy or routing guarantees fail closed; no silent provider fallback that violates a selected policy.
- Every provider call records routing reason, model, latency, usage when available, and the classes of context disclosed—without duplicating secrets or sensitive prompt bodies into ordinary logs.
- AI may draft a configuration or action, but the server validates, previews, authorizes, confirms when required, executes, and audits it.
- Every data access path is guild-scoped. Database queries, caches, search indexes, vector namespaces, job payloads, logs, exports, and provider disclosures must not mix server data.
- DM handling is a restricted interface: help/FAQ without AI by default; dashboard-authorized AI is bound to an explicit guild and the caller’s permissions.
- Authorization is configuration, not a fixed role name. The owner maps Discord users/roles to dashboard, AI, moderation, memory, and module-management capabilities per guild.
- The distributable product is self-hosted. It must run comfortably on older Linux consumer hardware without local generation models, Redis, a message broker, or a multi-service cluster as baseline requirements.

## First vertical slice

1. Owner setup and one-guild allowlist.
2. Discord mention handling and `/ask`.
3. Durable message ingestion for configured channels.
4. Context compilation from recent channel history, curated resources, and a small set of reviewed memories.
5. One OpenAI-compatible hosted provider plus a generic compatible endpoint.
6. Streaming or progress acknowledgement appropriate to Discord time limits.
7. Dashboard: health, provider test, resource CRUD, authorization, memory inspection/purge, and assistant chat.
8. `/remind`, `/find`, and `/review-plan` as the first club workflows.
9. Audit trail and backup/export path.

Because automod and reaction roles are the owner’s current dependencies, their safe minimum replacements should follow immediately after the first vertical slice. Do not wait for the complete moderation suite or full dashboard to validate them.

The first moderation slice should then add cases, warnings/notes, timeout, kick, ban/unban, message purge, mod logs, protected-role checks, and a dry-run automod rule. Broader bot parity follows the milestone gates in `docs/08_ROADMAP.md`.

## Freedom deliberately left to implementers

Choose the language, framework, monorepo shape, database access layer, queue mechanism, UI toolkit, test stack, and concrete retrieval algorithm. Prefer boring dependencies, a small deployment footprint, migrations, and seams that can be replaced. Do not split into distributed services without evidence that the single-host workload needs it.

## Definition of done for the slice

- DMs and unconfigured guilds receive no assistant response.
- Unauthorized members cannot invoke the assistant or retrieve archived content.
- A mention and `/ask` return useful answers with visible error states.
- Provider failure can fall back only according to an explicit routing policy.
- Restarting the process preserves configuration, reminders, archive state, and reviewed memory.
- Owner can see why a memory exists and delete it.
- Resource links can be added in the dashboard and retrieved in an answer with source links.
- Relevant automated tests cover permission gates, routing policy, retention, reminder delivery, and prompt-injection boundaries.
- Core moderation commands work with the AI provider disabled, enforce Discord role hierarchy, are idempotent where applicable, and create immutable case/audit events.
- The measured baseline meets the resource targets in `docs/15_LINUX_RESOURCE_BUDGETS.md`, and background work yields to Discord interactions and moderation.
