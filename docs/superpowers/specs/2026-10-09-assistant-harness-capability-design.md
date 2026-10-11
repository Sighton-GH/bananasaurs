# Assistant harness: capability, attachments and streaming — design

> **STATUS: APPROVED** (owner, 2026-10-10). Every decision is made; order 1 → 6 → 2 → 3 → 4 → 5. Each slice gets
> its own implementation plan under `docs/superpowers/plans/`. Slice 1 is
> `2026-10-10-assistant-capability-truth.md`.

**Status:** APPROVED
**Date:** 2026-10-09 (decisions 2026-10-10) · **Base:** `main` @ 950f78fe (job-lanes merged: ADR 0135, migrations
0105–0106; next free ADR 0136, next migration 0107)
**Evidence:** live database (`sqlite3 -readonly`), 116 traces and every conversation turn from 2026-10-04 to
2026-10-10 across UHill Physineering Club, SFU Racerbot Club and Bananasaurs dev. Four code maps (tool catalogue,
providers, ingestion, research) were read and the load-bearing claims re-checked against source.

## Contents

1. Decisions I need from you
2. What the logs show (symptoms → root causes)
3. How other harnesses do it (what to copy, what not to)
4. Design, in six slices
   - Slice 1: Capability truth (prompt and tool catalogue reorganisation)
   - Slice 2: New abilities (pings, tasks, scheduled messages, member names)
   - Slice 3: Streaming, idle timeout, live progress and thinking in the dashboard
   - Slice 4: Attachments, images and PDFs
   - Slice 5: Daily digest and automatic memory proposals
   - Slice 6: Provider key pools, exhausted-key cooldowns, Gemini default chain, complexity routing
   - 4.7 Everything configurable, on the dashboard
5. Order, dependencies, ADRs and migrations
6. Testing
7. Out of scope / noticed but not planned
8. Appendix: evidence

---

## 1. Decisions I need from you

