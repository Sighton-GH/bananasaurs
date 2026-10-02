import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
} from 'discord.js';
import {
  CLUB_ASSISTANT_SKILLS,
  argsHashFor,
  authorize,
  contentHashFor,
  customEmojiKey,
  effectiveSkillScope,
  isInScope,
  parseSnowflakeId,
  RateLimiter,
  runMcpAction,
  safeLogFields,
  skillScopeAllows,
  unicodeEmojiKey,
  type Authorized,
  type DiscordPort,
  type GuildId,
  type Logger,
  type McpActionOutcome,
  type OpsJobRow,
  type RefusalReason,
} from '@bananasaurs/core';
import { taskAdminPortFor } from './task-admin-port.js';
import { mcpRoleGatewayFor, roleGrantRefusal } from './roles-gateway.js';
import { resolvePings, resolveSendTarget, type SendTarget, type TargetNeed } from './targets.js';
import { protectedMessageReason } from './protected.js';
import { resolveChannel } from '../channels/resolver.js';
import { mcpActionDepsFor } from './actions.js';
import { requireBearer, type HttpDeps } from '@bananasaurs/http';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  createMcpServer,
  GUILD_REFUSAL_MESSAGE,
  MEMBER_LISTING_CAP,
  type McpActionView,
  type McpActionsPort,
  type McpArchiveMessage,
  type McpArchivePort,
  type McpContextPort,
  type McpGuildHealth,
  type McpGuildPort,
  type McpGuildThread,
  type McpHealthPort,
  type McpJob,
  type McpJobsPort,
  type McpMemberProfile,
  type McpMembersPort,
  type McpPrincipal,
  type McpReadAuditPort,
  type McpRecordsPort,
  type McpResourcesPort,
  type McpResourceSummary,
  type McpSendPort,
  type SendEmbed,
  type McpMessageWriteOutcome,
  type McpMessageWritesPort,
  type McpRoleWriteOutcome,
  type McpRoleWriteRefusal,
  type McpRoleWritesPort,
  type McpThreadsPort,
  type McpThreadWritesPort,
  type McpThreadWriteOutcome,
  type McpThreadWriteRefusal,
  type McpUndoOutcome,
  type ThreadFirstMessage,
  type McpTaskDetailPort,
  type McpTaskPort,
} from '@bananasaurs/mcp';
import {
  archiveRepo,
  archiveSearchRepo,
  assistantRepo,
  automodAdminRepo,
  authzStoreFor,
  effectRepo,
  guildRepo,
  isTargetProtected,
  loggingRepo,
  modCaseRepo,
  panelRepo,
  resourceCacheRepo,
  roleRepo,
  accountRepo,
  mcpActionsRepo,
  mcpRolePolicyRepo,
  mcpSendRepo,
  taskBindingRepo,
  taskNudgeRepo,
  taskRepo,
  type GuildScope,
} from '@bananasaurs/storage';

/**
 * The owner's MCP read surface (slice M4), mounted at `/mcp` by the daemon's
 * HTTP wiring — and only when the operator opted in with `MCP_PUBLIC_URL`.
 *
 * Ruling M4-D7: the bearer guard is called here, by the daemon, not by
 * `packages/mcp` (which may not import `@bananasaurs/http` at all). The
 * composition root authenticates with `requireBearer` and hands the resulting
 * principal straight to the server factory — `BearerPrincipal` is
 * structurally compatible with `McpPrincipal`, so no adapter is needed.
 */

export const MCP_ROUTE_PATH = '/mcp';

/**
 * Projects the operator surface down to the narrow port `get_health` needs,
 * field by field. `OpsInstance` itself is never passed: it carries write
 * members (`mcpRevokeToken`, `accountSetDisabled`, …) no MCP tool may reach,
 * and M4 is read-only. One entry per guild in the caller's reachable set, so
 * a guild-independent tool still reports per-guild facts without taking a
 * guild argument — and an emptied reachable set yields an empty list, which
 * is what `get_health` refuses on (ADR 0044 §4 obligation 1).
 */
const healthPortFor = (principal: McpPrincipal, deps: HttpDeps): McpHealthPort => ({
  startedAtMs: deps.instance.startedAtMs,
  readonly: deps.instance.readonly,
  env: deps.instance.env,
  now: deps.now,
  gateway: () => {
    const gateway = deps.instance.gateway();
    return {
      connected: gateway.connected,
      pingMs: gateway.pingMs,
      guildCount: gateway.guildCount,
    };
  },
  // Read when `get_health` asks, not when the port is built: this runs a
  // `portsFor` and four port reads per reachable guild, and the daemon
  // constructs one port per request before it knows which tool the request
  // will call. As a precomputed value every `tools/list` and every
  // `search_messages` paid for a snapshot nobody read — and so did every
  // request from a token holding no read scope, which registers no tools at
  // all.
  guilds: (): readonly McpGuildHealth[] => {
    const nowMs = deps.now();
    return principal.reachableGuilds.map((guildId) => {
      const ports = deps.portsFor(deps.scopes.forGuild(guildId));
      const safety = ports.safetyState();
      const dueAtMs = ports.oldestDueJobAtMs(nowMs);
      return {
        guildId,
        guildName: ports.guildName(),
        safety:
          safety === undefined
            ? undefined
            : {
                killswitch: safety.killswitch,
                dryRun: safety.dryRun,
                breakerOpen: safety.breakerOpen,
                breakerReason: safety.breakerReason,
              },
        jobCounts: ports.jobCounts(),
        // Clamped at zero so a clock that moved backwards reports "not behind"
        // rather than a negative lag — the same rule `/status` follows.
        schedulerLagMs: dueAtMs === undefined ? 0 : Math.max(0, nowMs - dueAtMs),
      };
    });
  },
});

/**
 * The step-2 trace (ruling M4-D18). Every port method below runs inside one
 * of these wrappers, so a repository or cache fault leaves one error line
 * before the throw reaches the tool layer — which answers the shared refusal
 * and swallows the throw, while the route's `catch` only fires on a
 * transport fault. Without this line the operator has no trace to contradict
 * a "guild unknown or unreachable" report caused by a stale FTS index or a
 * missing intent. Rethrown after logging: the tool layer still refuses.
 *
 * Allowlisted fields only (CLAUDE.md rule 4): `component`, `reason`, `err`.
 * `safeLogFields` (`packages/core/src/obs/logger.ts`) permits no `tool`
 * field, so the port method name goes in `reason`. Never a token, a session
 * id, message content, a member name, a snippet, or an audit payload.
 *
 * `err` is the one free-text field in that allowlist — deliberately, because
 * stomping it once hid the real error on every job failure
 * (`docs/reports/WP5-slice-6-live-test.md` finding 2), and the helper must
 * keep that behaviour for its other callers. But it is free text, and these
 * eleven call sites are the first to put a *caller-influenced* failure into
 * it: SQLite and FTS5 both quote the offending fragment back, so a search
 * query can end up in the message. That is the operator's own typing rather
 * than a member's words, so it is not a rule-4 breach — but it is unbounded,
 * and an unbounded free-text field reached from a network request is worth
 * capping rather than trusting. One line of a log is enough to diagnose a
 * stale index or a missing intent, which is all this line exists for.
 */
const ERR_MESSAGE_MAX = 200;

const logPortFailure = (logger: Logger, reason: string, err: unknown): never => {
  const message = err instanceof Error ? err.message : 'mcp port failed';
  logger.error(
    safeLogFields({
      component: 'mcp',
      reason,
      err:
        message.length > ERR_MESSAGE_MAX
          ? `${message.slice(0, ERR_MESSAGE_MAX)}… (truncated)`
          : message,
    }),
    'mcp port failed',
  );
  throw err;
};

const loggedCall = <T>(logger: Logger, reason: string, call: () => T): T => {
  try {
    return call();
  } catch (err) {
    return logPortFailure(logger, reason, err);
  }
};

const loggedCallAsync = async <T>(
  logger: Logger,
  reason: string,
  call: () => Promise<T>,
): Promise<T> => {
  try {
    return await call();
  } catch (err) {
    return logPortFailure(logger, reason, err);
  }
};

/**
 * Projects the archive row to the seven fields `packages/mcp` reads, field by
 * field like every other port here. `retentionClass`, `caseId`, `deletedAt`,
 * `editedAt` and `mentionedRoleIds` stop at this boundary: they were crossing it and being read
 * by nothing, and the point of naming each field is that a column added to
 * `archive_messages` later cannot arrive in the MCP package for free.
 */
const toMcpArchiveMessage = (row: archiveRepo.ArchiveMessage): McpArchiveMessage => ({
  messageId: row.messageId,
  channelId: row.channelId,
  threadId: row.threadId,
  authorId: row.authorId,
  content: row.content,
  createdAt: row.createdAt,
  contentPurgedAt: row.contentPurgedAt,
  replyToMessageId: row.replyToMessageId,
});

/**
 * The `McpArchivePort` behind the three archive tools, field by field like
 * `healthPortFor` above. Each method turns the already-resolved `GuildId`
 * into a `GuildScope` per call and reads through the archive repositories —
 * nothing here writes, and M4 is read-only. The visibility set is built in
 * the tool layer from `listArchiveChannelIds` (every archive-enabled channel
 * in the guild); the caller's `channelIds` only ever narrows within it.
 * A fault leaves one allowlisted-fields error line via `loggedCall` above,
 * never message content (rule 4).
 */
