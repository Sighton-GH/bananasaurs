import {
  ApplicationCommandOptionType,
  Events,
  type AutoModerationActionExecution,
  type ChatInputCommandInteraction,
  type Client,
  type CommandInteractionOption,
  type GuildMember,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialGuildMember,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type Role,
  type User,
} from 'discord.js';
import {
  emojiKeyFromGateway,
  type DomainEvent,
  type NativeAutoModAction,
  type NativeAutoModTrigger,
  type SlashCommandOption,
} from '@bananasaurs/core';

/**
 * Gateway dispatches, normalised into `packages/core/src/discord/events.ts`.
 *
 * Two rules run through all of it.
 *
 * **Guild attribution happens here or not at all.** Every `DomainEvent` carries
 * `guildId`, so an event that cannot be attributed to a guild is dropped at this
 * boundary rather than travelling upward with an optional scope. A DM reaction
 * is the ordinary case, not a hypothetical.
 *
 * **Translation is not assumed infallible.** discord.js structures are lazy: a
 * getter can dereference client state that does not exist yet — `reaction.emoji`
 * reads `client.application.emojis` for custom emoji and throws when the
 * application is unresolved. An exception escaping a gateway listener is an
 * unhandled rejection, which would take the daemon down over one malformed
 * event. Every handler is wrapped; a failure is reported and the event dropped.
 */

export interface TranslationDeps {
  /** Injected rather than `Date.now()`, so a test can pin `receivedAtMs`. */
  now: () => number;
  /**
   * The guild allowlist. Note `guildCreate` is deliberately exempt: it is the
   * event the composition root uses to *leave* an unlisted guild, and filtering
   * it here would silence the single most important behaviour in `docs/21`.
   */
  isGuildAllowed: (guildId: string) => boolean;
  emit: (event: DomainEvent) => void | Promise<void>;
  /** A translation that threw. Reported, never rethrown into the gateway. */
  onError: (err: unknown, context: { event: string }) => void;
}

type AnyReaction = MessageReaction | PartialMessageReaction;
type AnyUser = User | PartialUser;
type AnyMessage = Message | PartialMessage;
type AnyMember = GuildMember | PartialGuildMember;

