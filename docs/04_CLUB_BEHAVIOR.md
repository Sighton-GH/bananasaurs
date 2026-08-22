# Engineering-club behavior and commands

Commands are stable product affordances. Natural-language equivalents may call the same server-side workflows.

## Release 1 commands

- `/privacy` — render the published privacy policy with live settings substituted. Available to everyone, no AI, no permission required.
- `/roles` — where role panels live, if a command surface is wanted alongside the panels themselves.

## Assistant commands (Release 3)

- `/ask question` — answer with scoped club context and linked evidence.
- `/find query [where] [when]` — locate messages, decisions, and resources; never broaden permission scope.
- `/remind when text [audience]` — create a confirmed reminder; owner controls who may target channels or other users.
- `/review-plan` — review goals, assumptions, dependencies, owners, milestones, risks, validation, safety, and rollback.
- `/design-review` — examine requirements, interfaces, constraints, tradeoffs, failure modes, testability, maintainability, and open questions.
- `/decision record|find|supersede` — store a concise decision with rationale, alternatives, owner, date, status, and sources.
- `/resources search|list` — search the curated resource registry.
- `/memory show|forget` — inspect or request deletion of accessible memories; administrative purge remains in the dashboard.
- `/mydata` — what Bananasaurs holds about the caller: counts and classes, not a dump.
- `/forgetme` — queue an owner-reviewed purge of the caller's stored messages and derived memories. Moderation records are explicitly out of scope and the command says so.

## Moderation command family (Release 2)

- `/mod warn|note|history|case` — maintain a structured, permission-scoped case record.
- `/mod timeout|untimeout|kick|ban|unban` — explicit staff actions with target protection, reason, evidence, duration, and audit. Timeout durations are clamped to Discord's 28-day maximum; the parser rejects longer values rather than silently failing.
- `/mod purge` — bounded cleanup, run as a durable background job with progress and cancellation. Bulk deletion reaches only messages under 14 days old, 100 per call; older messages are deleted individually under rate limits, so a large purge takes minutes, not milliseconds.
- `/mod lockdown` — apply or restore a versioned channel-permission snapshot.
- `/automod test|enable|disable|status` — simulate rules before enforcement and show the exact matching/action path.

Natural language may prepare these actions, but never bypass the same command permission, validation, preview, confirmation, and audit path. AI must not independently infer that a member deserves punishment.

## Response behavior

- Lead with the answer or recommendation.
- Separate sourced facts from inference.
- Include compact source links back to Discord messages/resources when available. Permission-filter the citation list itself, not only the content — a link reveals that a message exists.
- For reviews, prioritize a few material risks and concrete next steps over generic checklists.
- For ambiguous reminder dates, resolve timezone and exact delivery time before confirmation.
- For destructive or consequential future tools, require explicit confirmation and server-side authorization.

## Discord mechanics

Ignore ordinary messages for response generation, but ingest messages only in channels whose archive policy allows it (ADR 0009: default-deny). Avoid mention loops and bot-to-bot chatter. Thread replies preserve thread context; forum posts inherit their parent forum's policy.

Interactions must be acknowledged within **3 seconds** and can be followed up for **15 minutes**. Every AI path defers immediately and then edits. "Streaming" to Discord means throttled progressive edits — roughly one edit per second at most, each one a REST call against a rate limit — with a final edit carrying citations. It is not token streaming.

Rate limits, duplicate gateway events, restarts, and interaction expiry are normal operating conditions, not error cases.