const archivePortFor = (deps: HttpDeps, client: Client, discord: DiscordPort): McpArchivePort => ({
  now: deps.now,
  listArchiveChannelIds: (guildId) =>
    loggedCall(deps.logger, 'listArchiveChannelIds', () =>
      archiveRepo.listChannels(deps.scopes.forGuild(guildId)).map((channel) => channel.channelId),
    ),
  searchMessages: (guildId, input) =>
    loggedCall(deps.logger, 'searchMessages', () => {
      const result = archiveSearchRepo.searchMessages(deps.scopes.forGuild(guildId), {
        query: input.query,
        visibility: input.visibility,
        ...(input.channelIds !== undefined ? { channelIds: input.channelIds } : {}),
        ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return {
        total: result.total,
        hits: result.hits.map((hit) => ({
          messageId: hit.messageId,
          channelId: hit.channelId,
          threadId: hit.threadId,
          authorId: hit.authorId,
          createdAt: hit.createdAt,
          excerpt: hit.excerpt,
        })),
      };
    }),
  findMessage: (guildId, messageId) =>
    loggedCall(deps.logger, 'findMessage', () => {
      const row = archiveRepo.findMessage(deps.scopes.forGuild(guildId), messageId);
      return row === undefined ? undefined : toMcpArchiveMessage(row);
    }),
  listChannelHistory: (guildId, input) =>
    loggedCall(deps.logger, 'listChannelHistory', () =>
      archiveRepo
        .listChannelHistory(deps.scopes.forGuild(guildId), {
          channelId: input.channelId,
          // M1: a forum's posts are threads; the read rolls them up under
          // the forum id. The type comes from the live cache — the repo
          // never trusts caller input for the visibility decision.
          ...(client.guilds.cache.get(guildId)?.channels.cache.get(input.channelId)?.type ===
          ChannelType.GuildForum
            ? { includeThreads: true as const }
            : {}),
          ...(input.beforeMessageId !== undefined
            ? { beforeMessageId: input.beforeMessageId }
            : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
        })
        .map(toMcpArchiveMessage),
    ),
  listMessagesSince: (guildId, input) =>
    loggedCall(deps.logger, 'listMessagesSince', () =>
      archiveRepo
        .listMessagesSince(deps.scopes.forGuild(guildId), {
          channelIds: [...input.channelIds],
          since: input.since,
          ...(input.after !== undefined ? { after: input.after } : {}),
          limit: input.limit,
        })
        .map(toMcpArchiveMessage),
    ),
  listUnansweredRoleMentions: (guildId, input) =>
    loggedCall(deps.logger, 'listUnansweredRoleMentions', () =>
      archiveRepo
        .listUnansweredRoleMentions(deps.scopes.forGuild(guildId), { ...input })
        .map(toMcpArchiveMessage),
    ),
  /**
   * Slice 2, Task 6: one message's live pin state and reaction counts over
   * REST. `undefined` when Discord no longer has it (the adapter's 404/403
   * fold); a throw stays a throw here — the tool layer fails soft, this port
   * only logs. A fault leaves one allowlisted-fields error line via
   * `loggedCallAsync` above, never message content (rule 4).
   */
  messageMeta: (guildId, channelId, messageId) =>
    loggedCallAsync(deps.logger, 'messageMeta', () =>
      discord.fetchMessageMeta(guildId, { channelId, messageId }),
    ),
  botUserId: () => client.user?.id ?? undefined,
});

/**
 * The owner's Discord user id behind ADR 0112's private-thread reads:
 * `BANANASAURS_OWNER_USER_ID` from the instance's redacted config — the only
 * config surface `HttpDeps` carries. Absent or empty reads as no owner, and
 * every private-thread check below answers false (fail closed).
 */
const ownerUserId = (deps: HttpDeps): string | undefined => {
  const raw = deps.instance.redactedConfig()['BANANASAURS_OWNER_USER_ID'];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
};

/**
 * ADR 0112's readability check, shared by the guild port's private-thread
 * listing and the threads port below: true only when a live check shows
 * **both the bot and the owner are members of the thread**. Membership is
 * never cached — two live `isThreadMember` calls per check — and any error,
 * or either id unknown, answers false. A non-member's 404 is routine, not a
 * fault, so failures leave no error line: refusing loudly here would log
 * every unshared thread as a failure.
 *
 * Slice 3 Task 5 extends it (plan Task 5, ADR 0116 §3): a thread the MCP
 * created — an `mcp_private_threads` row — reads without the owner, as long
 * as this guild's cache or REST still knows the thread id at all. The row is
 * the grant; the cache-or-REST probe only confirms the id still names a
 * thread of this guild rather than a deleted or foreign one.
 */
const privateThreadReadableFor = (
  deps: HttpDeps,
  client: Client,
  discord: DiscordPort,
): ((guildId: GuildId, threadId: string) => Promise<boolean>) => {
  return async (guildId, threadId) => {
    if (mcpRolePolicyRepo.isMcpPrivateThread(deps.scopes.forGuild(guildId), threadId)) {
      const cached = client.guilds.cache.get(guildId)?.channels.cache.get(threadId);
      if (cached !== undefined && cached.isThread()) return true;
      try {
        return (await discord.fetchThreadInfo(guildId, threadId)) !== undefined;
      } catch {
        return false;
      }
    }
    const botUserId = client.user?.id;
    const ownerId = ownerUserId(deps);
    if (botUserId === undefined || ownerId === undefined) return false;
    try {
      return (
        (await discord.isThreadMember(guildId, threadId, botUserId)) &&
        (await discord.isThreadMember(guildId, threadId, ownerId))
      );
    } catch {
      return false;
    }
  };
};

/**
 * The `McpGuildPort` behind the three Discord-cache tools, field by field
 * like `healthPortFor` above. Channels and roles are projected out of the
 * gateway cache (`ChannelManager`/`RoleManager` have no size limit, so the
 * cache is complete once the guild is READY); members are a paginated REST
 * fetch (`guild.members.list`, ruling M4-D10 — the 50-entry
 * `GuildMemberManager` cap in `packages/discord/src/client.ts` makes a cache
 * read silently wrong on any guild over 50 members).
 *
 * This is a READ from Discord, so it does not go through ADR 0014's effect
 * gateway: the gateway governs writes, and a read calling
 * `guild.members.list` directly is the same pattern `doctor` already uses
 * for `guild.members.me`. Do not route it through the gateway later "for
 * consistency" — the gateway would add kill-switch/breaker write semantics
 * to a read that must refuse, never queue.
 *
 * A guild missing from the cache (not READY, or left) throws with the shared
 * refusal message — the tool layer turns every port throw into that same
 * refusal, so absence reads as "not yours", never as an error and never as
 * an empty list. A fault leaves one allowlisted-fields error line via
 * `loggedCall` above, never a member name (rule 4).
 */
export const guildPortFor = (
  client: Client,
  deps: HttpDeps,
  discord: DiscordPort,
): McpGuildPort => {
  const requireGuild = (guildId: GuildId): Guild => {
    const guild = client.guilds.cache.get(guildId);
    if (guild === undefined) throw new Error(GUILD_REFUSAL_MESSAGE);
    return guild;
  };
  // ADR 0112's readability check, shared with the threads port: the guild
  // port lists a private thread only when it is shared with the MCP.
  const readable = privateThreadReadableFor(deps, client, discord);
  return {
    listChannels: (guildId) =>
      loggedCall(deps.logger, 'listChannels', () => {
        const guild = requireGuild(guildId);
        const enabled = new Set(
          archiveRepo
            .listChannels(deps.scopes.forGuild(guildId))
            .map((channel) => channel.channelId),
        );
        const names = new Map(
          [...guild.channels.cache.values()].map((channel) => [channel.id, channel.name] as const),
        );
        return (
          [...guild.channels.cache.values()]
            // Threads are transient conversations, not channels: an operator
            // asking "what channels exist" means the room list, and a thread
            // that archived away would otherwise flicker in and out of answers.
            .filter((channel) => !channel.isThread())
            .map((channel) => {
              const parentId =
                'parentId' in channel && typeof channel.parentId === 'string'
                  ? channel.parentId
                  : undefined;
              const topic =
                'topic' in channel && typeof channel.topic === 'string' ? channel.topic : undefined;
              return {
                id: channel.id,
                name: channel.name,
                type: ChannelType[channel.type] ?? `unknown(${String(channel.type)})`,
                parentId,
                parentName: parentId === undefined ? undefined : names.get(parentId),
                topic,
                archiveEnabled: enabled.has(channel.id),
              };
            })
            .sort((a, b) => {
              const positionOf = (id: string): number => {
                const channel = guild.channels.cache.get(id);
                if (channel === undefined) return 0;
                return 'position' in channel && typeof channel.position === 'number'
                  ? channel.position
                  : 0;
              };
              return positionOf(a.id) - positionOf(b.id) || (a.id < b.id ? -1 : 1);
            })
        );
      }),
    listThreads: (guildId, channelId, includeArchived) => {
      const guild = requireGuild(guildId);
      // Private threads under the channel that are shared with the MCP —
      // bot AND owner both members, checked live per thread. Unshared ones
      // never reach the tool, which renders but never filters. Archived ones
      // list only when the caller asked for archived threads, the way
      // archived public threads do.
      //
      // Limits, stated rather than implied. This walks the gateway cache
      // only: an archived private thread the sweeper has evicted is not
      // listed even with `includeArchived`, although `read_thread` still
      // reaches it by id through the REST fallback. Each cached private
      // thread costs two sequential REST calls (bot, then owner), and any
      // failure — rate limit, unknown member, owner unconfigured — unlists
      // the thread rather than listing it unreadable (fail closed).
      const sharedPrivate = async (
        includeArchived: boolean,
      ): Promise<readonly McpGuildThread[]> => {
        const found: McpGuildThread[] = [];
        for (const channel of guild.channels.cache.values()) {
          if (!channel.isThread() || channel.parentId !== channelId) continue;
          if (channel.type !== ChannelType.PrivateThread) continue;
          const archived = channel.archived ?? false;
          if (archived && !includeArchived) continue;
          if (await readable(guildId, channel.id)) {
            found.push({
              id: channel.id,
              name: channel.name,
              parentId: channelId,
              archived,
              isPrivate: true,
            });
          }
        }
        return found;
      };
      if (includeArchived) {
        // Review S4: the cache cannot answer this — the default sweeper
        // evicts archived threads (node_modules discord.js Options.js), so
        // an includeArchived read from cache silently dropped them. The
        // REST listing pages active + archived and never returns private
        // threads (review B4 lives in the port's filter too).
        return loggedCall(deps.logger, 'listThreads', () =>
          discord.listPublicThreads(guildId, channelId).then(async (threads) => [
            ...threads.map((thread) => ({
              id: thread.id,
              name: thread.name,
              parentId: channelId,
              archived: thread.archived,
              isPrivate: false as const,
            })),
            ...(await sharedPrivate(true)),
          ]),
        );
      }
      // Review B4: exclude private threads explicitly — the clause this
      // replaces, `channel.isThreadOnly()`, is `'availableTags' in this` and
      // is never true on a thread (node_modules discord.js
      // BaseChannel.js:154), so private threads leaked to any caller.
      const active = [...guild.channels.cache.values()].flatMap((channel) => {
        if (
          !channel.isThread() ||
          channel.parentId !== channelId ||
          channel.type === ChannelType.PrivateThread
        )
          return [];
        return [
          {
            id: channel.id,
            name: channel.name,
            parentId: channelId,
            archived: channel.archived ?? false,
            isPrivate: false as const,
          },
        ];
      });
      return (async (): Promise<readonly McpGuildThread[]> => [
        ...active.filter((thread) => !thread.archived),
        ...(await sharedPrivate(false)),
      ])();
    },
    listRoles: (guildId) =>
      loggedCall(deps.logger, 'listRoles', () => {
        const guild = requireGuild(guildId);
        const scope = deps.scopes.forGuild(guildId);
        return (
          [...guild.roles.cache.values()]
            // `@everyone` is the guild itself wearing a role id: every member
            // holds it, so listing it answers nothing and a managed flag on it
            // is meaningless. The port drops it; the tool says so in its header.
            .filter((role) => role.id !== guild.id)
            .map((role) => ({
              id: role.id,
              name: role.name,
              position: role.position,
              color: role.color,
              managedByBananasaurs: roleRepo.isAllowlisted(scope, role.id),
            }))
            .sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1))
        );
      }),
    listMembers: async (guildId, input) =>
      loggedCallAsync(deps.logger, 'listMembers', async () => {
        const guild = requireGuild(guildId);
        const page = await guild.members.list({
          limit: input.limit,
          ...(input.after !== undefined ? { after: input.after } : {}),
          // Not a cache read (ruling M4-D10): paginated REST, and `false` so
          // the listing does not churn the 50-entry member cache either.
          cache: false,
        });
        const members = [...page.values()].map((member) => ({
          id: member.id,
          username: member.user.username,
          displayName: member.displayName,
          // `GuildMemberRoleManager.cache` unconditionally inserts the
          // guild-id (@everyone) role before walking `_roles`
          // (`cache.set(this.guild.id, this.guild.roles.everyone)` in
          // `node_modules/discord.js/src/managers/GuildMemberRoleManager.js`),
          // so the raw key set always contains the guild id — which
          // `list_roles` deliberately hides. Dropped here to match that rule,
          // so an operator never sees a role id on a member that appears
          // nowhere in `list_roles` and has no name anywhere in the toolset.
          roleIds: [...member.roles.cache.keys()].filter((id) => id !== guildId).sort(),
          // Projected field by field: no presence, no activity, no status —
          // there is nowhere for such a field to hide because each field is
          // named here rather than spread from the discord.js object.
          joinedAt: member.joinedAt?.getTime(),
        }));
        const last = members[members.length - 1];
        return { members, nextCursor: last === undefined ? undefined : last.id };
      }),
    // The gateway scalar, not the cache size (ruling M4-D10): the 50-entry
    // `GuildMemberManager` cap makes `members.cache.size` silently wrong on
    // any guild over 50 members, while `memberCount` is what the gateway
    // keeps accurate. The overview card reads this; nothing here counts a
    // listing. A guild missing from the cache throws the shared refusal, the
    // same as every other method here.
    memberCount: (guildId) =>
      loggedCall(deps.logger, 'memberCount', () => requireGuild(guildId).memberCount),
  };
};

/**
 * The `McpRecordsPort` behind the four records tools and the overview
 * resource, field by field like `healthPortFor` above. Each method turns the
 * already-resolved `GuildId` into a `GuildScope` per call and reads through
 * the moderation and audit repositories — nothing here writes, and M4 is
 * read-only. Reader calls only: the repositories' state-changing functions
 * are never referenced here, let alone called (ruling M4-D14). A fault
 * leaves one allowlisted-fields error line via `loggedCall` above, never a
 * snippet, a reason or a payload (rule 4).
 *
 * It takes the principal for one reason: `tailAudit` needs the caller's
 * token id to exclude the caller's *own* trail reads and no one else's
 * (ADR 0050). That is the same division of labour the write side uses — the
 * tool layer names the action, the daemon supplies the actor.
 */
const recordsPortFor = (
  principal: McpPrincipal & { readonly tokenId: string },
  deps: HttpDeps,
): McpRecordsPort => ({
  listRecentCases: (guildId, input) =>
    loggedCall(deps.logger, 'listRecentCases', () =>
      automodAdminRepo
        .listRecentCases(deps.scopes.forGuild(guildId), { limit: input.limit })
        .map((row) => ({
          caseId: row.caseId,
          memberId: row.memberId,
          openedAt: row.openedAt,
          violationCount: row.violationCount,
          escalationTier: row.escalationTier,
          status: row.status,
        })),
    ),
  findCase: (guildId, caseId) =>
    loggedCall(deps.logger, 'findCase', () => {
      const found = automodAdminRepo.findCase(deps.scopes.forGuild(guildId), caseId);
      if (found === undefined) return undefined;
      return {
        caseId: found.caseId,
        memberId: found.memberId,
        openedAt: found.openedAt,
        violationCount: found.violationCount,
        escalationTier: found.escalationTier,
        status: found.status,
      };
    }),
  listCaseEvents: (guildId, caseId) =>
    loggedCall(deps.logger, 'listCaseEvents', () =>
      modCaseRepo.listCaseEvents(deps.scopes.forGuild(guildId), caseId).map((event) => ({
        eventId: event.eventId,
        ruleId: event.ruleId,
        memberId: event.memberId,
        at: event.at,
        matchedCategory: event.matchedCategory,
        matchedSnippet: event.matchedSnippet,
        actionTaken: event.actionTaken,
        escalationAction: event.escalationAction,
        refusalReason: event.refusalReason,
        actorId: event.actorId,
      })),
    ),
  tailAudit: (guildId, input) =>
    loggedCall(deps.logger, 'tailAudit', () =>
      effectRepo
        .tailAudit(deps.scopes.forGuild(guildId), {
          limit: input.limit,
          ...(input.sinceMs !== undefined ? { sinceMs: input.sinceMs } : {}),
          // ADR 0050: `list_audit_events` excludes *the caller's own* reads
          // from what it returns. The same split as the write side — the
          // tool layer names the action, this port supplies the actor, so
          // `packages/mcp` never learns who is reading (ruling M4-D14) and
          // another operator's trail reads stay visible.
          ...(input.excludeActions !== undefined
            ? {
                excludeOwnActions: { actions: input.excludeActions, actorId: principal.tokenId },
              }
            : {}),
        })
        .map((row) => ({
          auditId: row.auditId,
          at: row.at,
          actorType: row.actorType,
          actorId: row.actorId,
          actorUnixUserClaimed: row.actorUnixUserClaimed,
          via: row.via,
          action: row.action,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          batchId: row.batchId,
          before: row.before,
          after: row.after,
          // The columns are SQLite integers; the port speaks booleans, so the
          // conversion happens once here rather than in every renderer.
          dryRun: row.dryRun === 1,
          inferred: row.inferred === 1,
        })),
    ),
  // Reading `mod_rules`, not touching it: the counts the card renders come
  // from this read, and no writer is referenced here (ruling M4-D14).
  listRules: (guildId) =>
    loggedCall(deps.logger, 'listRules', () =>
      automodAdminRepo.listRules(deps.scopes.forGuild(guildId)).map((rule) => ({
        ruleId: rule.ruleId,
        name: rule.name,
        mode: rule.mode,
        enabled: rule.enabled,
      })),
    ),
  listPanels: (guildId) =>
    loggedCall(deps.logger, 'listPanels', () =>
      panelRepo.listPanels(deps.scopes.forGuild(guildId)).map((panel) => ({
        panelId: panel.panelId,
      })),
    ),
});

/**
 * Projects one ops job row to the seven fields `packages/mcp` reads, field
 * by field like every other port here. `dedupeKey` stops at this boundary:
 * it names the dedupe contract, which the operator never needs, and the
 * point of naming each field is that a column added to `jobs` later cannot
 * arrive in the MCP package for free.
 */
const projectJob = (row: OpsJobRow): McpJob => ({
  jobId: row.jobId,
  kind: row.kind,
  state: row.state,
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  runAfter: row.runAfter,
  lastError: row.lastError,
});

/**
 * The `McpJobsPort` behind `list_jobs` and `get_job`, field by field like
 * `healthPortFor` above. Each method turns the already-resolved `GuildId`
 * into a `GuildScope` per call and reads through the real ops ports —
 * nothing here writes, and M4 is read-only. Guild isolation comes from the
 * scope: a job enqueued in guild B is invisible to a `list_jobs` call for
 * guild A. A fault leaves one allowlisted-fields error line via `loggedCall`
 * above, never the last error text (rule 4).
 */
const jobsPortFor = (deps: HttpDeps): McpJobsPort => ({
  listJobs: (guildId, query) =>
    loggedCall(deps.logger, 'listJobs', () =>
      deps.portsFor(deps.scopes.forGuild(guildId)).listJobs(query).map(projectJob),
    ),
  findJob: (guildId, jobId) =>
    loggedCall(deps.logger, 'findJob', () => {
      const row = deps.portsFor(deps.scopes.forGuild(guildId)).findJob(jobId);
      return row === undefined ? undefined : projectJob(row);
    }),
});

/**
 * The `McpMembersPort` behind `get_member` and `search_members`, field by
 * field like `healthPortFor` above. `listAllMembers` pages the REST listing
 * (`guild.members.list`, ruling M4-D10 — the 50-entry
 * `GuildMemberManager` cap makes a cache read silently wrong) at Discord's
 * own per-page maximum of 1000 with `cache: false`, following the `after`
 * cursor until a short page. When the collected count reaches
 * `MEMBER_LISTING_CAP` on a full last page, one more `limit: 1` probe past
 * the last id decides `truncated`: a guild with exactly 5,000 members
 * reports `truncated: false`. Each member is projected field by field — the guild-id
 * (@everyone) role dropped from `roleIds` like `list_members`, no presence,
 * no status, no activity — never spread from the discord.js object.
 * `lastMessageAt` reads the archive's newest message time per author, so the
 * tools can answer "hasn't posted in N days" in one call. A guild missing
 * from the cache throws the shared refusal, the same as every guild method.
 * A fault leaves one allowlisted-fields error line via the logged calls
 * above, never a member name (rule 4).
 */
const membersPortFor = (deps: HttpDeps, client: Client): McpMembersPort => ({
  listAllMembers: (guildId) =>
    loggedCallAsync(deps.logger, 'listAllMembers', async () => {
      const guild = client.guilds.cache.get(guildId);
      if (guild === undefined) throw new Error(GUILD_REFUSAL_MESSAGE);
      const collected: McpMemberProfile[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await guild.members.list({
          limit: 1000,
          ...(after !== undefined ? { after } : {}),
          // Not a cache read (ruling M4-D10): paginated REST, and `false` so
          // the listing does not churn the 50-entry member cache either.
          cache: false,
        });
        for (const member of page.values()) {
          collected.push({
            id: member.id,
            username: member.user.username,
            displayName: member.displayName,
            nickname: member.nickname ?? undefined,
            // Same @everyone drop as `listMembers` above: the manager inserts
            // the guild id into every member's role cache, while `list_roles`
            // deliberately hides it.
            roleIds: [...member.roles.cache.keys()].filter((id) => id !== guildId).sort(),
            // Projected field by field: no presence, no activity, no status.
            joinedAt: member.joinedAt?.getTime(),
          });
        }
        if (collected.length >= MEMBER_LISTING_CAP) {
          const members = collected.slice(0, MEMBER_LISTING_CAP);
          // The last page was full, so exactly CAP members is ambiguous with
          // more beyond: probe one row past the last id and claim truncation
          // only when it exists.
          const lastId = [...page.keys()].pop();
          const probe =
            lastId === undefined
              ? undefined
              : await guild.members.list({ limit: 1, after: lastId, cache: false });
          return { members, truncated: probe !== undefined && probe.size > 0 };
        }
        if (page.size < 1000) break;
        const last = [...page.keys()].pop();
        if (last === undefined) break;
        after = last;
      }
      return { members: collected, truncated: false };
    }),
  lastMessageAt: (guildId, authorIds) =>
    loggedCall(deps.logger, 'lastMessageAt', () =>
      archiveRepo.lastMessageAtByAuthor(deps.scopes.forGuild(guildId), [...authorIds]),
    ),
  now: deps.now,
});

/**
 * The club time zone behind `get_server_context`: `BANANASAURS_TIME_ZONE`
 * from the instance's redacted config — the only config surface `HttpDeps`
 * carries (there is no `deps.config` on this wiring). A missing or empty
 * value throws, which the tool layer answers as its shared refusal.
 */
const contextTimeZone = (deps: HttpDeps): string => {
  const raw = deps.instance.redactedConfig()['BANANASAURS_TIME_ZONE'];
  if (typeof raw !== 'string' || raw === '') throw new Error('BANANASAURS_TIME_ZONE unavailable');
  return raw;
};

/**
 * The `McpContextPort` behind `get_server_context` (slice 2, Task 1), field
 * by field like `healthPortFor` above. The card is the same owner-written
 * text the assistant's `server_info` sees (`assistantRepo.getServerCard`,
 * per-guild like every other port here). The skills are the guild's allowed
 * skills computed the way the assistant service computes them — the stored
 * grants through `effectiveSkillScope`/`skillScopeAllows` for the owner, who
 * is this tool's caller — projected to `{ id, name, description }`.
 *
 * `timeZone` is a getter, not a value: the daemon builds one port per
 * request before it knows which tool the request will call, so an eager read
 * would fail every `tools/list` when the key is absent; read at call time it
 * fails inside the tool layer's try/catch as the shared refusal instead. A
 * fault leaves one allowlisted-fields error line via the logged calls above,
 * never the card text (rule 4).
 */
const contextPortFor = (deps: HttpDeps): McpContextPort => ({
  serverCard: (guildId) =>
    loggedCall(deps.logger, 'serverCard', () =>
      assistantRepo.getServerCard(deps.scopes.forGuild(guildId)),
    ),
  get timeZone(): string {
    return contextTimeZone(deps);
  },
  now: deps.now,
  skills: (guildId) =>
    loggedCall(deps.logger, 'contextSkills', () => {
      const scope = deps.scopes.forGuild(guildId);
      const grants = new Map(
        assistantRepo.listSkillGrants(scope).map((grant) => [grant.skillId, grant] as const),
      );
      return CLUB_ASSISTANT_SKILLS.filter((skill) =>
        skillScopeAllows(effectiveSkillScope(skill, grants.get(skill.id)), {
          owner: true,
          roleIds: [],
        }),
      ).map((skill) => ({ id: skill.id, name: skill.name, description: skill.description }));
    }),
});

/**
 * The `McpResourcesPort` behind `search_resources` and `open_resource`
 * (slice 2, Task 2), field by field like `healthPortFor` above. Each method
 * turns the already-resolved `GuildId` into a `GuildScope` per call and reads
 * through the assistant resource catalogue and the resource cache — nothing
 * here writes, and M4 is read-only.
 *
 * Enabled resources only: the catalogue rows are filtered to `enabled`
 * exactly the way the assistant service filters them (`service.ts` keeps
 * `listResources(scope).filter((r) => r.enabled)`), and the chunk search is
 * scoped to those ids, so a disabled resource's chunks are invisible even to
 * an exact query. Guild isolation comes from the scope: guild B's cache rows
 * are invisible to a call for guild A.
 *
 * Cache only, by construction: the port's three members are reads
 * (`listResources`, `searchChunks`, `listDocuments`/`outline`/`getChunk`).
 * There is no refresh member — `enqueueAssistantRefresh` and the fetcher are
 * never referenced here, let alone called — so an unfetched resource answers
 * with the dashboard pointer and no fetch is ever enqueued. A fault leaves
 * one allowlisted-fields error line via `loggedCall` above, never a title, a
 * snippet or chunk text (rule 4).
 */
const resourcesPortFor = (deps: HttpDeps): McpResourcesPort => {
  // One `search_resources` call reads `listResources` then `searchChunks`:
  // the enabled catalogue is memoized per port instance so the search does
  // not read the table twice. The instance lives for one request (the route
  // builds a stateless server per request) and every port here is read-only,
  // so the snapshot cannot go stale mid-use. The port shape is unchanged —
  // the reuse stays inside this implementation.
  const enabledCache = new Map<GuildId, readonly McpResourceSummary[]>();
  const enabledResources = (guildId: GuildId): readonly McpResourceSummary[] => {
    const cached = enabledCache.get(guildId);
    if (cached !== undefined) return cached;
    const rows = assistantRepo
      .listResources(deps.scopes.forGuild(guildId))
      .filter((resource) => resource.enabled)
      .map((resource): McpResourceSummary => ({
        id: resource.id,
        title: resource.title,
        kind: resource.kind,
        url: resource.url,
      }));
    enabledCache.set(guildId, rows);
    return rows;
  };
  return {
    listResources: (guildId) =>
      loggedCall(deps.logger, 'listResources', () => enabledResources(guildId)),
    searchChunks: (guildId, input) =>
      loggedCall(deps.logger, 'resourceSearchChunks', () =>
        resourceCacheRepo
          .searchChunks(deps.scopes.forGuild(guildId), {
            query: input.query,
            resourceIds: enabledResources(guildId).map((resource) => resource.id),
            limit: input.limit,
          })
          .map((hit) => ({
            chunkId: hit.chunkId,
            docId: hit.docId,
            resourceId: hit.resourceId,
            headingPath: hit.headingPath,
            text: hit.snippet,
          })),
      ),
    resourceChunks: (guildId, resourceId, limit) =>
      loggedCall(deps.logger, 'resourceChunks', () => {
        const scope = deps.scopes.forGuild(guildId);
        const docs = resourceCacheRepo.listDocuments(scope, resourceId);
        const first = docs[0];
        if (first === undefined) return [];
        // The first document's chunks in outline order — the same
        // outline-then-getChunk walk the assistant's `cacheResourceChunks`
        // makes, projected field by field.
        return resourceCacheRepo
          .outline(scope, first.docId)
          .slice(0, limit)
          .flatMap((row) => {
            const found = resourceCacheRepo.getChunk(scope, row.chunkId);
            return found === undefined
              ? []
              : [
                  {
                    chunkId: found.chunkId,
                    docId: found.docId,
                    resourceId: found.resourceId,
                    headingPath: found.headingPath,
                    text: found.text,
                  },
                ];
          });
      }),
  };
};

/**
 * The `McpThreadsPort` behind `read_thread` (slice 2, Task 4; ADR 0112),
 * field by field like `healthPortFor` above. A public thread reads the
 * archive (`archiveThread` is the same `listChannelHistory` call with the
 * thread id, which the repository answers from the thread's rows); a
 * private thread reads live over REST (`liveThreadMessages` projects
 * `fetchChannelMessages`) and nothing here writes — the port has no write
 * member, so a private read cannot leave an `archive_messages` row by
 * construction, not by discipline. A fault leaves one allowlisted-fields
 * error line via the logged calls below, never message content (rule 4).
 */
const threadsPortFor = (deps: HttpDeps, client: Client, discord: DiscordPort): McpThreadsPort => {
  const readable = privateThreadReadableFor(deps, client, discord);
  return {
    archiveThread: (guildId, threadId, beforeMessageId, limit) =>
      loggedCall(deps.logger, 'archiveThread', () =>
        archiveRepo
          .listChannelHistory(deps.scopes.forGuild(guildId), {
            channelId: threadId,
            ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
            limit,
          })
          .map(toMcpArchiveMessage),
      ),
    threadInfo: (guildId, threadId) =>
      loggedCallAsync(deps.logger, 'threadInfo', async () => {
        const cached = client.guilds.cache.get(guildId)?.channels.cache.get(threadId);
        if (cached !== undefined) {
          // In the cache under this guild: it is what it is — a non-thread
          // id answers not-a-thread without a REST call.
          if (!cached.isThread() || cached.parentId === null) return undefined;
          return {
            id: cached.id,
            name: cached.name,
            parentId: cached.parentId,
            isPrivate: cached.type === ChannelType.PrivateThread,
          };
        }
        // Cache miss: the default sweeper evicts archived threads after 4
        // hours (`Options.DefaultSweeperSettings`), so an older archived
        // thread is absent here even though the archive holds its messages.
        // One REST read resolves it; the membership check below still runs,
        // unchanged, after either path.
        const fetched = await discord.fetchThreadInfo(guildId, threadId);
        if (fetched === undefined) return undefined;
        return {
          id: fetched.id,
          name: fetched.name,
          parentId: fetched.parentId,
          isPrivate: fetched.isPrivate,
        };
      }),
    privateThreadReadable: (guildId, threadId) => readable(guildId, threadId),
    liveThreadMessages: (guildId, threadId, beforeMessageId, limit) =>
      loggedCallAsync(deps.logger, 'liveThreadMessages', async () => {
        const messages = await discord.fetchChannelMessages(guildId, threadId, {
          ...(beforeMessageId !== undefined ? { before: beforeMessageId } : {}),
          limit,
        });
        // `fetchChannelMessages` reports oldest first; `read_thread` promises
        // newest first on both paths, so the live page is reversed here —
        // paging with `beforeMessageId` takes the last shown id backwards.
        return [...(messages ?? [])].reverse().map((message) => ({
          messageId: message.messageId,
          channelId: threadId,
          threadId,
          authorId: message.authorId,
          content: message.content === '' ? null : message.content,
          createdAt: message.at,
          contentPurgedAt: undefined,
          replyToMessageId: undefined,
        }));
      }),
  };
};

/**
 * The tool's embed vocabulary to Discord's: every field passes through, and
 * the footer string becomes Discord's `{ text }` object. The tool layer
 * already rejected unknown fields (strict Zod), so nothing here is dropped.
 */
const toDiscordEmbed = (embed: SendEmbed): unknown => ({
  ...(embed.title !== undefined ? { title: embed.title } : {}),
  ...(embed.description !== undefined ? { description: embed.description } : {}),
  ...(embed.fields !== undefined
    ? {
        fields: embed.fields.map((field) => ({
          name: field.name,
          value: field.value,
          ...(field.inline !== undefined ? { inline: field.inline } : {}),
        })),
      }
    : {}),
  ...(embed.color !== undefined ? { color: embed.color } : {}),
  ...(embed.footer !== undefined ? { footer: { text: embed.footer } } : {}),
});

/**
 * The `McpSendPort` behind `send_message` (slice M5, re-routed in v2 slice 3
 * onto `runMcpAction`), field by field like `healthPortFor` above. It
 * resolves the target against send scope and the bot's live permissions,
 * resolves explicit pings under the role policy, builds the `McpActionDeps`
 * over the storage repos, and runs the one pipeline — kind `message.send`,
 * cap group `message`, with the duplicate-content guard. The pipeline's
 * `McpActionOutcome` is mapped onto the tool's `McpSendOutcome` explicitly:
 * `guild-unknown` throws the shared refusal (the tool layer turns every port
 * throw into it, and a missing guild row reads as "not yours"), and the
 * `failed` code stays in the daemon's logs rather than reaching the model. A
 * fault leaves one allowlisted-fields error line via `loggedCallAsync` above
 * — never message content (rule 4): the channel id and the outcome name what
 * happened, and the content lives only in the ledger's hash and in Discord.
 */
const sendPortFor = (
  principal: McpPrincipal & { readonly clientId: string; readonly tokenId: string },
  deps: HttpDeps,
  discord: DiscordPort,
  /**
   * The same live client the guild tools read (C2 send-time defence in
   * depth): target resolution answers guild membership from
   * `client.guilds.cache`, so a stale allowlist row for a channel outside
   * the guild is refused before any Discord call.
   */
  client: Client,
): McpSendPort => ({
  send: (guildId, input) =>
    loggedCallAsync(deps.logger, 'sendMessage', async () => {
      const scope = deps.scopes.forGuild(guildId);
      // The target becomes the thread when one is named, with the
      // post-in-thread permission to match.
      const targetId = input.threadId ?? input.channelId;
      const target = await resolveSendTarget(
        client,
        scope,
        guildId,
        targetId,
        input.threadId !== undefined ? 'post-in-thread' : 'post',
      );
      if (!target.ok) {
        // The target layer's reasons map onto this package's
        // `McpSendRefusal` — including `channel-not-in-guild`, which keeps
        // its own text (N3) rather than borrowing the allowlist text, so the
        // model is not pointed at a command that would refuse the same id.
        // Never the content, never a throw.
        switch (target.reason) {
          case 'not-in-guild':
            return { status: 'refused', reason: 'channel-not-in-guild' };
          case 'not-in-send-scope':
            return { status: 'refused', reason: 'channel-not-allowlisted' };
          case 'private-thread-not-allowed':
            return { status: 'refused', reason: 'private-thread' };
          case 'bot-lacks-permission':
            return {
              status: 'refused',
              reason: 'bot-lacks-permission',
              ...(target.missing !== undefined ? { detail: target.missing } : {}),
            };
        }
      }
      const pings = await resolvePings(client, scope, guildId, {
        roles: input.pingRoles,
        users: input.pingUsers,
      });
      if (!pings.ok) return { status: 'refused', reason: pings.reason, detail: pings.ref };
      // Plain-text sends keep `contentHashFor(channelId, content)` so a
      // retry that straddles the migration-0092 deploy replays rather than
      // posting twice (ADR 0116 §2). Any richer shape hashes a canonical
      // JSON of the arguments. Neither hash covers the dry-run flag: a dry
      // run claims the key, so a live retry under it replays.
      const plainText =
        input.embeds === undefined &&
        input.pingRoles.length === 0 &&
        input.pingUsers.length === 0 &&
        input.replyTo === undefined;
      const argsHash =
        plainText && input.content !== undefined
          ? contentHashFor(target.channelId, input.content)
          : argsHashFor('message.send', {
              channel: target.channelId,
              content: input.content,
              embeds: input.embeds,
              replyTo: input.replyTo,
              pingReplyAuthor: input.pingReplyAuthor,
              pingRoles: input.pingRoles,
              pingUsers: input.pingUsers,
            });
      const outcome = await runMcpAction(
        mcpActionDepsFor(
          deps,
          guildId,
          principal,
          target.derivedGrant ? { grantedByChannelId: target.grantId } : {},
        ),
        {
          kind: 'message.send',
          capGroup: 'message',
          idempotencyKey: input.idempotencyKey,
          tokenId: principal.tokenId,
          argsHash,
          targetChannelId: target.channelId,
          dryRun: input.dryRun,
          duplicateContentGuard: true,
        },
        true,
        async () => {
          const ref = await discord.sendMessage(guildId, target.channelId, {
            ...(input.content !== undefined ? { content: input.content } : {}),
            ...(input.embeds !== undefined ? { embeds: input.embeds.map(toDiscordEmbed) } : {}),
            ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
            // ADR 0117 §5: the tool layer already defaulted this to false,
            // so a reply never pings its author unless asked.
            pingReplyAuthor: input.pingReplyAuthor,
            // Always `{ parse: [] }` plus only policy-approved roles/users
            // (ADR 0117 §1): a mention typed into the content that is not in
            // these lists renders but notifies nobody. Never `'everyone'`.
            allowedMentions: { parse: [], roles: pings.roleIds, users: pings.userIds },
          });
          return { resultMessageId: ref.messageId };
        },
      );
      switch (outcome.status) {
        case 'done': {
          if (outcome.result.resultMessageId === undefined) return { status: 'failed' };
          return {
            status: 'sent',
            messageId: outcome.result.resultMessageId,
            actionId: outcome.actionId,
          };
        }
        case 'dry-run':
          return { status: 'dry-run', actionId: outcome.actionId };
        case 'replayed':
          return {
            status: 'replayed',
            messageId: outcome.resultMessageId,
            actionId: outcome.actionId,
          };
        case 'refused':
          switch (outcome.reason) {
            case 'killswitch':
              return { status: 'refused', reason: 'killswitch' };
            case 'breaker-open':
              return { status: 'refused', reason: 'breaker-open' };
            case 'rate-cap':
              return {
                status: 'refused',
                reason: 'rate-cap',
                ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
              };
            case 'key-reused-with-other-args':
              return { status: 'refused', reason: 'duplicate-key-different-content' };
            case 'duplicate-content-recently':
              return { status: 'refused', reason: 'duplicate-content-recently' };
            case 'guild-unknown':
              throw new Error(GUILD_REFUSAL_MESSAGE);
            case 'target':
              // Unreachable: every target refusal above returned before the
              // pipeline ran, so `targetCheck` is always `true` here.
              throw new Error(GUILD_REFUSAL_MESSAGE);
          }
          break;
        case 'failed':
          return { status: 'failed' };
      }
    }),
});

/**
 * Name resolution for the thread/forum tools (slice 3, Task 5): the tools
 * take a channel id *or* name, but `resolveChannel` and the scope predicate
 * only speak ids. A snowflake passes through unchanged (existence is the
 * target layer's business, with its fetch fallback); anything else matches
 * case-insensitively against the live guild cache after one leading `#` is
 * stripped, the same normaliser `resolveChannelRef` owns in `packages/mcp`.
 * Zero matches is `channel-not-in-guild` — the name is not a channel of this
 * guild, so allowlisting could not help either — and several matches is
 * `ambiguous-channel` with the `name (id)` list the tool renders.
 */
const resolveThreadChannelRef = (
  client: Client,
  guildId: GuildId,
  ref: string,
):
  | { readonly ok: true; readonly channelId: string }
  | {
      readonly ok: false;
      readonly reason: 'ambiguous-channel' | 'channel-not-in-guild';
      readonly detail?: string | undefined;
    } => {
  const trimmed = ref.trim();
  try {
    parseSnowflakeId(trimmed);
    return { ok: true, channelId: trimmed };
  } catch {
    const needle = (
      trimmed.startsWith('#') ? trimmed.slice('#'.length).trim() : trimmed
    ).toLowerCase();
    const guild = client.guilds.cache.get(guildId);
    const matches =
      guild === undefined
        ? []
        : [...guild.channels.cache.values()]
            .filter((channel) => channel.name.toLowerCase() === needle)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, 10);
    if (matches.length === 1 && matches[0] !== undefined) {
      return { ok: true, channelId: matches[0].id };
    }
    if (matches.length === 0) return { ok: false, reason: 'channel-not-in-guild' };
    return {
      ok: false,
      reason: 'ambiguous-channel',
      detail: matches.map((channel) => `${channel.name} (${channel.id})`).join(', '),
    };
  }
};

