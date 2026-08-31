# Owner setup checklist

Exact screens and policies change; verify current official documentation while performing setup.

> **Revised 2026-08-22.** This document predated ADR 0009 and ADR 0012 and described the opposite of both. Archive scope is now **default-deny**, retention is **tiered**, and ADR 0007's indefinite-retention position is superseded. Dashboard access is owner-provisioned local accounts, not any Discord permission.

## Accounts and identifiers

- Create a Discord application and bot.
- Record the target guild ID, owner user ID, and initial allowed channel IDs.
- Choose the archive scope explicitly. **Default-deny (ADR 0009):** no channel is archived until you enable it. Enabling a category also enables channels created in it later. Release 3, not Release 1.
- Confirm the default attachment ceiling of 10 MB and choose stored/indexed types, metadata-only types, and excluded types.
- Register slash commands in the target guild during development for faster iteration.
- Obtain credentials for the first hosted AI provider and set a hard spending/quota policy.

## Discord configuration

- Grant only the permissions needed to view configured channels, read history where required, send messages, embed links, attach files if used, and create/use application commands.
- Enable privileged intents only if the selected interaction/archive design requires them.
- Do not invite the bot to unrelated guilds.

## Host

- Prepare an always-on Linux host with reliable time synchronization, sufficient disk, backups, and a non-admin service account.
- Linux Mint is a first-class target. Record CPU architecture, cores, RAM, available disk, and filesystem before choosing resource limits.
- Choose direct install or containers based on maintainability.
- Reserve storage separately for database, attachments, backups, and logs.
- Configure LAN access first, then Tailscale; add Cloudflare Tunnel only if needed and protect it with Access.

## Policy choices to make before backfill

- Archive channel list and exclusions.
- Retention per data class, using the ADR 0009 tiers: live messages in enabled channels indefinite until you purge; deleted messages tombstoned with content purged after 30 days; content pinned to an open case retained until close plus 90 days; anything explicitly marked "preserve" indefinite and audited.
- Who may ask, search, create reminders, target other members/channels, and administer.
- Which roles may view cases, warn, timeout, kick, ban, purge, manage rules, manage role menus, and use AI-assisted configuration.
- Map actual server users/roles to these capabilities in the dashboard; do not rely on universal role names. **Discord Administrator grants nothing** (ADR 0012) — other club members hold it. Dashboard access comes only from an owner-provisioned local account created through the one-time bootstrap token.
- Which members/roles are protected from bot moderation, and which high-impact actions require owner confirmation.
- Whether new automod rules must spend a review period in observe-only mode before enforcement.
- Whether deleted Discord messages should be deleted locally immediately or by scheduled reconciliation.
- ~~Current decision: retain deleted messages/attachments as protected tombstoned archive records until an explicit owner purge or policy change.~~ **Superseded by ADR 0009** — see the tiers above. ADR 0007's rationale survives for moderation evidence; its indefinite-by-default does not.
- Whether any provider may receive archive excerpts, attachments, or memory; configure profiles accordingly.
- Which users may access deterministic DM help and which, if any, receive guild-bound AI in DMs.
- Monthly cost ceiling and behavior at the ceiling.

## Launch sequence

1. Run locally with a test guild/channel and test provider key.
2. Verify DM silence and unauthorized denial.
3. Validate archive/retrieval on synthetic non-sensitive content.
4. Test backup and restore — see `docs/SMOKE_TESTS.md` §C for the drill.
5. Add the real guild and a minimal channel set.
6. Review audit events and provider disclosure before expanding scope.
7. Run the moderation test plan with synthetic accounts/roles before removing existing moderation bots.
8. Migrate one module at a time and keep a documented rollback path until Bananasaurs has proven equivalent behavior.
