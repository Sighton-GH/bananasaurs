import { humaniseDuration, type GuildId, type OpsAutomodState } from '@bananasaurs/core';
import { requireAnyReachableGuild, type McpPrincipal } from '../scope.js';
import { escapeEvidenceText } from '../envelope.js';
import { MCP_READ_GET_HEALTH, type McpReadRecord } from '../read-audit.js';

/**
 * `get_health` — the one tool Task 3 ships, chosen because it takes no
 * `guildId` and is therefore the hardest case of ADR 0044 obligation 1: a
 * guild-independent tool would otherwise answer a token whose account lost
 * `mcp.authorize` everywhere after the token was minted, so
 * `requireAnyReachableGuild` below is the only thing standing between such a
 * token and a reply.
 */

export const GET_HEALTH_TOOL_NAME = 'get_health';

export const GET_HEALTH_TOOL_DESCRIPTION =
  'Process health: uptime, gateway connection, per-guild safety controls ' +
  '(kill switch, dry run, breaker), the automod switch (off, watch or on), ' +
  'job counts and scheduler lag. ' +
  'Refuses when the caller reaches no guild. Use list_jobs to see why jobs failed.';

/**
 * One reachable guild's share of the report. Projected field by field from
 * `OpsPorts` (`safetyState`, `jobCounts`, `oldestDueJobAtMs`, `guildName`) by
 * the daemon, which is the only place holding those ports — this package
 * never sees `OpsInstance` or `OpsPorts` themselves, because `OpsInstance`
 * carries write members no MCP tool may reach.
 */
export interface McpGuildHealth {
  readonly guildId: GuildId;
  readonly guildName: string | undefined;
  readonly safety:
    | {
        readonly killswitch: boolean;
        readonly dryRun: boolean;
        readonly breakerOpen: boolean;
        readonly breakerReason: string | null;
        /** ADR 0121: the guild-wide automod switch. */
        readonly automodState: OpsAutomodState;
        /** ADR 0131: the guild's task-posts switch (dry run still overrides it). */
        readonly taskPostsEnabled: boolean;
      }
    | undefined;
  readonly jobCounts: Readonly<Record<string, number>>;
  readonly schedulerLagMs: number;
}

/**
 * The narrow port `get_health` needs. Three cheap instance-level constants as
 * values, and everything that costs something behind a call.
 *
 * `gateway()` and `guilds()` are functions rather than precomputed snapshots
 * on purpose. The daemon builds one port per request, before it knows which
 * tool the request will call, and `guilds()` does a `portsFor` plus four port
 * reads for every guild in the caller's reachable set. As values, every
 * `tools/list`, every `search_messages` and every request from a token that
 * registers no tools at all paid for a health snapshot nobody read. As
 * functions, only `get_health` pays.
 *
 * Reading them at call time also makes the report fresher than the request,
 * which is the direction a health readout should err in.
 */
export interface McpHealthPort {
  readonly startedAtMs: number;
  readonly readonly: boolean;
  readonly env: string;
  gateway(): {
    readonly connected: boolean;
    readonly pingMs: number | undefined;
    readonly guildCount: number;
  };
  /** Injected, like every clock in this tree. Never `Date.now()` here. */
  now(): number;
  /** One entry per guild in the caller's reachable set; an emptied set yields an empty list. */
  guilds(): readonly McpGuildHealth[];
}

/**
 * A successful read carries the record ADR 0050 says the server must
 * perform: `get_health` returns process state, never member content, so it
 * is one info log line per reachable guild (hard rule 2 — it takes no guild
 * argument, so the per-guild fan-out is how every line still carries an
 * explicit guild id). A refusal carries none.
 */
export type HealthOutcome =
  | { readonly ok: true; readonly text: string; readonly read: McpReadRecord }
  | { readonly ok: false; readonly message: string };