interface ForumTag {
  readonly id: string;
  readonly name: string;
}

/**
 * A forum's available tags, live from the discord.js cache with the same
 * fetch fallback `resolveChannel` uses. `undefined` when the channel object
 * cannot be produced at all — the caller then matches against an empty list,
 * so any tag refuses naming what is (not) available rather than throwing.
 */
const readForumTags = async (
  client: Client,
  guildId: GuildId,
  forumId: string,
): Promise<readonly ForumTag[] | undefined> => {
  const pick = (channel: unknown): readonly ForumTag[] | undefined => {
    if (typeof channel !== 'object' || channel === null) return undefined;
    const tags = (channel as { availableTags?: unknown }).availableTags;
    if (!Array.isArray(tags)) return undefined;
    return tags.flatMap((tag) => {
      if (typeof tag !== 'object' || tag === null) return [];
      const { id, name } = tag as { id?: unknown; name?: unknown };
      return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : [];
    });
  };
  const cached = client.guilds.cache.get(guildId)?.channels.cache.get(forumId);
  const fromCache = cached === undefined ? undefined : pick(cached);
  if (fromCache !== undefined) return fromCache;
  const fetched = await client.channels.fetch(forumId).catch(() => null);
  return fetched === null || fetched.isDMBased() ? undefined : pick(fetched);
};

/**
 * Matches the caller's tag refs — names (case-insensitive) or ids — against
 * the forum's live tags. Unknown refs come back for the refusal, which names
 * them alongside the available list.
 */
const matchForumTags = (
  available: readonly ForumTag[],
  refs: readonly string[],
):
  | { readonly ok: true; readonly ids: string[] }
  | { readonly ok: false; readonly unknown: string[] } => {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const needle = ref.trim().toLowerCase();
    const found = available.find(
      (tag) => tag.id === ref.trim() || tag.name.toLowerCase() === needle,
    );
    if (found === undefined) unknown.push(ref);
    else if (!ids.includes(found.id)) ids.push(found.id);
  }
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, ids };
};

/** Discord's 10007 Unknown Member / 10013 Unknown User, or a bare 404. */
const isUnknownThreadMember = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const { code, status } = err as { code?: unknown; status?: unknown };
  return code === 10007 || code === 10013 || status === 404;
};

/**
 * Whether the user is in this guild, checked live like `resolvePings` does:
 * the member cache caps at fifty, so a hit proves membership but a miss
 * proves nothing — one REST read decides. Only Discord's own "no such
 * member" answer means not a member; a transport fault throws, so an outage
 * is never reported as a refusal.
 */
const liveGuildMember = async (
  client: Client,
  guildId: GuildId,
  userId: string,
): Promise<boolean> => {
  const guild = client.guilds.cache.get(guildId);
  if (guild === undefined) return false;
  if (guild.members.cache.has(userId)) return true;
  try {
    await guild.members.fetch(userId);
    return true;
  } catch (err) {
    if (isUnknownThreadMember(err)) return false;
    throw err;
  }
};

/**
 * Whether the bot owns the thread, in which case member and state edits need
 * only `post-in-thread` rather than `ManageThreads` (Task 5 ruling: "created
 * by the bot via MCP"). Only the ledger says so — the `mcp_private_threads`
 * row or a completed `thread.create`/`forum.post`. A thread the bot opened
 * for another module (a task post, a panel) is not the MCP's to manage, so a
 * cached `ownerId` is deliberately not consulted.
 */
const botOwnsThread = (scope: GuildScope, threadId: string): boolean =>
  mcpRolePolicyRepo.isMcpPrivateThread(scope, threadId) ||
  mcpActionsRepo.isMcpCreatedThread(scope, threadId);

/**
 * The guild channel object, cache first with one fetch on miss — the same
 * fallback `resolveChannel` uses, so a thread or forum it resolved by fetch
 * is never treated as unknown here. `undefined` for another guild's channel.
 */
