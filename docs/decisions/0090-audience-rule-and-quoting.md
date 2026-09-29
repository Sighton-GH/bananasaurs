# 0090. Audience rule and quoting

Status: accepted. Implements docs/23 slice 4 (owner decisions D2, D3). Extends ADR 0067 (archive search). It must land before slice 7 (recall).

## Context

`search_archive` searches the channels the **asker** can read (ADR 0067), but the answer is posted in channel C, where everyone who can view C reads it. A member with access to a private channel can ask in #general and have its content summarised to everyone there. Models leak such context 39–57% of the time when only told not to (docs/23 research §1 item 9), so the rule has to live in code.

- **D2:** an answer in C draws only on channels every viewer of C can read.
- **D3:**
  - answers aggregate by default, with no names or quotes;
  - "Did X say Y?" gets a yes or no plus a message link that code adds;
  - "Summarise everything X said" is refused;
  - asked how it knows, the bot answers in general terms and never denies having a source.

## Decision

### 1. The audience set, computed from overwrites

Enumerating every member who can view C is not practical: the member cache is capped at 50 (ADR 0008), and a full member fetch on every mention is a gateway request per question. Instead, a pure function `audienceChannels(answerChannel, candidates)` in `apps/daemon/src/assistant/audience.ts` decides from the permission overwrites alone. It can wrongly leave a channel out, but never wrongly let one in.

A candidate text channel X (never a thread) is **in the audience of C** when any of these holds:
1. X is C.
2. X is **open**: the `@everyone` role can View Channel and Read Message History in X (`X.permissionsFor(everyoneRole)`), and no role or member overwrite on X denies either permission.
3. X has **the same audience as C**: X's overwrites that mention View Channel or Read Message History match C's exactly, overwrite by overwrite (id, type, and the allow and deny bits for those two permissions), and `@everyone`'s base permission for them is the same.

A viewer of C can read an open X because nothing on X denies them. A channel with identical overwrites has exactly C's viewers.

Anything unknown fails closed: an uncached guild or channel, or a thread as C (its parent's audience is used only if the thread is public; a private thread yields only itself).

### 2. Where the audience applies

- **Archive search:** the searched channels are `memberChannels(asker) ∩ audienceChannels(C)`.
  - Try it (no channel) keeps today's asker-only filter; its answers are never posted in Discord.
  - Threads stay excluded (ADR 0067).
- **Channel context** (ADR 0089): it is C itself, so it is in the audience trivially. The thread starter comes from the parent of a public thread only.
- **Recall** (slice 7) reuses `audienceChannels`.

### 3. Quoting (D3)

- **Archive results never carry author names.** The hit lines stay `#channel date: excerpt`. The output rules already say to answer in aggregate without names or quotes.
- **"Did X say Y?"** `search_archive` gains an optional `from` argument: a member mention or name.
  - Code resolves it to one member id, by an exact id or mention, or by a unique display-name match among the members the job can see. An ambiguous or unknown name refuses: "I couldn't tell which member you meant."
  - With `from`, the `query` must hold at least one search term of three or more characters, and at most three hits come back.
  - Each hit gets a citation tag whose source is the message link `https://discord.com/channels/<guild>/<channel>/<message>`.
  - The tool text ends with `Answer only whether they said it. Cite the message tag. Do not summarise or list this member's messages.`
- **Links come from code.** When the answer cites a hit's tag, the code-built Sources line adds the message link, exactly as it does for club resources. The model never writes a message URL; an uncited hit adds no link. Archive links are citable only for `from` searches.
- **"Summarise everything X said"** has no tool path:
  - `from` requires a specific query and returns at most three hits;
  - the tool text forbids summarising;
  - a new output rule says: `If someone asks you to summarise or list what a particular member has said, say you don't do that.`
- **How it knows.** The output rules gain: `If asked how you know something, say where in general terms — the club's docs, earlier messages in the server, or this conversation. Never say you have no source when you used one.`

### 4. Tests first

Permission and audience code is written test-first (CLAUDE.md working style), and each guard must be seen to fail before it is trusted:
- a private channel is excluded from an answer in a public channel, even when the asker can read it;
- two channels synced to the same private category share an audience;
- a role deny on an otherwise open channel excludes it;
- an uncached channel excludes everything except C;
- the `from` cap, the ambiguous-name refusal, and the code-added link.

## Consequences

- A channel with an unusual overwrite shape (for example, one extra role allowed) drops out of answers in public channels even though most of its readers could see it. The error only ever withholds, never leaks.
- "Did X say Y?" becomes answerable with proof, and bulk profiling of one member has no tool path.
