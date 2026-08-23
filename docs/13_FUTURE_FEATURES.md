# Future feature catalogue

**The stated goal is full Carl-bot and Dyno parity.** That is a reasonable destination. It is not a plan, and the difference is what determines whether it happens.

## Honest sizing

Between them, Carl-bot and Dyno ship roughly thirty modules: automod, reaction roles, logging, moderation and cases, welcome/leave, autoroles, tags and custom commands, autoresponders, scheduled messages, announcements, starboard, tickets, suggestions and forms, giveaways, levels and XP, polls, RSS and YouTube and Twitch and Reddit feeds, AFK, birthdays, temporary and sticky roles, verification, raid protection, slowmode automation, auto-purge, server stats, managed embeds, timers, reminders, and music.

Each one is small on its own — one to three focused days with an agent writing and you reviewing, *once the spine exists*. Thirty of those is a year or more of sustained part-time work. That is achievable. What is not achievable is building them in parallel, or building them before Release 1's foundations are solid.

## Why the spine is the whole game

Every module above is the same shape: a Discord event or command arrives, permissions are checked, a typed action is validated, an idempotency key is written, a side effect happens, an audit row lands. Release 1 builds that once — event pipeline, permission model, storage, job table, audit, rate limits, circuit breaker, dry-run, undo, operator CLI, dashboard shell.

After that, a module is mostly configuration schema plus a handler. Starboard is a day. Sticky roles is a day. Welcome messages is an afternoon. The reason Carl-bot and Dyno took teams years is that they built the spine *and* thirty modules *and* multi-tenant infrastructure for millions of servers. You need the spine and the modules your club uses, for one server.

## The rule that makes it work

**One module at a time, finished, before the next one starts.** Finished means: configured from the dashboard or CLI, permission-checked, audited, idempotent, tested against the fake Discord harness, and used in the real server for a week without a surprise.

Thirty half-built modules is worse than five reliable ones, because the value of Carl-bot is not its feature list — it is that each feature works every time without anyone thinking about it. A parity checklist where two-thirds of the items are "mostly works" has not replaced anything.

So: keep the list. Work the list. Do not schedule the list.

## Music is a separate project

Dyno's music is not a module, it is a different application: voice connections, audio transcoding, source platform terms, buffering, and reliability problems that share nothing with the rest of this system. It stays excluded until it is deliberately chosen as its own project.

---

This is a product backlog, not a promise to build every item. Each module must have a concrete server use case, permissions, audit behavior, dashboard design, tests, migration path, and failure isolation. The current source of comparison is the public module set documented by Dyno and the common capabilities of Carl-bot-style server management.

## Now: replace current dependencies

### Automod

- Keyword/phrase/wildcard/regex rules.
- Discord invite, URL/domain, phishing, attachment, mention, spam, duplicate, caps, emoji, account-age, and member-age rules.
- Role/user/channel scopes and exemptions.
- Sliding windows, violation counters, escalation, cooldowns, and rate-limited actions.
- Observe-only mode, fixture testing, human-readable match trace, false-positive review, versioning, rollback, and emergency disable.
- Flag/log, delete, warning/case, timeout, kick, and ban actions under explicit policy.
- Native Discord AutoMod synchronization where useful.

### Reaction and component roles

- Reaction, button, and select-menu role panels.
- Add, remove, toggle, single-choice, multiple-choice, required/conflicting role, and prerequisite modes.
- Role hierarchy validation, protected roles, limits, audit, panel previews, localization-ready text, and accessible labels.
- Reconciliation for deleted messages/roles, renamed roles, missed events, manual role changes, and bot downtime.
- Import worksheet for current Carl-bot/Dyno role panels.

## Next: moderation and operations

- Cases, warnings, notes, evidence, member history, templates, and staff-only search.
- Timeout, kick, ban/unban, softban if needed, purge, lockdown, voice moderation, duration changes, and reversals.
- Protected roles/users, granular moderator roles, action confirmations, escalation limits, and audit exports.
- Message/member/role/channel/thread/voice/action logs with routing and retention.
- Diagnostics for missing permissions, role hierarchy, stale managed messages, event lag, and failed jobs.
- Raid mode, join-rate detection, verification gates, quarantine, account-age checks, and carefully scoped anti-nuke controls.

## Community management

- Welcome/leave/ban messages, embeds, images, and autoroles/delayed roles.
- Tags, custom commands, aliases, reusable snippets, autoresponders, and managed embeds.
- Scheduled messages, announcements, reminders, auto-delete, auto-purge, and slowmode automation.
- Starboard/highlights, polls, suggestions, forms, event/RSVP support, and server statistics.
- Tickets using private channels/threads, intake forms, routing, transcripts, staff actions, and FAQ suggestions.
- Temporary roles, sticky roles, role persistence, voice-linked text channels, and optional self-service profiles.

## Engagement and optional modules

- Giveaways with eligibility, rerolls, audit, and anti-abuse controls.
- Levels/XP, rewards, leaderboards, exclusions, cooldowns, imports, and privacy controls.
- AFK, birthdays/timezones, reputation, fun commands, and club-specific achievements.
- RSS, GitHub releases/activity, YouTube, Twitch, Reddit, and other feed notifications through isolated provider adapters.
- Music remains a separately approved project because media sources, transcoding, voice reliability, and platform policies substantially change operations.

## Engineering-club extensions

- Project registry, team/role map, decision records, meeting preparation and summaries, design/plan reviews, milestone reminders, resource catalogue, and searchable technical FAQ.
- GitHub repository/release/issue notifications and read-only project context before any write integration.
- Equipment inventory, lab booking, safety checklist, build log, competition schedule, sponsor/contact, onboarding, and member skill-directory modules if the club needs them.
- AI-assisted policy and configuration drafting with deterministic validation and preview.

## Public-release readiness

- Self-hosted Linux distribution with guided setup, systemd and minimal Compose paths, permissions diagnostic, module templates, configuration import/export, migrations, backup/restore, localization, accessibility, privacy controls, rate/cost limits, release channels, opt-in-only telemetry, and operator documentation.
- Strict per-guild data isolation and deletion/export tools even if one self-hosted instance later connects to multiple guilds.
