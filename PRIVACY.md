# Bananasaurs — Privacy Policy

**Last updated:** 2026-10-07
**Applies to:** the Bananasaurs bot running in `<SERVER NAME>`
**Operator:** `<OWNER NAME / CONTACT>`

Bananasaurs is a self-hosted bot built and run by a member of this server. It is not a commercial service, it is not operated by Discord, and no company receives your data from it.

Run `/privacy` in the server at any time to see this policy and the current settings it describes.

---

## The short version

- Bananasaurs stores messages **only from channels the server owner has specifically turned on for recording** — except replies to task posts, described under Task tracking. Recording is off everywhere else by default. Turning recording off later stops new messages being kept but deletes nothing already stored.
- It keeps a copy of those messages, including edits and deletions, so the server has a searchable history and a moderation log.
- When someone asks it a question, small, relevant excerpts may be sent to an external AI provider to generate an answer. Nothing is sent unless someone asks, or a member replies to a task post with a progress update (see Task tracking).
- Nothing is sold or advertised against. Excerpts sent to the AI provider may be used by that provider to train its models; see "One exception: AI answers" below.
- You can see what is stored about you, and you can ask for it to be removed.

---

## What Bananasaurs stores

**From enabled channels only:**

- Message content, author, channel, timestamps, and edit history
- Attachments and links, subject to a size limit and file-type rules
- The fact that a message was deleted, and its content at the time

**Server-wide:**

- Moderation records — warnings, notes, timeouts, kicks, bans — including who acted, on whom, why, and when
- Automod matches and the action taken: the rule, the short piece of text that matched, and why it matched. Automod keeps no copy of the whole message
- Whether the owner flagged a match as right or as a false positive, used to tune the rule
- Role changes made by the bot, such as reaction-role assignments
- Join and leave events
- Commands run against the bot, and the answers it gave

To log what changed when a member's roles, nickname, username, display name
or avatar change, Bananasaurs keeps a last-seen record for each member:
username, display name, nickname, avatar IDs, and role IDs. It holds IDs and
hashes only — no images are downloaded or stored. The record is written
only while some enabled logging route includes a member-change action; when no
route does, a member's record is deleted the next time Bananasaurs sees that
member join or update; and it is always deleted when the member leaves.

**Not stored:**

- Voice calls or anything spoken in them
- Direct messages between members
- Direct messages to the bot, beyond what is needed to answer help questions
- Anything from channels the bot cannot see, or that the owner has not enabled
- Your Discord password, email, payment details, or anything else Bananasaurs has no way to access

## Why it stores it

- So members can search the server's own history and find past decisions, links, and discussions
- So moderators have an accurate record when handling an incident
- So the bot can answer questions about the club with real sources instead of guesses
- So the server has a log if something is deleted or changed

That is the whole list. Bananasaurs does not profile members, score them, rank them, or build behavioural models of anyone.

## Where your data goes

**It stays on one computer.** Bananasaurs runs on a machine owned and operated by the server owner. There is no Bananasaurs company, no cloud account holding your messages, and no analytics service receiving them.

**One exception: AI answers.** When someone asks Bananasaurs a question, it selects a small number of relevant excerpts and sends them to an external AI provider to generate a reply. This happens only when someone explicitly asks, or when a member's reply to a task post is recorded as a progress update — that update's text is sent so the AI can check whether it is clear (see Task tracking). The provider currently in use, what its terms say about training on this data, and the date that was checked are recorded on the bot's AI setup page; a server admin can show you.

**The AI provider may train on what is sent.** The server owner has chosen a provider whose terms allow it to use the excerpts it receives to train its models. The bot shows a warning on its setup page while that is the case. If you do not want your messages used this way, do not ask Bananasaurs questions that would draw on them, and ask a server admin which channels are stored.

**Web search.** If the server owner turns on web search, the assistant may send a short search query, written by the AI from your question, to the search service the owner chose: the Brave Search API or the Tavily search API. Queries that look like they contain personal data or secrets (an email address, a phone number, a key) are refused before they are sent. Answers that use Brave results say "Powered by Brave Search". Tavily's terms let it keep queries and use them to improve its services, including training AI models.

**AI log channel.** If the server owner chooses a log channel, every question asked of Bananasaurs is copied there, together with its answer, the sources used and the outcome. That channel is meant for server staff only. Messages in it are kept by Discord, not by Bananasaurs, until someone deletes them.

## Assistant conversations and resources

- Conversations with the assistant — the questions asked, the answers given,
  who asked, and in which channel — are stored on the club's server. They are
  deleted automatically after the owner's chosen period (2 months, 6 months,
  12 months, or keep forever; the default is 6 months).
- When someone tags Bananasaurs in a reply to another person's message, that
  replied-to message is sent to the AI provider as context for the answer.
