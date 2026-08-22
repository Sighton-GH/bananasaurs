# Product definition

## Purpose

Bananasaurs helps an engineering club run its Discord server and remember, find, understand, plan, and review its work. It should feel like a capable club operations assistant with excellent recall—not a chatty mascot and not an AI with unchecked administrator powers.

## Users and scope

- One configured Discord guild during private testing. The later public release distributes a self-hosted application; each operator owns their instance and server data.
- Initially one owner/operator.
- Additional users or roles may be authorized later.
- Authorization can be narrower than archive visibility; distinguish who may ask from what content may be retrieved.
- Archive scope is an explicit owner-chosen list of channels and forums, default-deny (ADR 0009). The bot pulls information only from what was deliberately turned on.
- A limited member-facing feature tier is planned after Release 3: members get search and question-asking within what they can already read in Discord, and nothing administrative.
- No Discord role name is universally privileged. The owner maps users and server roles to granular capabilities.

## Interaction contract

- Speak only after an explicit mention or slash command.
- In DMs, answer from a maintained non-AI help/FAQ catalogue by default. Do not retrieve server history, memory, or AI answers unless the dashboard explicitly authorizes that user for a named guild.
- Keep replies concise by default and provide sources when using club archives or resources.
- Say when evidence is incomplete, stale, or permission-limited.
- Never pretend a reminder, decision, or memory was saved unless the server confirms it.
- `/privacy` renders the published policy with live settings substituted; `/mydata` and `/forgetme` give members visibility and a deletion request path.
- Advice remains advice. The initial bot does not merge code, modify calendars, manage roles, or edit external systems.

## Primary jobs

- Answer questions from allowed server history and curated resources.
- Find prior discussions, decisions, links, and attachments.
- Summarize a channel/thread or prepare meeting context.
- Review plans and designs using engineering-oriented checklists.
- Capture explicit decisions with provenance.
- Create and deliver reminders.
- Maintain useful long-term club context without hoarding everything forever.
- Provide moderator cases, warnings, notes, timeouts, kicks, bans, cleanup, and lockdown workflows.
- Run deterministic automod, logging, welcome, role, scheduled-message, tag/custom-command, and other server modules.
- Let the owner configure, diagnose, export, and audit those modules from one dashboard.
- Provide a full dashboard chat with the same server-specific AI, memory, sources, and permissions as Discord.

## Out of scope for the first release

Voice, DMs, public multi-server operation, local text-generation models, arbitrary computer control, full project management, music playback, and unreviewed ingestion of every channel.

“Full replacement” is a long-term product target. The first releases prioritize safety-critical moderation and the club assistant. Entertainment, social, feed, leveling, giveaway, and similar parity modules should be selected deliberately rather than delaying the core.

The application targets small and medium community servers on consumer Linux hardware. The initial sizing reference is approximately 30 members, two dozen channels, and inconsistent daily activity, with additional burst testing for raids and archive backlogs.

## Success measures

- Useful answers with fewer manual searches.
- High retrieval precision and visible provenance.
- No unauthorized disclosure in permission tests.
- Owner can understand and control stored data.
- Provider outages and quota limits degrade clearly rather than corrupting state.
- Moderation and automod continue to operate correctly with every AI provider offline.
- Staff can replace their existing general-purpose bots module by module without losing an audit trail.
