# 0085. Assistant voice, speaker labels and prompt order

Date: 2026-09-27
Status: Accepted (owner decisions D1–D9 in `docs/23_ASSISTANT_MEMORY_PLAN.md`, 2026-09-27)

## Context

Members read the assistant as stiff and forgetful. The system prompt names
tools in its prose ("search them with search_sources…"), so the model repeats
them. Earlier turns carry a speaker name only once two people have spoken and
never say how long ago they were said. The question comes first in the user
turn and the evidence after it. The wizard knows only the Discord server's
name. Slice 1 of docs/23 fixes these without any new data flow; the research
is `docs/research/2026-09-26-memory-context-tools-research.md`.

## Decision

1. **Wizard identity.** The wizard answers gain `clubName`, `serverType`
   (club / team / friends), `botName`, `personality`, `channelGuide` and a
   `glossary` of up to 10 terms, plus a `casual` tone. Every new field has a
   Zod default, so stored answers still parse and no migration is needed.
   Empty club and bot names fall back to the server name and the behaviour
   name.
2. **Built-in style examples.** The compiled prompt carries two example
   replies per tone that show register and hold no club facts, so a copied
   example can never go stale. The owner's own examples follow them.
3. **Output rules** are a fixed section of every system instruction, placed
   after the locked safety suffix: chat like a member, steps only when asked,
   never name a tool or say "I searched", say where in general terms when
   asked and never deny a source, say so when nothing turned up, give the
   gist of what members said without names or quotes unless asked about a
   specific person, and answer the person in the current message.
4. **No tool names in prompt prose.** Tool declarations still carry names
   (providers need them). The compiler strips the one tool-naming sentence
   older wizard prompts saved, so existing behaviours need no re-save.
5. **Speaker labels.** Every earlier user turn reads `[Name, 3 min ago] …`,
   however many people have spoken. The bot's turns stay in the assistant
   role, unlabelled.
6. **Question last.** The user turn is: club evidence, the quoted message,
   then `[CURRENT MESSAGE from="Name"]…[/CURRENT MESSAGE]`, then one line
   naming who to answer. The trace records this text as a `user-message`
   section, so the History page shows what the model was asked.

## Addendum (slice 1 build)

- Citation tags `[S#]` are per request and stripped from the answer before posting.
- The Sources line lists only sources the answer cited, at most 5, and is omitted when nothing is cited.
- The typing indicator starts when a mention is queued (new jobs only) and is re-sent every 8 s for up to 180 s.
- Display names are sanitised (no brackets or control characters, 32 characters), and earlier turns without a name read "a member".
- Evidence, quotes and titles have every block marker neutralised.

## Consequences

Replies follow the owner's voice settings with a stable, cacheable system
prompt. The recent-turn window grows slightly (labels cost a few tokens per
turn). The new wizard fields change only prompt text; nothing new is stored
or sent outside the prompt.
