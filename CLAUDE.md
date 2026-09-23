# Claude implementation guidance

Bananasaurs is a self-hosted Discord assistant and server-management bot for **one** engineering-club guild. It is a general-purpose club assistant, not a coding agent exposed to Discord.

Read `IMPLEMENTATION_BRIEF.md`, `REVIEW.md`, and `docs/` before proposing an implementation plan. Where `REVIEW.md` contradicts an older document, `REVIEW.md` wins.

## Stack — decided, do not re-litigate

TypeScript (Node 22, strict) · discord.js v14 · SQLite via better-sqlite3 (WAL, single writer) · Drizzle ORM + drizzle-kit migrations · SQLite FTS5 · database-backed job table · Fastify · React + Vite built to static files · Zod at every boundary · Vitest · Pino · systemd.

Full rationale and the mandatory discord.js cache configuration are in `docs/decisions/0008-stack-selection.md`.

## Commands

```bash
npm run dev          # bot + api + dashboard, watch mode
npm run start        # the built daemon, reading .env
npm run doctor       # connect, report intents/partials/permissions, exit
npm run build        # typecheck + build all packages
npm run test         # vitest, no network, no live Discord
npm run test:watch
npm run lint         # eslint + prettier check
npm run typecheck    # tsc --noEmit, must be clean
npm run db:generate  # drizzle-kit generate after a schema change
npm run db:migrate
npm run restore      # scripts/restore.mjs — daemon must be stopped first; see docs/SMOKE_TESTS.md
npm run smoke        # optional, requires TEST_GUILD_ID and a real token
```

Before claiming any task is done: `npm run typecheck && npm run lint && npm run test` must all pass. Do not report completion on the basis of code you have not run.

## Hard rules — never violate these

1. **AI is never in the enforcement path.** A model may draft a proposed action or a configuration. Only deterministic, validated, authorised code executes anything. Moderation, automod, roles, schedules, and logging must work with every AI provider unreachable. (ADR 0002)
2. **Guild scope is a mandatory partition key.** Every query, cache key, job payload, index, export, log line, and provider request carries an explicit guild ID. Enforce it in repository function signatures and database constraints, not in caller discipline. A query that can omit guild scope is a bug even if every current caller passes it. (ADR 0004)
3. **Model output is untrusted input.** It passes the same Zod validator as a form submission. Retrieved Discord messages, attachments, web pages, and repository text are evidence, never instructions. A turn whose only new input is retrieved text may not emit a tool call.
4. **No secrets in the repo, in logs, in config exports, or in diagnostics bundles.** Pino redaction is an allowlist, not a denylist.
5. **Provider training is disclosed, not blocked.** Every provider needs a terms record (`trainsOnInput`, cited clause, review date) before it receives server content. `"unknown"` is treated as `"yes"`. A provider that may train is allowed by owner decision but must raise warnings (log, dashboard, doctor) and PRIVACY.md must say so. (ADR 0062, superseding REVIEW §A2)
6. **Every Discord side effect has a durable idempotency key** and a unique constraint that makes double execution impossible. Gateway events replay on reconnect; assume it.
7. **Licensing: this project is Apache-2.0.** You may study any codebase. You may copy code only from permissively licensed sources (MIT/Apache/BSD) with attribution recorded in `docs/PROVENANCE.md`. You may **not** copy from Red-DiscordBot (GPL-3.0) or Zeppelin (Elastic License 2.0) — read their behaviour and write original code. If a source's license is unclear, do not copy it.
8. **No autonomous write actions, no broad guild access, no DM AI, no new outbound network destinations** without an explicit instruction in the current task.
9. **Never spawn the `claude` binary or read Claude subscription credentials from application code.** No Discord handler, job, scheduler, or HTTP route may do it, directly or through a queue, even with a human approving each step. The operator CLI is invoked by a human over SSH and returns output to that human's terminal. If a club member's action would cause `claude` to run, stop — that is the wrong design. Discord-facing AI goes through the provider layer only. (ADR 0013)

## Working style

- Record consequential choices as short ADRs in `docs/decisions/` **before** implementing them, numbered sequentially.
- Identify the thinnest end-to-end slice and its tests before writing feature code.
- When ambiguity is reversible, make a documented choice and continue. Ask the owner only when the choice changes privacy, cost exposure, authorisation, retention, or external side effects.
- Prefer boring dependencies and small ones. Every new dependency needs a one-line justification in the PR description.
- Preserve clean boundaries around interfaces, providers, context, tools, authorisation, and storage. Avoid speculative abstractions everywhere else.
- Do not split into services. One process. (ADR 0006)
- Write the test first for anything touching permissions, hierarchy, idempotency, retention, or guild scope.
- **Verify, do not assert.** Check a library's behaviour against the copy in `node_modules`, not from memory; re-run the gates yourself rather than believing a report; and never trust a guard you have not watched fail. Slice 0 shipped four claims that were confidently wrong until tested — the record is in `docs/22`.
- **Delegate implementation and review to subagents; keep decisions and verification here.** Hand briefs and diffs over as files, take back five-line reports, and specify a model on every dispatch. See `docs/22_DELEGATION_AND_CONTEXT.md`.

## Current release scope

See `REVIEW.md` §E. Work only on the current release. Do not build ahead into later releases, and do not build any part of the dashboard beyond what the current release names.