const liveGuildChannel = async (
  client: Client,
  guildId: GuildId,
  channelId: string,
): Promise<GuildBasedChannel | undefined> => {
  const cached = client.channels.cache.get(channelId);
  const channel = cached ?? (await client.channels.fetch(channelId).catch(() => null));
  if (channel === null || channel === undefined || channel.isDMBased()) return undefined;
  return channel.guildId === guildId ? channel : undefined;
};

/**
 * The thread's live archive/lock state, for the `thread.state` undo record
 * (ADR 0116 §5: an archive or lock records the previous state). `undefined`
 * only when Discord cannot produce the thread at all — the change then
 * records no undo, and Task 7's `undo_action` refuses it rather than guessing.
 */
const liveThreadState = async (
  client: Client,
  guildId: GuildId,
  threadId: string,
): Promise<
  { readonly archived?: boolean | undefined; readonly locked?: boolean | undefined } | undefined
> => {
  const channel = await liveGuildChannel(client, guildId, threadId);
  if (channel === undefined || !channel.isThread()) return undefined;
  const archived = channel.archived ?? undefined;
  const locked = channel.locked ?? undefined;
  return {
    ...(archived === undefined ? {} : { archived }),
    ...(locked === undefined ? {} : { locked }),
  };
};

interface ThreadActionResult {
  readonly resultThreadId?: string | undefined;
  readonly resultMessageId?: string | undefined;
  readonly undo?: unknown;
}

/**
 * The gateway's outcomes onto the thread tools' vocabulary, one to one like
 * `sendPortFor` above: `guild-unknown` throws the shared refusal (the guild
 * gate already answered that), and the `failed` code stays in the daemon's
 * logs rather than reaching the model.
 */
const mapThreadOutcome = (outcome: McpActionOutcome<ThreadActionResult>): McpThreadWriteOutcome => {
  switch (outcome.status) {
    case 'done':
      return {
        status: 'done',
        actionId: outcome.actionId,
        ...(outcome.result.resultThreadId !== undefined
          ? { threadId: outcome.result.resultThreadId }
          : {}),
        ...(outcome.result.resultMessageId !== undefined
          ? { messageId: outcome.result.resultMessageId }
          : {}),
      };
    case 'dry-run':
      return { status: 'dry-run', actionId: outcome.actionId };
    case 'replayed':
      return {
        status: 'replayed',
        actionId: outcome.actionId,
        ...(outcome.resultThreadId !== undefined ? { threadId: outcome.resultThreadId } : {}),
        ...(outcome.resultMessageId !== undefined ? { messageId: outcome.resultMessageId } : {}),
      };
    case 'refused':
      switch (outcome.reason) {
        case 'killswitch':
          return { status: 'refused', reason: 'killswitch' };
        case 'breaker-open':
          return { status: 'refused', reason: 'breaker-open' };
        case 'rate-cap':
          return {
            status: 'refused',
            reason: 'rate-cap',
            ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
          };
        case 'key-reused-with-other-args':
          return { status: 'refused', reason: 'duplicate-key-different-content' };
        case 'duplicate-content-recently':
          return { status: 'refused', reason: 'duplicate-content-recently' };
        case 'guild-unknown':
        case 'target':
          // Unreachable: every target refusal above returned before the
          // pipeline ran, so `targetCheck` is always `true` here.
          throw new Error(GUILD_REFUSAL_MESSAGE);
      }
      break;
    case 'failed':
      return { status: 'failed' };
  }
};

/**
 * Forum-post target resolution (slice 3, Task 5): send scope ∩ the bot's live
 * permissions — the same two halves `resolveSendTarget` owns, but that helper
 * answers `not-in-guild` for any channel whose `resolveChannel.postable` is
 * false, and discord.js reports `ForumChannel.isTextBased() === false`, so a
 * forum can never pass through it. This resolves the forum the same way up to
 * the postable gate: ADR 0047's `isInScope('send', …)` with the forum's own
 * facts, then the live `ViewChannel` + `SendMessages` check behind the `post`
 * need (the Task 5 ruling). `targets.ts` is outside this task's Files list,
 * so the fork lives here; a later task owning that file should reunite them.
 */
const resolveForumTarget = async (
  client: Client,
  scope: GuildScope,
  guildId: GuildId,
  forumId: string,
): Promise<SendTarget> => {
  if (client.guilds.cache.get(guildId) === undefined) {
    return { ok: false, reason: 'not-in-guild' };
  }
  const resolved = await resolveChannel(client, guildId, forumId);
  if (resolved === undefined || !resolved.isForum) {
    return { ok: false, reason: 'not-in-guild' };
  }
  const grantId = isInScope('send', {
    channelId: resolved.channelId,
    parentChannelId: resolved.parentChannelId,
    categoryId: resolved.categoryId,
    isPrivateThread: false,
    hasOwnRow: (id) => mcpSendRepo.isChannelAllowed(scope, id),
    hasCategoryRow: (id) => mcpSendRepo.isScopeAllowed(scope, id, 'category'),
    isExcluded: (id) => loggingRepo.isChannelExcluded(scope, id),
    parentIncludesThreads: () => true,
  });
  if (grantId === undefined) return { ok: false, reason: 'not-in-send-scope' };
  const me: GuildMember | null = client.guilds.cache.get(guildId)?.members.me ?? null;
  if (me === null) return { ok: false, reason: 'bot-lacks-permission', missing: 'ViewChannel' };
  // The resolved channel itself, not a cache probe: a forum `resolveChannel`
  // fetched on a cache miss must not refuse as if the bot could not see it.
  const channel = (await liveGuildChannel(client, guildId, resolved.channelId)) as
    { permissionsFor(member: GuildMember): { has(bit: bigint): boolean } | null } | undefined;
  const perms = channel?.permissionsFor(me) ?? null;
  if (perms === null) return { ok: false, reason: 'bot-lacks-permission', missing: 'ViewChannel' };
  const missing =
    (
      [
        { bit: PermissionFlagsBits.ViewChannel, name: 'ViewChannel' },
        { bit: PermissionFlagsBits.SendMessages, name: 'SendMessages' },
      ] as const
    ).find((need) => !perms.has(need.bit))?.name ?? undefined;
  if (missing !== undefined) return { ok: false, reason: 'bot-lacks-permission', missing };
  return {
    ok: true,
    channelId: resolved.channelId,
    parentChannelId: resolved.parentChannelId,
    categoryId: resolved.categoryId,
    isThread: false,
    isPrivateThread: false,
    isForum: true,
    grantId,
    derivedGrant: grantId !== resolved.channelId,
  };
};

type ThreadTargetRefusal = Extract<SendTarget, { readonly ok: false }>;
/**
 * The target layer's reasons onto the thread tools' refusals. `notFound`
 * varies by tool: a creation names the channel it could not see, while a
 * thread-id tool reports the thread as not found.
 */
const targetRefusalFor = (
  target: ThreadTargetRefusal,
  notFound: McpThreadWriteRefusal,
): McpThreadWriteOutcome => {
  switch (target.reason) {
    case 'not-in-guild':
      return { status: 'refused', reason: notFound };
    case 'not-in-send-scope':
      return { status: 'refused', reason: 'channel-not-allowlisted' };
    case 'private-thread-not-allowed':
      return { status: 'refused', reason: 'private-thread' };
    case 'bot-lacks-permission':
      return {
        status: 'refused',
        reason: 'bot-lacks-permission',
        ...(target.missing !== undefined ? { detail: target.missing } : {}),
      };
  }
};

/**
 * The `McpThreadWritesPort` behind the six thread/forum tools (slice 3,
 * Task 5), field by field like `sendPortFor` above. Each method resolves its
 * target against send scope and the bot's live permissions, builds the
 * `McpActionDeps` over the storage repos, and runs the one pipeline:
 *
 * - `create_thread`: kind `thread.create`, cap group `structure`. A private
 *   thread writes the `mcp_private_threads` row and its own allowlist row
 *   inside the action's execute — after the Discord call returned, before the
 *   completion lands — so a retry that finds the claim replays instead of
 *   creating twice, and both writes are idempotent. The
 *   `addedByAccountId` is the principal's account. `firstMessage` is a second
 *   action, key `<key>:first`, through the `message.send` path into the new
 *   thread; when it fails the thread still stands and the tool says so.
 * - `add_thread_members` / `remove_thread_members`: one action per call
 *   (kinds `thread.members.add|remove`, cap group `structure`). An add
 *   records `{ userIds }` as its undo (ADR 0116 §5); a removal is not
 *   undoable.
 * - `create_forum_post`: kind `forum.post`, cap group `message`, with the
 *   duplicate-content guard — the content-bearing write of this family.
 *   Always public.
 * - `archive_thread` / `lock_thread`: kind `thread.state`, cap group
 *   `structure`, recording the previous state as the undo.
 *
 * Member and state edits on a thread the bot owns run under `post-in-thread`
 * rather than `manage-thread`. Audit actions are `mcp.<kind>` by the shared
 * default in `mcpActionDepsFor` — `mcp.thread.create`,
 * `mcp.thread.members.add`, `mcp.forum.post`, `mcp.thread.state` — holding
 * ids, the outcome and `actionId`, never content (rule 4). A fault leaves one
 * allowlisted-fields error line via `loggedCallAsync` above, never content:
 * the thread id and the outcome name what happened.
 */
const threadWritesPortFor = (
  principal: McpPrincipal & { readonly clientId: string; readonly tokenId: string },
  deps: HttpDeps,
  discord: DiscordPort,
  /**
   * The same live client the guild tools read (C2 send-time defence in
   * depth): target resolution answers guild membership from
   * `client.guilds.cache`, so a stale allowlist row for a channel outside
   * the guild is refused before any Discord call.
   */
  client: Client,
): McpThreadWritesPort => {
  const grantContext = (
    target: Extract<SendTarget, { readonly ok: true }>,
  ): { readonly grantedByChannelId?: string } =>
    target.derivedGrant ? { grantedByChannelId: target.grantId } : {};

  /**
   * The starter message `create_thread` posts into the new thread: the
   * `message.send` path with the `<key>:first` key, so it is idempotent and
   * audited like any other post. Anything but `done` answers no message id,
   * and the tool renders the thread as created with an unknown first-message
   * outcome rather than failing the creation.
   */
  const postFirstMessage = async (
    guildId: GuildId,
    threadId: string,
    parentChannelId: string,
    mainKey: string,
    first: ThreadFirstMessage,
  ): Promise<{ readonly messageId?: string | undefined }> => {
    const plainText = first.embeds === undefined;
    const argsHash =
      plainText && first.content !== undefined
        ? contentHashFor(threadId, first.content)
        : argsHashFor('message.send', {
            channel: threadId,
            content: first.content,
            embeds: first.embeds,
          });
    const outcome = await runMcpAction(
      mcpActionDepsFor(deps, guildId, principal, { grantedByChannelId: parentChannelId }),
      {
        kind: 'message.send',
        capGroup: 'message',
        idempotencyKey: `${mainKey}:first`,
        tokenId: principal.tokenId,
        argsHash,
        targetChannelId: threadId,
        dryRun: false,
        duplicateContentGuard: true,
      },
      true,
      async () => {
        const ref = await discord.sendMessage(guildId, threadId, {
          ...(first.content !== undefined ? { content: first.content } : {}),
          ...(first.embeds !== undefined ? { embeds: first.embeds.map(toDiscordEmbed) } : {}),
          pingReplyAuthor: false,
          allowedMentions: { parse: [], roles: [], users: [] },
        });
        return { resultMessageId: ref.messageId };
      },
    );
    return outcome.status === 'done' ? { messageId: outcome.result.resultMessageId } : {};
  };

  return {
    createThread: (guildId, input) =>
      loggedCallAsync(deps.logger, 'threadCreate', async () => {
        const scope = deps.scopes.forGuild(guildId);
        const ref = resolveThreadChannelRef(client, guildId, input.channel);
        if (!ref.ok) {
          return ref.reason === 'ambiguous-channel'
            ? {
                status: 'refused',
                reason: 'ambiguous-channel',
                ...(ref.detail !== undefined ? { detail: ref.detail } : {}),
              }
            : { status: 'refused', reason: 'channel-not-in-guild' };
        }
        const resolved = await resolveChannel(client, guildId, ref.channelId);
        if (resolved === undefined) return { status: 'refused', reason: 'channel-not-in-guild' };
        if (resolved.isForum) return { status: 'refused', reason: 'use-forum-post' };
        if (resolved.isThread) return { status: 'refused', reason: 'invalid-parent' };
        const target = await resolveSendTarget(
          client,
          scope,
          guildId,
          resolved.channelId,
          input.type === 'private' ? 'create-private-thread' : 'create-public-thread',
        );
        if (!target.ok) return targetRefusalFor(target, 'channel-not-in-guild');
        const argsHash = argsHashFor('thread.create', {
          channel: target.channelId,
          name: input.name,
          type: input.type,
          autoArchiveMinutes: input.autoArchiveMinutes,
          invitable: input.invitable,
          fromMessageId: input.fromMessageId,
          firstMessage: input.firstMessage,
        });
        // The action id up front: the private-thread rows written inside
        // `execute` reference the creating action, and the gateway only mints
        // it when it claims. Overriding `newActionId` keeps the gateway's
        // ordering untouched — a lost claim race never runs `execute`, so the
        // rows always name the winning action.
        const claimId = randomUUID();
        const actionDeps = {
          ...mcpActionDepsFor(deps, guildId, principal, grantContext(target)),
          newActionId: () => claimId,
        };
        const outcome = await runMcpAction(
          actionDeps,
          {
            kind: 'thread.create',
            capGroup: 'structure',
            idempotencyKey: input.idempotencyKey,
            tokenId: principal.tokenId,
            argsHash,
            targetChannelId: target.channelId,
            dryRun: input.dryRun,
            duplicateContentGuard: false,
          },
          true,
          async () => {
            const created = await discord.createThread(guildId, target.channelId, {
              name: input.name,
              type: input.type,
              autoArchiveMinutes: input.autoArchiveMinutes,
              ...(input.type === 'private' ? { invitable: input.invitable } : {}),
              ...(input.fromMessageId !== undefined ? { fromMessageId: input.fromMessageId } : {}),
            });
            if (input.type === 'private') {
              mcpRolePolicyRepo.recordPrivateThread(scope, {
                threadId: created.threadId,
                parentChannelId: target.channelId,
                createdActionId: claimId,
                now: deps.now(),
              });
              mcpSendRepo.allowChannel(scope, {
                channelId: created.threadId,
                addedByAccountId: principal.accountId,
                now: deps.now(),
              });
            }
            const first =
              input.firstMessage === undefined
                ? undefined
                : await postFirstMessage(
                    guildId,
                    created.threadId,
                    target.channelId,
                    input.idempotencyKey,
                    input.firstMessage,
                  );
            return {
              resultThreadId: created.threadId,
              ...(first?.messageId !== undefined ? { resultMessageId: first.messageId } : {}),
            };
          },
        );
        return mapThreadOutcome(outcome);
      }),
    addThreadMembers: (guildId, input) =>
      loggedCallAsync(deps.logger, 'threadAddMembers', async () => {
        const scope = deps.scopes.forGuild(guildId);
        const resolved = await resolveChannel(client, guildId, input.threadId);
        if (resolved === undefined || !resolved.isThread) {
          return { status: 'refused', reason: 'thread-not-found' };
        }
        const owned = botOwnsThread(scope, resolved.channelId);
        const target = await resolveSendTarget(
          client,
          scope,
          guildId,
          resolved.channelId,
          owned ? 'post-in-thread' : 'manage-thread',
        );
        if (!target.ok) return targetRefusalFor(target, 'thread-not-found');
        for (const userId of input.userIds) {
          if (!(await liveGuildMember(client, guildId, userId))) {
            return { status: 'refused', reason: 'user-not-member', detail: userId };
          }
        }
        const outcome = await runMcpAction(
          mcpActionDepsFor(deps, guildId, principal, grantContext(target)),
          {
            kind: 'thread.members.add',
            capGroup: 'structure',
            idempotencyKey: input.idempotencyKey,
            tokenId: principal.tokenId,
            argsHash: argsHashFor('thread.members.add', {
              thread: target.channelId,
              userIds: [...input.userIds],
            }),
            targetChannelId: target.channelId,
            dryRun: input.dryRun,
            duplicateContentGuard: false,
          },
          true,
          async () => {
            for (const userId of input.userIds) {
              await discord.addThreadMember(guildId, target.channelId, userId);
            }
            return { undo: { userIds: [...input.userIds] } };
          },
        );
        return mapThreadOutcome(outcome);
      }),
    removeThreadMembers: (guildId, input) =>
      loggedCallAsync(deps.logger, 'threadRemoveMembers', async () => {
        const scope = deps.scopes.forGuild(guildId);
        const resolved = await resolveChannel(client, guildId, input.threadId);
        if (resolved === undefined || !resolved.isThread) {
          return { status: 'refused', reason: 'thread-not-found' };
        }
        const owned = botOwnsThread(scope, resolved.channelId);
        const target = await resolveSendTarget(
          client,
          scope,
          guildId,
          resolved.channelId,
          owned ? 'post-in-thread' : 'manage-thread',
        );
        if (!target.ok) return targetRefusalFor(target, 'thread-not-found');
        for (const userId of input.userIds) {
          if (!(await liveGuildMember(client, guildId, userId))) {
            return { status: 'refused', reason: 'user-not-member', detail: userId };
          }
        }
        const outcome = await runMcpAction(
          mcpActionDepsFor(deps, guildId, principal, grantContext(target)),
          {
            kind: 'thread.members.remove',
            capGroup: 'structure',
            idempotencyKey: input.idempotencyKey,
            tokenId: principal.tokenId,
            argsHash: argsHashFor('thread.members.remove', {
              thread: target.channelId,
              userIds: [...input.userIds],
            }),
            targetChannelId: target.channelId,
            dryRun: input.dryRun,
            duplicateContentGuard: false,
          },
          true,
          async () => {
            for (const userId of input.userIds) {
              await discord.removeThreadMember(guildId, target.channelId, userId);
            }
            // A removal records no undo (ADR 0116 §5): only the add inverts.
            return {};
          },
        );
        return mapThreadOutcome(outcome);
      }),
    createForumPost: (guildId, input) =>
      loggedCallAsync(deps.logger, 'forumPost', async () => {
        const scope = deps.scopes.forGuild(guildId);
        const ref = resolveThreadChannelRef(client, guildId, input.forum);
        if (!ref.ok) {
          return ref.reason === 'ambiguous-channel'
            ? {
                status: 'refused',
                reason: 'ambiguous-channel',
                ...(ref.detail !== undefined ? { detail: ref.detail } : {}),
              }
            : { status: 'refused', reason: 'channel-not-in-guild' };
        }
        const resolved = await resolveChannel(client, guildId, ref.channelId);
        if (resolved === undefined) return { status: 'refused', reason: 'channel-not-in-guild' };
        if (!resolved.isForum) return { status: 'refused', reason: 'not-a-forum' };
        const target = await resolveForumTarget(client, scope, guildId, resolved.channelId);
        if (!target.ok) return targetRefusalFor(target, 'channel-not-in-guild');
        const available = (await readForumTags(client, guildId, target.channelId)) ?? [];
        const matched = matchForumTags(available, [...input.tags]);
        if (!matched.ok) {
          return {
            status: 'refused',
            reason: 'tag-unknown',
            detail: JSON.stringify({
              unknown: matched.unknown,
              available: available.map((tag) => tag.name),
            }),
          };
        }
        const outcome = await runMcpAction(
          mcpActionDepsFor(deps, guildId, principal, grantContext(target)),
          {
            kind: 'forum.post',
            capGroup: 'message',
            idempotencyKey: input.idempotencyKey,
            tokenId: principal.tokenId,
            argsHash: argsHashFor('forum.post', {
              forum: target.channelId,
              title: input.title,
              content: input.content,
              embeds: input.embeds,
              tags: matched.ids,
            }),
            targetChannelId: target.channelId,
            dryRun: input.dryRun,
            duplicateContentGuard: true,
          },
          true,
          async () => {
            const posted = await discord.createForumPost(guildId, target.channelId, {
              name: input.title,
              message: {
                ...(input.content !== undefined ? { content: input.content } : {}),
                ...(input.embeds !== undefined ? { embeds: input.embeds.map(toDiscordEmbed) } : {}),
                allowedMentions: { parse: [], roles: [], users: [] },
              },
              appliedTagIds: matched.ids,
            });
            return { resultThreadId: posted.threadId, resultMessageId: posted.messageId };
          },
        );
        return mapThreadOutcome(outcome);
      }),
    setThreadState: (guildId, input) =>
      loggedCallAsync(deps.logger, 'threadState', async () => {
        const scope = deps.scopes.forGuild(guildId);
        const resolved = await resolveChannel(client, guildId, input.threadId);
        if (resolved === undefined || !resolved.isThread) {
          return { status: 'refused', reason: 'thread-not-found' };
        }
        // Discord lets a thread's owner archive it, but only ManageThreads
        // locks or unlocks — ownership never relaxes a lock.
        const owned = input.locked === undefined && botOwnsThread(scope, resolved.channelId);
        const target = await resolveSendTarget(
          client,
          scope,
          guildId,
          resolved.channelId,
          owned ? 'post-in-thread' : 'manage-thread',
        );
        if (!target.ok) return targetRefusalFor(target, 'thread-not-found');
        const previous = await liveThreadState(client, guildId, target.channelId);
        const state =
          input.archived !== undefined ? { archived: input.archived } : { locked: input.locked };
        const outcome = await runMcpAction(
          mcpActionDepsFor(deps, guildId, principal, grantContext(target)),
          {
            kind: 'thread.state',
            capGroup: 'structure',
            idempotencyKey: input.idempotencyKey,
            tokenId: principal.tokenId,
            argsHash: argsHashFor('thread.state', { thread: target.channelId, ...state }),
            targetChannelId: target.channelId,
            dryRun: input.dryRun,
            duplicateContentGuard: false,
          },
          true,
          async () => {
            await discord.setThreadState(guildId, target.channelId, state);
            // The previous state is the undo (ADR 0116 §5); when the cache
            // never knew the thread there is nothing truthful to record.
            const undo =
              input.archived !== undefined
                ? previous?.archived === undefined
                  ? undefined
                  : { archived: previous.archived }
                : previous?.locked === undefined
                  ? undefined
                  : { locked: previous.locked };
            return undo === undefined ? {} : { undo };
          },
        );
        return mapThreadOutcome(outcome);
      }),
  };
};

