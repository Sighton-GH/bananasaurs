import { createHash } from 'node:crypto';
import type { DomainEvent } from '../discord/events.js';

/**
 * Gateway deduplication, and where the planning documents are wrong.
 *
 * `docs/02`, `docs/08` and `REVIEW.md` C8 all prescribe **"a unique index on
 * `(guild_id, discord_event_id)`"**. That cannot be implemented as written:
 * **Discord gateway dispatches do not carry an event ID.**
 * `MESSAGE_REACTION_ADD` has no id field at all, and the `s` sequence number is
 * per-session and resets on every reconnect, so it identifies nothing across
 * the reconnect that deduplication exists to survive.
 *
 * What replaces it is a fingerprint derived per event kind — and, for the kinds
 * where no honest fingerprint exists, no deduplication at all.
 *
 * | Event | Fingerprint |
 * |---|---|
 * | `interaction` / `slashCommand` | the interaction id — a real snowflake, genuinely unique |
 * | `messageCreate` | sha256(message) — creation is terminal |
 * | `messageUpdate` | sha256(message ‖ editedTimestamp) |
 * | `messageDelete` | sha256(message) — deletion is terminal |
 * | `memberAdd` / `memberRemove` | sha256(user ‖ joinedAt or a time bucket) |
 * | `roleCreate` / `roleDelete` | sha256(role) — a role id is created and deleted once |
 * | `autoModerationAction` | digest of rule / user / action / matched content, time bucket fallback |
 * | everything else | **not deduplicated** |
 *
 * **Reactions are deliberately absent, and this is the load-bearing decision.**
 * `(message, user, emoji, action)` is not unique over time: a member may add a
 * reaction, remove it, and add it again, all legitimately. Any time bucket
 * would be a guess, and a wrong guess silently drops a real action.
 *
 * So reactions are treated as **level-triggered, not edge-triggered**. A
 * reaction event is a hint that a message's reaction state may have changed;
 * the handler recomputes the member's desired role set from panel configuration
 * plus live reaction state and converges toward it. Convergence is naturally
 * idempotent — running it twice produces the same state, and the second run
 * issues no REST call because the state already matches.
 *
 * `memberUpdate` is level-triggered for the same reason: a role can be granted
 * and revoked repeatedly, and amendment 5's drift detection already works by
 * diffing rather than by counting events. `guildCreate` is level-triggered
 * because it fires on every reconnect and we *want* to re-run the allowlist
 * check each time.
 *
 * This is a better design than event dedupe anyway: it is the same code path
 * that handles reconciliation after downtime, so drift repair in Release 1 is
 * not a separate feature with its own separate bugs.
 */

/** Components are joined with NUL, which cannot occur in a snowflake. */
const digest = (...parts: (string | number)[]): string =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex');

/**
 * How coarse the fallback bucket is when a join timestamp is unavailable.
 *
 * Reached for `memberRemove`, where Discord does not always give us
 * `joined_at`, and for `autoModerationAction`, where Discord never gives us an
 * event id or timestamp. The trade-off differs by kind: for `memberRemove`, a
 * duplicate arriving more than a minute later is treated as a new event (right
 * direction: logging a leave twice is noise, missing one is a hole); for
 * `autoModerationAction`, a byte-identical match inside the bucket collapses
 * into one event (under-counts repeats but avoids replay double-recording, and
 * native events do not count toward escalation anyway — ADR 0038).
 */
const FALLBACK_BUCKET_MS = 60_000;

/**
 * A stable identity for this dispatch, or `undefined` when the event kind is
 * level-triggered and must not be deduplicated.
 *
 * The `default` clause at the bottom of the `switch` is not dead code, even
 * though every `DomainEvent['kind']` is already handled above it and it can
 * never run. It is what makes this function's exhaustiveness compiler-
 * enforced: this function's return type is `string | undefined`, so falling
 * off the end of an unhandled `case` would silently type-check as an
 * implicit `return undefined` — `strict` does not catch that, and
 * `noImplicitReturns` is deliberately not set repo-wide. Do not delete it.
 */
export function fingerprintOf(event: DomainEvent): string | undefined {
  switch (event.kind) {
    case 'interaction':
    case 'slashCommand':
    case 'modalSubmit':
      // The only events carrying a usable id of their own. An interaction id is
      // minted per click and per invocation, so a dispatch replayed across a
      // reconnect collides here rather than answering the member twice.
      return event.interactionId;

    case 'messageUpdate':
      // An edit is identified by which message and when it was edited. Two
      // dispatches for the same edit carry the same edited_timestamp.
      return digest(event.messageId, event.editedTimestampMs ?? 'no-edit-timestamp');

    case 'messageCreate':
      // Creation is terminal too: a message is created at most once, so its id
      // alone identifies the dispatch — the same reasoning as messageDelete.
      return digest(event.messageId);

    case 'messageDelete':
      // Deletion is terminal: a message is deleted at most once.
      return digest(event.messageId);

    case 'messageDeleteBulk':
      // A bulk delete is identified by the channel and the set of ids; Discord
      // may order the list differently on a replay, so sort before digesting.
      return digest(event.channelId, ...[...event.messageIds].sort());

    case 'memberAdd':
    case 'memberRemove':
      return digest(
        event.kind,
        event.userId,
        event.joinedAtMs ?? Math.floor(event.receivedAtMs / FALLBACK_BUCKET_MS),
      );

    case 'roleCreate':
    case 'roleDelete':
      // A role id is created once and deleted once; it is never reused.
      return digest(event.kind, event.roleId);

    case 'autoModerationAction': {
      // Discord sends no event id and no timestamp for this dispatch, and
      // `message_id` "will not be present if message was blocked by AutoMod"
      // — the common case, since every native rule in this guild blocks
      // (ADR 0038). Prefer whichever id Discord did supply; otherwise fall
      // back to what was matched, by whom, under which rule, in the same
      // coarse bucket `memberRemove` already uses for the same reason.
      //
      // The accepted trade-off: two byte-identical blocked messages from one
      // member inside the bucket collapse into one event. That under-counts a
      // repeat offender in the review queue rather than risking a replayed
      // dispatch being recorded twice — and since native events never count
      // toward escalation, an under-count costs nothing in enforcement.
      const discordId = event.alertMessageId ?? event.messageId;
      if (discordId !== undefined) return digest(event.kind, discordId, event.actionType);
      return digest(
        event.kind,
        event.ruleId,
        event.userId,
        event.actionType,
        event.content,
        Math.floor(event.receivedAtMs / FALLBACK_BUCKET_MS),
      );
    }

    case 'auditLogEntry':
      // An entry is created once; its id is its identity.
      return digest(event.entryId);

    case 'reactionAdd':
    case 'reactionRemove':
    case 'memberUpdate':
    case 'roleUpdate':
    case 'guildCreate':
    case 'guildDelete':
    case 'connection':
      return undefined;

    default: {
      // Not reachable: every `DomainEvent` kind above returns. This clause
      // exists so that *adding* a kind without deciding its dedupe behaviour
      // is a compile error rather than a silent fallback to "not
      // deduplicated" — which would be an idempotency gap (CLAUDE.md rule 6)
      // that nothing surfaces. `strict` alone does not catch it: falling off
      // the end of a `string | undefined` function is legal, and
      // `noImplicitReturns` is not set.
      const unhandled: never = event;
      void unhandled;
      return undefined;
    }
  }
}

/** True when this kind is recomputed rather than counted. */
export const isLevelTriggered = (event: DomainEvent): boolean => fingerprintOf(event) === undefined;
