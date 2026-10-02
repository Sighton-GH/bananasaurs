# 0125. A tag of the bot's integration role is a tag of the bot

Date: 2026-10-02

Status: accepted (owner request 2026-10-02). Extends ADR 0063.

## Context

When the bot is installed, Discord creates a managed role for it. That role
usually has the bot's name and is listed as `@Bananasaurs` in the mention
picker next to the bot user. A member who picks the role sends `<@&roleId>`,
not `<@botUserId>`. Mention routing only recognised the bot user and the roles
mapped to a desk behaviour, so the bot stayed silent. Members cannot tell the
two entries apart, so to them the bot just looked broken.

## Decision

1. **Routing.** `routeAssistantMention` takes the integration role's id. A
   tag of it counts exactly as a tag of the bot user: it goes to the one
   behaviour flagged `answersBotTag`, a mapped desk role tag in the same
   message still wins, and the role tag is stripped from the prompt. An
   explicit role tag in a reply to a task post routes, like an explicit
   `<@bot>` (ADR 0112 decision 4 only exempts the reply ping). The daemon
   reads the id live from the gateway cache (`guild.roles.botRoleFor`), so
   a reinstall's new role is picked up without a restart.
2. **Desk roles.** A behaviour save refuses a mention role that **is** the
   integration role (`mention-role-is-bot-role`) or whose name matches the
   bot's role, username, global name or server nickname
   (`mention-role-name-clash`). Names are compared trimmed, case-folded,
   NFKC-normalised and without a leading `@`. Members could not tell such a
   role from the bot tag. If the guild is not cached, the check is skipped:
   it is a setup guard, not an authorisation check.

## Consequences

- No migration and no new permission. The role id comes from the gateway
  cache the daemon already keeps.
- A behaviour saved before this change with the integration role as its desk
  role keeps routing as that desk. Routing gives a mapped desk precedence,
  and the API only refuses new saves.
- Caller-role checks are unchanged: as with a bot user tag, the service
  decides and refuses visibly (ADR 0064).
