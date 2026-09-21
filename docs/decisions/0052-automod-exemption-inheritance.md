# ADR 0052: Automod channel exemptions inherit to parent channels and categories

Status: Accepted

## Decision

A channel-type exemption row on an automod rule matches a message when the
exempt id is the message's own channel, the message's parent channel, or the
message's category.

Inheriting to threads is the narrow half: threads are transient
conversations of their parent channel, so a channel exemption that skipped
threads would exempt almost nothing in a channel that uses them. Inheriting
to an entire category is the wide half, taken deliberately: an exemption row
naming a category id exempts **every channel in it**, present and future.
The category is the same unit of channel grouping ADR 0047 uses for archive
and MCP send scope, so the operator reasons about one grouping, not two.

Exemption is additive: there is no per-channel override that re-includes a
channel inside an exempt category, the same way an exempt role cannot be
narrowed per member.

## Context and record

The behaviour shipped on `oc/threads-and-forums`
(`packages/storage/src/repos/automod-rules.ts`'s `isExempt` matching
`channelId`, `parentChannelId` or `categoryId`) before any ADR covered it;
the only prior record was an appendix in
`docs/reports/release2-gate-signoff.md`. ADR 0047 is scoped to archive and
MCP send scope and says nothing about automod. This ADR is the record.

The owner confirmed at recording time that the guild has no live mod rules,
so no collected match was reclassified by the widening and no migration or
backfill of review state is needed.

## Trade

A moderator who exempts a category exempts channels that do not exist yet.
That is the intended reading of the gesture — "this rule does not apply in
this part of the server" — and it carries the same trust implication ADR
0047 names: anyone with Manage Channels can move a channel into an exempt
category and thereby remove it from the rule's enforcement. Revisit if the
moderator roster grows.

(Numbered 0052 rather than 0051 because 0051 is taken on a sibling branch.)
