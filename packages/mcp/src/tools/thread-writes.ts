import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { idsAreWellFormed } from '../ids.js';
import { SEND_CONTENT_MAX, SEND_EMBED_TOTAL_MAX, SEND_EMBEDS_MAX, type SendEmbed } from './send.js';

/**
 * The six thread/forum write tools, registered under the send scope.
 *
 * They follow the same five steps as `send_message` — Zod parse →
 * `requireReachableGuild` → port call → render — so hard rule 3 holds by
 * construction, and the same two-message contract (ruling M4-D18): a parse
 * failure is the argument-fault message, a gate failure or any throw is the
 * shared refusal. No tool here throws. Refusal texts are distinct, actionable
 * and content-free (ids only), as in `packages/mcp/src/tools/send.ts`.
 *
 * This module holds no allowlist handle of any kind: the daemon's target
 * resolution owns the allowlist check, the live permission check, the safety
 * reads and the ledger, and this package's port projects its outcomes field
 * by field. `create_thread` in a forum is refused by the daemon (only it
 * knows a channel's live type) with a pointer at `create_forum_post`; forum
 * tag matching is likewise live, against the forum's available tags.
 */

/** A thread or forum-post title is capped at Discord's 100 characters. */
export const THREAD_NAME_MAX = 100;
/** Discord caps thread membership edits per call the way ADR 0117 caps pings. */
export const THREAD_MEMBERS_MAX = 25;
/** Discord caps a forum post at five applied tags. */
export const FORUM_TAGS_MAX = 5;
/** Discord's default thread auto-archive. */
export const THREAD_AUTO_ARCHIVE_DEFAULT = 1440;

export const CREATE_THREAD_TOOL_NAME = 'create_thread';
export const CREATE_THREAD_TOOL_DESCRIPTION =
  'Creates a public or private thread under an allowlisted text channel of this guild. ' +
  'Takes a channel id or name, a thread name up to 100 characters, and the thread type. ' +
  'Private threads are readable back through read_thread and postable through send_message. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call ' +
  '(for example after a timeout): a new key on a retry will create the thread twice. ' +
  'Pass dryRun to record without creating. ' +
  'Refuses when the guild is unreachable, the channel is not allowlisted, the channel is a forum ' +
  '(call create_forum_post instead), or the bot lacks the Discord permission.';

export const ADD_THREAD_MEMBERS_TOOL_NAME = 'add_thread_members';
export const ADD_THREAD_MEMBERS_TOOL_DESCRIPTION =
  'Adds up to 25 guild members to a thread. Each member must be in this guild. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without changing anything.';

export const REMOVE_THREAD_MEMBERS_TOOL_NAME = 'remove_thread_members';
export const REMOVE_THREAD_MEMBERS_TOOL_DESCRIPTION =
  'Removes up to 25 members from a thread. Removing a non-member is a no-op. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without changing anything.';

export const CREATE_FORUM_POST_TOOL_NAME = 'create_forum_post';
export const CREATE_FORUM_POST_TOOL_DESCRIPTION =
  'Creates a public post in a forum channel of this guild: a title up to 100 characters plus ' +
  'content, embeds, or both, with up to 5 tags matched by name or id against the forum tags. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call ' +
  '(for example after a timeout): a new key on a retry will post twice. ' +
  'Pass dryRun to record without posting.';

export const ARCHIVE_THREAD_TOOL_NAME = 'archive_thread';
export const ARCHIVE_THREAD_TOOL_DESCRIPTION =
  'Archives or unarchives a thread. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without changing anything.';

export const LOCK_THREAD_TOOL_NAME = 'lock_thread';
export const LOCK_THREAD_TOOL_DESCRIPTION =
  'Locks or unlocks a thread. A locked thread accepts no new messages except by moderators. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without changing anything.';

/** The starter message `create_thread` posts into the new thread. */
export interface ThreadFirstMessage {
  readonly content?: string | undefined;
  readonly embeds?: readonly SendEmbed[] | undefined;
}

