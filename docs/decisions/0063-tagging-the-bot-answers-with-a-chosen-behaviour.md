# 0063. Tagging the bot answers with a chosen behaviour

Date: 2026-09-23
Status: accepted

## Context

`routeAssistantMention` (`packages/discord/src/assistant-routing.ts`) answered only
role tags mapped to a behaviour; tagging the bot user itself (`<@botId>`) was
silently ignored, so members had to use `/ask`.

## Decision

A behaviour may be flagged "answers when someone tags @Bananasaurs"
(`assistant_behaviours.answers_bot_tag`). At most one per guild, enforced by the
partial unique index `assistant_behaviours_one_bot_tag` on `(guild_id) WHERE
answers_bot_tag = 1`. The owner picks it on the Assistant page
(`PUT /api/assistant/bot-tag`, audited `assistant_bot_tag.set`). The migration
flags the single enabled `bananasaurs`-surface behaviour if exactly one exists.
A bot tag routes to the flagged behaviour only if it is enabled; otherwise it is
ignored. A mapped role tag in the same message wins. For bot tags the caller-role
check is left to the assistant service, as with `/ask` (owner exempt, visible
refusal). Role tags such as `@it-services` keep working as before.

## Consequences

Members can talk to the assistant by tagging it; several desks remain possible
through mapped roles; no new slash commands.
