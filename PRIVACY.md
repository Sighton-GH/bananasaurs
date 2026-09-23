# Bananasaurs — Privacy Policy

**Last updated:** 2026-09-16
**Applies to:** the Bananasaurs bot running in `<SERVER NAME>`
**Operator:** `<OWNER NAME / CONTACT>`

Bananasaurs is a self-hosted bot built and run by a member of this server. It is not a commercial service, it is not operated by Discord, and no company receives your data from it.

Run `/privacy` in the server at any time to see this policy and the current settings it describes.

---

## The short version

- Bananasaurs stores messages **only from channels the server owner has specifically turned on**. It is off everywhere else by default.
- It keeps a copy of those messages, including edits and deletions, so the server has a searchable history and a moderation log.
- When someone asks it a question, small, relevant excerpts may be sent to an external AI provider to generate an answer. Nothing is sent unless someone asks.
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
- Automod matches and the action taken
- Messages an automod rule matched while it was being tested, kept as examples so a human can check whether the rule was right — including the name, type and size of any files attached to them
- Role changes made by the bot, such as reaction-role assignments
- Join and leave events
- Commands run against the bot, and the answers it gave

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

**One exception: AI answers.** When someone asks Bananasaurs a question, it selects a small number of relevant excerpts and sends them to an external AI provider to generate a reply. This happens only when someone explicitly asks. The provider currently in use, what its terms say about training on this data, and the date that was checked are recorded on the bot's AI setup page; a server admin can show you.

**The AI provider may train on what is sent.** The server owner has chosen a provider whose terms allow it to use the excerpts it receives to train its models. The bot shows a warning on its setup page while that is the case. If you do not want your messages used this way, do not ask Bananasaurs questions that would draw on them, and ask a server admin which channels are stored.

**Web search.** If the server owner turns on web search, the assistant may send a short search query based on your question to the Brave Search API. It never sends your name or any stored messages. Answers that use web results say "Powered by Brave Search".

**AI log channel.** If the server owner chooses a log channel, every question asked of Bananasaurs is copied there, together with its answer, the sources used and the outcome. That channel is meant for server staff only. Messages in it are kept by Discord, not by Bananasaurs, until someone deletes them.

## Who can see it

- **Everyone:** their own data, via `/mydata`
- **Members:** search results and answers drawn only from channels they can already read in Discord. The bot never reveals content from a channel you do not have access to
- **Moderators:** moderation records, according to what the owner has granted them
- **The server owner:** the admin dashboard, which requires a separate login the owner creates. Having Administrator in Discord does **not** grant dashboard access

## Messages the bot posts on the owner's behalf

The owner can connect their own AI client to Bananasaurs and ask it to post a
message to this server. When that happens:

- It can only post in channels the owner has explicitly allowed. It cannot
  post in a channel that is not on that list, and it cannot send you a DM.
- Mentions in those messages never ping anyone — `@everyone`, `@here`, role
  and user mentions are all switched off before the message is sent.
- Every such message is recorded: which channel, when, and which credential
  was used. The owner can list them at any time.
- The message is posted by the bot, under the bot's name, like any other bot
  message. Nothing is posted as you or attributed to you.

The trigger is always the owner typing a request in their own client. Nothing
a member says can cause the bot to post one of these.

## How long it is kept

| What | How long |
|---|---|
| Messages from enabled channels | Kept until the owner deletes them or changes the policy |
| Deleted messages | Content kept for 30 days, then removed — unless attached to an active moderation case |
| Moderation records | Kept as long as the server needs them for consistent moderation |
| Automod test examples | Kept until the owner removes them. `/forgetme` removes yours. |
| Bot conversations and answers | Kept until deleted on request |
| Attachments | Same as the messages they belong to |
| Archived messages from channels the owner enabled | Kept until the owner disables the channel or purges; nothing is archived unless the owner lists the server and enables the channel |
| Archived messages that were deleted | Content removed 30 days after deletion; the fact that a message existed is kept |
| Previous versions of edited archived messages | Kept with the message; removed when the message's content is removed |
| Archived messages linked to a moderation case | Content kept until the case closes, then 90 days |
| Archived messages the owner marked preserved | Kept indefinitely; the audit log records who preserved it and when |
| Attachments on archived messages | File name, type and size only; no file contents are downloaded |
| The record of each message the bot posted on the owner's behalf | Kept indefinitely. It holds the channel, the time, which credential sent it, and a fingerprint of the text — **not the message itself**. It is what stops a retry posting the same message twice, and what lets the owner list what was posted; the message you can read is the one in the channel |
| The record that Claude — the AI tool the owner uses to read the server — is set not to train on your messages | Kept for as long as the tool is in use. The owner re-checks that account setting by hand, and the bot warns when the check is more than 90 days old, when the record says the tool does train on input, or when it says the tool is not approved for this use |

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
