> **STATUS: DRAFT** — decisions D1–D9 answered 2026-09-27; slice 1 in progress.

# Assistant memory, context and personality — plan

**Status:** DRAFT (2026-09-26)
**Evidence:** `docs/research/2026-09-26-memory-context-tools-research.md` (sourced; cited below as "Research §n").

## Contents

1. Decisions I need from you
2. Why the bot loses the thread (what the code does today)
3. Your proposals: verdicts
4. Design
5. Tools: keep, change, add
6. Slices, in build order
7. What I am deliberately not doing

## 1. Decisions (answered by the owner, 2026-09-27)

| # | Decision | Owner's answer |
|---|---|---|
| D1 | **Channel context** sent to providers | Every provider, disclosed in PRIVACY.md, with a warning when the active provider may train (ADR 0062 pattern). The window is a **count only: the last 15 messages, no time limit**, configurable in the AI config tab from 0 to 50 (0 = off) |
| D2 | **Audience rule** | Enforced in code: an answer in channel C draws only on channels every viewer of C can read. Applies to archive search, channel context and recall |
| D3 | **Quoting** | Aggregate by default, no names or quotes. "Did X say Y?" gets yes/no plus a message link added by code. "Summarise everything X said" is refused. Asked how it knows, it answers in general terms; it never denies having a source |
| D4 | **Cross-conversation recall** | Build summaries **and** recall (`search_conversations`) in this round. Owner override of REVIEW §E ("memory extraction automation" after Release 3); recorded in the slice's ADR |
| D5 | **Opt-out** | **No opt-out** for channel context or recall. The existing memory opt-out keeps its current scope. PRIVACY.md says so plainly |
| D6 | **Summary retention** | Deleted with the conversation (6 months by default, the existing retention setting) |
| D7 | **Summary cost** | Summaries run on **the same model that produced the reply**. Skipped when that model is rate-limited; raw turns are kept, so the next run catches up |
| D8 | **Concurrent conversations** | Link, never merge. The web UI must show clearly how conversations are linked and what context and knowledge the AI used (4.6) |
| D9 | **What is recorded per reply** | A **full snapshot** of the exact prompt text sent to the provider (system, summary, turns, channel context, snippets, tool calls and results), deleted with the conversation. PRIVACY.md discloses that snapshots can hold copies of channel messages later deleted from Discord |

## 2. Why the bot loses the thread

Read from the code on 2026-09-26:

1. **Only the same author continues a conversation** (`packages/core/src/assistant/conversation.ts`). A second member who asks a follow-up without using Discord's reply starts a fresh conversation, with no history. In real group chat this is common: 37.7% of answered questions in annotated IRC logs got answers from more than one person (Research §1 item 2).
2. **The bot never reads the channel.** It sees only the message that tagged it, plus the replied-to message.
3. **Older turns are dropped, not summarised.** History is the last 12 turns or 6,000 characters (`apps/daemon/src/assistant/conversation-context.ts`).
4. **Weak labelling.** Earlier turns are plain `user`/`assistant` messages. Speaker names appear only once two people have spoken, and nothing marks them as earlier context or says how long ago they were.
5. **The prompt order works against the model.** The question arrives without the channel's recent messages, and long evidence can sit in the middle of the prompt (Research §1 item 5).
6. **The prompt invites tool narration.** The system prompt names the tools ("search them with search_sources; open one with read_chunk…"), and archive results show channel, date and excerpt, which the model then repeats.
7. **The wizard knows only the Discord server's name.** It has no club name, server type, bot persona or glossary.

## 3. Your proposals: verdicts

| # | Proposal | Verdict | Refinement |
|---|---|---|---|
| 1 | Label earlier turns as previous context, with who said what | Supported | Put the speaker in the message text (works on every provider), prefix every user turn, add relative time: `[Maya, 3 min ago] …` |
| 2 | Summarise past a word limit and store it | Partly | Trigger when turns leave the recent window, not on a word count. Summarise in the background after the reply. Keep the raw turns |
| 3 | Read the surrounding messages | Supported | A fixed, small window fetched by the bot (not a tool the AI calls), labelled as evidence, never stored in the conversation |
| 4 | Merge related concurrent conversations | Not supported as a merge | Link instead (D8) |
| 5 | Read its other past conversations | Partly | A tool over summaries, audience-filtered and aggregated. Later slice (D4) |
| 6 | Personality, short replies | Supported | Positive voice rules plus 3–5 example replies with **no real club facts** (a copied "Thursdays at 4pm" goes stale). Allow longer replies for step-by-step answers. A one-line tone reminder at the end of every prompt |
| 7 | Never reveal searches or messages; aggregate; quote only when asked | Partly | D3. The real risk is the *audience*, fixed in code (D2) |
| 8 | Never expose tool names | Supported | Remove tool names from the prompt text; add an output rule; the output guard already watches for leaks |
| 9 | Wizard asks for club name and type | Supported | Also ask for the bot's name and personality, what the main channels are for, and a short glossary ("the lab" = …) |

