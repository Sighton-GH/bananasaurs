# 0067. One read-only tool round, and resources shared by every behaviour

Amended by ADR 0071 (follow-up rounds may only open IDs an earlier result returned).

Date: 2026-09-23
Status: accepted (owner decision 2026-09-23)

## Context

Each command ran one skill with one model call. The model could not look
anything up beyond the resources pre-fetched for its behaviour. Resources were
attached to single behaviours, so a resource added for one desk was invisible
to the others.

## Decision

### Tools

When the provider supports tool calls, a request offers the model these
read-only tools:

- `search_archive`: search messages in archive-enabled channels that the asking
  member can view (checked against their live Discord permissions). Thread
  messages are left out: the archive does not record which threads are
  private, and a private thread is not visible to everyone who can see its
  channel. `/find` uses the same search, answered without the AI.
- `open_resource`: open any enabled reviewed resource
- `web_search`: the Brave Search API, when it is switched on (ADR 0066)
- `server_info`: the server card and the channels the member can view
- `current_time`: the date and time in the club's time zone
- `my_reminders`: the member's own upcoming reminders

Hard rule 3 says a turn whose only new input is retrieved text may not emit a
tool call. So there is **exactly one tool round**:

1. The model sees the member's question and may call any tools, in parallel.
2. The tool results go back to it with tools switched off, and it must answer.

A second round would be a tool call driven by retrieved text. There is no
separate "read a page from the search results" tool for the same reason: the
model would choose which page from retrieved text.

- Every tool call is validated by Zod. An invalid call is answered with an
  error result, never executed.
- Every tool result is redacted like other evidence and wrapped in the
  untrusted-evidence envelope.
- No tool writes anything. Writes stay the explicit, confirmed commands they
  are today (hard rules 1 and 8).

Providers without tool support keep the single-call path, and they get every
enabled resource pre-fetched instead.

### Resources

Every enabled resource is available to every behaviour. A behaviour's resource
list now means **emphasise**: those resources are pre-fetched into the context
and marked as preferred sources. The others are listed by title and reachable
through `open_resource`. No migration is needed: existing per-behaviour lists
become emphasis lists.

## Consequences

The model can reach more than before, but only through read paths a member
could already use, never through a write. Each request costs at most two model
calls and one search.