/**
 * The `McpMessageWritesPort` behind the six message-write tools (slice 3,
 * Task 6), field by field like `healthPortFor` above. Every method resolves
 * its target against send scope and the bot's live permissions, then runs
 * the one `runMcpAction` pipeline — edits and deletes in cap group `edit`,
 * pins, unpins and reactions in `pin_react` (ruling) — with the
 * duplicate-content guard off (it is a message-post rule) and the audit
 * action defaulting to `mcp.<kind>` (so `mcp.message.edit` and friends land
 * without a new audit vocabulary entry).
 *
 * Edit/delete eligibility order is fixed: the target resolves, then the
 * protected-message guard (a storage read — no Discord call), then the
 * live authorship check (`fetchMessageAuthor`: gone → `not-found`, another
 * author → `not-bot-authored` against the discord.js client's own user
 * id), and only then the pipeline. A fault leaves one allowlisted-fields
 * error line via `loggedCallAsync` — never message content (rule 4).
 *
 * Undo (ADR 0116 §5, for Task 7's `undo_action`): an edit stores the
 * previous `{content, embeds}`; a pin stores `{op:'unpin'}` and an unpin
 * `{op:'pin'}`; a reaction add stores `{op:'remove-reaction', emoji}` and
 * a removal `{op:'add-reaction', emoji}`. A delete stores nothing and is
 * not undoable.
 */