## 4. Design

### 4.1 Conversation boundary (keep the rules, add three)

Kept: reply to a known message → that conversation; same author, same channel, 30 minutes → continue; `new topic:` → fresh.

Added:
- **A Discord thread is a conversation.** Every @mention inside a thread where the bot has spoken joins that thread's conversation, whoever asks.
- **Unambiguous follow-up.** A *different* member's @mention joins the channel's conversation when the bot replied in that channel within 10 minutes and exactly one bot conversation was active there in that time. Otherwise it starts fresh. The channel window still carries the context, so a wrong guess costs little.
- **Who is being answered** is always explicit in the prompt, and the Discord reply targets that member's message.

### 4.2 Prompt layout, top to bottom

1. **System** (stable, so providers can cache it): identity (club name, type, bot name) → personality and example replies → output rules (below) → locked safety suffix → owner-approved club facts → the source catalogue, **without tool names in its prose**.
2. **Earlier in this conversation (summary)**, if any: at most 150 words, marked as data.
3. **Recent turns**, word for word: the last 8 turns or about 2,000 tokens. User turns look like `[Maya, 3 min ago] …`; the bot's turns stay in the assistant role. Earlier turns' raw tool results are never replayed.
4. **The final user message**, in this order:
   - `<channel_context>`: recent messages in #channel not addressed to the bot. Evidence only. The last N messages (N from AI config, default 15, 0–50, no time limit), `[name, time]` prefixes, replies marked. Messages already in the transcript are left out.
   - `<reference_snippets>`: the 4 pre-retrieved club-source snippets.
   - `<current_message from="Maya">` with its replied-to message, if any.
   - One line: "Answer Maya. Keep it short."

Every block carries its origin label, which ADR 0071 already requires.

### 4.3 Conversation summaries

- **When:** after a reply, if turns fell out of the recent window, a background job updates the summary from the previous summary plus the evicted turns.
- **Shape** (Zod-validated JSON, rendered as short text): topic; established facts, each tagged *said by a member / club doc / archive*; open questions; commitments (who, when); participants. The bot's own earlier claims are kept apart from facts, so a guess never hardens into one.
- **Stored** on the conversation row; raw turns are kept, so a summary can always be rebuilt. Deleted with the conversation (D6).
- **Model:** the model that produced the reply (D7).
- **Idempotent** (hard rule 6): keyed by conversation and the last turn it covers.

### 4.4 Personality and the wizard

New wizard fields:
- club name (default: the server name)
- server type: club / team / friends
- bot name (default: Bananasaurs)
- personality in one line (default: "a friendly senior member")
- what the main channels are for
- a glossary of club terms (up to 10)

Tone presets gain **casual**, the new default for a friends server.

Built-in output rules, always on:
- Reply like a member of {club}: one to three short sentences, plain words. Use steps only when someone asks how to do something.
- Say what you know directly. If asked how you know, say where in general terms. Never name tools and never say "I searched".
- If nothing turned up, say you couldn't find it. Don't guess.
- By default, say what people generally said without names or quotes (D3).
- Answer the person who asked. Use the channel messages only to understand them.

The examples you pasted from Haiku are good for register ("yeah, meetings are Thursdays at 4pm in the lab"). I would keep the style and swap the facts for placeholders, so the model never repeats a stale time.

### 4.5 Audience rule (D2), enforced in code

For any answer posted in channel C, the channels the bot may draw on are those every viewer of C can read. For a public channel, that means other public channels. This applies to archive search, channel context (trivially: it is C itself) and later recall. Enforced where results are fetched, never left to the model (ConfAIde: models leak 39–57% of the time, Research §1 item 9).

### 4.6 Context inspector and conversation links (D8, D9)

- **Snapshot per reply:** the exact messages sent to the provider for each model call, plus the model, entry, token counts and which blocks were included (summary version, N channel messages, snippet chunk IDs, archive hits, tool calls). Stored with the turn, guild-scoped, deleted with the conversation. Secrets never enter it: the prompt contains none, and the snapshot is written after the output guard.
- **Links:** every way a conversation joined or relates to another is recorded as a typed link: `reply-to`, `thread`, `follow-up` (the 10-minute rule), `same-channel-concurrent` (shared channel context), and `recalled` (a `search_conversations` hit).
- **Web UI:** the Conversations page shows, per conversation, its turns with a "What the AI saw" panel per reply (the snapshot, split into labelled sections: identity and rules, summary, recent turns, channel context, club sources, tool calls), the current summary, and a Links panel listing linked conversations with the link type and a jump link. A channel view shows conversations that overlapped in time as a timeline.
- The AI config tab gains the channel-context window setting (D1) next to the other tuning values.

## 5. Tools: keep, change, add

