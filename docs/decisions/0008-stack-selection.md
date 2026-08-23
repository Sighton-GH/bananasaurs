# ADR 0008: Initial technology stack

Status: proposed (2026-08-22)

## Context

`docs/15` targets a modular monolith on older Linux Mint consumer hardware with roughly 512 MB steady-state memory, no Redis, no broker, no separate vector service, and no local generation model. `docs/06` requires a real web dashboard. `docs/02` requires a durable job table, full-text search, and migrations. The code will be written predominantly by Claude Code with owner review, which favours a stack with a large, well-documented ecosystem and strong static typing to catch generated mistakes at compile time rather than in production.

Milestone 0 in `docs/08` deferred this choice. Deferring it further is now the main obstacle to starting, because an agent asked to "select the stack" will produce a different answer each session.

## Decision

| Layer | Choice | Reason |
|---|---|---|
| Language | **TypeScript**, Node 22 LTS, strict mode | One language across bot, API, and dashboard. Strong types catch a large share of agent-generated errors before runtime. |
| Discord | **discord.js v14** | The best-documented library, which materially improves what an agent generates. Caching must be explicitly restricted — see below. |
| Database | **SQLite** via **better-sqlite3**, WAL mode, `busy_timeout`, single writer | Embedded, no service, survives restarts, ships FTS5. Synchronous API removes a whole class of concurrency bugs. |
| Migrations + queries | **Drizzle ORM** with drizzle-kit migrations | Typed schema, readable SQL, real migration files. Guild scope can be enforced in repository helpers. |
| Search | **SQLite FTS5** (built in) | Lexical retrieval with no extra process and no extra memory. Embeddings deferred per REVIEW §C11. |
| Jobs | **Database-backed job table**, one in-process worker, `dedupe_key` unique constraint | `docs/02` explicitly permits this before a broker. Gives idempotency and restart-safety for free. |
| HTTP API | **Fastify** | Small, fast, first-class TypeScript, good plugin story for auth and CSRF. |
| Dashboard | **React + Vite**, built to static files, served by Fastify | Satisfies `docs/15`'s "static/cacheable, no separate always-running dev server." |
| Dashboard auth | **Discord OAuth2** (`identify`, `guilds`), owner user ID allowlisted, signed session cookies | One integration provides login, identity, and live role membership — exactly what the capability model needs. |
| Validation | **Zod** at every boundary: config, HTTP, Discord interaction options, and all model output | Model output is untrusted input; it must pass the same validator as a human-submitted form. |
| Tests | **Vitest** + a hand-written fake Discord gateway/REST harness | Enables real tests without a live Discord connection. See `docs/16`. |
| Logging | **Pino**, JSON, with a redaction allowlist | Structured logs with secrets and prompt bodies excluded by construction. |
| Process | **systemd** unit, non-root service account, `EnvironmentFile=` at 0600 | The native path `docs/15` asks for. Compose comes later, if ever. |
| License | **Apache-2.0** | See REVIEW §F. Constrains reuse: YAGPDB (MIT) may be borrowed with attribution; Red (GPL-3.0) and Zeppelin (ELv2) may not be copied. |

### Mandatory discord.js configuration

Default discord.js caching will blow the memory budget on its own. The client must be constructed with explicit sweepers and disabled caches:

- Only the intents actually required: `Guilds`, `GuildMembers`, `GuildMessages`, `MessageContent`, `GuildMessageReactions`, `GuildModeration`, `DirectMessages`.
- Message cache limited to a small per-channel maximum with an aggressive sweeper; the archive, not the client cache, is the source of history.
- Presence, voice-state, and reaction caches disabled or swept to zero.
- Member cache limited; fetch on demand rather than keeping the whole guild resident.

Memory must be measured against `docs/15` at the end of every release, not assumed.

## Rejected alternatives

- **Python + discord.py.** Excellent library and lower memory per process, but the dashboard forces a second language and toolchain, and the typing story is weaker for agent-generated code.
- **Go or Rust.** Best resource profile by a wide margin, worst iteration speed for a review-heavy, agent-written project, and the smallest ecosystem of examples for the agent to draw on.
- **PostgreSQL.** Correct at scale, unnecessary at ~30 members, and contradicts the "no extra service" baseline in ADR 0006. Drizzle keeps a future migration path open.
- **Redis / BullMQ.** Explicitly excluded by ADR 0006. The job table is sufficient at this scale.
- **A vector database.** Deferred with embeddings.
- **Next.js.** Requires a Node server for the frontend, contradicting the static-assets requirement.

## Consequences

- The whole system is one Node process plus a SQLite file, which is the smallest thing that meets the requirements and the easiest to back up, restore, and reason about.
- Node's baseline memory (~40–80 MB) plus discord.js is comfortable inside 512 MB **only with** the cache configuration above. This must be verified, not assumed.
- SQLite's single-writer model must be respected: all writes go through one worker or one serialised path. This is a constraint on module design from day one, not a later optimisation.
- Choosing Apache-2.0 now makes `docs/11`'s reuse assessment actionable and creates a hard rule Claude Code must follow.
- If measured load ever exceeds what SQLite handles, Drizzle makes the PostgreSQL migration mechanical rather than a rewrite. There is currently no evidence that will be needed.
