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

/**
 * One option Discord sent with a slash command.
 *
 * `value` is the primitive the interaction payload carries and nothing more: a
 * user, channel, role or mentionable option arrives as its **snowflake string**,
 * and resolving that into a member or a channel is a REST call the handler makes
 * deliberately if it needs one. Modelling the resolved object here would put a
 * fetch behind a field access, which is the mistake `rest/port.ts` avoids by
 * using raw routes rather than discord.js structures.
 */
export interface SlashCommandOption {
  name: string;
  value: string | number | boolean;
}

/**
 * A slash command invocation, normalised.
 *
 * A sibling of `InteractionEvent` rather than a widening of it, because the two
 * are addressed differently in every way that matters downstream. A component
 * interaction is anchored to a *message* — `customId` and `messageId` are how a
 * panel is resolved and how a crafted custom id is caught. A slash command has
 * no message at all; it is addressed by name, and its arguments are named
 * options rather than a packed string. One interface carrying both would have
 * `messageId` and `customId` optional on the very fields that resolve a panel,
 * and `packages/core/src/panels/interactions.ts` guards those today by narrowing
 * on `event.kind`.
 *
 * Shares `InteractionEvent`'s two credentials-and-ids properties: `interactionId`
 * is a real snowflake unique per invocation (so `fingerprintOf` can dedupe a
 * replayed dispatch on it), and `token` is a **short-lived credential** kept out
 * of `LOGGABLE_FIELDS` so `safeLogFields` drops it.
 */
export interface SlashCommandEvent extends Base {
  kind: 'slashCommand';
  /** A real snowflake, unique per invocation. The dedupe fingerprint. */
  interactionId: Snowflake;
  /** The interaction token — a short-lived credential. Never logged. */
  token: string;
  /** The top-level command name, without the leading slash: `status`. */
  commandName: string;
  /**
   * The subcommand group and subcommand beneath `commandName`, outermost first.
   *
   * `[]` for `/status`, `['tail']` for a hypothetical `/audit tail`, and
   * `['route', 'set']` for a group plus a subcommand. One field rather than two
   * nullable ones, so that a command growing a group later is a new array entry
   * rather than a change to this interface.
   */
  subcommandPath: readonly string[];
  /**
   * The options actually supplied, flattened out of any subcommand nesting.
   *
   * Discord nests a subcommand's options inside the subcommand option, so the
   * adapter unwraps them; a handler reads the options it was given without
   * caring how deep in the payload they arrived.
   */
  options: readonly SlashCommandOption[];
  /**
   * Where it was invoked. `undefined` is possible — `BaseInteraction.channelId`
   * is nullable — and is not a reason to drop the event: the reply is addressed
   * by the interaction token, not by the channel.
   */
  channelId: Snowflake | undefined;
  userId: Snowflake;
}

/**
 * One file attached to a message, as Discord declared it.
 *
 * `contentType` is Discord's `content_type`, which is **the uploader's
 * declaration**, not a sniffed type — trivially spoofed by renaming a file.
 * That is exactly why Slice 5's `attachment_type` predicate matches on the
 * declared type *and* the file extension rather than either alone. No bytes
 * are fetched here or anywhere in Release 2.
 */
export interface MessageAttachment {
  /**
   * Discord's attachment id. Optional (PR-71): a fixture-derived attachment
   * (`FixtureAttachment` in storage, replayed by the dry-run evaluator)
   * genuinely has no Discord attachment id, so `undefined` (absent) is a true
   * statement there. The live adapter and `FakeDiscord` always populate it;
   * later archive consumers treat absence as "none" and skip the attachment.
   */
  readonly attachmentId?: Snowflake;
  readonly fileName: string;
  /** Absent when Discord did not declare one. Never flattened to `''`. */
  readonly contentType: string | undefined;
  readonly sizeBytes: number;
}

