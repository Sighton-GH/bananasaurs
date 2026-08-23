# Dashboard requirements (target state)

> **This document describes where the dashboard is going, not what to build now.**
>
> **Release 1 dashboard is one page:** health, log routing config, role-panel config, audit table, kill switch. Authentication is owner-provisioned local accounts (ADR 0012) — Discord Administrator grants nothing here, because other club members hold it.
>
> Release 2 adds automod rules, fixtures, testing mode, and cases. Release 3 adds the AI workspace, archive, memory, providers, and resources. Everything else below is backlog. Do not build ahead of the current release in `docs/08`.

The dashboard is the owner’s control plane and a second interface to the same assistant—not a separate chatbot.

It is a primary product surface, not a thin settings page. It should make complex policy understandable, support safe previews and recovery, and expose enough context to diagnose why the bot or AI behaved a certain way.

## Required areas

- **Overview:** Discord connection, archive lag, scheduler, storage, active provider/profile, recent errors.
- **AI workspace:** converse with the same guild-specific assistant used in Discord; start/continue conversations; attach files; select routing profile; inspect citations, chosen memory capsules, context budget, provider/fallback, tool calls, and disclosure classes; correct an answer or propose a reviewed memory.
- **Activity:** recent requests, commands, tool executions, routing/fallback, latency, and usage.
- **Moderation:** cases, member history, evidence, actions/reversals, protected roles, escalation policy, and permission-aware search.
- **Automod:** ordered rules, predicates, exemptions, thresholds/windows, actions, test fixtures, dry-run results, violations, and emergency disable.
- **Modules:** enable/disable, dependencies, health, configuration history, import/export, and per-role/channel command permissions.
- **Server operations:** managed roles, role menus, welcome/leave, scheduled messages, tags/custom commands, logging destinations, tickets, and selected parity modules.
- **Providers:** credentials by secret reference, model discovery/configuration, capability overrides, routing profiles, health tests, and budgets.
- **Resources:** curate website and GitHub links with title, description, tags, scope, status, last checked, and notes; validate and deduplicate URLs.
- **Memory:** candidates, active/superseded/expired items, provenance, confidence, last use, approve/edit/reject/forget, and bulk purge preview.
- **Archive:** channel policies, backfill status, retention, search, and deletion controls.
- **Access:** owner, authorized users/roles, channel allow/deny policies, and permission explanations.
- **Reminders:** upcoming, delivered, failed, cancelled, timezone, creator, and target.
- **Instructions:** versioned editor for assistant behavior with diff, validation, rollback, and reload status.
- **Audit and backup:** security-relevant history, export, backup status, and restore guidance.
- **Help and DM access:** edit/version the non-AI FAQ, preview DM answers, authorize DM AI per user and guild, set rate/cost limits, and inspect access history.
- **Performance and storage:** CPU/memory/event-loop or worker pressure, queue depth, archive/index lag, database size, attachment growth, parser activity, backup duration, disk forecasts, and configurable concurrency/maintenance windows.
- **Future-feature catalogue:** view planned modules, status, priority, dependencies, design notes, and migration readiness without pretending unbuilt modules are available.

## Information architecture

- Guild switcher with prominent current-guild identity and no cross-guild content view.
- Global command/search palette for settings, members, cases, resources, memories, and help.
- Overview cards that lead to actionable detail rather than decorative statistics.
- Module pages sharing a consistent pattern: purpose, health, enablement, permissions, configuration, test/preview, recent activity, versions, import/export, and rollback.
- Access editor where the owner maps users and Discord roles to capability groups such as dashboard view, AI use, moderation actions, automod management, reaction-role management, memory review, provider/secrets management, and owner administration.
- Member detail page combining roles, relevant cases, authorized memory visibility, reminders, and activity only to the extent the viewer is permitted.
- Source inspector for Discord messages, resources, memories, and context traces without exposing hidden channels.

## AI quality controls

- Test console that runs saved server questions against a draft instruction, retrieval, or provider configuration before publishing it.
- Owner-authored golden questions with expected sources and forbidden scopes.
- Per-answer feedback, correction workflow, and reviewed conversion of corrections into memory.
- Quality, latency, token, provider, fallback, citation, retrieval, and error trends.
- Context simulator showing what would be sent for a selected user/channel while redacting inaccessible content.

## Automod testing controls

- A prominent global **Testing mode** toggle makes every configured automod action observe-only while continuing to record matches and proposed actions.
- Each rule also has its own `test`, `observe`, or `enforce` state so new rules can be evaluated without disabling established enforcement.
- Testing mode displays a persistent banner, start time, actor, scope, recent match count, and a one-click results review.
- Leaving global testing mode previews which rules will resume enforcement and requires owner or explicitly granted automod-manager confirmation.
- Emergency disable is separate from testing mode: it stops rule evaluation/actions when stability or safety is uncertain.

## UX requirements

- Desktop-first responsive UI usable over LAN, Tailscale, or protected tunnel. Local-account login is the inner gate; network exposure still requires Tailscale or Cloudflare Access.
- Dangerous actions show exact scope and require confirmation.
- Rule changes show a human-readable diff and can be tested against saved or synthetic messages before activation.
- AI-assisted configuration always produces a draft; only the deterministic validated configuration is saved.
- Empty, stale, degraded, and partial-success states are explicit.
- Secrets are write-only after entry.
- Accessibility and keyboard operation are part of done.
- Source links deep-link to Discord when possible.
- Navigation, forms, tables, diffs, dialogs, loading/error states, mobile layouts, and destructive confirmations receive deliberate design and usability testing.

Do not turn the first dashboard into a generic enterprise admin suite. Optimize for one technically capable owner.
