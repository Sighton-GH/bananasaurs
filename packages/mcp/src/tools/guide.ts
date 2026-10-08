import { z } from 'zod';
import {
  CAPABILITY_INFO,
  findGuideTopic,
  GUIDE_TOPICS,
  mcpScopeLabel,
  type Capability,
  type GuideTopic,
  type GuildId,
} from '@bananasaurs/core';
import { escapeEvidenceText } from '../envelope.js';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { registerReadTool, type ReadOutcome, type RegisterContext } from '../register.js';
import type { McpGuildHealth, McpHealthPort } from './health.js';

/**
 * `bananasaurs_guide` (ADR 0133, Task 4): the shared guide, read by connected
 * apps. With no `topic` it answers the index; with a `topic`, that topic. With
 * a reachable `guildId` a "This server right now" block follows: the guild's
 * safety switches from the health port, and this account's standing and
 * permissions there from the access port.
 *
 * The answer is static guide text plus labels, never retrieved member
 * content, so it carries no evidence envelope. The account name is the one
 * free-text field in it, and goes through the same escaper as the guild name
 * in `get_health` (ruling M4-D19).
 */

export const GUIDE_TOOL_NAME = 'bananasaurs_guide';
export const GUIDE_TOOL_DESCRIPTION =
  'How Bananasaurs works: features, permissions, connecting apps, tasks, automod, and what this connection can do. ' +
  'Call with no topic for the index. Use it to answer questions about Bananasaurs before guessing.';

/**
 * The ADR 0050 action for this read. It lives here, not in `read-audit.ts`,
 * the same way `GET_TASK_READ_ACTION` lives beside its tool.
 */
export const GUIDE_READ_ACTION = 'mcp.read.bananasaurs_guide';

/** The loose wire shapes registered with the MCP server; `guideArgsSchema` is the strict boundary. */
export const guideParams = {
  topic: z
    .string()
    .max(100)
    .describe('A topic id or title from the index, such as "permissions". Omit it for the index.')
    .optional(),
  guildId: z
    .string()
    .max(64)
    .describe(
      "Guild id, reachable by the caller. Adds this server's live safety settings and this connection's permissions.",
    )
    .optional(),
};

const guideArgsSchema = z.object(guideParams);

/** One account's standing in one guild, as the access port reads it. */
export interface McpGuildAccess {
  readonly username: string;
  readonly isOwner: boolean;
  /** Capability ids this account holds in this guild (e.g. 'tasks.manage'); empty for the owner is fine. */
  readonly permissions: readonly string[];
}

/**
 * The narrow port the live block needs. The daemon builds it per request
 * (`accessPortFor` in `apps/daemon/src/mcp/access-port.ts`).
 */
export interface McpAccessPort {
  /** undefined when the account is missing or disabled. Must read only `guildId`'s rows. */
  forGuild(accountId: string, guildId: GuildId): McpGuildAccess | undefined;
}

/**
 * The ports the guide reads. Both are optional: an absent port makes its part
 * of the live block read as unavailable, and never fails the call.
 */
export interface McpGuideDeps {
  readonly health?: McpHealthPort | undefined;
  readonly access?: McpAccessPort | undefined;
}

const UNAVAILABLE = 'unavailable right now';

const INDEX_INTRO =
  'Bananasaurs guide. Each topic is listed as id (title): summary, under its group.';
const INDEX_LAST_LINE =
  'Call bananasaurs_guide again with topic set to an id or a title above to read that topic.';

const indexText = (): string => {
  const groups = new Map<string, GuideTopic[]>();
  for (const topic of GUIDE_TOPICS) {
    const members = groups.get(topic.group) ?? [];
    members.push(topic);
    groups.set(topic.group, members);
  }
  const sections = [...groups].map(([group, members]) =>
    [group, ...members.map((topic) => `- ${topic.id} (${topic.title}): ${topic.summary}`)].join(
      '\n',
    ),
  );
  return [INDEX_INTRO, ...sections, INDEX_LAST_LINE].join('\n\n');
};

const topicText = (topic: GuideTopic): string => {
  const parts = [`# ${topic.title}`, topic.body];
  if (topic.seeAlso !== undefined && topic.seeAlso.length > 0) {
    const labels = topic.seeAlso.map((link) => `${link.label} (${link.path})`).join(', ');
    parts.push(`See also: ${labels}.`);
  }
  return parts.join('\n\n');
};

const unknownTopicMessage = (): string =>
  `No guide topic has that id or title. Valid topics: ${GUIDE_TOPICS.map((topic) => topic.id).join(', ')}.`;

/** A capability id's plain label; an id the table does not know is shown as it is. */
const capabilityLabel = (id: string): string =>
  Object.hasOwn(CAPABILITY_INFO, id) ? CAPABILITY_INFO[id as Capability].label : id;

interface LiveSafety {
  readonly safety: NonNullable<McpGuildHealth['safety']>;
  readonly installDryRun: boolean;
}

/**
 * The guild's safety state, or undefined when the health port is absent, the
 * guild is not in its answer, the guild has no settings row, or the port
 * throws. `installDryRun` reads as on when absent, the rule `get_health`
 * follows (ADR 0131).
 */
