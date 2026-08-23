# ADR 0009: Archive scope is an explicit channel allowlist

Status: accepted (2026-08-22)
Supersedes: ADR 0005
Amends: ADR 0007

## Context

ADR 0005 made the archive default "every channel and thread Bananasaurs can view," with dashboard exclusions. The owner has since specified the opposite: he wants to choose which channels and forums Bananasaurs pulls information from.

That is also the safer default. Default-allow means a new private channel is silently archived the moment the bot can see it; default-deny means archiving is always a deliberate act. It narrows the privacy surface, shrinks storage, and makes `PRIVACY.md` short and true.

The reference server's Discord history is small, so there is no retrieval-quality argument for archiving everything.

## Decision

**Archive scope is default-deny.** No channel is archived until the owner enables it in the dashboard.

- Enablement is per channel, per forum, and per category. Enabling a category enables channels created in it later, and the dashboard says so plainly at the moment of enabling.
- Forum channels are enabled as a unit: enabling a forum enables its posts (threads). Threads inherit the policy of their parent channel and never carry a policy of their own.
- Each enabled channel carries: archive on/off, attachment handling (`none` / `metadata` / `bytes`), and a retention override.
- Disabling a channel stops future ingestion. It does not delete what was already stored; deletion is a separate, explicit, previewed action.
- The bot posts nothing and stores nothing from a channel that is not enabled, beyond what moderation and logging modules require server-wide.

**Logging is separate from archiving.** The message/member/role logging module (Carl-bot's current job) forwards events to a log channel and operates server-wide by owner configuration. It is not the archive, does not feed retrieval, and has its own retention setting.

**Retention tiers** replace ADR 0007's single permanent policy:

| Class | Default |
|---|---|
| Live messages in enabled channels | Indefinite until the owner purges or changes policy |
| Deleted messages, no case attached | Tombstone kept indefinitely; **content purged after 30 days** |
| Deleted messages pinned to an open moderation case | Content retained until the case closes plus 90 days |
| Content the owner explicitly marks "preserve" | Indefinite, audited |
| Log-channel forwards | Governed by Discord's own retention in that channel, not by Bananasaurs |

All values are dashboard-configurable. The defaults above are what `PRIVACY.md` describes, and the two must be kept in sync — a config change that contradicts the published policy is a bug.

## Consequences

- `PRIVACY.md` can make a short, honest, verifiable claim about scope, which is worth more to member trust than any amount of policy prose.
- Retrieval quality now depends on the owner enabling the right channels. The dashboard must show which channels are enabled, which are not, and when an answer was limited by scope.
- Storage forecasting matters much less. The alerts in `docs/15` stay, but drop in priority.
- ADR 0007's rationale survives for moderation evidence; its "indefinite by default for everything deleted" does not.
- Backfill is bounded and cheap: only enabled channels, and only when the owner asks.
