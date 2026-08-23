# Moderation, automation, and bot-replacement scope

## Feasibility

Replacing Carl-bot or Dyno for one self-hosted server is feasible. Reproducing every mature feature, edge case, integration, and polished dashboard is a substantial multi-stage product. The sensible goal is operational replacement: cover the modules this club actually uses, migrate them one at a time, and leave the old bot enabled until each Bananasaurs module passes its acceptance gate.

AI is an advantage for explanation, retrieval, policy drafting, and natural-language configuration. It must not sit in the enforcement path. If every model provider is offline, moderation, rules, schedules, logging, roles, and recovery must still work.

## Module catalogue

### Priority A — moderation foundation

- Cases with immutable action history, notes, warnings, evidence links, edits as new revisions, and permission-scoped search.
- Timeout/untimeout, kick, ban/unban, optional softban, bounded message purge, reason templates, and duration parsing.
- Protected users/roles, Discord hierarchy checks, per-action staff roles, cooldowns, and confirmation policy.
- Mod/action logs, failures, reversals, and reconciliation with actions taken directly in Discord. Reconciliation is an eventually-consistent background reader of the guild audit log; its output is flagged `source: discord_audit_log (inferred)` and is never authoritative case data. Audit-log correlation is delayed, paginated, and silent for self-deletions.
- Lock/unlock with saved channel-permission snapshots and recovery after partial failure.

### Priority A — automod and safety

- Keyword, wildcard, regex, invite/link/domain, mention spam, repeated message, rapid spam, caps, emoji, attachment/type, account-age, and join-age predicates.
- Role/channel/user exemptions and affected scopes.
- Sliding-window counters, violation expiry, progressive escalation, and per-rule rate limits.
- Actions such as flag, log, delete, warn/case, timeout, kick, and ban, limited by explicit policy.
- Observe-only mode, saved-message fixtures, human-readable match explanations, false-positive review, versioning, rollback, and kill switch.
- Native Discord AutoMod integration where it blocks content earlier or more reliably; custom rules supplement rather than duplicate it blindly.

Observation mode means the rule evaluates real messages and logs the action it would have taken without deleting content or punishing the member. It is the recommended default for a new punishment rule, but the owner may enable enforcement immediately after reviewing a clear warning and test results. Provide both a global testing-mode toggle and per-rule `test`, `observe`, or `enforce` state.

### Priority B — server essentials

- Join/leave messages, autoroles, delayed roles, role menus using buttons/selects, temporary or sticky roles if required.
- Message/member/role/channel/voice/thread/moderation logs with per-event routing and privacy-aware retention.
- Tags, custom commands, autoresponders, managed embeds, announcements, reminders, scheduled messages, and auto-purge.
- Starboard/highlights and server diagnostics.
- Verification and raid controls appropriate to the club’s risk.

### Priority C — optional parity

- Tickets or private help threads, suggestions/forms, giveaways, feeds, polls, AFK, levels/reputation, events/RSVP, and social integrations.
- Anti-nuke protections for privileged-account abuse require a separate threat model; they should not be marketed as foolproof.
- Music is a separate operational and policy domain and is excluded until explicitly requested.

## Permission and execution model

Commands and rules produce a typed proposed action. The server then:

1. resolves the actor, target, guild, and configured policy;
2. checks Bananasaurs authorization and live Discord permissions/hierarchy;
3. validates duration, reason, evidence, rate limits, and protected-target policy;
4. previews and requests confirmation when the action class requires it;
5. writes a durable execution intent/idempotency key;
6. performs the Discord API call;
7. records outcome, Discord identifiers, errors, and any reversible prior state;
8. emits audit and user-facing results.

The AI can fill a proposed-action draft but cannot skip any step. Model output is untrusted input to the validator.

Authorization policies refer to owner-configured capability groups and live Discord roles/users. There is intentionally no single built-in answer for which role may moderate; each guild maps its own roles to actions, scopes, confirmation requirements, and protected targets.

## Migration approach

Inventory the currently enabled modules and configuration in Carl-bot/Dyno. Build a parity worksheet with current behavior, Bananasaurs target, test cases, data migration, cutover, and rollback. Migrate low-risk modules first, moderation only after synthetic hierarchy/action tests, and automod only after an observe-only period.

For the current server, Carl-bot is doing three things: logging edits and deletions to a log channel, reaction roles, and some automod. Logging and reaction roles are Release 1; automod is Release 2 (`docs/08`).

**Never run two enforcing automods at once.** Two engines deleting the same message and issuing separate timeouts produces duplicate punishments, duplicate cases, and confused members. While Carl-bot enforces a rule, the Bananasaurs equivalent stays observe-only. Cutover is per rule and atomic: disable it there, then enable it here. Each rule records the legacy rule it replaces and its cutover state. Logging and reaction roles carry no such risk and can be cut over as soon as they are verified.

Preserve the old bot configuration until Bananasaurs has reconciled assigned roles and demonstrated equivalent automod behavior.