export interface MessageEvent extends Base {
  kind: 'messageCreate' | 'messageUpdate' | 'messageDelete';
  channelId: Snowflake;
  /** Thread parent when this message is in a thread. Cache-derived only. */
  parentChannelId: Snowflake | undefined;
  /** Category of the authorized unit: thread parent, or channel itself. */
  categoryId: Snowflake | undefined;
  /** Private threads never inherit archive or send authorization. */
  isPrivateThread: boolean;
  messageId: Snowflake;
  authorId: Snowflake | undefined;
  /**
   * `message.author.bot` — true for this bot, any other bot, and a webhook.
   * `false` when the author is unknown (an uncached delete names nobody).
   *
   * Load-bearing for automod: discord.js emits `MessageCreate` for the bot's
   * own messages, and the `message_delete` logging route quotes the deleted
   * content, so without this an enforce-mode rule deletes a message, matches
   * its own log entry about that deletion, deletes that, and loops.
   */
  authorIsBot: boolean;
  /** Absent when the message was not cached, or when content logging is off. */
  content: string | undefined;
  editedTimestampMs: number | undefined;
  /**
   * Resolved mentions, for Slice 4's `mention_spam`. Empty for a partial
   * message, where nothing is known — which every predicate must read as "do
   * not match", the same way `content: undefined` is read today.
   */
  mentionedUserIds: readonly Snowflake[];
  mentionedRoleIds: readonly Snowflake[];
  /** Author roles known on message create/update. Empty for partials or unavailable members. */
  authorRoleIds?: readonly Snowflake[];
  mentionsEveryone: boolean;
  /** For Slice 5's `attachment_type`. Metadata only; no bytes are fetched. */
  attachments: readonly MessageAttachment[];
}

export interface MessageBulkDeleteEvent extends Base {
  kind: 'messageDeleteBulk';
  channelId: Snowflake;
  parentChannelId: Snowflake | undefined;
  categoryId: Snowflake | undefined;
  isPrivateThread: boolean;
  /** Every id Discord named, in the order it named them. Never empty. */
  messageIds: readonly Snowflake[];
}

/** Which action Discord's own AutoMod executed. */
export type NativeAutoModAction = 'block' | 'alert' | 'timeout' | 'block_interaction';

/** Which kind of native rule fired. `unknown` covers enum values Discord adds later. */
export type NativeAutoModTrigger =
  'keyword' | 'spam' | 'keyword_preset' | 'mention_spam' | 'member_profile' | 'unknown';

/**
 * Discord's own AutoMod acted (ADR 0038). Bananasaurs records this; it never
 * acts on it. Native blocks *before* the message exists, so no `messageCreate`
 * is dispatched for blocked content and our own subscriber never sees it —
 * this event is the only way that decision is observable.
 */
export interface AutoModerationEvent extends Base {
  kind: 'autoModerationAction';
  /** Discord's AutoMod rule id. Never one of our own `mod_rules.rule_id`s. */
  ruleId: Snowflake;
  triggerType: NativeAutoModTrigger;
  /** The member whose content triggered the rule. */
  userId: Snowflake;
  actionType: NativeAutoModAction;
  /** Absent when the content was not part of a channel message. */
  channelId: Snowflake | undefined;
  /**
   * Absent exactly when AutoMod *blocked* the message — the common case here,
   * since a blocking rule is why we hear about it at all. Never flattened to a
   * string: `undefined` means "there is no message", not "the id is empty".
   */
  messageId: Snowflake | undefined;
  /** Present only for the `alert` action: the id of the log message it posted. */
  alertMessageId: Snowflake | undefined;
  /** Requires `MESSAGE_CONTENT`, which this bot holds. Empty string if not. */
  content: string;
  /** The rule's configured word that matched, when Discord names one. */
  matchedKeyword: string | undefined;
  /** The substring of `content` that matched. Requires `MESSAGE_CONTENT`. */
  matchedContent: string | undefined;
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
  | SlashCommandEvent
  | MessageEvent
  | MessageBulkDeleteEvent
  | MemberEvent
  | RoleEvent
  | GuildEvent
  | ConnectionEvent
  | AutoModerationEvent;

export type DomainEventKind = DomainEvent['kind'];
