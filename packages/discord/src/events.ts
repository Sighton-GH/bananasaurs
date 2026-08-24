import {
  Events,
  type Client,
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
import { emojiKeyFromGateway, type DomainEvent } from '@bananasaurs/core';

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
      // Only message components drive panels. Anything else — a slash command, an
      // autocomplete — is not this adapter's business and is dropped rather than
      // translated into a shape that cannot describe it.
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
  client.on(Events.MessageUpdate, (_old: AnyMessage, message: AnyMessage) => {
    translate('messageUpdate', () => toMessageEvent('messageUpdate', message, now()));
  });
  client.on(Events.MessageDelete, (message: AnyMessage) => {
    translate('messageDelete', () => toMessageEvent('messageDelete', message, now()));
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
  kind: 'messageUpdate' | 'messageDelete',
  message: AnyMessage,
  receivedAtMs: number,
): DomainEvent | undefined {
  const guildId = message.guildId;
  if (!guildId) return undefined;
  return {
    kind,
    guildId,
    receivedAtMs,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author?.id ?? undefined,
    /**
     * Absent when the message was never cached — which for a delete is the
     * common case, because the dispatch carries only ids. `undefined` means "we
     * do not know", and must never be flattened into an empty string, which
     * would read as "the message was empty".
     */
    content: message.partial ? undefined : (message.content ?? undefined),
    editedTimestampMs: message.editedTimestamp ?? undefined,
  };
}