- When someone tags Bananasaurs, the last messages in that channel (15 by default; the owner can set 0–50) are sent to the AI provider with the question, so it can follow the conversation — but only in channels where the owner has left reading on. These can be from any member, including members who never used the bot. There is no opt-out where reading is on. If the provider may train on what it receives, that includes these messages.
- **Read:** whether the bot may look up recent messages live from Discord, including the opening message of a thread. Where reading is off, a tagged question is answered from the tagging message, the message it replies to, and stored copies only.
- Private threads follow their parent channel's reading and posting settings. They are never added to the searchable message archive unless the owner enables that thread itself.
- Where the owner has turned posting off for a channel, the bot stays silent there — tagging it gets no reply, and scheduled reminders or task nudges for that channel are skipped.
- Each assistant reply keeps a diagnostic snapshot of what the AI was given: the instructions, the club-source excerpts, earlier turns, and the full text of what its tools returned, which can include Discord message excerpts. Snapshots can keep a copy of a message after it is deleted from Discord. They are deleted with their conversation (the retention period above), and forgetting a member deletes the snapshots of every conversation they took part in. A working copy is also held in the bot's job records for up to 14 days after the reply, and is deleted then, even if the conversation was deleted sooner. The replied-to message itself is never kept in a snapshot.
- When an AI provider call fails, the provider's short error message (at most 160 characters, with anything key-shaped removed) is stored with the trace. It is shown on the dashboard only to accounts that can read configuration, and it is deleted with the conversation.
- The bot also keeps a step log for each AI request: timestamps, which model and tools were used, timings, token counts, error codes and the provider's short error text. It holds no message text. It is deleted with the conversation, and a request with   no conversation is deleted after 30 days. A trace with no conversation, such as a refused or failed request that never reached one, is also deleted after 30 days.

- Content from GitHub repositories and organisations the owner adds is fetched
  from GitHub and cached on the club's server so the assistant can answer
  from it. This includes private repositories that the owner's GitHub token
  can read: any member who can ask the assistant may get answers drawn from
  them, and excerpts are sent to the AI provider like any other source.
- The owner can reveal dashboard account passwords from an encrypted copy
  kept on the server. Every reveal is recorded in the audit log without the
  password itself.
- Test chats typed into the dashboard ("Try it") are sent to the AI provider
  like any other question. They are saved as conversations marked Dashboard
  test and are never posted to Discord.
- Long conversations keep a short AI-written summary of their earlier part, made by the same AI provider that answered. It is deleted with the conversation.
- The assistant can look back at the summaries of earlier conversations held in channels that everyone in the current channel can read. Conversations from channels the owner has marked as no-access are never used. Names are left out of what it sees. There is no opt-out.

## Task tracking

- Tasks the owner creates — title, due date, steps, and who they are
  assigned to — are stored on the club's server, along with the text of
  replies to the bot's task posts that count as progress updates. These
  replies are kept from any channel a task posts in — except channels marked
  no-access — including channels not enabled for archiving.
- A reply that could belong to several tasks is held for up to 7 days until
  the member picks which task it belongs to, then recorded or dropped.
- Each recorded update is sent to the configured AI provider to check
  whether it is clear; if it is not, the bot asks one clarifying question.
  The provider-training disclosure that applies to the assistant applies
  here too: if the provider may train on what it receives, that includes
  these updates.
- Updates are kept until the owner deletes the update or the whole task.
  Completed tasks are archived automatically and not deleted. To ask for
  deletion, ask the owner, who can delete individual updates on the task's
  page.

## Who can see it

- **Everyone:** their own data, via `/mydata`
- **Members:** search results and answers drawn only from channels they can already read in Discord. The bot never reveals content from a channel you do not have access to, and anything stored earlier from a channel later marked as no-access is hidden from every search
- **Moderators:** moderation records, according to what the owner has granted them
- **The server owner:** the admin dashboard, which requires a separate login the owner creates. Having Administrator in Discord does **not** grant dashboard access

## Messages the bot posts on the owner's behalf

The owner, or an account the owner has given the Connect apps permission, can
connect their own AI client to Bananasaurs and ask it to post a message to this
server. When that happens:

- It can only post in channels where the bot's Write permission is on. It
  cannot post anywhere else, and it cannot send you a DM.
- If the message mentions you, you get a notification, the same as when a
  person mentions you. A role mention notifies that role only if the role
  passes the server's ping rules (for example, no roles with admin or
  moderator powers). `@everyone` and `@here` never notify anyone.
- Every such message is recorded: which channel, when, and which credential
  was used. The owner can list them at any time.
- The message is posted by the bot, under the bot's name, like any other bot
  message. Nothing is posted as you or attributed to you.

The trigger is always a person typing a request in the client they connected.
Nothing a member says can cause the bot to post one of these.

## How long it is kept

