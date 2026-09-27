# Memory, context and tools for Bananasaurs: research report

Date: 2026-09-26. Scope: what the evidence says about memory, channel context and tools for a Discord assistant that several members @mention at once in busy channels. Claims with a URL come from that source. Claims marked "(unsourced)" are my own judgement.

## 1. Summary: ten findings for this bot

1. **Less context works better than more.** Every model Chroma tested scored clearly higher on a focused ~300-token version of a LongMemEval question than on the full ~113k-token history. Claude models showed the largest gap, mostly because they abstained when the history was ambiguous (https://research.trychroma.com/context-rot). Anthropic's guidance is to find "the smallest possible set of high-signal tokens" (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). Recent channel context should be short and marked as its own section.
2. **The second-member follow-up is common, not an edge case.** In annotated Ubuntu IRC chat, 37.7% of conversation-opening messages that got any response got replies from more than one person. 94.9% of consecutive messages in a conversation were within 2 minutes, and almost all were within an hour (https://arxiv.org/pdf/1810.11118). The rule that only the same author continues a conversation will drop the context for many real follow-ups.
3. **Cheap heuristics are weak at untangling conversations, and models are not much better.** Linking each message to the one before it scored 35 link-F. A feature model scored 63.5 and a feedforward model 72.3. The widely used time-and-mention heuristic produced only 10.8% correct conversations (https://arxiv.org/pdf/1810.11118). Out-of-the-box GPT-4o "performs poorly". A fine-tuned GPT-4o Mini reached 74.4% link F1 and 45.3% exact-conversation F1 (https://lrec.elra.info/lrec2026-main-229). Do not build merging on automatic disentanglement. Rely on Discord's structure (replies, threads, mentions) and let the model read a short window.
4. **The standard pattern has three parts:** recent turns kept word for word, a rolling summary of older turns, and on-demand retrieval for everything else. Examples: MemGPT's FIFO queue with a recursive summary at its head (https://arxiv.org/html/2310.08560v2), Anthropic compaction plus memory (https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool), and OpenAI Agents SDK trimming or summarising (https://developers.openai.com/cookbook/examples/agents_sdk/session_memory).
5. **Order matters.** Put long material first and the question last. Anthropic reports that queries at the end "can improve response quality by up to 30 percent" (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). Models use the start and end of a long context best and the middle worst (https://arxiv.org/abs/2307.03172).
6. **Short replies score better.** Across 200,000+ simulated conversations, performance fell 39% from single-turn to multi-turn. Longer assistant replies carried more assumptions and scored lower on five of six tasks (https://arxiv.org/html/2505.06120v1). Opus 5 writes longer by default and needs an explicit instruction to be concise (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5).
7. **Personas drift and need re-anchoring.** Measurable drift in following instructions appears within eight rounds on LLaMA2-70B and GPT-3.5 (https://arxiv.org/abs/2402.10962). Anthropic appends a `long_conversation_reminder` to the end of the user message in its own apps (https://platform.claude.com/docs/en/release-notes/system-prompts).
8. **Group-memory precedent is conservative.** In ChatGPT group chats, "personal ChatGPT memory is not used … and ChatGPT does not create new memories" (quoted in https://daringfireball.net/linked/2025/11/17/group-chats-in-chatgpt; OpenAI's page returned 403 to me). Claude keeps a separate memory per project as "a safety guardrail that keeps sensitive conversations contained" (https://www.computerworld.com/article/4056366/anthropic-adds-memory-to-claude-for-team-and-enterprise-plan-users.html, https://anthropic.com/news/memory). Slack AI "only operates on the data that the user can already see" (https://slack.com/blog/news/how-we-built-slack-ai-to-be-secure-and-private).
9. **Models cannot be trusted to keep secrets.** On the ConfAIde benchmark, GPT-4 revealed private information in contexts where humans would not 39% of the time, and ChatGPT 57% of the time (https://arxiv.org/abs/2310.17884). Any privacy rule has to be enforced in code, in what the model is shown.
10. **Hiding the mechanics is fine; hiding the truth is not.** The OpenAI Model Spec allows instructions to stay private but ranks "good answer > refusing > lie of omission > lie of commission" (https://model-spec.openai.com/2026-08-18.html). Slack AI shows citations so users can verify answers (https://slack.com/help/articles/28310650165907-Security-for-AI-features-in-Slack). "Don't narrate tools" is supported. "Deny having read anything" is not.

## 2. Verdict on each proposal

**1. Label previous turns as previous context, with who said what. Supported.**
Anthropic recommends separating a prompt into distinct tagged sections (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). The OpenAI API has a `name` field "to differentiate between participants of the same role" (https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). Community reports say the Responses API drops it, though (https://community.openai.com/t/dealing-with-multiple-participants-using-the-responses-api-message-name/1154818), and Anthropic's API has no such field. Speaker addressing is structural, and LLMs struggle with it (https://aclanthology.org/2024.emnlp-main.628; https://arxiv.org/abs/2501.16643).
Refinements:
- Put the speaker in the message content so it works across providers.
- Prefix every user turn, even when only one human has spoken. Channel context will bring in other names anyway.
- Keep the bot's own turns in the assistant role.
- Add relative times.

**2. Summarise above a word threshold and store it with the conversation. Partly supported.**
Summarising is the main lever for continuity (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents; https://arxiv.org/abs/2308.15022). Production systems trigger on tokens or on eviction, not words. MemGPT warns at about 70% of its window and, at 100%, evicts messages into a recursive summary (https://arxiv.org/html/2310.08560v2). Anthropic's clearing of old tool results defaults to 100,000 input tokens (https://platform.claude.com/docs/en/build-with-claude/context-editing).
Refinements:
- Summarise the turns that are about to fall out of the verbatim window.
- Do it in the background after the reply. LangMem contrasts "active" formation during a conversation with background formation (https://github.com/langchain-ai/langmem/blob/main/docs/docs/concepts/conceptual_guide.md).
- Keep the raw turns in the database.

**3. Read surrounding channel messages. Supported, with limits.**
Claude in Slack does exactly this: "When mentioned directly in a channel, Claude looks at recent channel messages" (https://code.claude.com/docs/en/slack). The same page warns: "Claude may follow directions from other messages in the context."
Refinements:
- Use a small, recent window.
- Wrap it in a labelled evidence block, which fits the existing ADR 0071.
- Keep it out of the transcript. Distractors hurt more as input grows (https://research.trychroma.com/context-rot).
- Marking where untrusted text came from (spotlighting) cut prompt-injection success from over 50% to under 2% on GPT models (https://arxiv.org/abs/2403.14720).

**4. Merge related, concurrent conversations. Not supported as a merge.**
No framework I found merges sessions. LangGraph threads, Agents SDK sessions and MemGPT queues each assume one ID per conversation (https://docs.langchain.com/oss/python/langgraph/memory; https://openai.github.io/openai-agents-python/sessions/). Automatic untangling is unreliable (finding 3). A wrong merge brings one member's context into another member's answer.
Refinement: link instead of merging. A reply to any message in conversation A joins A, as it does today. The other active conversations in a channel reach the model through the channel-context window, not through a fused transcript.

**5. Let the AI read its other past conversations. Partly supported.**
Cross-session recall is well established:
- Letta's recall memory with `conversation_search` (https://www.letta.com/blog/introducing-the-agent-development-environment/)
- ChatGPT's "reference chat history" (https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- Mem0 (https://arxiv.org/abs/2504.19413)
- Zep (https://arxiv.org/abs/2501.13956)

All of these are single-user or scoped to one project. The only group product I found turns memory off (finding 8).
Refinements:
- Make recall a tool, not automatic injection.
- Search summaries, not transcripts.
- Filter in code by who can see the reply (§3.5).
- Let members opt out.

**6. A real personality with short, casual replies. Supported.**
Examples are "one of the most reliable ways to steer Claude's output format, tone, and structure" (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), and positive examples beat "don't" rules (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5). Brevity also improves accuracy (finding 6).
Refinements:
- Use example replies that contain no real club facts. A model that copies "Thursdays at 4pm" will repeat it after the meeting moves. (unsourced)
- Allow longer replies for step-by-step instructions. In Laban et al., the shortest replies hurt on the one action-like task (https://arxiv.org/html/2505.06120v1).
- Re-state tone at the end of each prompt (finding 7).

**7. Never reveal searching or which messages were read; aggregate; quote only when asked. Partly supported.**
Aggregating by default is sensible. Discord forbids processing data "in a way that surprises or violates Discord users' expectations" (https://github.com/discord/discord-api-docs/blob/62c9a95b56d2f989d3eefe39a058d69189f6b4a6/docs/policies_and_agreements/Developer_Policy.md). "Never reveal" goes too far for two reasons:
- Denying a source when asked is a lie of omission or commission under the Model Spec.
- Slack's precedent is to cite, so people can verify.

The larger risk is not attribution, it is audience. A reply in #general is visible to everyone there, so quoting or summarising a private-channel message leaks it even without a name attached. The model cannot be trusted to judge this (finding 9).
Refinements:
- Enforce the reply channel's audience in code.
- Don't narrate searches by default.
- Answer truthfully and in general terms when someone asks where a fact came from.
- Allow targeted "did X say Y?" questions. Refuse "summarise everything X has said".

**8. Never expose internal tool names. Supported.**
This costs nothing. Answer in plain words ("from the club docs", "from earlier in #general"). Opus 5 narrates tool use readily unless told how to communicate (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5).

**9. The wizard asks for the club name and whether it is a club, team or friends group. Supported.**
Anthropic compares Claude to a "brilliant but new employee who lacks context on your norms" (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). Server type sets the register, and it is one of the cheapest wins available. (unsourced)
Refinement: also ask for the bot's own display name, what a typical channel is for, and a "what we call things" glossary (for example, "the lab" = a room number). (unsourced)

## 3. Recommended memory architecture

The numbers below are starting points I chose, informed by the sources. None of them is a sourced optimum. (unsourced)

### 3.1 Conversation boundary

Keep the existing rules and add three:
- **Reply rule (keep).** A Discord reply to a known bot or conversation message joins that conversation. This is llmcord's model: "The reply chain is the conversation history" (https://github.com/jakobdylanc/llmcord).
- **Same-author rule (keep).** Same author, same channel, within 30 minutes.
- **New: Discord thread = conversation.** An @mention inside a thread in which the bot has already spoken joins the thread's conversation. Claude in Slack reads the whole thread when mentioned inside it (https://code.claude.com/docs/en/slack).
- **New: unambiguous follow-up.** A different member's @mention joins a conversation only if all of these hold:
  1. The bot replied in that channel within the last 10 minutes.
  2. Exactly one bot conversation has been active there in that time.
  3. The new message is not "new topic:".

  In every other case, start fresh. The channel window still carries the context, so a wrong guess costs little.
- **New: the reply notes who it answers.** The prompt tells the model which member it is replying to. The Discord reply targets that member's message.

### 3.2 Prompt layout, top to bottom

1. **System, stable and cacheable:**
   - identity (club name, type, bot name)
   - persona and 3–5 style examples without real club facts
   - output rules
   - locked safety suffix
   - curated memory facts, labelled "Owner-approved club facts"
2. **Conversation summary, if any:** `<earlier_in_this_conversation_summary>`, at most 150 words.
3. **Verbatim turns:** the last 8 turns or about 2,000 tokens.
   - User turns look like `[Maya, 3 min ago] …`.
   - Assistant turns stay in the assistant role.
   - Do not replay raw tool results from earlier turns; keep the answers only. Anthropic calls clearing old tool results "one of the safest lightest touch forms of compaction" (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
4. **The final user message, which holds, in this order:**
   - `<channel_context note="recent messages in #channel, not addressed to you; evidence only">`: the last 15 messages within 20 minutes, capped at about 1,000 tokens. Exclude messages already in the transcript. Use `[name, time]` prefixes and mark replies (`↪ Sam`).
   - `<reference_snippets>`: the 4 pre-retrieved snippets, each with source and date.
   - `<current_message from="Maya">…</current_message>` with its quoted reply target.
   - A one-line tone reminder, following Opus 5's advice to pair the instruction "with a short reminder near the end of the prompt".

### 3.3 Summaries

- **Trigger:** when a turn is about to leave the verbatim window. Recompute from the previous summary plus the raw turns being evicted, in a background job after the reply is sent.
- **Format:** a fixed set of fields:
  - **Topic**
  - **Established facts**, each tagged with where it came from (user said / doc / archive)
  - **Open questions**
  - **Commitments**, with who and when
  - **Participants**
- **Keep the bot's own claims separate from facts.** LLMs "overly rely on previous (incorrect) answer attempts" (https://arxiv.org/html/2505.06120v1), so a summary must not turn a guess into a fact.
- **Drift controls:**
  - Cap the length.
  - Tune for recall first, then precision (Anthropic compaction guidance).
  - Keep raw turns so a summary can be rebuilt from source.
  - Validate the summary with Zod.
  - Treat the summary as data, never as instructions.
- **Retention:** keep summaries on the same schedule as the archive. Slack keeps recaps for 90 days (https://slack.com/help/articles/28310650165907-Security-for-AI-features-in-Slack).

### 3.4 Merging

Never merge transcripts. Across concurrent conversations, only the channel window is shared. If two conversations turn out to be one, a member replies to the other thread, and the reply rule links them from then on.

### 3.5 Cross-conversation recall with a privacy guard

- **Tool:** `search_conversations(query)` over conversation summaries in this guild.
- **Code-level filter:** return only conversations held in channels whose viewers include everyone who can see the reply channel. For a public channel, that means other public channels. This follows Slack's rule of fetching with the requester's access list. The requester here is the whole audience of the reply, because the reply is public. (adaptation, unsourced)
- **Also exclude:**
  - thread-private or restricted channels
  - conversations of members who opted out
  - conversations whose starter asked for "private" (a flag set at runtime)
- **Output:** aggregated only (topic, outcome, date). No names unless the asker is one of that conversation's participants. (unsourced)

## 4. Tools, ranked

| Rank | Tool | Action | Value | Risk | Precedent |
|---|---|---|---|---|---|
| 1 | Recent channel context | **Add, as a harness pre-fetch** (deterministic, not model-called) | Highest: fixes "knows what we're talking about" | Injection, distractors; mitigate with an evidence block and caps | Claude in Slack (https://code.claude.com/docs/en/slack) |
| 2 | `thread_context` | **Add, also as a pre-fetch** when inside a Discord thread: starter plus recent posts | High | Low, same audience | Claude in Slack; llmcord threads |
| 3 | `event_calendar` / `upcoming_events` | **Add**: reads Discord scheduled events and bot schedules | High ("when's the meeting?" is the sample) | Low; read-only, deterministic | (unsourced) |
| 4 | `channel_history(before, limit≤50)` | **Add**: pages further back in the *current* channel only | Medium | Low, same audience | Letta `conversation_search` |
| 5 | `search_archive` | **Change**: filter by the reply-channel audience (§3.5). Optional `author` filter only for targeted "did X say" questions. Return a message link for anything quoted | Keeps value, removes the leak path | Profiling: refuse "everything X said" | Slack ACL + citations |
| 6 | `search_conversations` | **Add, after 1–5 are live**: summaries only, audience-filtered | Medium | Cross-member recall; mitigated by §3.5 | Letta recall, ChatGPT chat history (both single-user) |
| 7 | Document tools (`list_sources`, `search_sources`, `read_chunk`, `outline`, `open_resource`, `refresh_source`) | **Change**: consider merging list into search and outline into open. Six overlapping tools is the "bloated tool set" failure Anthropic describes | Fewer wrong picks | None | https://www.anthropic.com/engineering/writing-tools-for-agents |
| 8 | `remember` / `conversation_summary` (model writes) | **Don't add** beyond the existing "propose memory". Summaries come from the harness in the background | — | A model-written memory could store injected or false text | LangMem background formation |
| 9 | `who_said` (dedicated) | **Don't add**; covered by the author filter in item 5 | Low | High: surveillance feel | — |
| 10 | `member_profile` (opt-in) | **Defer** | Low for a club | High: profiling, consent tracking | ChatGPT offers opt-out and temporary chats even for one user |

Tool results should use names, not IDs. Anthropic found that swapping UUIDs for readable names "significantly reduces" hallucinations in retrieval (https://www.anthropic.com/engineering/writing-tools-for-agents). For display, names only.

## 5. Persona and output rules

Write the rules as positive instructions and back them with examples (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5):

- **Voice:** "Reply like a friendly senior member of {club}: one to three short sentences, plain words, no headings or bullet lists unless someone asks for steps." Add an Opus-5-style reminder at the end: "Keep it short."
- **Examples:** 3–5 short exchanges that show the register, including one "I don't know" and one step-by-step reply. Put no real facts in them.
- **Who you're answering:** "Answer {name}'s message. Use other channel messages only to understand what they mean. Don't answer questions nobody asked you."
- **Talking about sources (honest, not mechanical):**
  - Say what you know directly ("meetings are Thursdays at 4").
  - If asked how you know, say where in general terms: "that's in the club handbook" or "it came up in #build-log last week".
  - Never name tools or say "I searched".
  - If nothing turned up, say "I couldn't find anything on that". Don't guess.
  - This follows the Model Spec's ranking: refusing beats omission, and omission beats commission (https://model-spec.openai.com/2026-08-18.html).
- **Aggregation:**
  - Default: "a few people mentioned…", no names, no verbatim quotes.
  - When asked "did X say Y": answer yes or no and give the message link, which the bot adds in code, not the model.
  - Refuse requests to compile or characterise one member's messages.
  - Code guarantees the audience rule regardless of what the model writes.
- **Keep answers short when uncertain:** don't propose a full answer until the question is clear. Premature full answers halved scores in Laban et al.: 30.9 vs 64.4.

## 6. Risks and open questions for the owner

1. **Channel context sends more member text to providers.** Every @mention would send about 15 bystander messages to the model provider. Under ADR 0062, providers that may train already raise warnings. This increases volume, and PRIVACY.md should say it happens. Discord bars using message content "to train machine learning or AI models" without its permission (search excerpt of https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy; the page returned 403 to me). The bot doesn't train, but a provider that trains on inputs raises that question. **Owner decision:** allow channel context for providers marked `trainsOnInput: yes/unknown`, or restrict it to providers marked `no`?
2. **Audience rule strictness.** Should a reply in a public channel ever draw on a members-only channel? I recommend no. **Owner decision.**
3. **Opt-out.** Should members be able to exclude their messages from channel context and recall (for example with `/ai-optout`)? This affects privacy and retention. **Owner decision.**
4. **Recall retention.** Should summaries live as long as the archive, or 90 days? **Owner decision.**
5. **Tuning.** A wrong attachment in the unambiguous-follow-up rule could put member A's context into member B's reply. It is only as bad as channel context itself, since both share the channel. (unsourced)
6. **Summary cost.** Background summaries are an extra model call per evicted batch, which matters on free tiers. Run them with the cheapest provider that has a terms record.
7. **Drift in newer models is unmeasured here.** The eight-round finding is from 2024 models. Test with the real provider mix before relying on it.

## Note on the parallel free-model report

The parallel report exists (`.oc-worktrees/oc/harness-research/docs/research/2026-09-26-assistant-memory-research.md`). I skimmed it. It agrees on the core: short verbatim window plus summary plus retrieval, link rather than merge, and question last.

**Where it adds something:** the MemGPT 70%/100% thresholds. I checked them against the paper and they are correct.

**Where it is wrong or thin:**
- It covers 8 proposals, not 9. It omits the wizard proposal.
- It claims no source addresses several people talking to one assistant. MultiLIGHT (https://arxiv.org/abs/2304.13835), ChatGPT group chats, Claude in Slack and llmcord all do.
- It cites the 30% query-last figure to the system-prompts page. The figure is on the prompting best-practices page, as the report itself admits.
- It gives 30,000 as "the" context-editing trigger. The documented default is 100,000 input tokens.
- It misses the audience-leak point, ConfAIde, the verbosity evidence, the group-chat memory precedent, and Slack's access-list and citation practice.
- It rejects proposal 7 outright, where I found it partly supported.

## 7. Sources

- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://platform.claude.com/docs/en/build-with-claude/compaction
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5
- https://platform.claude.com/docs/en/release-notes/system-prompts
- https://anthropic.com/news/memory
- https://www.computerworld.com/article/4056366/anthropic-adds-memory-to-claude-for-team-and-enterprise-plan-users.html
- https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- https://code.claude.com/docs/en/slack
- https://help.openai.com/en/articles/8590148-memory-faq (search excerpt; direct fetch returned 403)
- https://openai.com/index/memory-and-new-controls-for-chatgpt/
- https://daringfireball.net/linked/2025/11/17/group-chats-in-chatgpt (quotes OpenAI's group-chat post; openai.com returned 403. A search result says group chats began winding down on 2026-07-09; unverified)
- https://openai.github.io/openai-agents-python/sessions/
- https://developers.openai.com/cookbook/examples/agents_sdk/session_memory
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- https://community.openai.com/t/dealing-with-multiple-participants-using-the-responses-api-message-name/1154818
- https://model-spec.openai.com/2026-08-18.html
- https://arxiv.org/abs/2310.08560 and https://arxiv.org/html/2310.08560v2 (MemGPT)
- https://docs.letta.com/guides/core-concepts/memory/memory-blocks
- https://www.letta.com/blog/introducing-the-agent-development-environment/
- https://docs.langchain.com/oss/python/langgraph/memory
- https://github.com/langchain-ai/langmem/blob/main/docs/docs/concepts/conceptual_guide.md
- https://arxiv.org/abs/2504.19413 (Mem0)
- https://arxiv.org/abs/2501.13956 (Zep)
- https://arxiv.org/pdf/2304.03442 (Generative Agents)
- https://arxiv.org/abs/2410.10813 (LongMemEval)
- https://arxiv.org/abs/2308.15022 (recursive summarisation)
- https://research.trychroma.com/context-rot
- https://arxiv.org/abs/2307.03172 (Lost in the Middle)
- https://arxiv.org/html/2505.06120v1 (LLMs Get Lost in Multi-Turn Conversation)
- https://arxiv.org/abs/2402.10962 (instruction/persona drift)
- https://arxiv.org/pdf/1810.11118 (Kummerfeld et al., disentanglement)
- https://lrec.elra.info/lrec2026-main-229 (LLM disentanglement)
- https://arxiv.org/abs/2304.13835 (MultiLIGHT)
- https://aclanthology.org/2024.emnlp-main.628 (multi-party addressee recognition)
- https://arxiv.org/abs/2501.16643 (addressee recognition benchmark)
- https://arxiv.org/abs/2403.14720 (spotlighting)
- https://arxiv.org/abs/2310.17884 (ConfAIde)
- https://slack.com/blog/news/how-we-built-slack-ai-to-be-secure-and-private
- https://slack.com/help/articles/28310650165907-Security-for-AI-features-in-Slack
- https://github.com/jakobdylanc/llmcord
- https://github.com/discord/discord-api-docs/blob/62c9a95b56d2f989d3eefe39a058d69189f6b4a6/docs/policies_and_agreements/Developer_Policy.md (older policy text)
- https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy (search excerpt only; 403)
