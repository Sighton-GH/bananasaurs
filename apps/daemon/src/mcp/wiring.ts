import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ChannelType, type Client, type Guild } from 'discord.js';
import {
  CLUB_ASSISTANT_SKILLS,
  effectiveSkillScope,
  isInScope,
  parseSnowflakeId,
  safeLogFields,
  sendMessageEffect,
  skillScopeAllows,
  type DiscordPort,
  type GuildId,
  type Logger,
  type OpsJobRow,
} from '@bananasaurs/core';
import { resolveChannel } from '../channels/resolver.js';
import { requireBearer, type HttpDeps } from '@bananasaurs/http';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  createMcpServer,
  GUILD_REFUSAL_MESSAGE,
  MEMBER_LISTING_CAP,
  type McpArchiveMessage,
  type McpArchivePort,
  type McpContextPort,
  type McpGuildHealth,
  type McpGuildPort,
  type McpHealthPort,
  type McpJob,
  type McpJobsPort,
  type McpMemberProfile,
  type McpMembersPort,
  type McpPrincipal,
  type McpReadAuditPort,
  type McpRecordsPort,
  type McpSendPort,
} from '@bananasaurs/mcp';
import {
  archiveRepo,
  archiveSearchRepo,
  assistantRepo,
  automodAdminRepo,
  effectRepo,
  guildRepo,
  loggingRepo,
  mcpSendRepo,
  modCaseRepo,
  panelRepo,
  roleRepo,
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
 * Projects the archive row to the six fields `packages/mcp` reads, field by
 * field like every other port here. `retentionClass`, `caseId`, `deletedAt`
 * and `editedAt` stop at this boundary: they were crossing it and being read
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
const archivePortFor = (deps: HttpDeps, client: Client): McpArchivePort => ({
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
  botUserId: () => client.user?.id ?? undefined,
});

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
      if (includeArchived) {
        // Review S4: the cache cannot answer this — the default sweeper
        // evicts archived threads (node_modules discord.js Options.js), so
        // an includeArchived read from cache silently dropped them. The
        // REST listing pages active + archived and never returns private
        // threads (review B4 lives in the port's filter too).
        return loggedCall(deps.logger, 'listThreads', () =>
          discord.listPublicThreads(guildId, channelId).then((threads) =>
            threads.map((thread) => ({
              id: thread.id,
              name: thread.name,
              parentId: channelId,
              archived: thread.archived,
            })),
          ),
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
          },
        ];
      });
      return Promise.resolve(active.filter((thread) => !thread.archived));
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
 * The `McpSendPort` behind `send_message` (slice M5), field by field like
 * `healthPortFor` above. It builds the `MessageGatewayDeps` the
 * `sendMessageEffect` in `packages/core/src/effects/message-gateway.ts`
 * needs — safety state and the allowlist, the `mcp_sends` ledger, and the
 * audit write — over the real repositories, and calls the effect. The
 * gateway's `MessageOutcome` is mapped onto the tool's `McpSendOutcome`
 * explicitly: `guild-unknown` throws the shared refusal (the tool layer turns
 * every port throw into it, and a missing guild row reads as "not yours"),
 * and the `failed` code stays in the daemon's logs rather than reaching the
 * model. A fault leaves one allowlisted-fields error line via
 * `loggedCallAsync` above — never message content (rule 4): the channel id
 * and the outcome name what happened, and the content lives only in
 * `mcp_sends` and in Discord.
 */