const liveSafety = (
  health: McpHealthPort | undefined,
  guildId: GuildId,
): LiveSafety | undefined => {
  if (health === undefined) return undefined;
  try {
    // One guild's entry when the port can give it, so the daemon reads only
    // this guild's ports; a port without `guild()` picks it out of the list.
    const entry =
      health.guild !== undefined
        ? health.guild(guildId)
        : health.guilds().find((guild) => guild.guildId === guildId);
    if (entry?.safety === undefined) return undefined;
    return { safety: entry.safety, installDryRun: health.installDryRun ?? true };
  } catch {
    return undefined;
  }
};

/** The access port's answer for this account and guild, or undefined when unavailable. */
const liveAccess = (
  access: McpAccessPort | undefined,
  accountId: string,
  guildId: GuildId,
): McpGuildAccess | undefined => {
  if (access === undefined) return undefined;
  try {
    return access.forGuild(accountId, guildId);
  } catch {
    return undefined;
  }
};

const onOff = (on: boolean): string => (on ? 'on' : 'off');

/** Task posts wording, the same three cases `get_health` prints (ADR 0131): dry run wins. */
const taskPostsWording = (enabled: boolean, installDryRun: boolean): string => {
  if (!enabled) return 'off';
  if (installDryRun) return 'on, held by dry run (BANANASAURS_DRY_RUN)';
  return 'on';
};

const safetyLines = (live: LiveSafety | undefined): readonly string[] => {
  if (live === undefined) return [`- Safety settings: ${UNAVAILABLE}`];
  const { safety, installDryRun } = live;
  return [
    `- Automod: ${safety.automodState}`,
    `- Dry run: ${onOff(safety.dryRun)}`,
    `- Kill switch: ${onOff(safety.killswitch)}`,
    `- Task posts: ${taskPostsWording(safety.taskPostsEnabled, installDryRun)}`,
  ];
};

const accountLines = (found: McpGuildAccess | undefined): readonly string[] => {
  if (found === undefined) {
    return [`- Your account: ${UNAVAILABLE}`, `- Your permissions on this server: ${UNAVAILABLE}`];
  }
  const standing = found.isOwner ? 'the instance owner' : 'not the instance owner';
  const labels = found.permissions.map(capabilityLabel);
  // ADR 0130: the instance owner may always manage club tasks, grant or not.
  if (found.isOwner && !found.permissions.includes('tasks.manage'))
    labels.push(`${capabilityLabel('tasks.manage')} (as instance owner)`);
  const permissions = labels.length === 0 ? 'none' : labels.join(', ');
  return [
    `- Your account: ${escapeEvidenceText(found.username)} (${standing})`,
    `- Your permissions on this server: ${permissions}`,
  ];
};

const approvalsLine = (scopes: readonly string[]): string => {
  const labels = scopes.length === 0 ? 'none' : scopes.map(mcpScopeLabel).join(', ');
  return `- This connection's approvals: ${labels}`;
};

const liveBlock = (principal: McpPrincipal, deps: McpGuideDeps, guildId: GuildId): string =>
  [
    `This server right now (guild ${guildId}):`,
    ...safetyLines(liveSafety(deps.health, guildId)),
    ...accountLines(liveAccess(deps.access, principal.accountId, guildId)),
    approvalsLine(principal.scopes),
  ].join('\n');

const guideInner = (principal: McpPrincipal, deps: McpGuideDeps, rawArgs: unknown): ReadOutcome => {
  const parsed = guideArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
  const { topic, guildId } = parsed.data;
  // The guild gate: the same reachable-guild check every read tool uses. A
  // refused guild answers before either port is read.
  let live: GuildId | undefined;
  if (guildId !== undefined) {
    const gate = requireReachableGuild(principal, guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    live = gate.guildId;
  }
  let guideBody: string;
  if (topic === undefined) {
    guideBody = indexText();
  } else {
    const found = findGuideTopic(topic);
    if (found === undefined) return { ok: false, message: unknownTopicMessage() };
    guideBody = topicText(found);
  }
  return {
    ok: true,
    text: live === undefined ? guideBody : `${guideBody}\n\n${liveBlock(principal, deps, live)}`,
    // One record per call. The index and topics read no guild's data, so
    // they name none, and the performer writes no log line (hard rule 2).
    read: {
      kind: 'structural',
      action: GUIDE_READ_ACTION,
      guildIds: live === undefined ? [] : [live],
      resultCount: undefined,
    },
  };
};

/** Never throws: a malformed argument is the argument-fault message, and anything unforeseen is the shared refusal. */
export const guideText = (
  principal: McpPrincipal,
  deps: McpGuideDeps,
  rawArgs: unknown,
): ReadOutcome => {
  try {
    return guideInner(principal, deps, rawArgs);
  } catch {
    return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  }
};

/** Registers `bananasaurs_guide` through the shared read-tool shape. */
export const registerGuideTool = (ctx: RegisterContext, deps: McpGuideDeps): void => {
  registerReadTool(ctx, GUIDE_TOOL_NAME, GUIDE_TOOL_DESCRIPTION, guideParams, (args) =>
    guideText(ctx.principal, deps, args),
  );
};