/** What the daemon's thread wiring must satisfy (Task 5 implements it). */
export interface McpThreadWritesPort {
  readonly createThread: (
    guildId: GuildId,
    input: {
      readonly channel: string;
      readonly name: string;
      readonly type: 'public' | 'private';
      readonly autoArchiveMinutes: 60 | 1440 | 4320 | 10080;
      readonly invitable: boolean;
      readonly fromMessageId: string | undefined;
      readonly firstMessage: ThreadFirstMessage | undefined;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpThreadWriteOutcome>;
  readonly addThreadMembers: (
    guildId: GuildId,
    input: {
      readonly threadId: string;
      readonly userIds: readonly string[];
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpThreadWriteOutcome>;
  readonly removeThreadMembers: (
    guildId: GuildId,
    input: {
      readonly threadId: string;
      readonly userIds: readonly string[];
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpThreadWriteOutcome>;
  readonly createForumPost: (
    guildId: GuildId,
    input: {
      readonly forum: string;
      readonly title: string;
      readonly content?: string | undefined;
      readonly embeds?: readonly SendEmbed[] | undefined;
      readonly tags: readonly string[];
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpThreadWriteOutcome>;
  readonly setThreadState: (
    guildId: GuildId,
    input: {
      readonly threadId: string;
      readonly archived?: boolean | undefined;
      readonly locked?: boolean | undefined;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpThreadWriteOutcome>;
}

/** Mirrors the gateway's outcomes, named in this package's own vocabulary. */
export type McpThreadWriteOutcome =
  | {
      readonly status: 'done';
      readonly actionId: string;
      readonly threadId?: string | undefined;
      readonly messageId?: string | undefined;
    }
  | { readonly status: 'dry-run'; readonly actionId: string }
  | {
      readonly status: 'replayed';
      readonly actionId: string;
      readonly threadId?: string | undefined;
      readonly messageId?: string | undefined;
    }
  | { readonly status: 'refused'; readonly reason: McpThreadWriteRefusal; readonly detail?: string }
  | { readonly status: 'failed' };

export type McpThreadWriteRefusal =
  | 'channel-not-allowlisted'
  | 'channel-not-in-guild'
  | 'bot-lacks-permission'
  | 'private-thread'
  | 'not-a-forum'
  | 'use-forum-post'
  | 'invalid-parent'
  | 'thread-not-found'
  | 'user-not-member'
  | 'tag-unknown'
  | 'ambiguous-channel'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content'
  | 'duplicate-content-recently';

export type ThreadWriteOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/**
 * The embed boundary, duplicated from `send.ts` rather than imported: the
 * schemas there are module-private, and this file may not restructure that
 * module. The limits are the shared constants, so the two boundaries cannot
 * drift — an embed valid here posts identically through `send_message`.
 */
const embedFieldSchema = z
  .object({
    name: z.string().min(1).max(256),
    value: z.string().min(1).max(1024),
    inline: z.boolean().optional(),
  })
  .strict();

const embedSchema = z
  .object({
    title: z.string().min(1).max(256).optional(),
    description: z.string().min(1).max(4096).optional(),
    fields: z.array(embedFieldSchema).max(10).optional(),
    color: z.number().int().min(0).max(0xff_ff_ff).optional(),
    footer: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .refine(
    (embed) =>
      embed.title !== undefined ||
      embed.description !== undefined ||
      (embed.fields !== undefined && embed.fields.length > 0) ||
      embed.footer !== undefined,
    { message: 'embed must have a title, description, field or footer' },
  );

const embedTotalLength = (embed: z.infer<typeof embedSchema>): number =>
  (embed.title ?? '').length +
  (embed.description ?? '').length +
  (embed.footer ?? '').length +
  (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);

const embedsWithinTotal = (embeds: readonly z.infer<typeof embedSchema>[] | undefined): boolean =>
  (embeds ?? []).reduce((sum, embed) => sum + embedTotalLength(embed), 0) <= SEND_EMBED_TOTAL_MAX;

const firstMessageSchema = z
  .object({
    content: z.string().min(1).max(SEND_CONTENT_MAX).optional(),
    embeds: z.array(embedSchema).max(SEND_EMBEDS_MAX).optional(),
  })
  .refine(
    (message) =>
      message.content !== undefined || (message.embeds !== undefined && message.embeds.length > 0),
    { message: 'content or embeds required' },
  )
  .refine((message) => embedsWithinTotal(message.embeds), {
    message: 'embeds exceed 6000 characters in total',
  });

const autoArchiveSchema = z.union([
  z.literal(60),
  z.literal(1440),
  z.literal(4320),
  z.literal(10080),
]);

/**
 * Zod schemas are the boundary (hard rule 3): a parse failure is the
 * argument-fault message, never a throw, and the parse runs before the guild
 * gate. `guildId` is a bare string on purpose — the gate parses it and
 * refuses malformed and unreachable identically. `channel` and `forum` take
 * an id or a name; the daemon resolves names against the live guild.
 * `idempotencyKey` is required with no maximum, like `send_message`.
 *
 * `invitable` is private-only and `fromMessageId` is public-only: either
 * combination the other way is an argument fault here, before the guild
 * gate, because the caller's shape is wrong whatever the guild holds.
 */
const createThreadArgsSchema = z
  .object({
    guildId: z.string(),
    channel: z.string().min(1),
    name: z.string().min(1).max(THREAD_NAME_MAX),
    type: z.enum(['public', 'private']),
    autoArchiveMinutes: autoArchiveSchema.optional(),
    invitable: z.boolean().optional(),
    fromMessageId: z.string().optional(),
    firstMessage: firstMessageSchema.optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .refine((args) => args.type !== 'public' || args.invitable === undefined, {
    message: 'invitable is private-only',
  })
  .refine((args) => args.type !== 'private' || args.fromMessageId === undefined, {
    message: 'fromMessageId is public-only',
  });

const threadMembersArgsSchema = z.object({
  guildId: z.string(),
  threadId: z.string(),
  userIds: z.array(z.string().min(1)).min(1).max(THREAD_MEMBERS_MAX),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().min(1),
});

const createForumPostArgsSchema = z
  .object({
    guildId: z.string(),
    forum: z.string().min(1),
    title: z.string().min(1).max(THREAD_NAME_MAX),
    content: z.string().min(1).max(SEND_CONTENT_MAX).optional(),
    embeds: z.array(embedSchema).max(SEND_EMBEDS_MAX).optional(),
    tags: z.array(z.string().min(1)).max(FORUM_TAGS_MAX).optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .refine(
    (args) => args.content !== undefined || (args.embeds !== undefined && args.embeds.length > 0),
    { message: 'content or embeds required' },
  )
  .refine((args) => embedsWithinTotal(args.embeds), {
    message: 'embeds exceed 6000 characters in total',
  });

const archiveThreadArgsSchema = z.object({
  guildId: z.string(),
  threadId: z.string(),
  archived: z.boolean(),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().min(1),
});

const lockThreadArgsSchema = z.object({
  guildId: z.string(),
  threadId: z.string(),
  locked: z.boolean(),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().min(1),
});

/**
 * The loose wire shapes registered with the MCP server. Deliberately without
 * refinements: the strict schemas above stay the single boundary.
 */
export const createThreadParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  channel: z.string().describe('Text channel to create the thread under, as an id or name.'),
  name: z.string().describe(`Thread name, 1 to ${String(THREAD_NAME_MAX)} characters.`),
  type: z.enum(['public', 'private']).describe('Thread type; private threads stay invite-only.'),
  autoArchiveMinutes: z
    .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
    .optional()
    .describe('Idle minutes before auto-archive. Defaults to 1440.'),
  invitable: z
    .boolean()
    .optional()
    .describe('Private threads only: whether members may invite others. Defaults to false.'),
  fromMessageId: z
    .string()
    .optional()
    .describe('Public threads only: start the thread from this message in the channel.'),
  firstMessage: z
    .object({
      content: z.string().optional(),
      embeds: z
        .array(
          z.object({
            title: z.string().optional(),
            description: z.string().optional(),
            fields: z
              .array(
                z.object({ name: z.string(), value: z.string(), inline: z.boolean().optional() }),
              )
              .optional(),
            color: z.number().optional(),
            footer: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional()
    .describe('Optional starter message posted into the new thread (content, embeds, or both).'),
  dryRun: z.boolean().optional().describe('Record without creating: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe(
      'Caller-supplied key for this creation; reuse the same value if you retry this call.',
    ),
};

export const addThreadMembersParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  threadId: z.string().describe('Thread to add members to.'),
  userIds: z.array(z.string()).describe('Up to 25 guild members to add, as ids.'),
  dryRun: z.boolean().optional().describe('Record without changing: nobody is added.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this edit; reuse the same value if you retry this call.'),
};

export const removeThreadMembersParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  threadId: z.string().describe('Thread to remove members from.'),
  userIds: z.array(z.string()).describe('Up to 25 members to remove, as ids.'),
  dryRun: z.boolean().optional().describe('Record without changing: nobody is removed.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this edit; reuse the same value if you retry this call.'),
};

export const createForumPostParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  forum: z.string().describe('Forum channel to post into, as an id or name.'),
  title: z.string().describe(`Post title, 1 to ${String(THREAD_NAME_MAX)} characters.`),
  content: z
    .string()
    .optional()
    .describe('Post text in Discord Markdown. Optional when embeds are present.'),
  embeds: z
    .array(
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        fields: z
          .array(z.object({ name: z.string(), value: z.string(), inline: z.boolean().optional() }))
          .optional(),
        color: z.number().optional(),
        footer: z.string().optional(),
      }),
    )
    .optional()
    .describe('Up to 3 rich embeds; at least one of content or embeds is required.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Up to 5 forum tags, as names or ids; unknown names refuse with the available list.'),
  dryRun: z.boolean().optional().describe('Record without posting: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this post; reuse the same value if you retry this call.'),
};

export const archiveThreadParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  threadId: z.string().describe('Thread to archive or unarchive.'),
  archived: z.boolean().describe('True archives the thread; false unarchives it.'),
  dryRun: z.boolean().optional().describe('Record without changing: the thread is untouched.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this change; reuse the same value if you retry this call.'),
};

export const lockThreadParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  threadId: z.string().describe('Thread to lock or unlock.'),
  locked: z.boolean().describe('True locks the thread; false unlocks it.'),
  dryRun: z.boolean().optional().describe('Record without changing: the thread is untouched.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this change; reuse the same value if you retry this call.'),
};

const refuse = (): ThreadWriteOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): ThreadWriteOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/** The unknown refs and the available names behind a `tag-unknown` refusal. */
const parseTagDetail = (detail: string | undefined): { unknown: string; available: string } => {
  if (detail === undefined) return { unknown: 'a tag', available: 'none listed' };
  try {
    const parsed = JSON.parse(detail) as { unknown?: unknown; available?: unknown };
    const unknown = Array.isArray(parsed.unknown) ? parsed.unknown.map(String).join(', ') : 'a tag';
    const available = Array.isArray(parsed.available)
      ? parsed.available.map(String).join(', ')
      : 'none listed';
    return { unknown, available };
  } catch {
    return { unknown: 'a tag', available: detail };
  }
};

/**
 * Every refusal renders distinctly and actionably: the operator reading it
 * knows what stopped the write and what to do next. No two reasons share a
 * string (pinned by test), and none echoes message content — ids only.
 * `nothingHappened` names what did not occur, per tool.
 */
const refusalText = (
  guildId: GuildId,
  targetId: string,
  reason: McpThreadWriteRefusal,
  detail: string | undefined,
  nothingHappened: string,
): string => {
  switch (reason) {
    case 'channel-not-allowlisted':
      return (
        `Channel ${targetId} in guild ${guildId} is not on the send allowlist, ` +
        `so ${nothingHappened}. The owner can allow it with ` +
        `\`bananasaurs mcp allow-channel ${targetId} --guild ${guildId} --confirm\`, then retry this call.`
      );
    case 'channel-not-in-guild':
      return (
        `Channel ${targetId} in guild ${guildId} is not a channel this guild's bot can see, ` +
        `so ${nothingHappened}. Allowlisting it will not help: ` +
        `\`bananasaurs mcp allow-channel ${targetId} --guild ${guildId} --confirm\` would refuse the same id. ` +
        'If the channel was already allowlisted, the bot may not see it yet ' +
        '(for example right after a restart) — wait a moment and retry this call.'
      );
    case 'bot-lacks-permission':
      return (
        `The bot lacks the ${detail ?? 'needed'} Discord permission in channel ${targetId} ` +
        `in guild ${guildId}, so ${nothingHappened}. An operator who can edit the channel's ` +
        'permission overwrites can grant it, then retry this call.'
      );
    case 'private-thread':
      return (
        `Thread ${targetId} in guild ${guildId} is private and was not created through this tool, ` +
        `so ${nothingHappened}. Private threads never inherit send authorization.`
      );
    case 'not-a-forum':
      return (
        `Channel ${targetId} in guild ${guildId} is not a forum, ` +
        'so no post was created. Pass a forum channel id or name — `list_channels` shows the types.'
      );
    case 'use-forum-post':
      return (
        `Channel ${targetId} in guild ${guildId} is a forum, ` +
        `so ${nothingHappened}. Forums take posts, not threads: call \`${CREATE_FORUM_POST_TOOL_NAME}\` instead.`
      );
    case 'invalid-parent':
      return (
        `Channel ${targetId} in guild ${guildId} is itself a thread, ` +
        `so ${nothingHappened}. Threads can only be created in text channels, not inside other threads.`
      );
    case 'thread-not-found':
      return (
        `Thread ${targetId} in guild ${guildId} was not found, ` +
        `so ${nothingHappened}. Check the id and retry this call.`
      );
    case 'user-not-member':
      return (
        `User ${detail ?? '?'} is not a member of guild ${guildId}, ` + `so ${nothingHappened}.`
      );
    case 'tag-unknown': {
      const tags = parseTagDetail(detail);
      return (
        `Tag "${tags.unknown}" is not a tag of forum ${targetId} in guild ${guildId}, ` +
        `so ${nothingHappened}. Available tags: ${tags.available}. ` +
        'Pass tag names or ids from that list.'
      );
    }
    case 'ambiguous-channel':
      return (
        `"${targetId}" matches several channels in guild ${guildId} (${detail ?? 'unlisted'}), ` +
        `so ${nothingHappened}. Pass a channel id instead of a name.`
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so ${nothingHappened}. ` +
        'Thread writes stay paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        `so ${nothingHappened}. Wait for an operator to clear it; do not retry in a loop.`
      );
    case 'rate-cap':
      return (
        `Guild ${guildId} has used its rolling-hour budget for this kind of action ` +
        '(setting mcp.cap.structure for thread changes, mcp.cap.message for forum posts), ' +
        `so ${nothingHappened}. Wait for the window to pass before retrying` +
        `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
        'answering an already-recorded idempotency key still works meanwhile.'
      );
    case 'duplicate-key-different-content':
      return (
        'That idempotency key was already used for a different write, ' +
        'so nothing new was created or changed. To write this, retry with a fresh key; ' +
        'the earlier write under the old key is unaffected.'
      );
    case 'duplicate-content-recently':
      return (
        `The same write already ran against channel ${targetId} within the last minute, ` +
        'so nothing new was created or changed. Wait a minute or vary the arguments, then retry with a fresh key.'
      );
  }
};

/**
 * Trims caller text the way `send_message` does: blank-after-trim is an
 * argument fault. The blank flag is separate from the text so a post whose
 * whole content is the word "blank" still posts.
 */
const trimmedContent = (
  content: string | undefined,
): { readonly text: string | undefined; readonly blank: boolean } => {
  if (content === undefined) return { text: undefined, blank: false };
  const trimmed = content.trim();
  return trimmed === '' ? { text: undefined, blank: true } : { text: trimmed, blank: false };
};

interface ParsedCall {
  readonly guildId: GuildId;
}

const gateGuild = (
  principal: McpPrincipal,
  rawGuildId: string,
): ParsedCall | ThreadWriteOutcomeText => {
  const gate = requireReachableGuild(principal, rawGuildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  return { guildId: gate.guildId };
};

const createThreadInner = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
): Promise<ThreadWriteOutcomeText> => {
  const parsed = createThreadArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  if (input.fromMessageId !== undefined && !idsAreWellFormed([input.fromMessageId])) {
    return refuseInvalidArgs();
  }
  const firstContent = input.firstMessage?.content;
  if (firstContent !== undefined && firstContent.trim() === '') return refuseInvalidArgs();
  const gate = gateGuild(principal, input.guildId);
  if (!('guildId' in gate)) return gate;
  const guildId = gate.guildId;
  const outcome = await port.createThread(guildId, {
    channel: input.channel,
    name: input.name,
    type: input.type,
    autoArchiveMinutes: input.autoArchiveMinutes ?? THREAD_AUTO_ARCHIVE_DEFAULT,
    // Private-only (the schema refused it on public): absent means Discord's
    // default, which for a private thread leaves members unable to invite.
    invitable: input.invitable ?? false,
    fromMessageId: input.fromMessageId,
    firstMessage:
      input.firstMessage === undefined
        ? undefined
        : {
            ...(firstContent === undefined ? {} : { content: firstContent.trim() }),
            ...(input.firstMessage.embeds === undefined
              ? {}
              : { embeds: input.firstMessage.embeds }),
          },
    dryRun: input.dryRun ?? false,
    idempotencyKey: input.idempotencyKey,
  });
  const nothingHappened = 'no thread was created';
  switch (outcome.status) {
    case 'done': {
      if (outcome.threadId === undefined) return refuse();
      const first =
        input.firstMessage === undefined
          ? ''
          : outcome.messageId === undefined
            ? ' The thread was created but the first message failed with an unknown result: it may or may not be in the thread — check before retrying, and retry with the same idempotency key, never a fresh one.'
            : ` The first message was posted as ${outcome.messageId}.`;
      return {
        ok: true,
        text:
          `Created ${input.type} thread ${outcome.threadId} in channel ${input.channel} ` +
          `in guild ${guildId} (action ${outcome.actionId}).${first}`,
      };
    }
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          `nothing was created in channel ${input.channel}. The creation was recorded ` +
          `as action ${outcome.actionId} under its idempotency key but no Discord call was made. ` +
          `It would create a ${input.type} thread` +
          `${input.firstMessage === undefined ? '' : ' with a first message'}.`,
      };
    case 'replayed':
      if (outcome.threadId !== undefined) {
        return {
          ok: true,
          text:
            `Already created under this idempotency key as thread ${outcome.threadId} ` +
            `(action ${outcome.actionId}): ` +
            `nothing new was created in channel ${input.channel}.`,
        };
      }
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}, ` +
          'but the earlier attempt stored no thread id, so its outcome is unknown ' +
          `and the thread may or may not be in channel ${input.channel}: ` +
          'nothing new was created by this call. ' +
          `Check channel ${input.channel} for the thread before retrying, ` +
          'and if you retry, reuse this same idempotency key — never a fresh one.',
      };
    case 'refused':
      return {
        ok: false,
        message: refusalText(
          guildId,
          input.channel,
          outcome.reason,
          outcome.detail,
          nothingHappened,
        ),
      };
    case 'failed':
      return {
        ok: false,
        message:
          `The Discord call for channel ${input.channel} ` +
          `in guild ${guildId} failed with an unknown result: the thread ` +
          `may or may not have been created. Check the channel before retrying, ` +
          'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

const membersInner = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
  verb: 'add' | 'remove',
): Promise<ThreadWriteOutcomeText> => {
  const parsed = threadMembersArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  if (!idsAreWellFormed([input.threadId, ...input.userIds])) return refuseInvalidArgs();
  const gate = gateGuild(principal, input.guildId);
  if (!('guildId' in gate)) return gate;
  const guildId = gate.guildId;
  const outcome =
    verb === 'add'
      ? await port.addThreadMembers(guildId, {
          threadId: input.threadId,
          userIds: [...input.userIds],
          dryRun: input.dryRun ?? false,
          idempotencyKey: input.idempotencyKey,
        })
      : await port.removeThreadMembers(guildId, {
          threadId: input.threadId,
          userIds: [...input.userIds],
          dryRun: input.dryRun ?? false,
          idempotencyKey: input.idempotencyKey,
        });
  const count = input.userIds.length;
  const changed =
    verb === 'add'
      ? `added ${String(count)} member${count === 1 ? '' : 's'}`
      : `removed ${String(count)} member${count === 1 ? '' : 's'}`;
  const nothingHappened = 'the member list is unchanged';
  switch (outcome.status) {
    case 'done':
      return {
        ok: true,
        text: `Updated thread ${input.threadId} in guild ${guildId}: ${changed} (action ${outcome.actionId}).`,
      };
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          `nobody was ${verb === 'add' ? 'added to' : 'removed from'} thread ${input.threadId}. ` +
          `The edit was recorded as action ${outcome.actionId} under its idempotency key ` +
          'but no Discord call was made.',
      };
    case 'replayed':
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}: ` +
          `nothing new was changed in thread ${input.threadId}.`,
      };
    case 'refused':
      return {
        ok: false,
        message: refusalText(
          guildId,
          input.threadId,
          outcome.reason,
          outcome.detail,
          nothingHappened,
        ),
      };
    case 'failed':
      return {
        ok: false,
        message:
          `The Discord call for thread ${input.threadId} ` +
          `in guild ${guildId} failed with an unknown result: some members ` +
          `may or may not have been ${verb === 'add' ? 'added' : 'removed'}. Check the thread before retrying, ` +
          'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

const createForumPostInner = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
): Promise<ThreadWriteOutcomeText> => {
  const parsed = createForumPostArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  const { text: content, blank } = trimmedContent(input.content);
  if (blank) return refuseInvalidArgs();
  const gate = gateGuild(principal, input.guildId);
  if (!('guildId' in gate)) return gate;
  const guildId = gate.guildId;
  const outcome = await port.createForumPost(guildId, {
    forum: input.forum,
    title: input.title,
    ...(content === undefined ? {} : { content }),
    ...(input.embeds === undefined ? {} : { embeds: input.embeds }),
    tags: [...(input.tags ?? [])],
    dryRun: input.dryRun ?? false,
    idempotencyKey: input.idempotencyKey,
  });
  const nothingHappened = 'no post was created';
  switch (outcome.status) {
    case 'done': {
      if (outcome.threadId === undefined || outcome.messageId === undefined) return refuse();
      return {
        ok: true,
        text:
          `Created forum post ${outcome.threadId} in forum ${input.forum} ` +
          `in guild ${guildId} (starter message ${outcome.messageId}, action ${outcome.actionId}).`,
      };
    }
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          `nothing was posted to forum ${input.forum}. The post was recorded ` +
          `as action ${outcome.actionId} under its idempotency key but no Discord call was made.`,
      };
    case 'replayed':
      if (outcome.threadId !== undefined) {
        return {
          ok: true,
          text:
            `Already posted under this idempotency key as post ${outcome.threadId} ` +
            `(action ${outcome.actionId}): ` +
            `nothing new was posted to forum ${input.forum}.`,
        };
      }
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}, ` +
          'but the earlier attempt stored no post id, so its outcome is unknown ' +
          `and the post may or may not be in forum ${input.forum}: ` +
          'nothing new was posted by this call. ' +
          `Check forum ${input.forum} for the post before retrying, ` +
          'and if you retry, reuse this same idempotency key — never a fresh one.',
      };
    case 'refused':
      return {
        ok: false,
        message: refusalText(guildId, input.forum, outcome.reason, outcome.detail, nothingHappened),
      };
    case 'failed':
      return {
        ok: false,
        message:
          `The Discord call for forum ${input.forum} ` +
          `in guild ${guildId} failed with an unknown result: the post ` +
          `may or may not have been created. Check the forum before retrying, ` +
          'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

const setThreadStateInner = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
  verb: 'archive' | 'lock',
): Promise<ThreadWriteOutcomeText> => {
  const parsed =
    verb === 'archive'
      ? archiveThreadArgsSchema.safeParse(rawArgs)
      : lockThreadArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  if (!idsAreWellFormed([input.threadId])) return refuseInvalidArgs();
  const gate = gateGuild(principal, input.guildId);
  if (!('guildId' in gate)) return gate;
  const guildId = gate.guildId;
  // The schemas guarantee exactly one of the two fields, so `in` narrows
  // the parse union without a cast.
  const field = 'archived' in input ? input.archived : input.locked;
  const outcome = await port.setThreadState(guildId, {
    threadId: input.threadId,
    ...('archived' in input ? { archived: input.archived } : { locked: input.locked }),
    dryRun: input.dryRun ?? false,
    idempotencyKey: input.idempotencyKey,
  });
  const changed =
    verb === 'archive'
      ? field === true
        ? 'Archived'
        : 'Unarchived'
      : field === true
        ? 'Locked'
        : 'Unlocked';
  const nothingHappened = 'the thread state is unchanged';
  switch (outcome.status) {
    case 'done':
      return {
        ok: true,
        text: `${changed} thread ${input.threadId} in guild ${guildId} (action ${outcome.actionId}).`,
      };
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          `thread ${input.threadId} was left ${verb === 'archive' ? (field === true ? 'unarchived' : 'archived') : field === true ? 'unlocked' : 'locked'}. ` +
          `The change was recorded as action ${outcome.actionId} under its idempotency key ` +
          'but no Discord call was made.',
      };
    case 'replayed':
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}: ` +
          `nothing new was changed in thread ${input.threadId}.`,
      };
    case 'refused':
      return {
        ok: false,
        message: refusalText(
          guildId,
          input.threadId,
          outcome.reason,
          outcome.detail,
          nothingHappened,
        ),
      };
    case 'failed':
      return {
        ok: false,
        message:
          `The Discord call for thread ${input.threadId} ` +
          `in guild ${guildId} failed with an unknown result: the thread ` +
          `may or may not have been ${verb === 'archive' ? 'archived' : 'locked'}. Check the thread before retrying, ` +
          'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

/**
 * Never throws and never rejects: a malformed argument is the
 * argument-fault message, and anything unexpected (a port fault, which
 * cannot carry message content outward from here) is the shared refusal
 * rather than an exception out of the handler. The two messages are
 * deliberately different (ruling M4-D18).
 */
export const createThreadText = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
): Promise<ThreadWriteOutcomeText> => {
  try {
    return await createThreadInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};

export const addThreadMembersText = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
): Promise<ThreadWriteOutcomeText> => {
  try {
    return await membersInner(principal, port, rawArgs, 'add');
  } catch {
    return refuse();
  }
};

export const removeThreadMembersText = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
): Promise<ThreadWriteOutcomeText> => {
  try {
    return await membersInner(principal, port, rawArgs, 'remove');
  } catch {
    return refuse();
  }
};

export const createForumPostText = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
): Promise<ThreadWriteOutcomeText> => {
  try {
    return await createForumPostInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};

export const archiveThreadText = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
): Promise<ThreadWriteOutcomeText> => {
  try {
    return await setThreadStateInner(principal, port, rawArgs, 'archive');
  } catch {
    return refuse();
  }
};

export const lockThreadText = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  rawArgs: unknown,
): Promise<ThreadWriteOutcomeText> => {
  try {
    return await setThreadStateInner(principal, port, rawArgs, 'lock');
  } catch {
    return refuse();
  }
};