const sendPortFor = (
  principal: McpPrincipal & { readonly clientId: string; readonly tokenId: string },
  deps: HttpDeps,
  discord: DiscordPort,
  /**
   * The same live client the guild tools read (C2 send-time defence in
   * depth): the gateway's `isChannelInGuild` is answered from
   * `client.guilds.cache`, so a stale allowlist row for a channel outside
   * the guild is refused before any Discord call.
   */
  client: Client,
): McpSendPort => ({
  send: (guildId, input) =>
    loggedCallAsync(deps.logger, 'sendMessage', async () => {
      const scope = deps.scopes.forGuild(guildId);
      const resolved = await resolveChannel(client, guildId, parseSnowflakeId(input.channelId));
      if (resolved === undefined || !resolved.postable) {
        return { status: 'refused', reason: 'channel-not-in-guild' };
      }
      if (resolved.isPrivateThread && !mcpSendRepo.isChannelAllowed(scope, input.channelId)) {
        return { status: 'refused', reason: 'private-thread' };
      }
      // Review M3: the granting row's id comes from the one predicate that
      // owns the precedence — the nested ternary this replaces was a second,
      // driftable copy of it (and missed the private-thread rule).
      const grantId = isInScope('send', {
        channelId: resolved.channelId,
        parentChannelId: resolved.parentChannelId,
        categoryId: resolved.categoryId,
        isPrivateThread: resolved.isPrivateThread,
        hasOwnRow: (id) => mcpSendRepo.isChannelAllowed(scope, id),
        hasCategoryRow: (id) => mcpSendRepo.isScopeAllowed(scope, id, 'category'),
        isExcluded: (id) => loggingRepo.isChannelExcluded(scope, id),
        parentIncludesThreads: () => true,
      });
      const derivedGrant = grantId !== undefined && grantId !== input.channelId;
      const authorized = grantId !== undefined;
      const outcome = await sendMessageEffect(
        {
          guildId,
          discord,
          logger: deps.logger,
          now: deps.now,
          state: {
            // `readSafetyState` carries more than the send needs; the gateway
            // declares the narrow shape it reads, so extra columns cannot
            // leak across this boundary the way they did before the archive
            // port's projection.
            read: () => guildRepo.readSafetyState(scope),
            isChannelAllowed: () => authorized,
            isChannelInGuild: () => true,
          },
          sends: {
            find: (idempotencyKey) => mcpSendRepo.findSend(scope, idempotencyKey),
            claim: (claim) => mcpSendRepo.claimSend(scope, claim),
            recordMessageId: (record) => {
              mcpSendRepo.recordSentMessageId(scope, record);
            },
            countSince: (sinceMs) => mcpSendRepo.countSendsSince(scope, sinceMs),
            // No repository function (Task 1 needed none): the window is
            // sixty seconds, so the bounded `listSends({ sinceMs })` read
            // plus an in-memory match is the whole query.
            findRecentByContent: (contentHash, channelId, sinceMs) =>
              mcpSendRepo
                .listSends(scope, { sinceMs })
                .some((row) => row.contentHash === contentHash && row.channelId === channelId),
          },
          audit: {
            record: (record) => {
              effectRepo.recordAudit(scope, {
                at: record.atMs,
                actorType: 'mcp_operator',
                actorId: record.tokenId,
                // Ruling M5-D10: `via` is the transport vocabulary — this
                // call arrived over HTTP on the dashboard's own Fastify app
                // — and `actor_type` is the identity. Do not "fix" this to
                // `'mcp'`: the CHECK forbids it, and the actor type already
                // answers who made the call.
                via: 'http',
                action: 'mcp.message.sent',
                subjectType: 'channel',
                subjectId: record.channelId,
                before: undefined,
                // The channel, the credential and the outcome — never the
                // content (rule 4). Content lives in `mcp_sends` and in
                // Discord.
                after: {
                  clientId: principal.clientId,
                  tokenId: record.tokenId,
                  outcome: record.outcome,
                  ...(record.messageId !== undefined ? { messageId: record.messageId } : {}),
                  ...(derivedGrant
                    ? { authorization: 'derived', grantedByChannelId: grantId }
                    : {}),
                },
                dryRun: record.dryRun,
              });
            },
          },
        },
        {
          channelId: parseSnowflakeId(input.channelId),
          content: input.content,
          idempotencyKey: input.idempotencyKey,
          tokenId: principal.tokenId,
        },
      );
      switch (outcome.status) {
        case 'sent':
          return { status: 'sent', messageId: outcome.messageId };
        case 'dry-run':
          return { status: 'dry-run' };
        case 'replayed':
          return { status: 'replayed', messageId: outcome.messageId };
        case 'refused':
          if (outcome.reason === 'guild-unknown') throw new Error(GUILD_REFUSAL_MESSAGE);
          // The gateway's reasons map one to one onto this package's
          // `McpSendRefusal` — including `channel-not-in-guild`, which keeps
          // its own text (N3) rather than borrowing the allowlist text, so the
          // model is not pointed at a command that would refuse the same id.
          // Never the content, never a throw.
          return { status: 'refused', reason: outcome.reason };
        case 'failed':
          return { status: 'failed' };
      }
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
      archive: archivePortFor(deps, client),
      guild: guildPortFor(client, deps, discord),
      records: recordsPortFor(principal, deps),
      send: sendPortFor(principal, deps, discord, client),
      readAudit: readAuditPortFor(principal, deps),
      jobs: jobsPortFor(deps),
      members: membersPortFor(deps, client),
      context: contextPortFor(deps),
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