/**
 * No `envelope()` around the result. The envelope marks *retrieved* content —
 * member-written Discord text that must be labelled as evidence, never
 * instructions (CLAUDE.md rule 3). Every line here is process-generated
 * (uptime, gateway state, job counts, safety flags) except the guild name,
 * which is member-controlled — anyone with Manage Server can set it, and the
 * daemon copies `guild.name` straight from the gateway — so the name goes
 * through the envelope's escaper while the rest stays unenveloped: a
 * preamble would teach the client to distrust its own operator's health
 * readout, and escaping the one member-controlled field is the narrower fix
 * (ruling M4-D19).
 */
export const renderHealth = (port: McpHealthPort): string => {
  const lines: string[] = [];
  lines.push(
    `Bananasaurs health (env ${port.env}, uptime ${humaniseDuration(Math.max(0, port.now() - port.startedAtMs))}, readonly ${port.readonly ? 'on' : 'off'})`,
  );
  // Each read once: two calls, not six, so the readout cannot describe two
  // different moments in one paragraph.
  const gateway = port.gateway();
  lines.push(
    gateway.connected
      ? `gateway: connected (${gateway.pingMs === undefined ? 'no heartbeat yet' : `${String(gateway.pingMs)}ms`}, ${String(gateway.guildCount)} guilds)`
      : 'gateway: not connected',
  );
  for (const guild of port.guilds()) {
    // Member-controlled (ruling M4-D19): escaped so a guild name carrying
    // the exact envelope delimiters cannot forge a frame in the operator's
    // model context.
    const name =
      guild.guildName === undefined ? '(name not yet known)' : escapeEvidenceText(guild.guildName);
    if (guild.safety === undefined) {
      lines.push(
        `guild ${guild.guildId} (${name}): no settings row — an operator needs to look at that`,
      );
    } else {
      const paused: string[] = [];
      if (guild.safety.killswitch) paused.push('kill switch on');
      if (guild.safety.dryRun) paused.push('dry run on');
      if (guild.safety.breakerOpen) {
        const reason =
          guild.safety.breakerReason === null ? '' : ` (${guild.safety.breakerReason})`;
        paused.push(`breaker tripped${reason}`);
      }
      const state = paused.length === 0 ? 'role changes enabled' : `paused (${paused.join(', ')})`;
      lines.push(`guild ${guild.guildId} (${name}): ${state}`);
      lines.push(`  automod ${guild.safety.automodState}`);
      lines.push(`  task posts ${guild.safety.taskPostsEnabled ? 'on' : 'off'}`);
    }
    const jobs = Object.entries(guild.jobCounts);
    const jobText =
      jobs.length === 0 ? 'none' : jobs.map(([st, n]) => `${st}=${String(n)}`).join(' ');
    const lagText =
      guild.schedulerLagMs === 0 ? 'none' : `${humaniseDuration(guild.schedulerLagMs)} behind`;
    lines.push(`  jobs: ${jobText}; scheduler lag: ${lagText}`);
    // The owner's "14 failed jobs" answer: a bare count gives no way to see
    // why, so a guild with failures points at the tool that shows them.
    const failed = guild.jobCounts['failed'] ?? 0;
    if (failed > 0) {
      lines.push(`  ${String(failed)} failed job(s): call list_jobs with this guildId to see why.`);
    }
  }
  return lines.join('\n');
};

export const getHealthText = (principal: McpPrincipal, port: McpHealthPort): HealthOutcome => {
  // ADR 0044 §4 obligation 1. `requireBearer` answers 200 with an empty
  // reachable set for a token minted before `mcp.authorize` was revoked;
  // this tool takes no guild, so this call is the whole guard. Removing it
  // answers a revoked-everywhere token with a health report.
  const gate = requireAnyReachableGuild(principal);
  if (!gate.ok) return { ok: false, message: gate.message };
  return {
    ok: true,
    text: renderHealth(port),
    read: {
      kind: 'structural',
      action: MCP_READ_GET_HEALTH,
      guildIds: principal.reachableGuilds,
      resultCount: undefined,
    },
  };
};
