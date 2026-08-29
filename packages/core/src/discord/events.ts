import type { EmojiKey, Snowflake } from './port.js';

/**
 * Gateway events normalised into domain shape. Every one carries `guildId`
 * explicitly; an event that cannot be attributed to a guild is dropped at the
 * adapter rather than travelling with an optional scope.
 */

interface Base {
  guildId: Snowflake;
  /** When the adapter observed it. Not Discord's timestamp. */
  receivedAtMs: number;
}

export interface ReactionEvent extends Base {
  kind: 'reactionAdd' | 'reactionRemove';
  channelId: Snowflake;
  messageId: Snowflake;
  userId: Snowflake;
  emoji: EmojiKey;
  /**
   * True when the event arrived for a message outside the client cache and had
   * to be hydrated. Without partials configured these events never arrive at
   * all, which is the single most likely cause of a panel appearing dead.
   */
  wasPartial: boolean;
}

export interface InteractionEvent extends Base {
  kind: 'interaction';
  /** A real snowflake, unique per click. The only event with a usable id. */
  interactionId: Snowflake;
  /**
   * The interaction token, which is how a response is addressed.
   *
   * **A short-lived credential.** It is absent from `LOGGABLE_FIELDS`, so
   * `safeLogFields` drops it, and pino's redaction covers `token` as well —
   * belt and braces, because a token in a log file is a token anyone reading
   * the log can act with for the next fifteen minutes.
   */
  token: string;
  channelId: Snowflake;
  messageId: Snowflake;
  userId: Snowflake;
  customId: string;
  values?: readonly string[] | undefined;
}

export interface MessageEvent extends Base {
  kind: 'messageUpdate' | 'messageDelete';
  channelId: Snowflake;
  messageId: Snowflake;
  authorId: Snowflake | undefined;
  /** Absent when the message was not cached, or when content logging is off. */
  content: string | undefined;
  editedTimestampMs: number | undefined;
}

export interface MemberEvent extends Base {
  kind: 'memberAdd' | 'memberRemove' | 'memberUpdate';
  userId: Snowflake;
  roleIds: readonly Snowflake[];
  /** Populated on memberUpdate so drift detection can diff without a fetch. */
  previousRoleIds: readonly Snowflake[] | undefined;
  /**
   * When the member joined, if Discord told us. Used to fingerprint an add or
   * a remove, since neither dispatch carries an id of its own. Frequently
   * absent on memberRemove, where the fingerprint falls back to a time bucket.
   */
  joinedAtMs: number | undefined;
}

export interface RoleEvent extends Base {
  kind: 'roleCreate' | 'roleUpdate' | 'roleDelete';
  roleId: Snowflake;
  /**
   * The role's name as of this dispatch — its new name on create and update,
   * its last-known name on delete. discord.js hands the listener the full
   * `Role` object on all three, including delete (the role is already gone
   * from `guild.roles.cache` by the time the handler runs, but the object
   * passed to it is not). Free, and the only way the logging module (ADR
   * 0022) can render "Role deleted: @name" instead of a bare, unrecognisable
   * id — a role that is gone cannot be looked up afterwards.
   */
  name: string;
}

export interface GuildEvent extends Base {
  kind: 'guildCreate' | 'guildDelete';
}

/**
 * Emitted on every reconnect. `resumed: false` means a fresh IDENTIFY, so
 * events in the gap were lost and are not replayed. Reaction state is
 * recoverable by reconciliation; message edits and deletions are not.
 */
export interface ConnectionEvent extends Base {
  kind: 'connection';
  resumed: boolean;
  disconnectedAtMs: number;
}

export type DomainEvent =
  | ReactionEvent
  | InteractionEvent
  | MessageEvent
  | MemberEvent
  | RoleEvent
  | GuildEvent
  | ConnectionEvent;

export type DomainEventKind = DomainEvent['kind'];
