# Assistant reliability, permissions, logging, web search and tools

Status: **APPROVED 2026-09-23 with owner decisions:**
- Q1 web search: Gemini Google Search grounding.
- Q3 permissions: "Who can ask" covers every skill the behaviour allows. Only
  owner-only skills stay owner-only, and the per-skill grants are no longer a
  gate for members.
- Q4 tools: all four groups (archive search; web search and reading a page;
  resources, server card and channel directory; date, time and reminders).
- Log content: the full question and answer.
Base: branch `bot-tag-behaviour`, which must be merged and migrated first.
Gate for every task: `npm run typecheck && npm run lint && npm run test`.

## Diagnosed bugs

### B1. "I could not complete that request. No action was taken."

Evidence: the live journal (3 days) shows 16 failures, and every one is
`ProviderError: Gemini request failed with HTTP 503`. A 503 means the Gemini
model is overloaded. The job retries up to 3 times, but the attempts land about
2 seconds apart, so all three hit the same overload. After the last one, the
member gets the generic message. Nothing in our request is wrong.

Fix:
- Retry with real backoff (about 10 s, 30 s, 90 s). That stays well inside
  Discord's 15-minute reply window.
- An optional **fallback model**, set in AI setup (for example
  `gemini-2.5-flash-lite`), is tried after the primary model returns a 503.
- An honest member message when it still fails: "The AI service is busy right
  now. Try again in a minute."
- The failure reason is recorded in the AI log channel (item F1).

### B2. A role allowed to "use the bot" still can't

Cause, from the code: a request passes **two separate gates**.
1. The behaviour's caller roles. This is what "Who can ask" on the Assistant
   page edits.
2. A per-skill grant for each skill (`assistant_skill_grants`). This is written
   once by "Grant everyday skills" for the roles chosen at that moment, and is
   not updated when you later add a role to "Who can ask".

So adding Operations to "Who can ask" passes gate 1 and fails gate 2. The
member gets "You do not have a matching grant for this assistant skill". If
they used a role tag and the role wasn't on that behaviour, they get silence:
that refusal is only logged. I could not read the live activity table from
here to confirm which gate refused, but both gates are covered by the fix.

Fix (**decision Q3**): everyday skills (read and draft) follow "Who can ask"
automatically. Only confirmation-class skills (reminders, decisions, memory)
and owner-only skills keep needing a grant. The role-tag path replies visibly
instead of refusing silently. Tests first: an Operations member added only
through "Who can ask" gets an answer.

## Features

### F1. AI log channel

- The owner picks a channel on the Assistant page, and a behaviour can be set
  to not log. Every assistant request posts one embed there, containing:
  - who asked and where (a channel link)
  - the behaviour
  - the question text
  - the answer text (truncated to Discord's limits, with the full text in the
    dashboard's Assistant history)
  - skills and tools used, and the resources and web sources cited
  - the provider and model, latency, and outcome (answered, refused, failed
    with its reason)
- Posting is a durable job whose idempotency key is the invocation id plus
  `log`, so a replay never double-posts (hard rule 6). Mentions are disabled.
  The post waits until the member has been answered.
- Privacy: this copies members' questions into a staff channel. `PRIVACY.md`
  says so, and the picker warns that the channel should be staff-only.

### F2. Web search skill (**decision Q1**)

A new read-only `search-web` skill.

Recommended: **Gemini's built-in Google Search grounding**.
- It sends no data to a new company and needs no new key.
- It only works while the provider is Gemini.
- Google caps free-tier grounded requests per day.
- Cited web pages are shown as sources in the answer and the log.

Alternative: the Brave Search API. It works with any provider, but it is a new
outbound destination, a new API key and a new terms record.

Search results are evidence, never instructions (hard rule 3).

### F3. Skills are clickable in the web UI

Each skill on the Skills page opens a detail panel showing:
- what it does and its effect class
- whether it needs confirmation or is owner-only
- which behaviours allow it and who is allowed to use it (after B2)
- the external services it contacts (web search: Google)
- its last 20 uses from the activity table

### F4. Resources are shared, and behaviours emphasise some

- Every enabled resource is available to every behaviour.
- A behaviour's resource list becomes "Emphasise these resources". In each
  request those resources are fetched first and marked "prefer these sources"
  for the model.
- A migration keeps today's per-behaviour lists as the emphasis lists. The
  Assistant page wording changes to match.

### F5. More tools (**decision Q4**)

Today each command runs exactly one skill and makes one model call, and the
model cannot call tools. Proposed: a **read-only tool loop**.
- The model may call up to 4 tools per request.
- Every call and result is validated by Zod (hard rule 3).
- Tools cannot write anything (hard rules 1 and 8). Writes stay as today's
  explicit commands with confirmation.

Candidate tools:
- search the club's Discord archive (enabled channels only)
- open a reviewed resource
- web search (F2)
- read a web page, restricted to URLs returned by web search or listed as a
  resource, never an arbitrary URL
- today's date and time in the club's time zone
- the member's upcoming reminders
- the server card and the channel directory

A turn whose only new input is a tool result may not trigger a write (hard
rule 3).

## Order

1. ADRs 0064 (permissions), 0065 (AI log channel), 0066 (web search) and
   0067 (tool loop), plus `PRIVACY.md`.
2. B1: backoff, fallback model and the busy message.
3. B2: unify the permission gates.
4. F4: shared resources with emphasis.
5. F1: the log channel.
6. F3: skill details.
7. F2 and F5: the tool loop, with web search as one of its tools.