export function attachGatewayTranslation(client: Client, deps: TranslationDeps): void {
  const { now, isGuildAllowed, emit, onError } = deps;

  /**
   * Runs one translation and delivers whatever it produced.
   *
   * `undefined` means "correctly dropped" — no guild, not allowlisted, or an
   * interaction we do not handle — and is not an error.
   */
  const translate = (name: string, build: () => DomainEvent | undefined): void => {
    try {
      const event = build();
      if (event === undefined) return;
      if (event.kind !== 'guildCreate' && !isGuildAllowed(event.guildId)) return;
      void emit(event);
    } catch (err) {
      onError(err, { event: name });
    }
  };

  // --- reactions ----------------------------------------------------------
  const reaction = (kind: 'reactionAdd' | 'reactionRemove') => (r: AnyReaction, u: AnyUser) => {
    translate(kind, () => {
      const guildId = r.message.guildId;
      if (!guildId) return undefined;
      return {
        kind,
        guildId,
        receivedAtMs: now(),
        channelId: r.message.channelId,
        messageId: r.message.id,
        userId: u.id,
        emoji: emojiKeyFromGateway({ id: r.emoji.id, name: r.emoji.name }),
        /**
         * Read before anything else touches the message. True means the client
         * had never seen it — the ordinary case for an adopted panel, whose
         * message is far older than a 25-message cache. Without the partials
         * configured in `client.ts` this event would not arrive at all.
         */
        wasPartial: r.message.partial,
      };
    });
  };
  client.on(Events.MessageReactionAdd, reaction('reactionAdd'));
  client.on(Events.MessageReactionRemove, reaction('reactionRemove'));

  // --- interactions -------------------------------------------------------
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    translate('interaction', () => {
      if (interaction.isChatInputCommand()) return toSlashCommandEvent(interaction, now());

      // Only message components drive panels. Anything else — an autocomplete, a
      // modal submit, a context-menu command — is not this adapter's business
      // and is dropped rather than translated into a shape that cannot describe
      // it. Note this is a *silent* drop by design: the dispatch is real and
      // well-formed, it simply belongs to a surface Release 1 does not have.
      if (!interaction.isButton() && !interaction.isStringSelectMenu()) return undefined;
      const guildId = interaction.guildId;
      if (!guildId) return undefined;
      return {
        kind: 'interaction',
        guildId,
        receivedAtMs: now(),
        interactionId: interaction.id,
        // A short-lived credential. It travels to the port and nowhere else: it
        // is absent from LOGGABLE_FIELDS and pino redacts `token`.
        token: interaction.token,
        channelId: interaction.channelId,
        messageId: interaction.message.id,
        userId: interaction.user.id,
        customId: interaction.customId,
        values: interaction.isStringSelectMenu() ? interaction.values : undefined,
      };
    });
  });

  // --- messages -----------------------------------------------------------
  client.on(Events.MessageCreate, (message: AnyMessage) => {
    translate('messageCreate', () => toMessageEvent('messageCreate', message, now()));
  });
  client.on(Events.MessageUpdate, (_old: AnyMessage, message: AnyMessage) => {
    translate('messageUpdate', () => toMessageEvent('messageUpdate', message, now()));
  });
  client.on(Events.MessageDelete, (message: AnyMessage) => {
    translate('messageDelete', () => toMessageEvent('messageDelete', message, now()));
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    translate('messageDeleteBulk', () => {
      const messageIds = [...messages.keys()];
      if (messageIds.length === 0) return undefined;
      return {
        kind: 'messageDeleteBulk',
        guildId: channel.guildId, // discord.js types the channel as GuildTextBasedChannel — always a guild
        receivedAtMs: now(),
        channelId: channel.id,
        messageIds,
      };
    });
  });

  // --- native auto-moderation (ADR 0038) ----------------------------------
  client.on(Events.AutoModerationActionExecution, (execution: AutoModerationActionExecution) => {
    translate('autoModerationAction', () => toAutoModerationEvent(execution, now(), onError));
  });

  // --- members ------------------------------------------------------------
  client.on(Events.GuildMemberAdd, (member: GuildMember) => {
    translate('memberAdd', () => ({
      kind: 'memberAdd',
      guildId: member.guild.id,
      receivedAtMs: now(),
      userId: member.id,
      roleIds: roleIdsOf(member),
      previousRoleIds: undefined,
      joinedAtMs: member.joinedTimestamp ?? undefined,
    }));
  });

  client.on(Events.GuildMemberRemove, (member: AnyMember) => {
    translate('memberRemove', () => ({
      kind: 'memberRemove',
      guildId: member.guild.id,
      receivedAtMs: now(),
      userId: member.id,
      roleIds: [],
      previousRoleIds: undefined,
      // Frequently absent on the wire, which is why the fingerprint has a
      // time-bucket fallback at all.
      joinedAtMs: member.joinedTimestamp ?? undefined,
    }));
  });

  client.on(Events.GuildMemberUpdate, (before: AnyMember, after: GuildMember) => {
    translate('memberUpdate', () => ({
      kind: 'memberUpdate',
      guildId: after.guild.id,
      receivedAtMs: now(),
      userId: after.id,
      roleIds: roleIdsOf(after),
      /**
       * **Undefined when the previous member was not resident, never `[]`.**
       *
       * For a member outside the 50-entry cache, discord.js builds "old" from
       * the dispatch's `user` alone, so its role collection is empty rather than
       * unknown. Reporting `[]` would tell amendment 5's drift detector that the
       * member just gained every role they hold, and it would "repair" a change
       * nobody made. `reconcile.ts` returns early on `undefined`, so the honest
       * answer degrades to "the periodic pass will catch it".
       */
      previousRoleIds: before.partial ? undefined : roleIdsOf(before),
      joinedAtMs: after.joinedTimestamp ?? undefined,
    }));
  });

  // --- roles --------------------------------------------------------------
  const roleEvent = (kind: 'roleCreate' | 'roleUpdate' | 'roleDelete') => (role: Role) => {
    translate(kind, () => ({
      kind,
      guildId: role.guild.id,
      receivedAtMs: now(),
      roleId: role.id,
      name: role.name,
    }));
  };
  client.on(Events.GuildRoleCreate, roleEvent('roleCreate'));
  client.on(Events.GuildRoleUpdate, (_old: Role, role: Role) => roleEvent('roleUpdate')(role));
  client.on(Events.GuildRoleDelete, roleEvent('roleDelete'));

  // --- guild lifecycle ----------------------------------------------------
  client.on(Events.GuildCreate, (guild) => {
    translate('guildCreate', () => ({
      kind: 'guildCreate',
      guildId: guild.id,
      receivedAtMs: now(),
    }));
  });
  client.on(Events.GuildDelete, (guild) => {
    translate('guildDelete', () => ({
      kind: 'guildDelete',
      guildId: guild.id,
      receivedAtMs: now(),
    }));
  });
}