const messageWritesPortFor = (
  principal: McpPrincipal & { readonly clientId: string; readonly tokenId: string },
  deps: HttpDeps,
  discord: DiscordPort,
  /**
   * The same live client the guild tools read: target resolution answers
   * guild membership from `client.guilds.cache`, the authorship check reads
   * the bot's own id from `client.user.id`, and custom emoji resolve
   * against this guild's emoji cache.
   */
  client: Client,
): McpMessageWritesPort => {
  /** The target layer's reasons mapped onto the writes outcome, ids only. */
  const targetRefusal = (
    reason:
      'not-in-guild' | 'not-in-send-scope' | 'private-thread-not-allowed' | 'bot-lacks-permission',
    missing?: string,
  ): McpMessageWriteOutcome => {
    switch (reason) {
      case 'not-in-guild':
        return { status: 'refused', reason: 'channel-not-in-guild' };
      case 'not-in-send-scope':
        return { status: 'refused', reason: 'channel-not-allowlisted' };
      case 'private-thread-not-allowed':
        return { status: 'refused', reason: 'private-thread' };
      case 'bot-lacks-permission':
        return {
          status: 'refused',
          reason: 'bot-lacks-permission',
          ...(missing !== undefined ? { detail: missing } : {}),
        };
    }
  };

  /** The gateway's outcomes mapped onto the writes outcome, ids only. */
  const gatewayOutcome = (
    outcome: McpActionOutcome<{ resultMessageId?: string; undo?: unknown }>,
  ): McpMessageWriteOutcome => {
    switch (outcome.status) {
      case 'done':
        return {
          status: 'done',
          actionId: outcome.actionId,
          ...(outcome.result.resultMessageId !== undefined
            ? { messageId: outcome.result.resultMessageId }
            : {}),
        };
      case 'dry-run':
        return { status: 'dry-run', actionId: outcome.actionId };
      case 'replayed':
        return {
          status: 'replayed',
          actionId: outcome.actionId,
          ...(outcome.resultMessageId !== undefined ? { messageId: outcome.resultMessageId } : {}),
        };
      case 'refused':
        switch (outcome.reason) {
          case 'killswitch':
            return { status: 'refused', reason: 'killswitch' };
          case 'breaker-open':
            return { status: 'refused', reason: 'breaker-open' };
          case 'rate-cap':
            return {
              status: 'refused',
              reason: 'rate-cap',
              ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
            };
          case 'key-reused-with-other-args':
            return { status: 'refused', reason: 'duplicate-key-different-content' };
          case 'duplicate-content-recently':
            return { status: 'refused', reason: 'duplicate-content-recently' };
          case 'guild-unknown':
            throw new Error(GUILD_REFUSAL_MESSAGE);
          case 'target':
            // Unreachable: every target refusal above returned before the
            // pipeline ran, so `targetCheck` is always `true` here.
            throw new Error(GUILD_REFUSAL_MESSAGE);
        }
        break;
      case 'failed':
        return { status: 'failed' };
    }
  };

  /**
   * The edit/delete eligibility chain: send-scope target with posting need
   * (edits and deletes are channel operations — the existing `post` need,
   * so no new target kind), then the protected guard with no Discord call,
   * then the live authorship read. Returns the resolved channel and the
   * previous content for the edit's undo row.
   */
  const resolveEditable = async (
    guildId: GuildId,
    channelId: string,
    messageId: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly channelId: string;
        readonly grantId: string;
        readonly derivedGrant: boolean;
        readonly prev: { readonly content: string; readonly embeds: readonly unknown[] };
      }
    | { readonly ok: false; readonly outcome: McpMessageWriteOutcome }
  > => {
    const scope = deps.scopes.forGuild(guildId);
    const target = await resolveSendTarget(client, scope, guildId, channelId, 'post');
    if (!target.ok) {
      return { ok: false, outcome: targetRefusal(target.reason, target.missing) };
    }
    const protectedReason = protectedMessageReason(scope, messageId);
    if (protectedReason === 'role-panel') {
      return { ok: false, outcome: { status: 'refused', reason: 'protected-role-panel' } };
    }
    if (protectedReason === 'task-post') {
      return { ok: false, outcome: { status: 'refused', reason: 'protected-task-post' } };
    }
    const live = await discord.fetchMessageAuthor(guildId, {
      channelId: target.channelId,
      messageId,
    });
    if (live === undefined) {
      return { ok: false, outcome: { status: 'refused', reason: 'not-found' } };
    }
    // The bot's own user id, live from the discord.js client — never a
    // configured constant, so a `/doctor`-rotated token cannot strand or
    // misattribute authorship.
    const botId = client.user?.id;
    if (botId === undefined || live.authorId !== botId) {
      return { ok: false, outcome: { status: 'refused', reason: 'not-bot-authored' } };
    }
    return {
      ok: true,
      channelId: target.channelId,
      grantId: target.grantId,
      derivedGrant: target.derivedGrant,
      prev: { content: live.content, embeds: live.embeds },
    };
  };

  /**
   * A reaction emoji in the tool's vocabulary to the port's canonical key:
   * `name:id` for a custom emoji that exists in this guild's cache (a
   * foreign guild's id answers `undefined` — the refusal, not a Discord
   * call), otherwise a unicode emoji key. Anything else answers `undefined`
   * too; the tool layer already rejected malformed shapes, so this is the
   * guild-membership check, not the format check.
   */
  const resolveReactionEmoji = (guildId: GuildId, raw: string): string | undefined => {
    const custom = /^([^:<>@#\s]+):(\d{17,20})$/.exec(raw);
    if (custom !== null) {
      const name = custom[1] ?? '';
      const id = custom[2] ?? '';
      const entry = client.guilds.cache.get(guildId)?.emojis.cache.get(id);
      if (entry === undefined || entry.name !== name) return undefined;
      try {
        return customEmojiKey(id);
      } catch {
        return undefined;
      }
    }
    if (raw.includes(':')) return undefined;
    try {
      return unicodeEmojiKey(raw);
    } catch {
      return undefined;
    }
  };

  const runWrite = async (
    guildId: GuildId,
    intent: {
      readonly kind: string;
      readonly capGroup: 'edit' | 'pin_react';
      readonly idempotencyKey: string;
      readonly argsHash: string;
      readonly targetChannelId: string;
      readonly dryRun: boolean;
      readonly grantedByChannelId?: string;
    },
    execute: () => Promise<{ resultMessageId?: string; undo?: unknown }>,
  ): Promise<McpMessageWriteOutcome> =>
    gatewayOutcome(
      await runMcpAction(
        mcpActionDepsFor(
          deps,
          guildId,
          principal,
          intent.grantedByChannelId !== undefined
            ? { grantedByChannelId: intent.grantedByChannelId }
            : {},
        ),
        {
          kind: intent.kind,
          capGroup: intent.capGroup,
          idempotencyKey: intent.idempotencyKey,
          tokenId: principal.tokenId,
          argsHash: intent.argsHash,
          targetChannelId: intent.targetChannelId,
          dryRun: intent.dryRun,
          duplicateContentGuard: false,
        },
        true,
        execute,
      ),
    );

  return {
    edit: (guildId, input) =>
      loggedCallAsync(deps.logger, 'editMessage', async () => {
        const eligible = await resolveEditable(guildId, input.channelId, input.messageId);
        if (!eligible.ok) return eligible.outcome;
        return runWrite(
          guildId,
          {
            kind: 'message.edit',
            capGroup: 'edit',
            idempotencyKey: input.idempotencyKey,
            argsHash: argsHashFor('message.edit', {
              channel: eligible.channelId,
              message: input.messageId,
              content: input.content,
              embeds: input.embeds,
            }),
            targetChannelId: eligible.channelId,
            dryRun: input.dryRun,
            ...(eligible.derivedGrant ? { grantedByChannelId: eligible.grantId } : {}),
          },
          async () => {
            await discord.editMessage(
              guildId,
              { channelId: eligible.channelId, messageId: input.messageId },
              {
                ...(input.content !== undefined ? { content: input.content } : {}),
                ...(input.embeds !== undefined ? { embeds: input.embeds.map(toDiscordEmbed) } : {}),
                // An edit that adds `@everyone` or a mention must never ping:
                // absent, Discord would apply its default and notify.
                allowedMentions: { parse: [], roles: [], users: [] },
              },
            );
            return {
              resultMessageId: input.messageId,
              undo: { content: eligible.prev.content, embeds: eligible.prev.embeds },
            };
          },
        );
      }),
    delete: (guildId, input) =>
      loggedCallAsync(deps.logger, 'deleteMessage', async () => {
        const eligible = await resolveEditable(guildId, input.channelId, input.messageId);
        if (!eligible.ok) return eligible.outcome;
        return runWrite(
          guildId,
          {
            kind: 'message.delete',
            capGroup: 'edit',
            idempotencyKey: input.idempotencyKey,
            argsHash: argsHashFor('message.delete', {
              channel: eligible.channelId,
              message: input.messageId,
            }),
            targetChannelId: eligible.channelId,
            dryRun: input.dryRun,
            ...(eligible.derivedGrant ? { grantedByChannelId: eligible.grantId } : {}),
          },
          async () => {
            await discord.deleteMessage(
              guildId,
              { channelId: eligible.channelId, messageId: input.messageId },
              'mcp delete_message',
            );
            // Deletes are not undoable (ADR 0116 §5): no undo row.
            return { resultMessageId: input.messageId };
          },
        );
      }),
    pin: (guildId, input) =>
      loggedCallAsync(deps.logger, 'pinMessage', async () => {
        const scope = deps.scopes.forGuild(guildId);
        const target = await resolveSendTarget(client, scope, guildId, input.channelId, 'pin');
        if (!target.ok) {
          return targetRefusal(target.reason, target.missing);
        }
        return runWrite(
          guildId,
          {
            kind: 'message.pin',
            capGroup: 'pin_react',
            idempotencyKey: input.idempotencyKey,
            argsHash: argsHashFor('message.pin', {
              channel: target.channelId,
              message: input.messageId,
            }),
            targetChannelId: target.channelId,
            dryRun: input.dryRun,
            ...(target.derivedGrant ? { grantedByChannelId: target.grantId } : {}),
          },
          async () => {
            await discord.pinMessage(guildId, {
              channelId: target.channelId,
              messageId: input.messageId,
            });
            return { resultMessageId: input.messageId, undo: { op: 'unpin' } };
          },
        );
      }),
    unpin: (guildId, input) =>
      loggedCallAsync(deps.logger, 'unpinMessage', async () => {
        const scope = deps.scopes.forGuild(guildId);
        const target = await resolveSendTarget(client, scope, guildId, input.channelId, 'pin');
        if (!target.ok) {
          return targetRefusal(target.reason, target.missing);
        }
        return runWrite(
          guildId,
          {
            kind: 'message.unpin',
            capGroup: 'pin_react',
            idempotencyKey: input.idempotencyKey,
            argsHash: argsHashFor('message.unpin', {
              channel: target.channelId,
              message: input.messageId,
            }),
            targetChannelId: target.channelId,
            dryRun: input.dryRun,
            ...(target.derivedGrant ? { grantedByChannelId: target.grantId } : {}),
          },
          async () => {
            await discord.unpinMessage(guildId, {
              channelId: target.channelId,
              messageId: input.messageId,
            });
            return { resultMessageId: input.messageId, undo: { op: 'pin' } };
          },
        );
      }),
    addReaction: (guildId, input) =>
      loggedCallAsync(deps.logger, 'addReaction', async () => {
        const scope = deps.scopes.forGuild(guildId);
        const target = await resolveSendTarget(client, scope, guildId, input.channelId, 'react');
        if (!target.ok) {
          return targetRefusal(target.reason, target.missing);
        }
        const key = resolveReactionEmoji(guildId, input.emoji);
        if (key === undefined) {
          return { status: 'refused', reason: 'unknown-emoji', detail: input.emoji };
        }
        return runWrite(
          guildId,
          {
            kind: 'reaction.add',
            capGroup: 'pin_react',
            idempotencyKey: input.idempotencyKey,
            argsHash: argsHashFor('reaction.add', {
              channel: target.channelId,
              message: input.messageId,
              emoji: key,
            }),
            targetChannelId: target.channelId,
            dryRun: input.dryRun,
            ...(target.derivedGrant ? { grantedByChannelId: target.grantId } : {}),
          },
          async () => {
            await discord.createReaction(
              guildId,
              { channelId: target.channelId, messageId: input.messageId },
              key,
            );
            return {
              resultMessageId: input.messageId,
              undo: { op: 'remove-reaction', emoji: key },
            };
          },
        );
      }),
    removeReaction: (guildId, input) =>
      loggedCallAsync(deps.logger, 'removeReaction', async () => {
        const scope = deps.scopes.forGuild(guildId);
        const target = await resolveSendTarget(client, scope, guildId, input.channelId, 'react');
        if (!target.ok) {
          return targetRefusal(target.reason, target.missing);
        }
        const key = resolveReactionEmoji(guildId, input.emoji);
        if (key === undefined) {
          return { status: 'refused', reason: 'unknown-emoji', detail: input.emoji };
        }
        return runWrite(
          guildId,
          {
            kind: 'reaction.remove',
            capGroup: 'pin_react',
            idempotencyKey: input.idempotencyKey,
            argsHash: argsHashFor('reaction.remove', {
              channel: target.channelId,
              message: input.messageId,
              emoji: key,
            }),
            targetChannelId: target.channelId,
            dryRun: input.dryRun,
            ...(target.derivedGrant ? { grantedByChannelId: target.grantId } : {}),
          },
          async () => {
            await discord.deleteOwnReaction(
              guildId,
              { channelId: target.channelId, messageId: input.messageId },
              key,
            );
            return { resultMessageId: input.messageId, undo: { op: 'add-reaction', emoji: key } };
          },
        );
      }),
  };
};

/**
 * The MCP gateway's per-guild rate limiter, shared across the requests one
 * daemon serves. One limiter per guild (buckets are per source, not per
 * guild, so a single limiter would let one guild spend another's budget);
 * created lazily at the guild's standing per-minute rate. Lives in the
 * `registerMcpRoutes` closure rather than the module so every app — and every
 * test app — starts with full buckets.
 */
const mcpRateLimiterFor = (
  limiters: Map<GuildId, RateLimiter>,
  scope: GuildScope,
): RateLimiter => {
  const existing = limiters.get(scope.guildId);
  if (existing !== undefined) return existing;
  const created = new RateLimiter(guildRepo.findGuild(scope)?.roleRatePerMin ?? 20);
  limiters.set(scope.guildId, created);
  return created;
};

const mcpGatewayFor = (
  limiters: Map<GuildId, RateLimiter>,
  deps: HttpDeps,
  client: Client,
  discord: DiscordPort,
  scope: GuildScope,
) =>
  mcpRoleGatewayFor(
    {
      authz: authzStoreFor(scope),
      rateLimiter: mcpRateLimiterFor(limiters, scope),
      logger: deps.logger,
      now: deps.now,
    },
    client,
    discord,
    scope,
  );

/**
 * The `roles.mutate` witness for one MCP role change (ADR 0118 §2). The actor
 * is the token's dashboard account with no Discord roles — `authorize` drops
 * dashboard role ids by construction, so a Discord grant can never satisfy
 * this. `undefined` on denial: the caller refuses with the account's own
 * refusal rather than falling back to anything else.
 */
const authorizeRoleChange = (
  scope: GuildScope,
  guildId: GuildId,
  accountId: string,
): Authorized<'roles.mutate'> | undefined => {
  const result = authorize(
    {
      store: authzStoreFor(scope),
      guildId,
      actor: { type: 'dashboard', id: accountId, roleIds: [] },
    },
    'roles.mutate',
  );
  return result.ok ? result.value : undefined;
};

type RolePrecheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: McpRoleWriteOutcome };

/**
 * The target and policy pre-checks for one role change, live and before the
 * claim — a refusal writes no ledger row. In task order: the member exists,
 * the role exists, the role is in `managed_roles`, the role passes the MCP
 * grant policy with the live floor, and the target is neither the guild owner
 * nor protected. The gateway re-checks all of these itself; these exist so
 * the refusal names its reason instead of surfacing as an unknown Discord
 * result, and so the undo can re-run the same set live.
 *
 * Reads are cache-first: the role cache is complete once the guild is READY
 * and a member-cache hit proves membership, so the common path makes no
 * Discord call at all — which is what makes the floor test's "no Discord
 * call" true rather than aspirational.
 */
const precheckRoleTarget = async (
  client: Client,
  discord: DiscordPort,
  scope: GuildScope,
  guildId: GuildId,
  memberId: string,
  roleId: string,
): Promise<RolePrecheck> => {
  const guild = client.guilds.cache.get(guildId);
  const cachedMember = guild?.members.cache.get(memberId);
  let memberIsOwner: boolean;
  if (cachedMember !== undefined) {
    memberIsOwner = guild !== undefined && cachedMember.user.id === guild.ownerId;
  } else {
    try {
      memberIsOwner = (await discord.fetchMember(guildId, memberId)).isGuildOwner;
    } catch {
      return {
        ok: false,
        outcome: { status: 'refused', reason: 'unknown-member', detail: memberId },
      };
    }
  }
  if (guild?.roles.cache.get(roleId) === undefined) {
    let found = false;
    try {
      found = (await discord.fetchRoles(guildId)).some((role) => role.id === roleId);
    } catch {
      found = false;
    }
    if (!found) {
      return { ok: false, outcome: { status: 'refused', reason: 'unknown-role', detail: roleId } };
    }
  }
  // ADR 0118 amendment: the role must already be in `managed_roles` AND pass
  // the MCP grant policy. The MCP never inserts into `managed_roles` itself.
  if (!roleRepo.isAllowlisted(scope, roleId)) {
    return {
      ok: false,
      outcome: { status: 'refused', reason: 'role-not-allowlisted', detail: roleId },
    };
  }
  const grantRefusal = roleGrantRefusal(client, scope, roleId);
  if (grantRefusal !== true) {
    return {
      ok: false,
      outcome: { status: 'refused', reason: 'role-not-permitted', detail: grantRefusal },
    };
  }
  if (memberIsOwner) {
    return {
      ok: false,
      outcome: { status: 'refused', reason: 'protected-target', detail: 'guild-owner' },
    };
  }
  if (isTargetProtected(scope, { userId: memberId, roleId })) {
    return {
      ok: false,
      outcome: { status: 'refused', reason: 'protected-target', detail: 'protected' },
    };
  }
  return { ok: true };
};

/**
 * A gateway refusal that slipped past the pre-checks (a race: the hierarchy
 * moved, the breaker opened, or the bucket filled between the check and the
 * call) back onto the role tools' vocabulary.
 */
const mapRoleGatewayRefusal = (
  reason: RefusalReason,
  roleId: string,
): McpRoleWriteOutcome => {
  switch (reason) {
    case 'killswitch':
      return { status: 'refused', reason: 'killswitch' };
    case 'breaker-open':
      return { status: 'refused', reason: 'breaker-open' };
    case 'rate-cap':
      return { status: 'refused', reason: 'rate-cap' };
    case 'protected-target':
      return { status: 'refused', reason: 'protected-target', detail: 'protected' };
    case 'role-not-allowlisted':
      return { status: 'refused', reason: 'role-not-allowlisted', detail: roleId };
    case 'unauthorized':
      return { status: 'refused', reason: 'unauthorized' };
    case 'role-above-bot':
      return { status: 'refused', reason: 'role-not-permitted', detail: 'above-bot' };
    case 'role-managed':
    case 'role-is-everyone':
      return { status: 'refused', reason: 'role-not-permitted', detail: 'managed-or-everyone' };
    case 'role-missing':
      return { status: 'refused', reason: 'unknown-role', detail: roleId };
    case 'panel-disabled':
    case 'guild-unknown':
      // Unreachable: role changes never name a panel, and the guild gate
      // already answered the guild.
      throw new Error(GUILD_REFUSAL_MESSAGE);
  }
};

/**
 * The `McpRoleWritesPort` behind `grant_role` / `remove_role` (slice 4,
 * Task 3), field by field like `sendPortFor` above. Each method runs the
 * live pre-checks, then the one `runMcpAction` pipeline — kind `role.grant` /
 * `role.remove`, cap group `member_role`, with `targetChannelId` undefined (a
 * role change has no channel target) — whose execute authorizes
 * `roles.mutate`, opens the `effect_batches` row (source `mcp`, batch id =
 * the claim's action id, actor `mcp_operator`) and calls the MCP role gateway
 * with trigger ref `mcp:<actionId>`.
 *
 * A gateway `skipped` (`no-change-needed`: the member already had the role,
 * or did not have it) still completes as `done` but records no undo, so it
 * is not undoable — and renders as already-had. A fault leaves one
 * allowlisted-fields error line via `loggedCallAsync` above, never a member
 * name (rule 4).
 *
 * Undo (ADR 0116 §5, for `undo_action`): a grant stores `{op:'remove-role'}`
 * and a removal `{op:'add-role'}`. The member and role ids are re-resolved
 * live at undo time from the effect row the forward call claimed (batch id =
 * the forward action id), through the same pre-check set.
 */
const roleWritesPortFor = (
  principal: McpPrincipal & { readonly clientId: string; readonly tokenId: string },
  deps: HttpDeps,
  discord: DiscordPort,
  /**
   * The same live client the guild tools read: the grant policy and the floor
   * answer from its role cache, so a role that gained a dangerous permission
   * is refused before any Discord call.
   */
  client: Client,
  mcpLimiters: Map<GuildId, RateLimiter>,
): McpRoleWritesPort => {
  const runRoleWrite = async (
    action: 'grant' | 'remove',
    guildId: GuildId,
    input: {
      readonly memberId: string;
      readonly roleId: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ): Promise<McpRoleWriteOutcome> => {
    const scope = deps.scopes.forGuild(guildId);
    const target = await precheckRoleTarget(
      client,
      discord,
      scope,
      guildId,
      input.memberId,
      input.roleId,
    );
    if (!target.ok) return target.outcome;
    const kind = action === 'grant' ? 'role.grant' : 'role.remove';
    // The action id up front: the `effect_batches` row opened inside
    // `execute` carries batch id = the claim's action id, the way
    // `create_thread` overrides `newActionId` for its private-thread rows.
    const claimId = randomUUID();
    const actionDeps = {
      ...mcpActionDepsFor(deps, guildId, principal, {}),
      newActionId: () => claimId,
    };
    let denied = false;
    let skipped = false;
    let gatewayRefusal: RefusalReason | undefined;
    const outcome = await runMcpAction(
      actionDeps,
      {
        kind,
        capGroup: 'member_role',
        idempotencyKey: input.idempotencyKey,
        tokenId: principal.tokenId,
        argsHash: argsHashFor(kind, { member: input.memberId, role: input.roleId }),
        targetChannelId: undefined,
        dryRun: input.dryRun,
        duplicateContentGuard: false,
      },
      true,
      async () => {
        const witness = authorizeRoleChange(scope, guildId, principal.accountId);
        if (witness === undefined) {
          // A denial is its own refusal ("this account lacks
          // roles.mutate"), recorded as a failed claim with no effect row
          // and no batch row — the flag below maps it back to a refusal.
          denied = true;
          throw new Error('roles.mutate denied');
        }
        effectRepo.openBatch(scope, {
          batchId: claimId,
          source: 'mcp',
          actorType: 'mcp_operator',
          actorId: principal.accountId,
          now: deps.now(),
        });
        const result = await mcpGatewayFor(mcpLimiters, deps, client, discord, scope).applyRoleEffect(
          witness,
          {
            userId: parseSnowflakeId(input.memberId),
            roleId: parseSnowflakeId(input.roleId),
            action,
            panelId: undefined,
            triggerRef: `mcp:${claimId}`,
            source: 'mcp',
            batchId: claimId,
            reason: action === 'grant' ? 'mcp grant_role' : 'mcp remove_role',
          },
        );
        switch (result.status) {
          case 'applied':
            return { undo: { op: action === 'grant' ? 'remove-role' : 'add-role' } };
          case 'dry-run':
            // Unreachable: the pipeline answers dry runs before execute runs.
            throw new Error('mcp gateway dry-ran inside a live action');
          case 'skipped':
            skipped = true;
            return {};
          case 'refused':
            gatewayRefusal = result.reason;
            throw new Error(`mcp gateway refused: ${result.reason}`);
          case 'failed':
            throw new Error(`mcp gateway failed: ${result.code}`);
        }
      },
    );
    switch (outcome.status) {
      case 'done':
        return { status: 'done', actionId: outcome.actionId, alreadyHad: skipped };
      case 'dry-run':
        return { status: 'dry-run', actionId: outcome.actionId };
      case 'replayed':
        return { status: 'replayed', actionId: outcome.actionId };
      case 'refused':
        switch (outcome.reason) {
          case 'killswitch':
            return { status: 'refused', reason: 'killswitch' };
          case 'breaker-open':
            return { status: 'refused', reason: 'breaker-open' };
          case 'rate-cap':
            return {
              status: 'refused',
              reason: 'rate-cap',
              ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
            };
          case 'key-reused-with-other-args':
            return { status: 'refused', reason: 'duplicate-key-different-content' };
          case 'duplicate-content-recently':
          case 'guild-unknown':
          case 'target':
            // Unreachable: the duplicate-content guard is off, the guild
            // gate already answered, and `targetCheck` is always `true` here.
            throw new Error(GUILD_REFUSAL_MESSAGE);
        }
        break;
      case 'failed':
        if (denied) return { status: 'refused', reason: 'unauthorized' };
        if (gatewayRefusal !== undefined) {
          return mapRoleGatewayRefusal(gatewayRefusal, input.roleId);
        }
        return { status: 'failed' };
    }
  };

  return {
    grant: (guildId, input) =>
      loggedCallAsync(deps.logger, 'roleGrant', () => runRoleWrite('grant', guildId, input)),
    remove: (guildId, input) =>
      loggedCallAsync(deps.logger, 'roleRemove', () => runRoleWrite('remove', guildId, input)),
  };
};

/**
 * The undo_json shapes, exactly as the ports above write them (slice 3,
 * Tasks 5–6): an edit stores the previous `{content, embeds}`, a pin stores
 * `{op:'unpin'}` and an unpin `{op:'pin'}`, a reaction add stores
 * `{op:'remove-reaction', emoji}` and a removal `{op:'add-reaction',
 * emoji}`, a thread-member add stores `{userIds}`, and a thread state change
 * stores `{archived}` or `{locked}`. Each kind parses only its own shape
 * (strict: an extra field refuses rather than guesses), and a row that
 * fails to parse is not undoable.
 */
const undoEditSchema = z.object({ content: z.string(), embeds: z.array(z.unknown()) }).strict();
/**
 * The stored previous embeds are Discord's own API objects, link previews
 * included. An edit accepts only rich embeds and only their authorable
 * fields, so the restore keeps exactly those: a preview (`type` link, image,
 * video, gifv, article) regenerates from the restored content by itself,
 * and sending it back could fail the PATCH (whole-branch review).
 */
const pickFields = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) picked[key] = source[key];
  return Object.keys(picked).length === 0 ? undefined : picked;
};

