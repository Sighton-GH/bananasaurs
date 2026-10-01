import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { safeName } from '../structured.js';
import { envelope } from '../envelope.js';
import { MCP_READ_GET_SERVER_CONTEXT } from '../read-audit.js';
import { registerReadTool, type ReadOutcome, type RegisterContext } from '../register.js';

/**
 * `get_server_context` — the operator model orientation call: the
 * owner-written server card (the same card the assistant's `server_info`
 * sees), the club time zone, the current time, and the enabled skills'
 * names and descriptions.
 *
 * The card is owner-typed prose, so it travels inside `envelope()` (which
 * withholds detector hits — ADR 0110). The skills are catalogue entries,
 * rendered as one compact JSON line with `safeName` framing, like every
 * other structured string (ADR 0110 §2).
 *
 * The port takes the already-resolved `GuildId`, never raw input (hard rule
 * 2). The daemon projects the assistant repositories field by field in
 * `apps/daemon/src/mcp/wiring.ts` — this package never sees storage
 * handles.
 */

export const GET_SERVER_CONTEXT_TOOL_NAME = 'get_server_context';
export const GET_SERVER_CONTEXT_TOOL_DESCRIPTION =
  'Server card, club time zone, current time and enabled assistant skills for one guild. ' +
  'The card is owner-written text, framed as evidence. ' +
  'Refuses when the guild is unreachable.';

export interface McpContextSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/**
 * The narrow port the context tool needs. `serverCard` is the owner-written
 * server description ('' when unset); `timeZone` is BANANASAURS_TIME_ZONE;
 * `skills` are the guild's enabled assistant skills. Every method takes the
 * already-resolved `GuildId`. A guild the daemon cannot serve surfaces as a
 * throw, which the tool below turns into the shared refusal, never an
 * exception out of the handler.
 */
export interface McpContextPort {
  /** Owner-written server description (the assistant's server card); '' when unset. */
  readonly serverCard: (guildId: GuildId) => string;
  readonly timeZone: string;
  readonly now: () => number;
  /** Enabled assistant skills for the guild: id, name, one-line description. */
  readonly skills: (guildId: GuildId) => readonly McpContextSkill[];
}

const getServerContextArgsSchema = z.object({
  guildId: z.string(),
});

/**
 * The loose wire shape registered with the MCP server. Deliberately without
 * refinements: this documents the wire type for clients while the strict
 * schema above stays the single boundary.
 */
export const getServerContextParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
};

/** The placeholder rendered when the owner never set a server description. */
export const NO_SERVER_CARD_MARKER = '(no server description set)';

const refuse = (): ReadOutcome => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): ReadOutcome => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/**
 * The `now` instant in the guild's own time zone, `YYYY-MM-DDTHH:MM:SS` —
 * what the head's "now" means next to the named zone. A bad zone throws,
 * which the caller turns into the shared refusal.
 */
const localIso = (at: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
};

const getServerContextInner = (
  principal: McpPrincipal,
  port: McpContextPort,
  rawArgs: unknown,
): ReadOutcome => {
  const parsed = getServerContextArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  // The guild gate: parses the id and refuses malformed and unreachable
  // identically — removing this call answers any guild's server card.
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const at = port.now();
  const card = port.serverCard(gate.guildId);
  const skills = port.skills(gate.guildId);
  const head = `Server context for guild ${gate.guildId} (time zone ${port.timeZone}, now ${localIso(at, port.timeZone)}).`;
  const cardFrame = envelope([
    {
      authorId: 'owner',
      channelId: 'server-card',
      messageId: 'server-card',
      timestamp: new Date(at).toISOString(),
      content: card === '' ? NO_SERVER_CARD_MARKER : card,
    },
  ]);
  const skillsLine = JSON.stringify({
    skills: skills.map((skill) => ({
      id: skill.id,
      name: safeName(skill.name),
      description: safeName(skill.description),
    })),
  });
  return {
    ok: true,
    text: [head, cardFrame, `Enabled assistant skills:\n${skillsLine}`].join('\n\n'),
    read: {
      kind: 'content',
      action: MCP_READ_GET_SERVER_CONTEXT,
      guildId: gate.guildId,
      subjectType: 'guild',
      subjectId: undefined,
      resultCount: 1,
    },
  };
};

/**
 * Never throws: a malformed argument is the argument-fault message, and
 * anything unexpected (a port fault) is the shared refusal rather than an
 * exception out of the handler.
 */
export const getServerContextText = (
  principal: McpPrincipal,
  port: McpContextPort,
  rawArgs: unknown,
): ReadOutcome => {
  try {
    return getServerContextInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};

/** Registers the context tool through the shared read-tool shape. */
export const registerContextTools = (ctx: RegisterContext, port: McpContextPort): void => {
  registerReadTool(
    ctx,
    GET_SERVER_CONTEXT_TOOL_NAME,
    GET_SERVER_CONTEXT_TOOL_DESCRIPTION,
    getServerContextParams,
    (args) => getServerContextText(ctx.principal, port, args),
  );
};