| What | How long |
|---|---|
| Messages from enabled channels | Kept until the owner deletes them or changes the policy |
| Deleted messages | Content kept for 30 days, then removed — unless attached to an active moderation case. Exception: when a deletion is logged (a log route covers deleted messages, whether or not it shows their content) or a moderator purges messages, the deleted message's text, if the bot has it, is copied into the moderation audit log, and that copy is kept with no time limit |
| The bot's background job records | Deleted 14 days after the job finishes or fails. Some hold a working copy of a deleted message or of what the AI was given |
| Moderation records | Kept as long as the server needs them for consistent moderation |
| Bot conversations and answers | Kept until deleted on request |
| Task progress updates | Kept until the owner deletes the update or the task |
| Attachments | Same as the messages they belong to |
| Archived messages from channels the owner enabled | Kept until the owner deletes them; turning recording off stops new messages being kept but deletes nothing already stored |
| Archived messages that were deleted | Content removed 30 days after deletion; the fact that a message existed is kept |
| Previous versions of edited archived messages | Kept with the message; removed when the message's content is removed |
| Archived messages linked to a moderation case | Content kept until the case closes, then 90 days |
| Archived messages marked preserved by an account with Change settings, or from the operator CLI | Kept indefinitely; the audit log records who preserved it and when |
| Attachments on archived messages | File name, type and size only; no file contents are downloaded |
| The record of each message the bot posted on the owner's behalf | Kept indefinitely. It holds the channel, the time, which credential sent it, and a fingerprint of the text — **not the message itself**. It is what stops a retry posting the same message twice, and what lets the owner list what was posted; the message you can read is the one in the channel |
| The record that Claude — the AI tool the owner uses to read the server — is set not to train on your messages | Kept for as long as the tool is in use. The owner re-checks that account setting by hand, and the bot warns when the check is more than 90 days old, when the record says the tool does train on input, or when it says the tool is not approved for this use |
| Key fingerprints for AI provider keys | Kept with the key row until the key is deleted. A SHA-256 hash of the key, used only to skip duplicates when keys are pasted in bulk. It is never shown and cannot be turned back into the key |
| Project labels on AI provider keys | Kept with the key until the owner edits or deletes it. An owner-typed label that groups keys into one daily quota bucket. It is not read by anything else |
| Per-key, per-model cooldown rows | Kept until the cooldown ends or the key is deleted. Key id, model, reset time and learned limits only. No message text |
| The `dashboard-test` record from Check models | Same window as other AI request records. Test case ids only; no member content. No new retention beyond the existing run and trace windows |

Current settings are shown by `/privacy`. If they change, this policy is updated and the change is announced in the server.

## Your choices

**Ask the owner.** Today that is the only route, and it works: the owner can
show you everything Bananasaurs holds about you and delete your stored
messages and any notes built about you. This is a club server, not a
helpdesk, and the owner is someone you can find.

| Command | Status |
|---|---|
| `/privacy` | Shows this policy and the current settings |
| `/mydata` | **Not built yet.** Ask the owner instead. |
| `/forgetme` | **Not built yet.** Ask the owner instead. |

These two are planned, not shipped. An earlier version of this page listed
them as though they existed; that was wrong, and this page says so rather
than quietly dropping them. Until they ship, the request goes to a person
rather than to a command — the outcome is the same, the speed is not.

Deletion does not remove moderation records. A warning or ban record has to
survive for moderation to mean anything, the same as it would with any other
bot. Everything else can go.

## How this compares to what already applies to you

Discord itself stores your messages, and has its own rules for how long and why — see the [Discord Privacy Policy](https://discord.com/privacy) and [Terms of Service](https://discord.com/terms). Any other bot in this server operates under its own policy too. Bananasaurs is not doing anything unusual for a Discord bot.

The differences worth knowing:

- **It is narrower.** Most bots that log messages log everywhere they can see. Bananasaurs only logs channels that were deliberately turned on.
- **It is local.** Your messages sit on one machine run by someone in this club, not on a company's servers.
- **You can see inside it.** Ask the owner what is held about you, or to delete it, and they will. The self-serve `/mydata` and `/forgetme` commands are planned but not built yet — see "Your choices" above.

None of that makes it harmless. It is a real archive of things people said, and it should be treated that way. Do not post anything in this server you would not want kept — which was already true before this bot existed.

## Security

The database sits on a machine with restricted access, backups are encrypted where practical, and dashboard access requires a separate login. It is a hobby project run by one person, not a hardened data centre. If something goes wrong, members will be told.

## Changes

Material changes are announced in the server, and this document's "last updated" date changes. Continuing to use the server after a change means the new version applies.

## Contact

Ask `<OWNER NAME>` in the server, or DM them. Concerns about how this bot handles your data are legitimate and will get a straight answer.

---

*This policy was drafted for a small private club server and is not legal advice. If Bananasaurs is ever distributed to servers outside this club, or if members from jurisdictions with strict data-protection law join, have it reviewed properly.*