| # | Decision | Options | My recommendation |
|---|---|---|---|
| D1 | **DECIDED 2026-10-10.** Reminders keep today's setup: owner-only unless you grant roles per guild on the Skills page. Memory should be **automatic**: once a day, the AI summarises that day's conversations, stores the summary for future reference, and drafts memory proposals for you to review. See Slice 5 and D10. | — | — |
| D2 | **DECIDED 2026-10-10: (b) + (c) + (d).** After round 1 the model may call any **read-only** tool, including `web_search` again. It may also act on an id an earlier result returned (`edit_reminder` or `cancel_reminder` with a returned `reminderId`). Other acting tools (`set_reminder`, `create_task`, proposals) stay round-1-only, so text read from a search can never trigger a new action. You accepted the exfiltration risk of later-round web searches. This amends ADR 0071 and the wording of hard rule 3 in CLAUDE.md. | — | — |
| D3 | **DECIDED 2026-10-10: (c), members and roles.** Code decides who is pinged. Members: those the asker named or mentioned, at most 5. Roles: under the ADR 0117 role-ping policy (below the bot or allowlisted, no dangerous permissions), at most 3. A role that is not mentionable also needs the asker to hold Mention Everyone in that channel, as reminders require today. `@everyone` and `@here` never ping. A skill scope can turn it off per guild. | — | — |
| D4 | **DECIDED 2026-10-10: (a).** "Create tasks" in UHill: the task system is team-based and UHill has no teams. | (a) assistant creates club tasks only inside existing teams, and only for team leads and the president; (b) add a lightweight "channel task" (title, assignees, due, nudges) with no team; (c) both | **(a)** first. It reuses everything built for tasks (nudges, posts, approvals). For UHill you would create one team. (b) is a new subsystem; scope it later if (a) is not enough. |
| D5 | **DECIDED 2026-10-10: (b).** Store the model's **thinking text**? It can echo member messages. ADR 0129 keeps the run ledger metadata-only. | (a) live only (in memory while the run is going, gone afterwards); (b) live, plus saved in the trace with the same retention as traces, which already hold the prompt and answer | **(b)**, capped at 8,000 characters per run, visible with the same capability as traces. PRIVACY.md gets one line. |
| D6 | **Default stands (2026-10-10, no objection).** Timeouts once responses stream: an idle timeout (keepalives count as bytes) plus a hard ceiling per model call, for every provider including Gemini. | — | **Idle 45 s, ceiling 300 s**, both instance settings. The job-lanes 60 s setting becomes the time-to-first-byte limit. |
| D7 | **DECIDED 2026-10-10: text files, images and PDFs.** This is your hard-rule-8 instruction for Discord's attachment CDN. Proposed caps (change any): text ≤ 256 KB (inline at most 24,000 chars, at most 3 files); images ≤ 5 MB each (at most 4); PDFs ≤ 10 MB (at most 2). Covers the current message and the replied-to message. Audio and video are deferred. | — | — |
| D7b | **DECIDED 2026-10-10: native only.** A PDF goes to the model only if the model reads PDFs itself (Gemini natively; on OpenRouter, models whose metadata lists `file` input, with the plugin pinned to `native`). There is no local PDF processing and no OCR or parsing service (no `cloudflare-ai`, no `mistral-ocr`). If the model in use cannot read PDFs, the bot says so plainly. Text files (`.txt`, `message.txt`, code, markdown) are sent as text. | — | — |
| D8 | **DECIDED 2026-10-10.** The default for Google AI Studio is **Gemini 3.8 Flash** (`gemini-3.8-flash`), with free-tier limits as the default RPM/RPD, served from a pool of many free keys (Slice 6). You add the other models yourself. Gemini 3.8 Flash reads text, images, audio, video and PDFs, calls tools, and thinks at low/medium/high ("minimal" errors). | — | — |
| D12 | **DECIDED 2026-10-10: re-record Gemini as may-train (`yes`) and use it regardless** (hard rule 5: allowed by owner decision, with log, dashboard and doctor warnings, and a PRIVACY.md line). Per-cost-class records (free = yes, paid = no) still ship in Slice 6. Background: **the Gemini terms record is wrong for free keys.** The live row says `trains_on_input = no` (reviewed 2026-09-23). Google's Gemini API Additional Terms (effective 2026-03-23): for Unpaid Services, "Google uses the content you submit… to provide, improve, and develop Google products… and machine learning technologies", and "Do not submit sensitive, confidential, or personal information to the Unpaid Services". A key counts as paid only if its Cloud project has an active billing account. | (a) re-record Gemini as `yes` (may train), warnings on; (b) make the record per key cost class: free Gemini keys are "may train", paid-project keys are "no" | **(b)**. Code already stores a cost class per key. Until it ships, re-record Gemini as `yes` before adding free keys (hard rule 5: the record must be true; warnings are fine, a wrong record is not). Re-check the OpenRouter row too: some free endpoints may log or train (unverified). |
| D13 | **DECIDED 2026-10-10 (from your AI Studio page): Gemini 3.8 Flash free tier = 5 RPM, 250,000 TPM, 20 RPD**, per Google Cloud project. The secondary source's 15 / 1,500 was wrong. These are the defaults for every free Gemini key, and the bot still corrects itself from Google's 429 replies if they change (Slice 6c). **Capacity:** one answer costs one request per model round (usually 1–3). The model-call ledger shows **94 requests on 2026-10-09 (Pacific day)**. Rolling conversation summaries and the daily digest (Slice 5) use the same chain. At 20 per project per day, that is at least 5 projects; plan on **8–10 keys from separate projects** for headroom. Keys from one project share a single 20/day. Fall back to OpenRouter models when every Gemini key is spent. | — | — |
| D15 | **DECIDED 2026-10-10: 8–10 Gemini keys, owner's risk call** (option a, recorded in the Slice 6 ADR with the clause below). Background: **many free Gemini projects vs Google's terms.** Google APIs Terms §2(d) "API Limitations": "Google sets and enforces limits on your use of the APIs… You agree to, and will not attempt to circumvent, such limitations… If you would like to use any API beyond these limits, you must obtain Google's express consent." Free limits are per project, so running one bot across many free projects to get past 20/day can be read as circumvention. That risks suspension of the keys or the Google account. ADR 0120 refused Brave account-stacking for the same reason. | (a) build the pool and use as many free projects as you like (your risk call); (b) enable billing on **one** project: paid tier, higher limits, and **no training on our data** (which also resolves D12); (c) a few free keys that are genuinely separate (for example, other execs' own projects), with OpenRouter free models as the overflow | Your call; I recommend **(b)**. Rough cost at today's volume (about 94 requests a day, about 10k input and 1k output tokens each, at the listed $0.75 / $3.75 per million; prices unverified): about **$1 a day**. Slice 6's pool, cooldowns and learned limits are useful under every option. |
| D16 | **DECIDED 2026-10-10: Gemini fallbacks and complexity routing.** The default Gemini chain is 3.8 Flash (5 RPM / 20 RPD) → 3.6 Flash (5 / 20) → 3.5 Flash-Lite (15 / 500), each over the whole key pool, then your OpenRouter models. Short, simple messages ("hi", "thanks") go to Flash-Lite first (Slice 6e). | — | Router is deterministic and configurable (6e). It does not spend an AI request to classify. |
| D17 | **DECIDED 2026-10-10: everything configurable is visible and editable on the dashboard** (§4.7). | — | — |
| D14 | **DECIDED 2026-10-10.** Order of work. | See §5 | 1 → 6 → 2 → 3 → 4 → 5. Job-lanes is merged, so nothing is blocked. Slice 6 moves up because Gemini as the default unlocks images and PDFs and replaces the weak chain. |
| D11 | **DECIDED 2026-10-10: (a), fast mode, training disclosure accepted; the free plan is fine.** Parallel as a web-search source (owner request 2026-10-10). Parallel's terms §4(b) allow it to **train on our queries**. | (a) add it in `fast` mode ($1 per 1,000 after 5,000 free a month), disclosed as training per rule 5; (b) `advanced` mode ($5 per 1,000), better results; (c) skip it | **(a)**, as one more source beside Brave and Tavily, with a default limit of 4,500 a month. Confirm you accept the training disclosure. |
| D10 | **DECIDED 2026-10-10: (a).** Which conversations the daily digest reads. | (a) the bot's own conversations only (turns already stored, no new read); (b) also every channel in the Read scope (ADR 0126), read live once a day; (c) also archived channels | **(a)** first: no new read surface, and the data is already kept. (b) sends a day of member chat to the provider every day, so it is a privacy and cost change. The design allows (b) later, per channel. |

Questions that only change details (I will pick a sensible default unless you say otherwise): the exact caps in D6/D7,
the wording of the capability block, and whether "schedule a message" is a style of reminder (my default) or a
separate tool.

---

## 2. What the logs show

### 2.1 Symptoms (from real conversations)

| Symptom | Example | Guild |
|---|---|---|
| Says it can't ping | "i can't actually ping sam or anyone else — i'm just a bot" | UHill |
| Says it can't create tasks | "can you create tasks?" → "i can set reminders… that's the closest thing" | UHill |
| Contradicts itself about reminders within 10 minutes | "i can set reminders that ping people" → "reminders are owner-only" → "i don't have a reminders tool available" | UHill |
| Says it can't schedule messages | "no scheduling tool on my end" | UHill |
| Refuses ordinary requests | 1,000-word fiction → "outside what I help with" ×4; politics → "I could not complete that request" ×5 | dev, Racerbot |
| Cannot see pasted text | "The one I just pasted:" → "There's no pasted text in your message" | Racerbot |
| Guesses at GIFs/images from the URL | "did an ai make this clip?" answered from the link text | Racerbot |
| Long answers fail | fiction and a cheatsheet fail at exactly 30.0 s | dev, UHill |
| Truncated answer delivered | "Sign-ups: 8 seniors and 5 juniors so far; they're" | UHill |

### 2.2 Root causes

**R1. Capability self-knowledge comes from three disagreeing places.**
- The API `tools` array says `set_reminder`.
- The system prompt's WHAT YOU CAN DO block says `reminders: Set, change… You really can do this`. It never names a tool.
- OUTPUT RULES say "Never mention tools… never write a tool's name" and "Never end with… a list of what you can do".

A weaker model, asked "do you have a reminders tool?", obeys the rule about never naming tools and answers no.
Nothing in the prompt says the tool list is the authority on what it can do.

**R2. The bot's earlier false replies are replayed as truth.** A non-owner member got a NOT AVAILABLE block
("Reminders: owner only"), so the bot correctly told her so. Four minutes later Bryan, the owner, asked in the same
conversation. His run *did* offer `set_reminder` (verified in trace `…61598073114657`), but the last 12 turns were
the bot saying reminders were owner-only. The model stayed consistent with its history, not with its tools.

**R3. Skill defaults make nearly everyone a non-owner.** `reminders`, `propose-memory` and `record-decision`
default to owner-only, and no guild has a grant row. Only the configured owner gets 17 tools; everyone else gets 11.
→ D1.

**R4. Abilities that do not exist for the Discord assistant.**
- There is no task tool. A read-only task context appears only on keyword match.
- There is no member lookup.
- There is no scheduled message apart from reminders.
- The reply can never ping. `allowedMentions` is `{ parse: [] }`, by a documented rule (`core/discord/port.ts:106-118`).
- The model never sees who was mentioned. `<@id>` is flattened to the literal `@user` before the provider sees it
  (`mentions.ts:7-11`), so "remind @Sam" arrives as "remind @user".

**R5. Multi-step tool use is blocked after round 1** (`tool-loop.ts:35-39, 511, 873-891`, ADR 0071). The
`set_reminder` description says "use current_time first", yet `set_reminder` cannot be called after `current_time`
returns. A second `web_search` was refused ("not allowed after reading results") in the TRIUMF cheatsheet run, which
then timed out. → D2.

**R6. The generated behaviour prompt invites refusal.**
- The wizard's BOUNDARIES line reads "…otherwise say it's outside what you help with". "WHAT YOU HELP WITH" lists 3–5
  narrow topics. In the dev guild that produced four fiction refusals, despite the owner's channel guide saying
  "help to fulfill each request the best you can".
- Two headers with near-identical names compete: "WHAT YOU HELP WITH" and "WHAT YOU CAN DO".
- The ROLE line says "You are Default assistant", while the safety suffix says "You are Bananasaurs".

**R7. Provider handling.**
- Requests are not streamed.
- `AbortSignal.timeout(30_000)` is a **total** timeout (`openai-compatible.ts:295-297`). Any answer that takes the
  model more than 30 s fails, even while OpenRouter is sending progress.
- `finish_reason` is recorded but never checked (`openai-compatible.ts:404-430`, `tool-loop.ts`
  `finishEntry`). A mid-stream provider error with partial text (`finish_reason: "error"`) is delivered as a normal
  answer, which is how "they're" was posted.
- Reasoning text is received and discarded (`openai-compatible.ts:413`).
- The 2,048-token output budget includes reasoning tokens on reasoning models.

**R8. Attachments are invisible.**
- `toMessageEvent` already captures attachment name, type and size (`packages/discord/src/events.ts:550-557`).
  `handleMention` drops them (`commands.ts:377`).
- The quote fetch keeps only `content` (`rest/port.ts:361-380`).
- Channel context shows `[attachment]` only when the text is empty (`channel-context.ts:115`).
- Embeds (GIF previews and link cards) are never read.
- Providers are text-only on the wire, and no model has a vision flag (`contracts.ts:25-40`,
  `openai-compatible.ts:235-264`).

**R9. The model itself.** The single chain model is a free, text-only model that called a tool in about 12 of 116
runs. It refused a politics question with an empty answer (`provider-empty-answer`) five times. Its fallback does
not exist. Prompt fixes help any model, but a weak tool caller will still under-use tools. → D8.

**Already handled elsewhere:** the 2026-10-06 and 10-08 messages that got no reply at all predate the run ledger
(10-09), so their cause is not recorded; they most likely match the serial-job-queue cause fixed by the approved
job-lanes plan. That plan also wraps the body read
and raises the total timeout to 60 s.

---

## 3. How other harnesses do it

Sources are listed in the appendix. These points are what applies to a single-process Discord bot.

1. **Tool descriptions carry most of the weight.** Anthropic's tool guidance calls detailed descriptions "by far
   the most important factor". The pattern is: what the tool does, when to use it, when not to, each parameter, and
   one example. Ours are one or two sentences and lead with restrictions ("Only when the member asks…").
2. **The capability list is generated from the tools actually offered.** OpenClaw filters tools by policy before
   the call: "the model only sees tools that survive the active profile". Claude Code and OpenClaw list skills
   compactly by name and description. Nobody adds "you really can do this" suffixes; the list is simply correct.
3. **Hide, then explain.** Tools a member may not use are not sent. The reason belongs in one short line, not in a
   rule the model must apply.
4. **Rules are short, sectioned and non-contradictory** ("the right altitude"). opencode keeps a short prompt per
   model family, with separate files for weaker models (kimi, meta, trinity). We do not need per-model prompts yet;
   we do need one prompt with no contradictions.
5. **11–17 tools is below the threshold for tool search** (about 30). Do not add deferred tools. Add one prompt
   line naming the tool categories.
6. **Streaming with keepalives.** OpenRouter sends `: OPENROUTER PROCESSING` comments to keep connections alive. It
   reports mid-stream failures as `finish_reason: "error"` inside a 200 response. Reasoning arrives as
   `delta.reasoning`. The common pattern is an idle timeout plus a hard ceiling, with progress shown to the user.
7. **Images are gated by model capability.** OpenRouter's `/models` exposes `architecture.input_modalities`, so a
   vision flag can be read rather than guessed. For a model without vision, send text metadata instead of the
   image.
8. **Chat agents resolve names to ids in code.** OpenClaw has outbound mention aliases. Our own MCP connector
   already says to look ids up and lets code apply the ping policy.

What not to copy: autonomous loops, DM agents, dynamic tool loading, model-side permission decisions. Hard rules 1,
3 and 8 stay.

### 3.1 Practices adopted into Bananasaurs (owner request 2026-10-10)

Each practice is written into a slice below; this is the index.

| Practice | Seen in | Where it lands |
|---|---|---|
| The capability list is generated from the tools actually sent that turn; there is no second source | OpenClaw tool policy, Claude Code skills listing | 1a |
| Tool descriptions follow what / when to use / when not / parameters / example, tested for shape | Anthropic tool guidance, opencode per-tool `.txt` files | 1b, with a test |
| Hide unavailable tools and give one plain reason line, rather than show-and-refuse | OpenClaw | 1a "Not available to <name>" |
| Short, sectioned prompt with no contradictions; the most decision-relevant section last | Anthropic context engineering, opencode `default.txt` | 1d, 1f |
| One line naming the tool categories instead of tool search (we have about 20 tools, below the roughly 30 where search pays) | Anthropic tool-search guidance, Claude Code | 1a |
| "You may call several tools in one turn when they don't depend on each other" | opencode `default.txt` | 1k |
| Actionable tool errors: a refusal says what to do next ("member 'sammy' not found; did you mean Sam L?") | Anthropic "writing tools for agents" | 1l |
| Per-model profiles: capabilities read from provider metadata (vision, PDF, tools, thinking control), not guessed from names | opencode per-model prompts, OpenRouter `/models`, Gemini model pages | 1g, 6d |
| Eval set read from real transcripts; descriptions and prompts tuned against it | Anthropic | 1h |
| Context hygiene: older tool results and stale self-claims do not outweigh the current tool list | Anthropic compaction guidance | 1e |
| Stream with keepalives; idle timeout plus hard ceiling; show progress and thinking | OpenRouter streaming, Anthropic "show planning steps" | Slice 3 |
| Multimodal input only when the model supports it; otherwise say so | OpenRouter modality routing | Slice 4 |
| Key rotation that skips exhausted keys until their reset, learned from the provider's error | common gateway practice (LiteLLM-style cooldowns) | Slice 6 |
| Scheduled background work (daily digest) with drafts a human approves | Hermes cron, OpenClaw | Slice 5 |

---

## 4. Design

### Slice 1: Capability truth

> **Built** on `worktree-assistant-harness-capability-plan` (ADRs 0136–0137, no migration); awaiting owner merge.

Goal: the bot's answer to "can you X?" matches what it can do on that turn, and it uses its tools when asked. There
is no new external surface and no migration.

**1a. One generated capability block, from the declarations actually sent.** Replace the WHAT YOU CAN DO,
SKILLS_PRECEDENCE_LINE, ACTS_SUFFIX and evidence-rule texts with one block, built in `context.ts` from the
`ToolDeclaration[]` that `service.ts:1115` hands the loop:

```
WHAT YOU CAN DO RIGHT NOW (your tools are the complete, current list)
- Reminders and scheduled posts (set_reminder, my_reminders, edit_reminder, cancel_reminder): post a message
  later in a channel, once or repeating, and ping members or roles.
- Club knowledge (search_sources, read_chunk, open_resource, search_archive, search_conversations): …
- This channel (channel_history): …
- The web (web_search): …
- Time (the current date and time are below; you do not need a tool for them)
When a member asks for something one of these does, use the tool. When asked what you can do, describe these in
plain words. Do not show tool names to members.
Not available to <name> right now: proposing memories (owner only). Say so plainly if asked.
```

- Group by `TOOL_CATALOGUE` category. Add a `group` field to each entry, plus a one-line group description.
- Each tool appears exactly once. A group with no offered tool disappears.
- Prose-only skills (draft-agenda, summarise-meeting and so on) become one line: "Writing help: agendas, summaries,
  announcements, checklists, handoffs, stories and anything else a member asks you to write."
- The prompt rule changes from "never write a tool's name" to "do not show tool names to members". The guard keeps
  stripping raw tool-call syntax from answers, as it does now.

**1b. Rewrite tool descriptions** in `tool-catalogue.ts` to the pattern: what it does / when to use / when not /
parameters / one example. Most important: `set_reminder` gets an example such as "remind Sam at 23:00 to sleep" →
`{ text, when, members: ["Sam L"] }`. It also states that `members` takes display names exactly as written. A
test enforces a minimum description length and the presence of "Use when".

**1c. Put date, time and time zone in the system prompt every turn.** `current_time` stays as a tool for odd
cases. This removes the most common blocked two-step chain without touching ADR 0071.

**1d. Make the default posture helpful.**
- **Wizard.** Rename the behaviour section "WHAT YOU HELP WITH" to "FOCUS (where to look first, not a limit)". The
  `answer-briefly` boundary becomes: "Help with any reasonable request, including general questions, writing and
  creative work, code and opinions. Decline only what the Bananasaurs rules forbid." `redirect` keeps its meaning
  for owners who choose it.
- **Stored prompts.** Rewrite stored prompts at compile time, the way `context.ts:71-74` already rewrites the old
  wording, so no stored prompt needs a migration. The wizard regenerates on the next save.
- **Identity.** The ROLE line uses the bot name ("Bananasaurs"), not the behaviour name.

**1e. Keep history from overriding the tools.**
- **As planned (Slice 1 plan, Task 6).** When the history holds any earlier bot reply, the user message ends with
  a fixed line just before "Answer <name>'s current message": "Your abilities for <name> are exactly what WHAT YOU
  CAN DO RIGHT NOW lists. An earlier reply here that says otherwise was to someone with different access, or is out
  of date."
  - It is deterministic.
  - It sits after the history, where recency helps most.
  - It needs no trace lookup and no migration.
- **Not done: per-turn prefixes on earlier assistant replies.** Models tend to copy such prefixes into their own
  answers, and the fixed line covers the observed failure (a member, then the owner). Revisit only if the live check after
  Slice 1 still shows carry-over.

**1f. Order the prompt for weak models.** The order becomes:

1. identity
2. safety (locked, ADR 0074)
3. how to answer (output rules, de-duplicated)
4. club context (behaviour, server card, sources)
5. **capability block last**, just before the history and the message

Recency matters most for small models. Remove the duplicated "if asked how you know" rule (it appears twice in
`OUTPUT_RULES`).

**1g. Fix the model chain.**
- The AI setup page checks each OpenRouter chain model against OpenRouter's public `/models` list. The host is
  already allowed, no key is sent, and the list is cached for an hour. A model that is no longer listed shows a
  warning on its row. Slice 1 builds this for OpenRouter; the Gemini capability table and the doctor line come with
  Slice 6.
- The same metadata fills a per-entry capability record `{ tools, image, pdf, reasoning }` (used by Slices 3, 4
  and 6):
  - OpenRouter: from `architecture.input_modalities` (`image`, `file`) and `supported_parameters` (`tools`,
    `reasoning`).
  - Gemini: the models list does not expose modalities, so a small, tested table keyed by model family is used
    (`gemini-3.8-flash`: image, pdf, tools, thinking levels low/medium/high). An unknown Gemini model is treated as
    text + tools only until listed.
  - NIM: text + tools only.
- The AI setup page shows these as chips per chain entry ("reads images", "reads PDFs").

**1h. Capability eval set (no network in CI).**
- A fixture file of about 20 member messages, each with its expected first action: "remind sam at 11pm" →
  `set_reminder`, "can you ping people?" → describes pings, "write a 1000-word story" → answers, and so on.
- Unit tests assert that the prompt and declarations those fixtures would receive are correct.
- **Moved to Slice 6: the live scorecard against real models.** It becomes a dashboard "Check models" button on AI
  setup (D17) rather than a script. It needs Slice 6's per-key budgets, because each fixture costs a request and a
  Gemini key has 20 a day.

**1i. Later-round tools (D2).**
- `ID_TOOL_ARGS` (`tool-loop.ts:35-39`) becomes a per-tool `rounds` policy in `TOOL_CATALOGUE`:
  - `any` for every read-only tool, `web_search` included.
  - `first-or-returned-id` for `edit_reminder` and `cancel_reminder`: allowed later only with a `reminderId` an
    earlier result returned, checked the same way `read_chunk` ids are today.
  - `first` for every other acting tool.
- `declarationsFor(round)` and the call-time check both read that policy, so the offer and the enforcement cannot
  drift.
- The hard rule 3 text in CLAUDE.md becomes: "A turn whose only new input is retrieved text may not emit an
  **acting** tool call, except one that acts on an id an earlier result in the same request returned." The rule's
  read-only/acting split is written into ADR 0137.

**1j. Web search as a clear skill (owner request 2026-10-10).** Today `web_search` has no skill line of its own,
and its description leads with restrictions. The behaviour prompt says only "Check the club's sources before
answering from general knowledge". Until D2, the natural chain "search club sources, find nothing, search the web"
was **impossible**: a round-2 `web_search` was refused (that is what happened in the TRIUMF run). With D2 decided,
the chain works, and the prompt now teaches it:
- **New skill `web-search`.** Default everyone; it shows on the Skills page so you can narrow it. It covers
  `web_search` and appears in the capability block as its own group: "The web (web_search): current events, facts,
  how-tos and anything general you are not sure of. Check club sources first for anything about the club; for a
  general question, search the web rather than guess or say you don't know."
- **Rewritten USING SOURCES section in the wizard.** It reads: "1. Club questions: club sources first. 2. If they
  have nothing, or the question is general or about current events, search the web. 3. Say you couldn't find it only
  after both." The compile-time rewrite in 1d upgrades stored prompts.
- **Rewritten `web_search` description** in the 1b pattern. Keep the existing "never put member names in the query"
  rule, which the local query scan also enforces.
- **Eval fixtures (1h)**: "who won the BC election", "what's the boiling point of nitrogen" and "is the TRIUMF tour
  open to grade 9s" each expect a `web_search` (the last after `search_sources`).

**1k. Parallel calls line.** The capability block ends with "When two lookups don't depend on each other, call
them together in one turn." Fewer rounds means fewer requests, which matters at 20 requests a day per Gemini key.

**1l. Actionable tool errors.** Every refusal string in `tools.ts` and `tool-loop.ts` is rewritten to say what to
do next:
- "no member called 'sammy'; closest: Sam L. Retry with that name or ask the member."
- "set_reminder can't run after reading results; ask the member to confirm and it will run next turn."

A test asserts that no refusal is a bare "not allowed".

### Slice 2: New abilities

**2a. Mentions become names, not `@user`.**
- `sanitizeMentionsForProvider` gets the event's `mentionedUserIds` and role ids. It renders `@Sam L` and
  `@Car Team A` using guild display names, through the existing display-name sanitiser.
- Unknown ids keep `@user`. Snowflakes still never leave the process, so the outbound scan is unaffected.

**2b. Member lookup tool `find_member`** (read-only, any round per D2).
- It returns up to 5 matches as `{ name, username, roles }`.
- It never returns ids. Tools take names and code resolves them; this reuses `reminder-targets.ts`.

**2c. Reply pings (D3: members and roles).**
- The model writes `@Sam L` or `@Car Team A` in its answer.
- Before posting, deterministic code finds `@Name` tokens that match a member or role the asker mentioned or named
  in the current message. It replaces them with `<@id>` or `<@&id>` and lists them in `allowedMentions.users` and
  `allowedMentions.roles`.
- Limits:
  - At most 5 members and 3 roles.
  - Roles pass the ADR 0117 policy (`checkRolePing`, dangerous-permission floor). A non-mentionable role also needs
    the asker's Mention Everyone permission, as reminders do.
  - `@everyone` and `@here` never ping.
  - Inline code and fenced code are skipped (same parser as ADR 0128).
  - A refused mention renders as plain text and pings nobody.
- Gated by a new skill `ping` (default: everyone; narrow per guild) and the asker's Send permission in the channel.
- The effect is idempotent by the reply's existing durable key, so a retry re-posts nothing.
- This amends the "only reminder delivery may set users" comment in `core/discord/port.ts`.

**2d. Scheduled messages.**
- `set_reminder` gains `style: "reminder" | "message"`.
- `message` posts the text as is, without the "⏰" and "Set by" frame.
- It uses the same storage, delivery, ping checks, edit and cancel as reminders, so there is no new scheduler.
  `my_reminders` lists both.

**2e. Tasks (D4a).**
- New acting skill `tasks` (default: team leads and the president).
- `create_task`: title, details, team, assignees by name, due date. The id is deterministic from the invocation key,
  the same way MCP uses `requestId`.
- `list_tasks`: read-only, the asker's teams.
- `task_progress`: records a progress note on a task the asker is assigned to, reusing `recordReport`.
- Authority comes from `TaskContextPort.access(actorId)` (team lead or president). It does not use `canManageTasks`,
  which keys on a dashboard account.
- Team, destination and assignee checks reuse `task-admin-port.ts`. The reply's confirmation line is built by code,
  as for reminders.

**2f. Skill defaults (D1).** No change to reminders: you grant roles per guild on the Skills page. The in-chat
`propose_memory` tool stays as it is (owner-only); automatic proposals come from Slice 5. The capability block (1a)
tells a non-owner plainly that reminders are not available to them. That is what the non-owner member got, and it is correct.

**2g. Parallel as a third web-search source (owner request 2026-10-10; D11).**
- **REST, not MCP.** Use Parallel's REST Search API, `POST https://api.parallel.ai/v1/search` with header
  `x-api-key`. Do not use its MCP server: same search, but the bot would need an MCP client. The Parallel connector
  in your Claude client is separate and cannot be reached by the bot.
- **Fits ADR 0120 unchanged in shape:**
  - `search_source` gains `parallel`.
  - Keys go in `assistant_search_keys` with the same sealed storage, ordering, per-key monthly and daily limits, and
    reserve-before-send.
  - A new `parallel-search.ts` sits next to `tavily-search.ts`. The result is mapped to the same `WebResult` shape,
    with each excerpt capped.
- **Fixed request:** `{ objective, search_queries: [query], mode: "fast" }`, 5 results. The `objective` is the
  model's query, put through the same local query scan as today. No member text is added.
- **Cost:** 5,000 free requests a month, then fast is $1 per 1,000 (advanced is $5). The default monthly limit for
  a new Parallel key is 4,500, under the free allowance.
- **Training disclosure (hard rule 5):** Parallel's customer terms §4(b) let it "use Customer IP to train and
  improve" its models, with a perpetual license. Customer IP includes our queries.
  - It needs a provider-eligibility row with `trainsOnInput: "yes"`, the cited clause and a review date.
  - It needs warnings in the log, dashboard and doctor, and a PRIVACY.md line.
  - Queries are the model's search terms (member names are already forbidden in them), not member messages. The
    exposure is smaller than a chat provider's, but it is still disclosed.
- **Rule 8:** `api.parallel.ai` is a new outbound destination. Your 2026-10-10 request is the instruction, recorded
  in the ADR.
- **Migration:** one, widening the `search_source` CHECK constraint.

### Slice 3: Streaming, idle timeout, live progress and thinking

Job-lanes is merged (950f78fe), so this is unblocked. Streaming replaces the body-read code that job-lanes Task 1
wrapped.

**3a. Stream every provider.**
- **OpenRouter and NIM.**
  - `OpenAiCompatibleProvider` sends `stream: true` and `stream_options: { include_usage: true }`.
  - It parses SSE `data:` lines and ignores `:` comment lines.
  - It assembles `delta.content`, `delta.reasoning` and `delta.tool_calls` (arguments are concatenated per index and
    parsed only when complete).
- **Gemini (now the default, D8).**
  - `gemini.ts` calls `:streamGenerateContent?alt=sse`.
  - It assembles text parts, `functionCall` parts and `thought: true` parts separately. The raw parts are still
    echoed back so thought signatures survive tool rounds.
  - Thinking moves from the 2.5-style `thinkingBudget` to Gemini 3's `thinkingConfig.thinkingLevel`: `low` for tool
    rounds, `medium` for the answer. Never `minimal`, which errors on 3.8 Flash.
  - It sets `includeThoughts: true`, so the dashboard gets Gemini's thought summaries (D5).
  - Which thinking parameter a model takes comes from the 1g capability table.
- Every provider returns the same `GenerateTextResponse`, so `SafeProvider`, the tool loop and the guard are
  unchanged.

**3b. Timeouts (D6).**
- **Idle timer.** Re-armed on every received byte; keepalive comments count. Setting:
  `assistant.providerIdleTimeoutMs`, default 45,000.
- **Hard ceiling.** `assistant.providerMaxCallMs`, default 300,000, so a trickling stream cannot hold one of the
  four job lanes forever.
- The job-lanes total timeout (`assistant.providerTimeoutMs`, 60 s) becomes the **time to first byte**. A provider
  that never starts responding is still cut off.
- **Typing indicator.** It is kept alive while bytes arrive, instead of stopping at its fixed 180 s cap.

**3c. Finish reasons are checked.**
- `error`, or a `choices[].error` object, becomes a retryable `ProviderError`. The partial text is kept as trace
  evidence and is never delivered.
- `length` with text is delivered with a code-built `-# (cut short)` line.
- `length` with no text is today's empty-answer path.
- `maxOutputTokens` default goes from 2,048 to 4,096, because reasoning tokens count against it.

**3d. Progress events (metadata, fits ADR 0129 as is).**
- A new run event `model-progress` carries `{ round, answerChars, reasoningChars, keepalives, msSinceLastByte }`.
- It is written at most every 3 s per call. It bumps `updatedAt`, so the 10-minute stalled label stays honest.
- `describeRunEvent` renders it: "Receiving… 1,240 chars of answer, 3,100 chars of thinking".

**3e. Live text in the dashboard (D5).**
- An in-memory, per-run buffer holds the streaming answer and thinking text, capped at 8,000 characters each.
- A new route, `GET /api/assistant/runs/:runId/live`, reads it, gated like traces.
- The StepLog / InProgressPanel polls it every 2 s alongside the events (ADR 0129's polling stays; no SSE).
- When the run finishes, the buffer is dropped. With D5(b), the thinking text is saved into the trace body under
  `reasoning` (per round, capped). The "What the AI saw" page shows it collapsed.
- OpenRouter is asked to return reasoning (`reasoning: { exclude: false }`) only when the model supports it, per
  1g's metadata. Gemini returns thought summaries via `includeThoughts`. A model that exposes no reasoning shows
  only the progress counters.

### Slice 4: Attachments, images and PDFs

**4a. Markers everywhere (no network).**
- The job payload gains `attachments: [{ name, type, sizeBytes }]` from the event, metadata only, so the Jobs
  page never shows file text.
- `[CURRENT MESSAGE]`, the quote envelope and channel lines render `[attached: message.txt, text/plain, 12 KB]` even
  when there is text. The quote fetch keeps attachment and embed metadata too.
- Embeds contribute their title, description and provider name ("Tenor: Top Gear loser dance") as untrusted
  evidence.
- One prompt line: "You can read an attachment only if its contents appear below."

This alone fixes "There's no pasted text in your message".

**4b. Text files (D7).**
- **When.** At job start, re-read the message (current or replied-to) through REST to get fresh signed URLs. The
  CDN URLs expire in about 24 h, and jobs retry.
- **How.** Fetch through `ResourceFetcher`:
  - `allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net']`; verify these against a live attachment URL
    before shipping.
  - HTTPS only, with DNS pinning (existing).
  - `maxBytes` 256 KB.
  - Allowed types: `text/*`, `application/json`, plus extension sniffing for code files.
- **How it reaches the model.** The body is redacted with `redactEvidenceText`, neutralised, capped at 24,000
  characters, and wrapped as `[UNTRUSTED ATTACHMENT name="message.txt"]…`. It is never put in the job payload or
  the run ledger.
- At most 3 text files per message.
- **Paperwork.** A new ADR line for the destination (rule 8) and a PRIVACY.md update.

**4c. Images (D7; Gemini 3.8 Flash reads them).**
- `GenerationMessage` gains optional `media: [{ kind: 'image' | 'pdf', mediaType, dataBase64, name }]`.
  - `gemini.ts` sends `inlineData: { mimeType, data }` parts.
  - `openai-compatible.ts` sends `{ type: 'image_url', image_url: { url: 'data:…' } }` for images and the `file` part
    for PDFs (4d).
- We download the image ourselves, the same way as 4b, so size and type are checked by us and the provider never
  receives a Discord URL:
  - PNG, JPEG, WebP or static GIF, checked by magic bytes, not the declared type.
  - At most 5 MB each and 4 per message.
  - Includes embed thumbnails from `media.discordapp.net`, which covers GIF links.
- **Routing (same rule for images and PDFs).** If the run carries media, each chain entry gets only the media its
  capability record (1g) allows.
  - The loop prefers the first entry that can read everything attached.
  - If none can, it uses the normal order. Unreadable files become a marker ("image.png attached; you can't see
    images right now"), and the model must say so instead of guessing.
- The trace records image count, size and type, never pixels.
- The outbound safety scan does not apply to pixels. That is an accepted gap, and it is written into the ADR.

**4d. PDFs (D7, D7b: native only).**
- **Fetch.** Same path as 4b: at most 10 MB, at most 2 per message, checked by magic bytes (`%PDF-`). We download
  the file and send it base64-encoded, so no Discord URL leaves the process.
- **No PDF processing anywhere but the model.** Bananasaurs does not parse, extract or OCR PDFs, and does not send
  them to a parsing service.
  - **Gemini:** an `inlineData` part with `mimeType: application/pdf`. Gemini reads the text and the page images
    itself.
  - **OpenRouter:** only for models whose metadata lists `file` input. The `file` part is sent with
    `plugins: [{ id: "file-parser", pdf: { engine: "native" } }]`, pinned so OpenRouter never substitutes
    `mistral-ocr` (paid) or `cloudflare-ai` (a third party). A test asserts that every request carrying a PDF has
    exactly this plugin, and that a model without `file` input gets no PDF.
  - **NIM, or any model without PDF input:** the PDF is not sent. The prompt carries "report.pdf (2.1 MB) attached;
    you can't read PDFs right now", and the bot says so.
- **Paperwork.** PRIVACY.md says attached PDFs, images and text files go to the AI provider that answers, and to
  no one else.

**Caps (D7, proposed), all instance settings:**

| Kind | Size | Count per message |
|---|---|---|
| Text | 256 KB / 24,000 chars | 3 |
| Image | 5 MB | 4 |
| PDF | 10 MB | 2 |

Only the current message and the replied-to message are read.

### Slice 5: Daily digest and automatic memory proposals (D1, D10)

Goal: the bot learns from the day without anyone asking it to, and you stay the only one who approves what becomes
memory (hard rule 1: the model drafts, code stores, the owner decides).

- **5a. Job.** A new time-bucketed job kind, `assistant_daily_digest`, runs once per guild per local day (default
  04:00 in the club's time zone). It uses ADR 0127's run-once bucket key, so a restart or a replay cannot run it
  twice.
- **5b. Input (D10a).** That day's assistant conversations: the turns already stored in
  `assistant_conversation_turns`, grouped by conversation, with the existing rolling summaries.
  - The input is capped (for example 40,000 chars) and split into chunks if larger.
  - The same evidence framing, `redactEvidenceText` and outbound scan as every provider call apply.
  - It runs on the guild's normal model chain.
- **5c. Output, validated by Zod like any form:**
  - `daySummary`: topics, decisions mentioned and open questions, at most 300 words.
  - `memoryProposals[]`: each with text, why, and source conversation ids, at most 10.
  - Proposals enter the **existing** memory-proposal review queue, the same one `propose_memory` feeds, marked
    `source: daily-digest`. Nothing becomes memory without your approval. A proposal that duplicates an existing
    memory or a pending proposal is dropped by code, using a normalised-text match.
- **5d. Stored for future reference.**
  - A new table, `assistant_daily_digests`, keyed by guild and day, holds the summary JSON. Retention follows the
    conversation retention setting.
  - `search_conversations` searches digests too, so "what did we talk about last Tuesday" works.
  - The dashboard gets a "Daily digests" list under the assistant's Conversations page.
- **5e. Observability.** Each run writes a run-ledger entry, source `daily-digest` (the CHECK constraint widens),
  so failures show on the dashboard like any other run.
- **Later (D10b), per channel:** add Read-scope channels, read live once a day. Not built now.
- **Budget.** The digest is one or two requests per guild per day. It runs at 04:00, after Gemini's midnight-Pacific
  reset, so it never competes with evening chat for a key's 20 daily requests.

### Slice 6: Provider key pools, exhausted-key cooldowns, Gemini 3.8 Flash default (D8, D12, D13)

**Today:**
- Each chain entry names exactly one key. Using one model across N keys means N chain entries, and the chain is
  capped at 6.
- Keys are added one form at a time.
- A Gemini 429 is never parsed:
  - daily and per-minute exhaustion look identical;
  - nothing remembers that a key is spent, so it is retried on every run and on each job retry (10 s, 30 s, 90 s);
  - the health banner ignores 429s.
- The only "exhausted" memory, `QuotaLedger`, is in memory only, OpenRouter `:free` only, and lost on restart.

**6a. A chain entry uses a key pool, not a key.**
- `assistant_model_chain` gains `pool` (`key` | `provider`), via migration.
  - `key` behaves exactly as today.
  - `provider` means "every enabled key of this entry's provider". New keys join automatically, and removed or
    disabled keys leave.
- The chain stays at most 6 entries, but one entry can now cover any number of keys.
- **Choosing a key.** Inside an entry, the loop takes the usable key with the most requests left today. Ties go to
  the least recently used. This spreads load across projects instead of draining key 1 first.
- **Limits are per key.** The entry's `rpmLimit` and `rpdLimit` apply to each key separately. `reserveModelCall`
  is already keyed by (key, model), so the ledger needs no change.
- **Keys from one project.** A key gains an optional `project` label. Keys with the same label share one ledger
  bucket, because Google limits per project, not per key. The add-keys form says so: "Keys from the same Google
  project share one 20/day."

**6b. Adding many keys at once.**
- The AI setup page gets a "Paste keys" box: one key per line, plus an optional project label per line
  (`key, project`).
- They are added in one request:
  - each key is sealed and auto-labelled ("Gemini 1", "Gemini 2", …);
  - each key is checked with one cheap call (Gemini `models.list`, which costs no generation quota);
  - each gets a ✓ or ✗ ("invalid key", "API not enabled", "unrestricted key refused").
- Duplicates are refused by a fingerprint (a hash of the key, never the key itself).
- `POST /api/assistant/keys/bulk` is owner-only and audited with the count and labels, never key text.
- A key's row shows: requests today / limit, and status (ok, cooling until 14:32, spent until midnight PT, invalid).

**6c. Exhausted keys are not retried (owner request).**
- **New table `assistant_key_cooldowns`** with `(key_id, model, until, reason, set_at)`. It replaces the in-memory
  `QuotaLedger`, survives restarts, and covers every provider.
- **Gemini 429s are parsed.** The adapter reads the error body (`status: RESOURCE_EXHAUSTED`,
  `details[]` with `google.rpc.QuotaFailure` violations and `google.rpc.RetryInfo.retryDelay`). The exact shape is
  to be confirmed against a real 429 in a fixture before shipping.
  - A violation whose `quotaId` names **PerDay**: the key is spent for that model until the next midnight Pacific
    (`provider-day.ts` already computes it). Reason `daily-quota`.
  - **PerMinute**, or a token-per-minute violation: cool down for `retryDelay`, or 60 s if absent. Reason
    `minute-quota`.
  - **The violation's `quotaValue` is recorded as the key's learned limit**, and the dashboard shows it ("Google
    says 20/day"). If it differs from the entry's configured limit, the learned value is used for that key. This
    self-corrects if Google changes the free tier again.
- **Other providers.**
  - OpenRouter `:free` daily caps move to the same table, from `resolveResetAt`.
  - A plain 429 with `Retry-After` honours the header.
  - 401/403 marks the key `invalid` until the owner edits or re-tests it. The dashboard shows it, and doctor fails
    on it.
- **The loop skips cooling keys** before reserving. A pool with every key cooling emits one `model-skipped`
  ("all 8 Gemini keys spent until 00:00 PT") and moves to the next chain entry, such as an OpenRouter model.
- If the whole chain is spent, the member gets the existing local-limit reply naming the time, and **the job does
  not retry** (today's `LocalLimitError` path), so spent keys are never hammered.
- **Health and banner.** The banner shows when a pool is fully spent, and when a key is invalid. A spent key is
  normal and is not an alarm while others remain.
- **Tests.**
  - Two runs after a daily 429 never call that key again before the reset.
  - A restart keeps the cooldown.
  - A minute cooldown expires on time.
  - A pool picks a different key after one is spent.
  - Break-it: remove the skip and watch the "never called again" test fail.

**6d. The default Gemini chain (D8, D16).**
- When the first Gemini key is added and the chain has no Gemini entry, the setup page offers one click ("Use the
  recommended Gemini setup") that inserts three pooled entries at the top. The existing entries move down as
  fallbacks.

  | Position | Model | Pool | RPM | RPD | Tier (6e) |
  |---|---|---|---|---|---|
  | 0 | `gemini-3.8-flash` | all Gemini keys | 5 | 20 | standard |
  | 1 | `gemini-3.6-flash` | all Gemini keys | 5 | 20 | standard |
  | 2 | `gemini-3.5-flash-lite` | all Gemini keys | 15 | 500 | light (also the last standard fallback) |
  | 3+ | your OpenRouter models | as today | as set | as set | standard |

- **Capacity.** Google's free quotas are per model and per project. The 429's `quotaId` reads
  `…PerProjectPerModel…` (confirm with the fixture in 6c). So with 10 keys from separate projects a day holds:
  - 200 requests on 3.8 Flash;
  - 200 on 3.6 Flash;
  - 5,000 on 3.5 Flash-Lite.
  The ledger and cooldowns are already per (key, model), so each model's quota is tracked separately.
- **Known limits, pre-filled.** A small table in code holds the known free-tier limits. Picking a model in a new
  chain row pre-fills its RPM and RPD, which you can edit.
  - 3.8 Flash and 3.6 Flash: 5 / 20.
  - 3.5 Flash-Lite: 15 / 500.
  - Unknown models: blank.
  - A learned limit from a 429 (6c) overrides the pre-fill for that key and is shown next to it. `TPM` (250,000) is not enforced locally:
  at 5 RPM with prompts of about 10k tokens it cannot be reached. A TPM 429 is still handled by 6c.
- The 1g capability table marks `gemini-3.8-flash` and `gemini-3.6-flash` as image + PDF + tools + thinking
  levels. `gemini-3.5-flash-lite`'s capabilities are confirmed from its model page when the table is written (not
  yet verified).
- **Terms (D12, owner 2026-10-10: "it should work based on what i select regardless").** The terms record is a
  disclosure, never a gate. Whatever the owner selects, keys are added and used.
  - The record only drives the may-train warnings (log, dashboard, doctor) and PRIVACY.md.
  - The setup page shows a non-blocking notice when a free Gemini key exists while the record says `no`: "Google's
    free tier may train on what you send. Update the record?"
  - Nothing is refused because of it.
- **Request budget per answer.** At 20 a day per key, rounds cost real capacity. The loop's default `rounds` limit
  stays 4, and 1k (parallel calls) and 1c (date in the prompt) cut typical answers to 1–2 requests.

**6e. Complexity routing (D16).** Simple messages should not spend 3.8 Flash's 20 a day.
- **Tiers.** Each chain entry gets a `tier`: `standard` (default) or `light`.
- **The router.** A pure function, `routeRun(input, rules) → { tier, reason }`, runs before the chain. It is
  deterministic and costs no AI request. A run is **light** only if every one of these holds:
  - the message is at most N characters after mentions are stripped (default 80);
  - it has no attachments, quote or replied-to message to read;
  - it matches none of the "needs the full model" keywords (default list: remind, schedule, task, ping, search,
    look up, summar, explain, why, how, write, story, code, plan, compare, translate, fix);
  - the conversation is short (at most 4 earlier turns), so follow-ups in a long thread keep the stronger model.

  A greeting, thanks or emoji-only message (a short, configurable pattern list) is light even inside a long
  conversation.
- **Order by tier.**
  - A light run tries light entries first, then the standard entries in order, so "hi" never fails because
    Flash-Lite is spent.
  - A standard run tries standard entries in order, then light entries as the last resort.
  - A run that falls back across tiers records it ("3.8 and 3.6 spent on all keys → answered by 3.5 Flash-Lite").
- **Same tools on both tiers.** If a light run's model calls a tool, the next round of that run switches to the
  standard tier, because tool use means the question was not simple. This is configurable (on by default) and
  costs nothing when it doesn't trigger.
- **Background jobs pick a tier too.** Rolling conversation summaries and the daily digest default to `light`
  (Flash-Lite's 500/day), which keeps 3.8 Flash for members. Configurable per job.
- **Visible.**
  - A new run event `routed { tier, reason }`, shown in the step log ("Light: 2-character greeting").
  - The trace page shows the tier.
  - The model-health table groups by tier.
  - The AI setup page has a **"Try the router"** box: type a message and see the tier and the rule that decided
    it, with no AI call.
- **Tests.** Every rule is test-first, with table-driven cases: "hi" is light; "remind me at 5" is standard; an
  attachment is standard; a long thread is standard unless the message is a greeting. Also: a light run falls back
  to standard when Flash-Lite is spent, and a tool call escalates.

**6f. "Check models" (moved from 1h).**
- A button on AI setup runs the capability fixtures against one chosen chain entry. Its tools are declared but
  stubbed, so nothing acts and nothing is posted.
- It shows a scorecard: which tool the model reached for first, versus the expected one.
- Before running, it states how many requests it will spend from that entry's keys, and it refuses when the
  remaining budget is too small.
- Each run is in the run ledger as source `dashboard-test`.

### 4.7 Everything configurable, on the dashboard (D17)

Rule for every slice: **nothing this plan adds is configured only in code or `.env`.** Each setting has a label, a
one-sentence help text saying what it changes, its default, its current value, and a "reset to default" control.
Owner-only settings say so. Each slice's tests include a dashboard test that the control renders and saves.

| Setting | Default | Page |
|---|---|---|
| Model chain: model, pool (one key or all keys of a provider), RPM, RPD, tier; recommended Gemini setup button | 6d table | AI setup → Model order |
| Keys: paste many, project label, cost class (free/paid), status (ok / cooling until / spent until / invalid), requests today / limit, learned limit | — | AI setup → Keys |
| Model capabilities (reads images / PDFs / tools / thinking) | from metadata (1g) | AI setup → Model order (chips, read-only, with a "refresh" button) |
| Router on/off, max characters, full-model keywords, greeting patterns, long-thread turns, escalate-on-tool | on, 80, list in 6e, list, 4, on | AI setup → Routing (with "Try the router") |
| Tier for summaries and for the daily digest | light, light | AI setup → Routing |
| Provider terms per provider and per cost class | from records | AI setup → Terms (existing form, extended) |
| Idle timeout, max call time, time to first byte, max answer tokens | 45 s, 300 s, 60 s, 4,096 | Assistant tuning (registry, ADR 0080) |
| Attachment caps: text size, chars and count; image size and count; PDF size and count; on/off per kind | caps table after 4d | Assistant tuning |
| Thinking text: show live, save in trace, max chars | on, on, 8,000 | Assistant tuning |
| Web search source (Brave / Tavily / Parallel), keys, monthly and daily limits | as ADR 0120 | AI setup → Web search (existing, plus Parallel) |
| Skills: reminders, ping, tasks, web-search scopes | per D1/D3/D4 | Skills (existing scope editor) |
| Reply pings: max members, max roles | 5, 3 | Skills → Ping |
| Daily digest: on/off, time of day, input cap, max proposals | on, 04:00, 40,000 chars, 10 | Assistant → Memory (with the digest list) |
| Behaviour wording: focus areas, boundary stance, USING SOURCES order | wizard (1d, 1j) | Behaviours (existing wizard) |

Where a value is a list (keywords, greeting patterns), the control is an editable chip list, not a comma string.

---

## 5. Order, dependencies, ADRs and migrations

| Slice | Depends on | ADR (next free: 0136) | Migration | Size |
|---|---|---|---|---|
| 1 Capability truth + web-search skill | — | 0136 capability block, prompt order, web-search skill; amend 0085 (tool names), 0087 (NOT AVAILABLE wording); 0137 later-round tools (D2, amends 0071 and the hard rule 3 text in CLAUDE.md) | none (history marker reads the trace) | M |
| 2 New abilities | 1 | 0138 reply pings (members + roles) + mention names; 0139 assistant task tools; 0140 Parallel search source (rule 5 + rule 8) | one (`search_source` CHECK); numbers follow job-lanes 0105–0106 | M–L |
| 3 Streaming (incl. Gemini) | — (job-lanes merged) | 0141 streaming, idle timeout, finish reasons, live buffer; amends 0129 §6 if D5(b) | none | M |
| 4 Attachments | 1 (4a), 1g + 6 (4c, 4d) | 0142 attachment fetch destination, images and PDFs to providers (native only); PRIVACY.md | none | M–L |
| 5 Daily digest | 1 | 0143 daily digest and automatic memory proposals | one (`assistant_daily_digests`, run `source` CHECK) | M |
| 6 Key pools, Gemini chain, routing | — (do second) | 0144 key pools, persistent cooldowns, learned limits, Gemini default chain, free-project risk (D15); per-cost-class terms (D12); 0145 complexity routing | one (`pool`, `project`, `tier`, `assistant_key_cooldowns`, key fingerprint, routing rules) | L |

ADR and migration numbers are assigned in build order; the table lists them by slice for reference only.

Each slice gets its own implementation plan (`docs/superpowers/plans/…`) and branch. They are delegated the way
recent work was, with Opus doing the final review.

## 6. Testing

- Test-first for every change that touches permissions or pings (skill scope defaults, reply-ping filter, task
  authority) and for idempotency (reply pings, `create_task`).
- **Prompt tests.** The capability block lists exactly the offered declarations. A hidden tool never appears as
  available. No section still says "never write a tool's name". The ROLE line uses the bot name.
- **Loop tests (D2).**
  - A later-round `search_sources` and a later-round `web_search` are allowed.
  - A later-round `set_reminder` is refused.
  - A `cancel_reminder` with a returned id is allowed, and one with an invented id is refused.
  - Break-it: drop the acting-tool check and watch the `set_reminder` test fail.
- **Provider tests.** An SSE fixture covers keepalive comments resetting the idle timer, fragmented tool-call
  arguments, `finish_reason: "error"` becoming retryable, `length` adding the cut-short note, and the hard ceiling.
- **Attachment tests.** Oversize is refused, a wrong magic number is refused, a host outside the allowlist is
  refused, an expired URL triggers a re-read, and text is redacted and framed.
- **Break-it check per slice.** Watch each new guard fail before trusting it.
- **Live check after deploy.** Re-run the UHill reminder conversation and the dev fiction request against the
  chosen model.

## 7. Out of scope / noticed but not planned

- Identity claims: the bot accepted "I am the club head" from a member and repeated it. The rolling summary's
  `botClaims` helps, but member claims about themselves are stored as facts. Worth its own small fix later.
- Per-model prompt variants (opencode style). Revisit only if the chosen model still under-uses tools after Slice 1.
- PDFs, audio, video, and attachments in older channel messages.
- SSE or WebSocket push to the dashboard. 2 s polling is enough for this.
- The empty answers on politics are the model's own refusal. A different model (D8) is the fix, not code.

## 8. Appendix: evidence

**Tools offered** (from `included.toolsOffered`):
- 11 tools: `channel_history, current_time, open_resource, read_chunk, refresh_source, search_archive,
  search_conversations, search_sources, server_info, upcoming_events, web_search`.
- 17 tools (owner only): those plus `set_reminder, my_reminders, edit_reminder, cancel_reminder, propose_memory,
  propose_decision`.

**Failures:**

| Code | Count | Guild | Model | Cause |
|---|---|---|---|---|
| `provider-empty-answer` | 7 | Racerbot | Nemotron | politics |
| `provider-bad-model` | 7 | Racerbot | space-bunny-alpha | model removed |
| `provider-error` (timeout) | 3 | dev ×2, UHill | Nemotron | at 30.0 s and 38.9 s |

**Key traces:**
- UHill `trace_1558361149563469835` (a non-owner member): prompt has `NOT AVAILABLE… Reminders: owner only`.
- UHill `trace_1558361598073114657` (Bryan): `set_reminder` offered, model calls only `current_time`, then says
  "i don't have a reminders tool".
- UHill run `1558357491723804763`: `web_search` ok → second `web_search` refused "not allowed after reading
  results" → timeout.
- dev runs `1558364670471962705` and `1558365624533786747`: 30,007 ms timeouts on a 1,000-word story.

**Code references:**

| Area | Location |
|---|---|
| Tool gate | `apps/daemon/src/assistant/tools.ts:370-384` |
| Skill scope | `service.ts:545-558`, `packages/core/src/assistant/skills.ts:38,50,62,153-171` |
| Prompt pieces | `packages/core/src/assistant/context.ts:40-54,103-108,206-247`, `prompt-wizard.ts:130-135,196,249-301` |
| Round rule | `apps/daemon/src/assistant/tool-loop.ts:35-39,511,873-891` |
| Mentions | `apps/daemon/src/assistant/mentions.ts:7-11` |
| Reply mentions | `apps/daemon/src/jobs/assistant.ts:86-89,1392-1395` |
| Provider | `packages/core/src/providers/openai-compatible.ts:287,295-297,300-325,389,404-430` |
| Attachments | `packages/discord/src/events.ts:550-557`, `apps/daemon/src/assistant/commands.ts:377`, `packages/discord/src/rest/port.ts:361-380` |
| Dashboard live | `packages/dashboard/src/hooks/useLiveResource.ts`, `pages/assistant-live.tsx` |

**External sources:**

- Anthropic: [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
  [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
  [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
  [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
  [Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
- Claude Code [skills](https://code.claude.com/docs/en/skills).
- opencode [prompts](https://github.com/sst/opencode/tree/dev/packages/opencode/src/session/prompt).
- OpenClaw [tools](https://docs.openclaw.ai/tools), [skills](https://docs.openclaw.ai/tools/skills) and
  [Discord](https://docs.openclaw.ai/channels/discord).
- Hermes [docs](https://hermes-agent.nousresearch.com/docs/).
- OpenRouter [streaming](https://openrouter.ai/docs/api-reference/streaming),
  [reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) and
  [multimodal](https://openrouter.ai/docs/guides/overview/multimodal/overview).
- OpenRouter `/api/v1/models`, fetched 2026-10-09: Nemotron 3 Ultra input = text only; space-bunny-alpha absent.

**Not verified:**
- The Codex CLI prompt and opencode's per-tool `.txt` files could not be fetched.
- The exact Discord CDN host names for signed attachment URLs need checking against a live attachment.
