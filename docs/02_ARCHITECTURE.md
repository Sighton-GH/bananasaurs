# Architecture

## Conceptual shape

```text
Discord gateway ─> event pipeline ─┬─> moderation/automod ─> Discord actions
                                   ├─> audit/logging
                                   └─> archive/indexing

Discord interactions ─┐
                      ├─> application core ─> context compiler ─> provider router
Dashboard/API ────────┘          │                    │                  │
                                 ├─ commands/tools     ├─ retrieval       └─ hosted models
                                 ├─ permissions       └─ disclosure plan
                                 ├─ module runtime
                                 └─ jobs
                                       │
                         local database + attachment/archive storage
```

The diagram defines ownership boundaries, not process boundaries. A modular monolith is the expected starting point.

## Core responsibilities

- **Interface adapters:** normalize Discord and dashboard requests and render responses.
- **Application core:** authorization, conversation lifecycle, commands, tool execution, audit events.
- **Event pipeline:** normalizes Discord events once and delivers them idempotently to enabled modules.
- **Moderation core:** cases, protected targets, role-hierarchy checks, explicit actions, reversals, and evidence references.
- **Rule engine:** deterministic predicates, exemptions, counters/windows, dry-run evaluation, actions, and escalation. It does not call an LLM in the message enforcement path.
- **Module runtime:** enablement, configuration versions, dependencies, permissions, health, and migrations for server-management features.
- **Context compiler:** selects instructions, recent context, archive evidence, memories, and resources within a token/disclosure budget.
- **Provider router:** resolves profiles, capabilities, quotas, cost limits, and explicit fallbacks.
- **Ingestion worker:** stores configured Discord events, attachments metadata, edits, and deletions idempotently.
- **Scheduler:** reminders, retention, compaction, health checks, and backup jobs.
- **Storage:** authoritative structured state plus optional search/vector indexes.

## Data concepts

Expect entities equivalent to guild configuration, principals and roles, channel policy, Discord message/event, conversation, turn, resource, memory, reminder, moderation case/action/evidence, automod rule/violation/counter, module configuration, managed role/message, scheduled job, provider/model configuration, routing profile, usage event, and audit event. The exact schema is an implementation choice.

Store Discord snowflakes as lossless identifiers. Preserve provenance and source timestamps. Treat edits and deletions explicitly. Attachments under the owner-configured ceiling (10 MB by default) are eligible for retention, but storage and parsing still enforce channel/type policy; metadata-only handling remains available.

## Guild isolation

Guild identity is a mandatory partition key, not an optional filter added by callers. Enforce it in repository interfaces and database constraints. Search indexes, embedding namespaces, caches, conversation identifiers, memory relationships, attachment paths, jobs, exports, audit views, provider requests, and dashboard sessions must all carry an explicit guild scope.

Instance-level secrets may be stored once, but a guild must explicitly select a provider profile. No model prompt or tool result may combine guilds. A self-hosted instance may support more than one guild later, but cross-guild administration, analytics, and memory are out of scope unless designed as metadata-only operator functions with no content access.

DM help uses a separate deterministic FAQ path. If DM AI is enabled, the request must resolve exactly one authorized guild before context compilation; ambiguous guild scope is an error, not an invitation to search across servers.

## Operational expectations

- One Linux host, restart-safe, migration-driven.
- Linux Mint and comparable Debian/Ubuntu-family systems are first-class targets. Offer a systemd-oriented installation and a small container/Compose option without forcing containers.
- Prefer a modular monolith, one primary application service, an embedded/local database where it remains sufficient, and local attachment storage. Do not require Redis, a broker, Kubernetes, or separate bot/API/worker services for the initial scale.
- **Storage is SQLite (ADR 0008), in WAL mode, with a busy timeout and a single-writer discipline.** All writes go through one serialised path. Background ingestion competing with interactive reads is the fastest way to throw `SQLITE_BUSY` at a slash command, and it is a design constraint from day one rather than a later optimisation.
- A database-backed job table is the queue. One in-process worker, a persisted cursor for resumable work, and a unique `dedupe_key` per job.
- Health endpoints distinguish process health, Discord connectivity, database access, scheduler lag, provider availability, and archive lag.
- Backups are encrypted where practical and restore procedures are tested.
- The event pipeline applies backpressure and isolates module failure: a broken AI or feed module must not stop moderation or logging.
- Discord side effects use stable idempotency keys and durable execution records so reconnects and retries do not duplicate punishments. Concretely: a unique index on `(guild_id, discord_event_id)` for ingestion, and a unique `dedupe_key` on every side-effecting job row. Gateway reconnects replay events; this is normal, not exceptional.
- Hard Discord constraints that shape module design: interactions must be acknowledged within 3 seconds and followed up within 15 minutes; bulk message deletion reaches only messages under 14 days old, 100 per call; timeouts cap at 28 days; the bot can act only on members whose highest role sits below its own, and never on the guild owner.
- Background parsing, indexing, summarization, and backup work use configurable concurrency and pause/yield under interactive or moderation load.
- No generation model runs locally. Local embeddings are optional and must have an off switch; lexical/full-text retrieval remains functional without them.
