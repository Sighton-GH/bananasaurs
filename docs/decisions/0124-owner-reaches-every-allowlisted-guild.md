# 0124. The owner reaches every allowlisted guild at startup

Date: 2026-10-01

Status: accepted (owner request 2026-10-01). Amends ADR 0045 Amendment 6 and
the slice 13 note on `account grant-guild`.

## Context

`bootstrap` gives the owner account access and every capability in each guild
the allowlist names **at the moment the account is created**. A guild added to
`BANANASAURS_GUILD_ALLOWLIST` later gets nothing. The owner added a third guild,
restarted, invited the bot, and the guild did not appear on the dashboard.
Doctor said to run `account grant-guild` and then `account grant` once per
capability (eleven commands). The dashboard cannot do it either, because the
grant-guild route refuses the owner account and only acts on the guild the
session is already in.

For the owner, the allowlist already states the intent. The owner edits it on
the host, the same place the CLI runs. A second manual step adds no protection.

## Decision

On every start, for each allowlisted guild, the daemon finds each **enabled
owner** account with **no access row** in that guild. It grants each one
access and every capability there, the same grants `bootstrap` makes, with
`granted_by = 'startup-owner-sync'`. It writes one `account.guild_granted`
audit row per grant in that guild (actor `system`) and logs it.

- **Only when the access row is missing.** If the owner already reaches a
  guild, nothing changes, so a capability the owner deliberately revoked
  stays revoked across restarts.
- **Owners only.** Member accounts still start with no guild access. ADR
  0012's least privilege for every other account is unchanged.
- **Disabled owners are skipped.** A disabled account can't log in, so access
  for it would serve no one.
- **Read-only mode skips it** with no write, like `applyConfiguredDryRun`.
- **Runs at startup, not on `GUILD_CREATE`.** The guild row is seeded at
  startup for every allowlisted guild whether or not the bot is in it yet,
  so a restart is enough even before the invite.

## Consequences

- `account revoke-guild` on an owner lasts only until the next restart. To keep
  the owner out of a guild, remove the guild from the allowlist. A disabled
  owner is not re-granted.
- Doctor's "no enabled dashboard account can reach guild" warning now fires
  only before the first restart after an allowlist change, or when there is
  no enabled owner.
- Adding a guild for the owner is: edit the allowlist, restart, invite. Grants
  to other accounts are still explicit.