/**
 * Fans a shard reconnect out into one `ConnectionEvent` per guild.
 *
 * `ConnectionEvent` carries a `guildId` because everything downstream of it is
 * guild-scoped — the gap record and the reconcile job both are. A shard is not,
 * so the adapter is where the one becomes the many. Kept separate from
 * `attachGatewayTranslation` because the composition root owns *which* guilds
 * exist, and because a resume with no allowlisted guild present should produce
 * nothing rather than an event with an invented scope.
 */
export function emitConnectionEvents(
  guildIds: readonly string[],
  input: { resumed: boolean; disconnectedAtMs: number; receivedAtMs: number },
  emit: (event: DomainEvent) => void | Promise<void>,
): void {
  for (const guildId of guildIds) {
    void emit({
      kind: 'connection',
      guildId,
      receivedAtMs: input.receivedAtMs,
      resumed: input.resumed,
      disconnectedAtMs: input.disconnectedAtMs,
    });
  }
}

/**
 * A chat-input command interaction, normalised.
 *
 * Separated from the listener because flattening the option tree is the only
 * part of translation with a shape worth reading on its own.
 *
 * Guild attribution is the same rule as everywhere else in this file: an
 * invocation Discord could not attribute to a guild is dropped here rather than
 * travelling upward with an optional scope. A user-installed app can be invoked
 * in a DM, so this is a real case rather than a hypothetical — and every handler
 * downstream reaches storage through a `GuildScope`, which a DM cannot produce.
 */
function toSlashCommandEvent(
  interaction: ChatInputCommandInteraction,
  receivedAtMs: number,
): DomainEvent | undefined {
  const guildId = interaction.guildId;
  if (!guildId) return undefined;

  const { subcommandPath, options } = flattenOptions(interaction.options.data);
  return {
    kind: 'slashCommand',
    guildId,
    receivedAtMs,
    interactionId: interaction.id,
    // A short-lived credential, exactly as on `InteractionEvent`. It travels to
    // the port and nowhere else: absent from LOGGABLE_FIELDS, and pino redacts
    // `token` besides.
    token: interaction.token,
    commandName: interaction.commandName,
    subcommandPath,
    options,
    // Nullable on `BaseInteraction`, and not a reason to drop the invocation:
    // the reply is addressed by the token, not by the channel.
    channelId: interaction.channelId ?? undefined,
    userId: interaction.user.id,
  };
}

/**
 * Discord's nested option tree, flattened into a path plus a flat option list.
 *
 * A subcommand is not a separate field in the payload — it is an *option* whose
 * own `options` are the command's real arguments, and a group nests one level
 * deeper again. Reading `data[0].value` without unwrapping that would report a
 * subcommand as an argument named after itself with no value, so the shape has
 * to be understood rather than copied across.
 *
 * Iterative rather than recursive, and deliberately: Discord permits exactly two
 * levels of nesting (group → subcommand → options), so a loop that walks down
 * while it sees a subcommand terminates by the payload's own grammar.
 */
function flattenOptions(data: readonly CommandInteractionOption[]): {
  subcommandPath: string[];
  options: SlashCommandOption[];
} {
  const subcommandPath: string[] = [];
  let level: readonly CommandInteractionOption[] = data;

  for (;;) {
    const nested = level.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand ||
        option.type === ApplicationCommandOptionType.SubcommandGroup,
    );
    if (nested === undefined) break;
    subcommandPath.push(nested.name);
    level = nested.options ?? [];
  }

  const options: SlashCommandOption[] = [];
  for (const option of level) {
    // An option Discord sent with no value is one the member did not supply.
    // Reporting it as present-but-undefined would make "absent" and "empty"
    // indistinguishable to a handler that only checks for the name.
    if (option.value === undefined) continue;
    options.push({ name: option.name, value: option.value });
  }
  return { subcommandPath, options };
}

/**
 * The roles a member holds, as the gateway payload describes them.
 *
 * **`member.roles.cache` is not that**, in two ways worth knowing
 * (`GuildMemberRoleManager.js:35-43`):
 *
 *  - It *adds* `@everyone`, whose id is the guild id. The wire payload never
 *    includes it. Passing it upward would inflate every count that matters —
 *    `max_roles: 2` would refuse a member's second option, having already
 *    counted a role nobody chose.
 *  - It *drops* any role missing from `guild.roles.cache`. That cache cannot be
 *    limited (discord.js refuses), `GUILD_CREATE` delivers every role and
 *    `GUILD_ROLE_CREATE` adds new ones, and a member cannot hold a role that
 *    does not exist — so the window is theoretical. Recorded rather than worked
 *    around, because the alternative is reading a private field.
 */