| Tool | Action |
|---|---|
| Recent channel context | **Add**, fetched by the bot on every @mention, not called by the model (4.2) |
| Thread context | **Add**, fetched by the bot inside a thread: starter message plus recent posts |
| `upcoming_events` | **Add**: Discord scheduled events and the bot's own schedules. The top question in your sample is "when's the meeting?" |
| `channel_history(before, limit ≤ 50)` | **Add**: page further back, current channel only |
| `search_archive` | **Change**: audience filter (D2); an optional author filter used only for "did X say Y?"; returns a message link that code adds when quoting |
| Six document tools | **Change**: fold `list_sources` into `search_sources`, and `outline` into `open_resource`. Six overlapping tools cause wrong picks (Research §4) |
| `search_conversations` | **Later** (D4) |
| Model-written memory | **No.** Summaries come from the harness; the existing "propose a memory for owner review" stays |
| `who_said`, `member_profile` | **No.** Surveillance feel; the author filter above covers the legitimate case |

## 6. Slices, in build order

Each slice ships on its own and is testable without the next one.

1. **Prompt and persona** (no new data flows): wizard fields, output rules, tool names out of the prompt, relative-time speaker labels on every turn, the new prompt order with the question last and the tone reminder. *Fixes: personality, tool narration, labelling.*
2. **Context snapshots and inspector** (D9): migration for per-reply snapshots, the "What the AI saw" panel. Comes early so every later slice is visible in it.
3. **Channel and thread context** (D1, D5, D8): the bot fetches the window; the window setting in AI config; the thread rule; the unambiguous-follow-up rule; typed conversation links and the Links panel; PRIVACY.md. *Fixes: "doesn't know what we're talking about".*
4. **Audience rule** (D2, D3): code filter on archive search; aggregation and quoting rules; message links added by code. *Fixes: the leak path.* Must land before recall.
5. **Conversation summaries** (D6, D7): summary column, background job, idempotency key, re-injection, summary shown in the inspector. *Fixes: long conversations.*
6. **Tools**: `upcoming_events`, `channel_history`, document-tool consolidation.
7. **Recall** (D4): `search_conversations` over summaries, audience-filtered, aggregated; `recalled` links.

Every slice gets its ADR first, tests first for anything touching permissions, guild scope or idempotency, and the golden question set gains multi-member follow-up cases.

## 6a. Skills and reminders (owner request 2026-09-27; builds right after slice 1)

Owner decisions:

| # | Decision | Owner's answer |
|---|---|---|
| S1 | **Skill scope** | Every skill has one server-wide scope: *Everyone who can ask*, *Specific roles*, or *Owner only*. It applies to slash commands and chat alike. A behaviour's skill list still decides which skills it offers. Supersedes ADR 0064 ("Who can ask is the only member gate") |
| S2 | **Defaults** | Skills that act (reminders, propose memory, record decision) default to *Owner only*; read and draft skills default to *Everyone who can ask* |
| S3 | **No confirmation** | A permitted member's request runs straight away. The model proposes the call; code validates it (Zod), checks the scope against the asker's live roles, and executes with an idempotency key. If the request is ambiguous (time, channel, who to ping), the bot asks instead of guessing |
| S4 | **One reminder skill** | `reminders` replaces `create-reminder` + `send-reminder`. Delivery is automatic |
| S5 | **Pings** | Any member or role the asker names. `@everyone`, `@here` and non-mentionable roles only when the asker has Discord's *Mention @everyone, @here and All Roles* permission in the target channel, checked live when set |
| S6 | **Channels** | The reminder may post in another channel, but only one the asker can view and send in (live check) and the bot can send in |
| S7 | **After setting** | The bot confirms it is set and replies with a summary: what, why (context), when (absolute date/time in the club's time zone), where, who it pings |
| S8 | **Chat operations** | Set, list mine, cancel mine, edit mine (text, time, channel, pings); the owner can change any. Recurring: daily, weekdays, weekly on chosen days, every N weeks, monthly on a date, optional end date or count; missed runs during downtime are skipped (at most one late post) |
| S9 | **Skills tab** | Shows each skill's live items: reminders set (with edit/cancel), memory proposals to review, decisions, recent activity |
| S10 | **Only mod slash commands** | Remove every slash command except `/mod` and its subcommands: the twelve that duplicate AI skills (`/ask`, `/find`, `/remind`, `/remember`, `/decision`, `/review-plan`, `/onboard`, `/agenda`, `/summarise`, `/announce`, `/checklist`, `/handoff`) and `/status`. Skills are reached only by talking to the bot; bot status stays on the dashboard and `npm run doctor` |

Injection guard (hard rule 3, ADR 0071): skill calls that act are offered only in the first tool round and only in answer to the asker's own current message; text in evidence, channel context or quoted messages can never trigger one. Every action is logged in skill activity.

## 7. What I am deliberately not doing

- Automatic conversation disentanglement or merging: unreliable even for fine-tuned models (Research §1 item 3).
- Embeddings: REVIEW C11 keeps search lexical.
- A model-written long-term memory: an injected message could plant a false "memory".
