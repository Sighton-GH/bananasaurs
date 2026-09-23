# 0065. AI log channel

Date: 2026-09-23
Status: accepted (owner decision 2026-09-23: full question and answer)

## Context

The owner cannot see what members ask the assistant, what it answers, or which
tools and sources it used, without reading the database.

## Decision

- A guild setting, `assistant_settings.log_channel_id`, chosen on the Assistant
  page from the live channel directory. When it is empty, nothing is logged.
- Every assistant request that reaches the job queue posts one log message
  there after the member has been answered. This covers answers, refusals and
  failures. The message contains:
  - who asked and where (a channel link)
  - the behaviour and command
  - the question text
  - the answer text
  - the tools called
  - the sources used (resource titles, web result links)
  - the model
  - the latency
  - the outcome, with a failure reason when there is one
  Texts are truncated to fit Discord's limits. Web search result text is never
  logged, only its links (Brave terms, ADR 0066).
- The post is a stage of the existing assistant job (`logged`, after
  `answered`), so a retried job never posts it twice (hard rule 6). Mentions
  are disabled.
- `PRIVACY.md` says questions and answers are copied to a staff log channel,
  and the picker says the channel should be staff-only.

## Consequences

Members' questions are duplicated into a Discord channel whose retention is
Discord's, not the bot's. Anyone who can read that channel sees them.