function roleIdsOf(member: AnyMember): string[] {
  const everyone = member.guild.id;
  return [...member.roles.cache.keys()].filter((roleId) => roleId !== everyone);
}

function toMessageEvent(
  kind: 'messageCreate' | 'messageUpdate' | 'messageDelete',
  message: AnyMessage,
  receivedAtMs: number,
): DomainEvent | undefined {
  const guildId = message.guildId;
  if (!guildId) return undefined;

  // A partial message carries ids and nothing else — the same reason `content`
  // is `undefined` above. Reading `.mentions` off one yields empty collections
  // at best and throws at worst, and "no mentions known" must not be reported
  // as "no mentions present", so the partial case is branched explicitly.
  const mentions = message.partial ? undefined : message.mentions;

  return {
    kind,
    guildId,
    receivedAtMs,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author?.id ?? undefined,
    // `?? false` rather than leaving it optional: an unknown author is not a
    // known bot, and a message automod cannot attribute is still a message it
    // should evaluate.
    authorIsBot: message.author?.bot ?? false,
    /**
     * Absent when the message was never cached — which for a delete is the
     * common case, because the dispatch carries only ids. `undefined` means "we
     * do not know", and must never be flattened into an empty string, which
     * would read as "the message was empty".
     */
    content: message.partial ? undefined : (message.content ?? undefined),
    editedTimestampMs: message.editedTimestamp ?? undefined,
    mentionedUserIds: mentions ? [...mentions.users.keys()] : [],
    mentionedRoleIds: mentions ? [...mentions.roles.keys()] : [],
    mentionsEveryone: mentions?.everyone ?? false,
    attachments: message.partial
      ? []
      : [...message.attachments.values()].map((a) => ({
          attachmentId: a.id,
          fileName: a.name,
          contentType: a.contentType ?? undefined,
          sizeBytes: a.size,
        })),
  };
}

/**
 * Discord's numeric enums are mapped to string unions here, at the adapter, so
 * `packages/core` never carries Discord enum values. An unrecognised value maps
 * to `'unknown'` rather than dropping the event: a decision we cannot name is
 * still a decision that happened, and ADR 0038 exists to record it.
 */
const ACTION_TYPES: Record<number, NativeAutoModAction> = {
  1: 'block',
  2: 'alert',
  3: 'timeout',
  4: 'block_interaction',
};

const TRIGGER_TYPES: Record<number, NativeAutoModTrigger> = {
  1: 'keyword',
  3: 'spam',
  4: 'keyword_preset',
  5: 'mention_spam',
  6: 'member_profile',
};

function toAutoModerationEvent(
  execution: AutoModerationActionExecution,
  receivedAtMs: number,
  onError: (err: unknown, context: { event: string }) => void,
): DomainEvent | undefined {
  // No `if (!guildId) return undefined` guard here, unlike every other
  // translator in this file: `AutoModerationActionExecution.guild` is
  // non-nullable (`discord.js` typings), because Discord only fires this
  // dispatch for a guild. A guard would be dead code, and eslint's
  // no-unnecessary-condition would say so.
  const actionType = ACTION_TYPES[execution.action.type];
  // An action type we cannot name is dropped rather than guessed: unlike a
  // trigger type, the action is what the recorded vocabulary asserts happened,
  // and recording "something" would put a falsehood in the case history. Report
  // the gap so an unrecognised value is not silently swallowed — ADR 0038
  // exists to record native decisions, and this branch produces exactly the
  // unrecorded decision it warns against.
  if (actionType === undefined) {
    onError(
      new Error(`Unrecognised native AutoMod action type: ${String(execution.action.type)}`),
      { event: 'autoModerationAction' },
    );
    return undefined;
  }
  return {
    kind: 'autoModerationAction',
    guildId: execution.guild.id,
    receivedAtMs,
    ruleId: execution.ruleId,
    triggerType: TRIGGER_TYPES[execution.ruleTriggerType] ?? 'unknown',
    userId: execution.userId,
    actionType,
    channelId: execution.channelId ?? undefined,
    messageId: execution.messageId ?? undefined,
    alertMessageId: execution.alertSystemMessageId ?? undefined,
    content: execution.content,
    matchedKeyword: execution.matchedKeyword ?? undefined,
    matchedContent: execution.matchedContent ?? undefined,
  };
}
