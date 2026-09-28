# 0087. A skill's scope is its only gate; behaviours prefer skills, they don't allow them

Status: accepted (owner decision, 2026-09-28). Amends ADR 0086 decision 1 and ADR 0064.

## Context

After the skills slice shipped, the owner tagged the bot and asked it to set a reminder. The bot said it could not. Two gates decided whether a skill was offered:

1. **The behaviour's `allowedSkillIds`.** Migration 0049 added `reminders` only to behaviours that already allowed `create-reminder` or `send-reminder`. The behaviour that answers the bot tag had neither.
2. **The skill's scope** (everyone, specific roles, owner only), set on the Skills page.

The owner passed the scope, but the behaviour's list hid the skill. Two things followed:
- the prompt's ALLOWED SKILLS had no reminders line, so the tools were never declared;
- the model filled the gap with a wrong instruction: "ask someone with bot permissions".

The owner's answers:
- "scope only. for certain behaviours i should be able to prioritize certain skills and resources. this should be something i can configure in the behaviours tab. move it out of the skills tab";
- for refusals, "name it plainly".

## Decision

1. **The only gate is the skill's scope.** It is set per skill, server-wide, on the Skills page (ADR 0086 decision 1). Every behaviour can use every skill the asker's scope allows. The existing checks all stay:
   - Try it and invocations without an id never act (`skipActions`);
   - the quote guard;
   - Zod validation;
   - channel and ping rights.
2. **Behaviours prefer, they don't allow.** A behaviour's skill list becomes `preferredSkillIds`, which works like its `resourceIds`:
   - preferred skills are listed first in the prompt and marked as this assistant's focus;
   - they never grant or deny anything;
   - an empty list, or a list with every skill, means no preference.

   The stored column keeps its name, and only the TypeScript field is renamed, so there is no migration.
3. **The Behaviours tab owns preferences.** Each behaviour's page gets "Preferred skills" beside its existing preferred resources. The Skills page no longer shows or edits which behaviours have a skill ("Where it's on"). It shows the skill, its scope, and its live items.
4. **The bot names unavailable skills plainly.** The prompt also lists catalogue skills the asker's scope denies, each with its reason, under `NOT AVAILABLE TO THIS MEMBER`. The reasons are "owner only" and "only for <role names>". The model is told to say so plainly, and not to suggest asking someone else. Those skills' tools stay undeclared, and a call to one is still refused in code.

## Consequences

- An owner who sets a skill to "everyone" gets it everywhere, without also editing each behaviour.
- The prompt names role names in the unavailable list. It already names the member and the channel guide, so nothing more private is disclosed.
- Behaviours seeded or saved with every skill in their list behave the same as before; their preference is empty in effect.
