# 0060. The assistant console splits into purpose pages and gains behaviour creation

Date: 2026-09-22
Status: accepted

## Context

`docs/RELEASE3_ASSISTANT_SCOPE.md` ("Dashboard ownership") plans seven
dashboard areas: assistant, skills, schedules, resources, context, providers
and evaluation. The Release 3 build shipped providers as AI setup
(`/providers`) and context as Memory (`/memory`), but consolidated everything
else - invocation behaviours, skill allowlists, grants, reminders, reviewed
resources, tickets and decisions - onto one long `/assistant` page. Operators
find it crowded, and the page carried two different sections both named
"Things the assistant can do" (a count card and a per-behaviour allowlist
panel), so the same words meant two things.

The dashboard also offered no way to create a behaviour: it edited existing
ones only, even though `PUT /api/assistant/behaviours/:id` already creates
(audited `assistant_behaviour.created`) and the mention router
(`packages/discord/src/assistant-routing.ts`) already resolves per-tag
behaviours by mentioned role and refuses ambiguity.

## Decision

Split the consolidated page into the planned purpose pages under the
Assistant navigation group, keeping ADR 0059's plain-language bar:

- **Assistant** (`/assistant`): invocation behaviours and tag mapping, the
  per-behaviour system prompt, caller-role access, attached resources,
  ticket routing, escalation tickets and decision records, plus the AI
  status card and the first-run checklist.
- **Skills** (`/assistant/skills`): the full skill catalogue with each
  skill's required permission and confirmation class, per-behaviour
  allowlists (the single place allowlists are edited), guild-wide skill
  grants, and a link to Assistant history (`/assistant/activity`) for recent
  activity.
- **Schedules** (`/assistant/schedules`): reminders with plain-language
  destination, run time, honest status including failures, and cancellation.
- **Resources** (`/assistant/resources`): reviewed sources with scope (kind),
  freshness (reviewed and last-fetched times) and fetch health, plus the
  add/edit/enable controls that already existed.

`/assistant/activity`, `/memory` and `/providers` stay as they are. The
legacy `/resources`, `/ai` and `/proposals` aliases keep working: `/resources`
now lands on the Resources page, the other two on the Assistant page. Each
section name lives in exactly one place; the duplicate "Things the assistant
can do" naming is gone.

Add a create-behaviour form on the Assistant page. It asks for a name, a tag
surface (`@bananasaurs`, `@it-services` or `@help`), a mention role chosen
from the live Discord role directory (never typed by hand), a system prompt,
a skill allowlist and caller roles, and writes the whole object through the
existing PUT create path with `promptVersion: 0`. New behaviours are created
**disabled**: enabling is a separate deliberate act, so a fresh behaviour can
never collide with an enabled one on the same mention role, and the server's
409 conflict path stays reachable only from an explicit enable. The
fail-closed semantics are stated where the choice is made: an empty
caller-role allowlist answers nobody, and a mention role mapped to two
behaviours is refused rather than mixed.

No server route changes. Pages that must show seeded or example data mark it
visibly as seeded demo data; the shipped pages read only live API data, so
the seeded-demo label appears in the local screenshot harness, not in the
product.

## Consequences

An operator with no Bananasaurs knowledge can open the page named after the
thing they want to change. The Assistant page gets shorter without losing
behaviour-level context (tickets and decisions stay beside the behaviour that
produces them). Behaviour creation is possible without a fresh deployment or
terminal access, and every create is audited as `assistant_behaviour.created`.
Allowlist edits move to the Skills page, so the Assistant page's access
editor saves the whole behaviour object with its current allowlist
preserved - the whole-object PUT contract is unchanged.