const restorableEmbeds = (embeds: readonly unknown[]): unknown[] =>
  embeds.flatMap((embed) => {
    if (typeof embed !== 'object' || embed === null) return [];
    const raw = embed as Record<string, unknown>;
    if (raw['type'] !== undefined && raw['type'] !== 'rich') return [];
    const top = pickFields(raw, ['title', 'description', 'url', 'timestamp', 'color']) ?? {};
    const footer = pickFields(raw['footer'], ['text', 'icon_url']);
    const image = pickFields(raw['image'], ['url']);
    const thumbnail = pickFields(raw['thumbnail'], ['url']);
    const author = pickFields(raw['author'], ['name', 'url', 'icon_url']);
    const fields = Array.isArray(raw['fields'])
      ? raw['fields'].flatMap((field) => {
          const kept = pickFields(field, ['name', 'value', 'inline']);
          return kept === undefined ? [] : [kept];
        })
      : [];
    const restored = {
      ...top,
      ...(footer !== undefined ? { footer } : {}),
      ...(image !== undefined ? { image } : {}),
      ...(thumbnail !== undefined ? { thumbnail } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(fields.length > 0 ? { fields } : {}),
    };
    return Object.keys(restored).length === 0 ? [] : [restored];
  });

const undoUnpinSchema = z.object({ op: z.literal('unpin') }).strict();
const undoPinSchema = z.object({ op: z.literal('pin') }).strict();
const undoRemoveReactionSchema = z
  .object({ op: z.literal('remove-reaction'), emoji: z.string().min(1) })
  .strict();
const undoAddReactionSchema = z
  .object({ op: z.literal('add-reaction'), emoji: z.string().min(1) })
  .strict();
const undoRemoveMembersSchema = z
  .object({ userIds: z.array(z.string().min(1)).min(1).max(25) })
  .strict();
const undoThreadStateSchema = z.union([
  z.object({ archived: z.boolean() }).strict(),
  z.object({ locked: z.boolean() }).strict(),
]);
/**
 * A role change stores only its direction: the member and role ids live in
 * the effect row the forward call claimed (batch id = the forward action
 * id), and the undo re-resolves them live through the same pre-check set.
 */
const undoRoleOpSchema = z.object({ op: z.enum(['remove-role', 'add-role']) }).strict();

/** Kinds with an inverse. Everything else cannot be undone (ADR 0116 §5). */
const REVERSIBLE_ACTION_KINDS: ReadonlySet<string> = new Set([
  'message.edit',
  'message.pin',
  'message.unpin',
  'reaction.add',
  'reaction.remove',
  'thread.members.add',
  'thread.state',
  'role.grant',
  'role.remove',
]);

const parseUndoJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

interface UndoPlan {
  readonly kind: string;
  /**
   * Set when the inverse needs more than its kind's usual permission:
   * Discord lets a thread's owner archive it, but only ManageThreads locks
   * or unlocks, whoever owns the thread.
   */
  readonly need?: TargetNeed;
  readonly capGroup: 'edit' | 'pin_react' | 'structure';
  readonly argsHash: string;
  readonly execute: () => Promise<{ resultMessageId?: string; resultThreadId?: string }>;
}

/**
 * The inverse of one ledger row (ADR 0116 §5), or `undefined` when the row
 * cannot be inverted: a kind with no inverse, a row with no `undo_json`
 * (a `thread.state` whose previous state was unknown records none), a row
 * whose `undo_json` fails its kind's schema, or a row missing the ids the
 * inverse needs. Never guesses — every one of those answers `not-undoable`
 * at the call site.
 */
const planUndo = (
  guildId: GuildId,
  discord: DiscordPort,
  row: {
    readonly kind: string;
    readonly targetChannelId: string | undefined;
    readonly resultMessageId: string | undefined;
    readonly undoJson: string | undefined;
  },
): UndoPlan | undefined => {
  if (row.undoJson === undefined) return undefined;
  const parsed = parseUndoJson(row.undoJson);
  if (parsed === undefined) return undefined;
  switch (row.kind) {
    case 'message.edit': {
      const undo = undoEditSchema.safeParse(parsed);
      const channelId = row.targetChannelId;
      const messageId = row.resultMessageId;
      if (!undo.success || channelId === undefined || messageId === undefined) return undefined;
      return {
        kind: 'message.edit',
        capGroup: 'edit',
        argsHash: argsHashFor('message.edit', {
          channel: channelId,
          message: messageId,
          content: undo.data.content,
          embeds: restorableEmbeds(undo.data.embeds),
        }),
        execute: async () => {
          await discord.editMessage(
            guildId,
            { channelId, messageId },
            {
              content: undo.data.content,
              embeds: restorableEmbeds(undo.data.embeds),
              // An undo edit that pings would notify on a restoration:
              // absent, Discord would apply its default and notify.
              allowedMentions: { parse: [], roles: [], users: [] },
            },
          );
          return { resultMessageId: messageId };
        },
      };
    }
    case 'message.pin':
    case 'message.unpin': {
      const undo =
        row.kind === 'message.pin'
          ? undoUnpinSchema.safeParse(parsed)
          : undoPinSchema.safeParse(parsed);
      const channelId = row.targetChannelId;
      const messageId = row.resultMessageId;
      if (!undo.success || channelId === undefined || messageId === undefined) return undefined;
      const pin = row.kind === 'message.unpin';
      return {
        kind: pin ? 'message.pin' : 'message.unpin',
        capGroup: 'pin_react',
        argsHash: argsHashFor(pin ? 'message.pin' : 'message.unpin', {
          channel: channelId,
          message: messageId,
        }),
        execute: async () => {
          if (pin) await discord.pinMessage(guildId, { channelId, messageId });
          else await discord.unpinMessage(guildId, { channelId, messageId });
          return { resultMessageId: messageId };
        },
      };
    }
    case 'reaction.add':
    case 'reaction.remove': {
      const undo =
        row.kind === 'reaction.add'
          ? undoRemoveReactionSchema.safeParse(parsed)
          : undoAddReactionSchema.safeParse(parsed);
      const channelId = row.targetChannelId;
      const messageId = row.resultMessageId;
      if (!undo.success || channelId === undefined || messageId === undefined) return undefined;
      const emoji = undo.data.emoji;
      const add = row.kind === 'reaction.remove';
      return {
        kind: add ? 'reaction.add' : 'reaction.remove',
        capGroup: 'pin_react',
        argsHash: argsHashFor(add ? 'reaction.add' : 'reaction.remove', {
          channel: channelId,
          message: messageId,
          emoji,
        }),
        execute: async () => {
          if (add) await discord.createReaction(guildId, { channelId, messageId }, emoji);
          else await discord.deleteOwnReaction(guildId, { channelId, messageId }, emoji);
          return { resultMessageId: messageId };
        },
      };
    }
    case 'thread.members.add': {
      const undo = undoRemoveMembersSchema.safeParse(parsed);
      const threadId = row.targetChannelId;
      if (!undo.success || threadId === undefined) return undefined;
      const userIds = [...undo.data.userIds];
      return {
        kind: 'thread.members.remove',
        capGroup: 'structure',
        argsHash: argsHashFor('thread.members.remove', { thread: threadId, userIds }),
        execute: async () => {
          for (const userId of userIds) {
            await discord.removeThreadMember(guildId, threadId, userId);
          }
          return { resultThreadId: threadId };
        },
      };
    }
    case 'thread.state': {
      const undo = undoThreadStateSchema.safeParse(parsed);
      const threadId = row.targetChannelId;
      if (!undo.success || threadId === undefined) return undefined;
      const state =
        'archived' in undo.data ? { archived: undo.data.archived } : { locked: undo.data.locked };
      return {
        kind: 'thread.state',
        capGroup: 'structure',
        ...('locked' in state ? { need: 'manage-thread' as const } : {}),
        argsHash: argsHashFor('thread.state', { thread: threadId, ...state }),
        execute: async () => {
          await discord.setThreadState(guildId, threadId, state);
          return { resultThreadId: threadId };
        },
      };
    }
    default:
      return undefined;
  }
};

/**
 * A failed live pre-check at undo time, onto the `role-unavailable` detail:
 * the member, the role or the policy moved since the forward call ran.
 */
const roleUnavailableDetail = (
  outcome: Extract<McpRoleWriteOutcome, { readonly status: 'refused' }>,
  guildId: GuildId,
  memberId: string,
  roleId: string,
): string => {
  switch (outcome.reason) {
    case 'unknown-member':
      return `member ${memberId} is no longer in guild ${guildId}`;
    case 'unknown-role':
      return `role ${roleId} no longer exists in guild ${guildId}`;
    case 'role-not-allowlisted':
      return `role ${roleId} is no longer on the bot's role allowlist`;
    case 'role-not-permitted':
      return `the grant policy now refuses role ${roleId} (${outcome.detail ?? 'unknown reason'})`;
    case 'protected-target':
      return (
        outcome.detail === 'guild-owner'
          ? `member ${memberId} is the guild owner`
          : `member ${memberId} or role ${roleId} is now protected`
      );
    default:
      return `role ${roleId} for member ${memberId} can no longer be changed (${outcome.reason})`;
  }
};

/** A gateway refusal inside an undo's execute, onto the same detail. */
const roleUnavailableGateway = (
  reason: RefusalReason,
  memberId: string,
  roleId: string,
): string => {
  switch (reason) {
    case 'protected-target':
      return `member ${memberId} or role ${roleId} is now protected`;
    case 'role-not-allowlisted':
      return `role ${roleId} is no longer on the bot's role allowlist`;
    case 'role-above-bot':
      return `the grant policy now refuses role ${roleId} (above-bot)`;
    case 'role-managed':
    case 'role-is-everyone':
      return `the grant policy now refuses role ${roleId} (managed-or-everyone)`;
    case 'role-missing':
      return `role ${roleId} no longer exists`;
    case 'unauthorized':
      return 'this account lacks roles.mutate';
    default:
      return `role ${roleId} for member ${memberId} can no longer be changed (${reason})`;
  }
};

/**
 * The inverse of a `role.grant` / `role.remove` ledger row: a removal
 * re-grants, a grant removes. The stored op names the direction; the effect
 * row the forward call claimed (batch id = the forward action id) names the
 * member and role, re-resolved live through the same pre-check set as the
 * forward call. The inverse runs through the one `runMcpAction` pipeline with
 * key `undo:<actionId>`, cap group `member_role` and no channel target, and
 * records no undo of its own: each action inverts once. A `skipped` forward
 * call recorded no undo, so it answers `not-undoable` here.
 */
const undoRoleChange = async (
  env: {
    readonly deps: HttpDeps;
    readonly principal: McpPrincipal & { readonly clientId: string; readonly tokenId: string };
    readonly discord: DiscordPort;
    readonly client: Client;
    readonly mcpLimiters: Map<GuildId, RateLimiter>;
  },
  guildId: GuildId,
  scope: GuildScope,
  row: { readonly kind: string; readonly actionId: string; readonly undoJson: string | undefined },
): Promise<McpUndoOutcome> => {
  const { deps, principal, discord, client, mcpLimiters } = env;
  const expectedOp = row.kind === 'role.grant' ? 'remove-role' : 'add-role';
  const forwardAction = row.kind === 'role.grant' ? 'grant' : 'revoke';
  const parsed = row.undoJson === undefined ? undefined : parseUndoJson(row.undoJson);
  const op = parsed === undefined ? undefined : undoRoleOpSchema.safeParse(parsed);
  if (op === undefined || !op.success || op.data.op !== expectedOp) {
    return { status: 'refused', reason: 'not-undoable', detail: row.kind };
  }
  const effect = effectRepo
    .effectsInBatch(scope, row.actionId)
    .find((entry) => entry.action === forwardAction);
  if (effect === undefined) {
    return { status: 'refused', reason: 'not-undoable', detail: row.kind };
  }
  const memberId = effect.userId;
  const roleId = effect.roleId;
  const target = await precheckRoleTarget(client, discord, scope, guildId, memberId, roleId);
  if (!target.ok) {
    return {
      status: 'refused',
      reason: 'role-unavailable',
      detail: roleUnavailableDetail(target.outcome, guildId, memberId, roleId),
    };
  }
  const inverseKind = row.kind === 'role.grant' ? 'role.remove' : 'role.grant';
  const inverseAction = row.kind === 'role.grant' ? 'revoke' : 'grant';
  const undoKey = nextUndoKey(scope, row.actionId, deps.now());
  if (undoKey === undefined) {
    return { status: 'refused', reason: 'not-undoable', detail: row.kind };
  }
  const claimUndoId = randomUUID();
  const actionDeps = {
    ...mcpActionDepsFor(deps, guildId, principal, {}),
    newActionId: () => claimUndoId,
  };
  let denied = false;
  let gatewayRefusal: RefusalReason | undefined;
  const outcome = await runMcpAction(
    actionDeps,
    {
      kind: inverseKind,
      capGroup: 'member_role',
      idempotencyKey: undoKey,
      tokenId: principal.tokenId,
      argsHash: argsHashFor(inverseKind, { member: memberId, role: roleId }),
      targetChannelId: undefined,
      dryRun: false,
      duplicateContentGuard: false,
    },
    true,
    async () => {
      const witness = authorizeRoleChange(scope, guildId, principal.accountId);
      if (witness === undefined) {
        denied = true;
        throw new Error('roles.mutate denied');
      }
      effectRepo.openBatch(scope, {
        batchId: claimUndoId,
        source: 'mcp',
        actorType: 'mcp_operator',
        actorId: principal.accountId,
        now: deps.now(),
      });
      const result = await mcpGatewayFor(mcpLimiters, deps, client, discord, scope).applyRoleEffect(
        witness,
        {
          userId: parseSnowflakeId(memberId),
          roleId: parseSnowflakeId(roleId),
          action: inverseAction,
          panelId: undefined,
          triggerRef: `mcp:${claimUndoId}`,
          source: 'mcp',
          batchId: claimUndoId,
          reason: `mcp undo ${row.kind}`,
        },
      );
      switch (result.status) {
        case 'applied':
        case 'skipped':
          // An undo records no undo of its own: each action inverts once.
          return {};
        case 'dry-run':
          // Unreachable: the pipeline answers dry runs before execute runs,
          // and an undo never asks for one.
          throw new Error('mcp gateway dry-ran inside a live undo');
        case 'refused':
          gatewayRefusal = result.reason;
          throw new Error(`mcp gateway refused: ${result.reason}`);
        case 'failed':
          throw new Error(`mcp gateway failed: ${result.code}`);
      }
    },
  );
  switch (outcome.status) {
    case 'done': {
      // Only the first undo wins: a lost race finds the mark taken and
      // answers already-undone with the winner's id rather than
      // inverting twice.
      const marked = mcpActionsRepo.markUndone(scope, row.actionId, outcome.actionId);
      if (!marked) {
        const reread = mcpActionsRepo.findActionById(scope, row.actionId);
        return {
          status: 'refused',
          reason: 'already-undone',
          detail: reread?.undoneByActionId ?? outcome.actionId,
        };
      }
      return {
        status: 'done',
        actionId: outcome.actionId,
        undoneActionId: row.actionId,
        kind: row.kind,
      };
    }
    case 'dry-run': {
      // Dry run records without executing, so the original stays
      // undoable: nothing was restored, and nothing is marked.
      return {
        status: 'dry-run',
        actionId: outcome.actionId,
        undoneActionId: row.actionId,
        kind: row.kind,
      };
    }
    case 'replayed': {
      const prior = mcpActionsRepo.findActionById(scope, outcome.actionId);
      if (prior?.status !== 'done') {
        return { status: 'refused', reason: 'undo-in-progress', detail: outcome.actionId };
      }
      mcpActionsRepo.markUndone(scope, row.actionId, outcome.actionId);
      const reread = mcpActionsRepo.findActionById(scope, row.actionId);
      return {
        status: 'refused',
        reason: 'already-undone',
        detail: reread?.undoneByActionId ?? outcome.actionId,
      };
    }
    case 'refused':
      switch (outcome.reason) {
        case 'killswitch':
          return { status: 'refused', reason: 'killswitch' };
        case 'breaker-open':
          return { status: 'refused', reason: 'breaker-open' };
        case 'rate-cap':
          return {
            status: 'refused',
            reason: 'rate-cap',
            ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
          };
        case 'key-reused-with-other-args':
        case 'duplicate-content-recently':
          // Unreachable: the key is derived from the action id and the
          // hash from the stored inverse, so one action always hashes one
          // way — and the duplicate-content guard is off.
          return { status: 'failed' };
        case 'guild-unknown':
        case 'target':
          // Unreachable: the guild gate above already answered that, and
          // `targetCheck` is always `true` here.
          throw new Error(GUILD_REFUSAL_MESSAGE);
      }
      break;
    case 'failed':
      if (denied) {
        return {
          status: 'refused',
          reason: 'role-unavailable',
          detail: 'this account lacks roles.mutate',
        };
      }
      if (gatewayRefusal !== undefined) {
        return {
          status: 'refused',
          reason: 'role-unavailable',
          detail: roleUnavailableGateway(gatewayRefusal, memberId, roleId),
        };
      }
      return { status: 'failed' };
  }
};

/**
 * The `McpActionsPort` behind `undo_action` and `list_actions` (slice 3,
 * Task 7), field by field like `healthPortFor` above.
 *
 * An undo finds the action in this guild's ledger — another guild's id
 * answers `action-not-found`, never its facts — refuses a dry run, a failed
 * row, a row that has not completed, an already-undone row, and a row with
 * no invertible state, then runs the inverse through the one `runMcpAction`
 * pipeline with key `undo:<actionId>` and the inverse's kind and cap group.
 * On `done` it names the undo with `markUndone`; a replayed undo (the same
 * key claimed twice) answers `already-undone` with the undo's action id.
 * An undo records no undo of its own: each action inverts once.
 *
 * Audit actions default to `mcp.<kind>` in `mcpActionDepsFor`, so the undo
 * lands as `mcp.message.edit`, `mcp.message.unpin` and friends — ids, the
 * outcome and `actionId`, never content (rule 4). A fault leaves one
 * allowlisted-fields error line via `loggedCallAsync` above, never content:
 * the action id and the outcome name what happened.
 */
/**
 * The undo's idempotency key for one attempt. Attempt 0 is `undo:<id>`; a
 * dry run or a failure spends its attempt without restoring anything, so the
 * next real undo takes `undo:<id>:<n>` rather than replaying that record
 * (whole-branch review: a spent key must never mark the original undone).
 */
const undoKeyFor = (actionId: string, attempt: number): string =>
  attempt === 0 ? `undo:${actionId}` : `undo:${actionId}:${attempt}`;

/** A bound on spent attempts, so a broken target cannot grow the ledger without limit. */
const UNDO_ATTEMPTS_MAX = 20;

/**
 * An undo still `claimed` this long after its claim died with the process
 * (a crash between claim and completion): nothing will ever complete it, so
 * it counts as spent rather than answering `undo-in-progress` forever. Safe
 * because every inverse sets a state — re-applying one changes nothing.
 */
const UNDO_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * The first attempt key not spent by a dry run or a failure: a fresh key,
 * or one whose row is `claimed` (in flight) or `done` (the pipeline then
 * replays it). `undefined` once every attempt is spent.
 */
const nextUndoKey = (scope: GuildScope, actionId: string, nowMs: number): string | undefined => {
  for (let attempt = 0; attempt < UNDO_ATTEMPTS_MAX; attempt += 1) {
    const key = undoKeyFor(actionId, attempt);
    const prior = mcpActionsRepo.findAction(scope, key);
    if (prior === undefined || prior.status === 'done') return key;
    if (prior.status === 'claimed' && nowMs - prior.createdAt < UNDO_CLAIM_STALE_MS) return key;
  }
  return undefined;
};

/**
 * The live permission an inverse needs — the same need its forward tool
 * resolves (ADR 0116 §5: the inverse runs through the same gateway, target
 * policy first). Thread inverses need only `post-in-thread` on a thread the
 * MCP created, like the forward member and state tools.
 */
const undoNeedFor = (scope: GuildScope, inverseKind: string, channelId: string): TargetNeed => {
  switch (inverseKind) {
    case 'message.edit':
      return 'post';
    case 'message.pin':
    case 'message.unpin':
      return 'pin';
    case 'reaction.add':
    case 'reaction.remove':
      return 'react';
    default:
      return botOwnsThread(scope, channelId) ? 'post-in-thread' : 'manage-thread';
  }
};

const actionsPortFor = (
  principal: McpPrincipal & { readonly clientId: string; readonly tokenId: string },
  deps: HttpDeps,
  discord: DiscordPort,
  /** Live target policy for the inverse: send scope ∩ the bot's permission now. */
  client: Client,
  /** The MCP gateway's per-guild rate limiters, shared with the role port. */
  mcpLimiters: Map<GuildId, RateLimiter>,
): McpActionsPort => ({
  undo: (guildId, input) =>
    loggedCallAsync(deps.logger, 'undoAction', async () => {
      const scope = deps.scopes.forGuild(guildId);
      const row = mcpActionsRepo.findActionById(scope, input.actionId);
      if (row === undefined) return { status: 'refused', reason: 'action-not-found' };
      if (row.undoneByActionId !== undefined) {
        return {
          status: 'refused',
          reason: 'already-undone',
          detail: row.undoneByActionId,
        };
      }
      if (row.status === 'dry_run') return { status: 'refused', reason: 'action-dry-run' };
      if (row.status === 'failed') return { status: 'refused', reason: 'action-failed' };
      if (row.status !== 'done') return { status: 'refused', reason: 'action-incomplete' };
      // Role changes carry no channel target: their inverse re-resolves the
      // member and role live from the effect row and re-runs the same
      // pre-check set, rather than resolving a send target.
      if (row.kind === 'role.grant' || row.kind === 'role.remove') {
        return undoRoleChange(
          { deps, principal, discord, client, mcpLimiters },
          guildId,
          scope,
          row,
        );
      }
      const plan = planUndo(guildId, discord, row);
      if (plan === undefined || row.targetChannelId === undefined) {
        return { status: 'refused', reason: 'not-undoable', detail: row.kind };
      }
      // The target policy again, live: a channel dropped from send scope or
      // a permission revoked since the forward write refuses cleanly here
      // rather than surfacing as an unknown Discord result.
      const target = await resolveSendTarget(
        client,
        scope,
        guildId,
        row.targetChannelId,
        plan.need ?? undoNeedFor(scope, plan.kind, row.targetChannelId),
      );
      if (!target.ok) {
        return {
          status: 'refused',
          reason: 'target-unavailable',
          detail: target.missing !== undefined ? `missing ${target.missing}` : target.reason,
        };
      }
      const undoKey = nextUndoKey(scope, row.actionId, deps.now());
      if (undoKey === undefined) {
        return { status: 'refused', reason: 'not-undoable', detail: row.kind };
      }
      const outcome = await runMcpAction(
        mcpActionDepsFor(
          deps,
          guildId,
          principal,
          target.derivedGrant ? { grantedByChannelId: target.grantId } : {},
        ),
        {
          kind: plan.kind,
          capGroup: plan.capGroup,
          idempotencyKey: undoKey,
          tokenId: principal.tokenId,
          argsHash: plan.argsHash,
          targetChannelId: row.targetChannelId,
          dryRun: false,
          duplicateContentGuard: false,
        },
        true,
        plan.execute,
      );
      switch (outcome.status) {
        case 'done': {
          // Only the first undo wins: a lost race finds the mark taken and
          // answers already-undone with the winner's id rather than
          // inverting twice.
          const marked = mcpActionsRepo.markUndone(scope, row.actionId, outcome.actionId);
          if (!marked) {
            const reread = mcpActionsRepo.findActionById(scope, row.actionId);
            return {
              status: 'refused',
              reason: 'already-undone',
              detail: reread?.undoneByActionId ?? outcome.actionId,
            };
          }
          return {
            status: 'done',
            actionId: outcome.actionId,
            undoneActionId: row.actionId,
            kind: row.kind,
          };
        }
        case 'dry-run': {
          // Dry run records without executing, so the original stays
          // undoable: nothing was restored, and nothing is marked.
          return {
            status: 'dry-run',
            actionId: outcome.actionId,
            undoneActionId: row.actionId,
            kind: row.kind,
          };
        }
        case 'replayed': {
          // `nextUndoKey` only hands out a key whose row is fresh, in flight
          // or done. Only a done undo restored anything, so only it may mark
          // the original; an in-flight one answers that and marks nothing.
          const prior = mcpActionsRepo.findActionById(scope, outcome.actionId);
          if (prior?.status !== 'done') {
            return { status: 'refused', reason: 'undo-in-progress', detail: outcome.actionId };
          }
          mcpActionsRepo.markUndone(scope, row.actionId, outcome.actionId);
          const reread = mcpActionsRepo.findActionById(scope, row.actionId);
          return {
            status: 'refused',
            reason: 'already-undone',
            detail: reread?.undoneByActionId ?? outcome.actionId,
          };
        }
        case 'refused':
          switch (outcome.reason) {
            case 'killswitch':
              return { status: 'refused', reason: 'killswitch' };
            case 'breaker-open':
              return { status: 'refused', reason: 'breaker-open' };
            case 'rate-cap':
              return {
                status: 'refused',
                reason: 'rate-cap',
                ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
              };
            case 'key-reused-with-other-args':
            case 'duplicate-content-recently':
              // Unreachable: the key is derived from the action id and the
              // hash from the stored inverse, so one action always hashes one
              // way — and the duplicate-content guard is off. A ledger edited
              // by hand is the only way here, and that is a failure, not a
              // refusal the model can act on.
              return { status: 'failed' };
            case 'guild-unknown':
            case 'target':
              // Unreachable: the guild gate above already answered that, and
              // every target refusal returns before the pipeline runs, so
              // `targetCheck` is always `true` here.
              throw new Error(GUILD_REFUSAL_MESSAGE);
          }
          break;
        case 'failed':
          return { status: 'failed' };
      }
    }),
  list: (guildId, input) =>
    loggedCall(deps.logger, 'listActions', () => {
      const scope = deps.scopes.forGuild(guildId);
      const limit = Math.min(Math.max(1, Math.floor(input.limit)), 100);
      return mcpActionsRepo.listActions(scope, { limit }).map((row): McpActionView => ({
        actionId: row.actionId,
        kind: row.kind,
        status: row.status,
        ...(row.targetChannelId !== undefined ? { targetChannelId: row.targetChannelId } : {}),
        ...(row.resultMessageId !== undefined ? { resultMessageId: row.resultMessageId } : {}),
        ...(row.resultThreadId !== undefined ? { resultThreadId: row.resultThreadId } : {}),
        undoable:
          row.status === 'done' &&
          row.undoneByActionId === undefined &&
          row.undoJson !== undefined &&
          REVERSIBLE_ACTION_KINDS.has(row.kind),
        createdAt: row.createdAt,
      }));
    }),
});

/**
 * The `McpReadAuditPort` behind every read tool (ADR 0050), the one writer
 * in this file: the tool layer says *what* was read (guild, action, subject,
 * result count) and this port closes over *who* read it — the OAuth token
 * id, account id and client id from the request's principal.
 *
 * A content-bearing read writes one `audit_events` row through
 * `effectRepo.recordAudit`, in the send path's vocabulary (ruling M5-D10):
 * `actor_type = 'mcp_operator'`, `actor_id = <token id>`, `via = 'http'`.
 * The `after` payload carries the account, client, token and result count —
 * never a query string, never returned content, never a message body (rule
 * 4; a log of what someone searched for is itself member content).
 *
 * A structural read is one allowlisted info line through `safeLogFields`:
 * guild id, action, account, token and client ids, result count. Arrays are
 * dropped by the allowlist, which is why `get_health` fans out one line per
 * guild at the call site instead.
 *
 * A failed audit write rethrows, because the read must fail closed — but it
 * logs before it does. The refusal the operator sees is the shared
 * `GUILD_REFUSAL_MESSAGE`, which is indistinguishable from an unreachable
 * guild; without this line a database that cannot accept audit rows would
 * look exactly like a revoked token, and the one event that must never pass
 * unnoticed would pass unnoticed.
 */
const readAuditPortFor = (
  principal: McpPrincipal & { readonly clientId: string; readonly tokenId: string },
  deps: HttpDeps,
): McpReadAuditPort => ({
  auditContentRead: (record) => {
    try {
      effectRepo.recordAudit(deps.scopes.forGuild(record.guildId), {
        at: deps.now(),
        actorType: 'mcp_operator',
        actorId: principal.tokenId,
        via: 'http',
        action: record.action,
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        before: undefined,
        after: {
          accountId: principal.accountId,
          clientId: principal.clientId,
          tokenId: principal.tokenId,
          resultCount: record.resultCount,
        },
        dryRun: false,
      });
    } catch (err) {
      deps.logger.error(
        safeLogFields({
          component: 'mcp',
          action: record.action,
          guildId: record.guildId,
          accountId: principal.accountId,
          oauthClientId: principal.clientId,
          oauthTokenId: principal.tokenId,
          err,
        }),
        'mcp read audit write failed — read refused',
      );
      throw err;
    }
  },
  logStructuralRead: (input) => {
    deps.logger.info(
      safeLogFields({
        component: 'mcp',
        action: input.action,
        guildId: input.guildId,
        accountId: principal.accountId,
        oauthClientId: principal.clientId,
        oauthTokenId: principal.tokenId,
        ...(input.resultCount !== undefined ? { count: input.resultCount } : {}),
      }),
      'mcp read',
    );
  },
});

/**
 * The `McpTaskDetailPort` behind `get_task_details` and `list_task_reminders`,
 * field by field like `healthPortFor` above. Each method rechecks the enabled
 * instance owner per call — the tool layer names the task, the daemon supplies
 * the authority — and reads through the task repositories. Archived tasks are
 * returned with `archived: true` rather than refused, so the owner can inspect
 * what left the default listing. Nothing here writes.
 */
const taskDetailPortFor = (deps: HttpDeps): McpTaskDetailPort => {
  const requireOwner = (accountId: string): boolean => {
    const account = accountRepo.findAccountById(deps.scopes.instance(), accountId);
    return account?.isOwner === true && !account.disabled;
  };
  const reminderSlots = (guildId: GuildId, taskId: string) =>
    taskNudgeRepo.reminderSlotsForTask(deps.scopes.forGuild(guildId), taskId).map((slot) => ({
      slotId: slot.slotId,
      kind: slot.kind,
      dueAt: slot.dueAt,
      state: slot.state,
    }));
  return {
    detail: (guildId, accountId, taskId) => {
      if (!requireOwner(accountId)) return undefined;
      const scope = deps.scopes.forGuild(guildId);
      const task = taskRepo.getTask(scope, taskId);
      if (!task) return undefined;
      return {
        taskId: task.taskId,
        teamId: task.teamId,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        assignmentKind: task.assignmentKind,
        assigneeId: task.assigneeId,
        assigneeIds: taskRepo.listTaskAssignees(scope, taskId),
        dueAt: task.dueAt,
        timezone: task.timezone,
        destinationId: task.destinationId,
        version: task.version,
        archived: task.archivedAt !== null,
        children: taskRepo.listChildren(scope, taskId).map((child) => ({
          childId: child.childId,
          title: child.title,
          dueAt: child.dueAt,
          status: child.status,
        })),
        reports: taskRepo.listReports(scope, taskId).map((report) => ({
          reportId: report.reportId,
          authorId: report.authorId,
          body: report.body,
          createdAt: report.createdAt,
        })),
        reminders: reminderSlots(guildId, taskId),
      };
    },
    reminders: (guildId, accountId, taskId) => {
      if (!requireOwner(accountId)) return undefined;
      if (!taskRepo.getTask(deps.scopes.forGuild(guildId), taskId)) return undefined;
      return reminderSlots(guildId, taskId);
    },
  };
};

/**
 * The `McpTaskPort` behind `list_tasks` and `list_task_teams`, field by field
 * like `healthPortFor` above. Each method rechecks the enabled instance owner
 * per call and reads through the task repositories — nothing here writes.
 * `list` passes the caller's visibility filter straight to the repository, so
 * the default answer stays open tasks while `includeDone`/`includeArchived`
 * opt back in; `teams` carries each team's members, the president role and
 * the quiet-hours row (or the default when no override is stored).
 */
const tasksPortFor = (deps: HttpDeps): McpTaskPort => {
  const requireOwner = (accountId: string): boolean => {
    const account = accountRepo.findAccountById(deps.scopes.instance(), accountId);
    return account?.isOwner === true && !account.disabled;
  };
  return {
    list: (guildId, accountId, filter) => {
      if (!requireOwner(accountId)) return undefined;
      const scope = deps.scopes.forGuild(guildId);
      return {
        teams: taskRepo.listTeams(scope).map((team) => ({ teamId: team.teamId, name: team.name })),
        tasks: taskRepo
          .listTasks(scope, {
            ...(filter.teamId !== undefined ? { teamId: filter.teamId } : {}),
            ...(filter.includeDone !== undefined ? { includeDone: filter.includeDone } : {}),
            ...(filter.includeArchived !== undefined
              ? { includeArchived: filter.includeArchived }
              : {}),
          })
          .map((task) => ({
            taskId: task.taskId,
            teamId: task.teamId,
            title: task.title,
            status: task.status,
            dueAt: task.dueAt,
            assigneeIds: taskRepo.listTaskAssignees(scope, task.taskId),
          })),
      };
    },
    teams: (guildId, accountId) => {
      if (!requireOwner(accountId)) return undefined;
      const scope = deps.scopes.forGuild(guildId);
      const quiet = taskRepo.getQuietHours(scope);
      return {
        teams: taskRepo.listTeams(scope).map((team) => ({
          teamId: team.teamId,
          name: team.name,
          categoryId: team.categoryId,
          kind: team.kind,
          announcementChannelId: team.announcementChannelId,
          leadRoleId: team.leadRoleId,
          memberRoleId: team.memberRoleId,
          members: taskBindingRepo.listTeamMemberships(scope, team.teamId).map((member) => ({
            discordUserId: member.discordUserId,
            kind: member.kind,
          })),
        })),
        presidentRoleId: taskBindingRepo.presidentRoleId(scope) ?? null,
        quietHours: quiet
          ? {
              startMinute: quiet.startMinute,
              endMinute: quiet.endMinute,
              timezone: quiet.timezone,
            }
          : { ...taskRepo.DEFAULT_QUIET_HOURS },
      };
    },
  };
};

/** Hop-by-hop headers that must not survive the Fastify → Web conversion. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

/**
 * Rebuilds the request as a Web-standard `Request` for the transport's
 * `handleRequest`. Method, path, query and headers pass through; the body is
 * re-serialised from what Fastify already parsed (`createServer` parses JSON
 * before handlers run), and handed to the transport as `parsedBody` as well,
 * so the transport never re-parses bytes that disagree with what the route
 * saw.
 */
const toWebRequest = (request: FastifyRequest): Request => {
  const host = typeof request.headers.host === 'string' ? request.headers.host : 'localhost';
  const url = `${request.protocol}://${host}${request.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  const body = request.body;
  if (
    body === undefined ||
    body === null ||
    request.method === 'GET' ||
    request.method === 'HEAD'
  ) {
    return new Request(url, { method: request.method, headers });
  }
  const raw = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(url, { method: request.method, headers, body: raw });
};

/**
 * Streams the transport's Web-standard `Response` back through the Fastify
 * reply: status, headers, then the body as a stream rather than a buffered
 * whole, so an SSE response starts flowing before the transport is done.
 * `set-cookie` is forwarded via `getSetCookie` because iterating `headers`
 * would join the values with a comma, which cookies do not survive.
 */
const sendWebResponse = (reply: FastifyReply, response: Response): FastifyReply => {
  void reply.status(response.status);
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') void reply.header(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) void reply.header('set-cookie', cookies);
  if (response.body === null) return reply.send();
  return reply.send(Readable.fromWeb(response.body));
};

export const registerMcpRoutes = (
  app: FastifyInstance,
  deps: HttpDeps,
  /** Required (ruling M4-D12): an optional client would serve three tools that silently always refuse. */
  client: Client,
  /**
   * Required (ruling M5-D11): the message gateway behind `send_message`
   * needs the port, not the client, and an optional port would serve a
   * `send_message` that registers and always fails.
   */
  discord: DiscordPort,
): void => {
  app.all(MCP_ROUTE_PATH, async (request, reply) => {
    // The opt-in, in the shape of `registerOAuthRoutes`' early return
    // (ruling PR-116): without a public origin there is nothing truthful to
    // serve, so a daemon that has not opted in answers 404 with no MCP
    // surface at all — no bearer processing, no transport, no tools. The
    // check lives in the handler rather than at registration because the
    // static-asset fallback would otherwise answer the SPA shell with a 200
    // on this path (`/mcp` is not one of its JSON-404 prefixes, and that file
    // is out of scope for this task); the observable behaviour is identical
    // to OAuth's — 404 JSON, nothing served.
    const publicUrl = deps.mcpPublicUrl;
    if (publicUrl === undefined) return reply.status(404).send({ error: 'not-found' });

    const principal = requireBearer(
      {
        scopes: deps.scopes,
        now: deps.now,
        guildIds: deps.guildIds,
        logger: deps.logger,
        mcpPublicUrl: publicUrl,
      },
      request,
      reply,
    );
    if (principal === undefined) return reply;

    /**
     * Session mode: stateless — `sessionIdGenerator` omitted, so the
     * transport mints no session id and keeps no session map. One server and
     * one transport are built per request and closed when the reply finishes;
     * there is nothing shared across requests and therefore nothing whose
     * cleanup could be missed and leak.
     *
     * Stateful was the alternative: one transport per MCP session id held in
     * a map, cleaned up on `onsessionclosed`. That buys resumability and
     * server-initiated notifications across requests — neither of which a
     * single operator polling `get_health` needs — at the price of a map that
     * leaks a transport per abandoned session if any close path is missed.
     * Stateless costs the reverse: no resumability, no cross-request
     * notifications, and one `McpServer` construction (a single tool
     * registration) per request. For one operator and one read tool, that is
     * the right trade.
     */
    const server = createMcpServer({
      principal,
      health: healthPortFor(principal, deps),
      archive: archivePortFor(deps, client, discord),
      guild: guildPortFor(client, deps, discord),
      records: recordsPortFor(principal, deps),
      send: sendPortFor(principal, deps, discord, client),
      messageWrites: messageWritesPortFor(principal, deps, discord, client),
      threadWrites: threadWritesPortFor(principal, deps, discord, client),
      actions: actionsPortFor(principal, deps, discord, client),
      readAudit: readAuditPortFor(principal, deps),
      jobs: jobsPortFor(deps),
      members: membersPortFor(deps, client),
      context: contextPortFor(deps),
      resources: resourcesPortFor(deps),
      threads: threadsPortFor(deps, client, discord),
      // Task tools are advertised only to the enabled instance owner at
      // connect time, so a non-owner token never sees them in `tools/list`
      // at all. The ports still recheck the owner on every call, so a token
      // whose owner was disabled mid-lifetime is refused rather than served.
      ...(() => {
        const ownerAccount = accountRepo.findAccountById(
          deps.scopes.instance(),
          principal.accountId,
        );
        if (ownerAccount?.isOwner !== true || ownerAccount.disabled) return {};
        return {
          taskAdmin: taskAdminPortFor(deps, client, discord),
          taskDetail: taskDetailPortFor(deps),
          tasks: tasksPortFor(deps),
        };
      })(),
    });
    const transport = new WebStandardStreamableHTTPServerTransport();
    // `server.close()` closes the transport too (`Protocol.close`), so one
    // hook covers both. `close` on the raw reply fires after the streamed
    // body is done — closing earlier would truncate the SSE stream.
    reply.raw.on('close', () => {
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(
        toWebRequest(request),
        request.body === undefined ? undefined : { parsedBody: request.body },
      );
      return sendWebResponse(reply, response);
    } catch (err) {
      // Allowlisted fields only (CLAUDE.md rule 4): the failure and where it
      // happened. Never a token, a session id, or the request itself.
      deps.logger.error(
        safeLogFields({
          component: 'mcp',
          err: err instanceof Error ? err.message : 'mcp request failed',
        }),
        'mcp request failed',
      );
      return reply.status(500).send({ error: 'internal' });
    }
  });
};
