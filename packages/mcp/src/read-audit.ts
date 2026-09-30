import type { GuildId } from '@bananasaurs/core';

/**
 * ADR 0050 — the read-logging contract for the MCP operator connector.
 *
 * Every successful read annotates its outcome with one of these records; the
 * server (`server.ts`) performs it through `McpReadAuditPort` before the
 * answer leaves the handler, so a read that cannot be recorded is refused
 * rather than served unrecorded. A refusal annotates nothing: nothing was
 * read, and an unreachable guild id has no row to key an audit row against.
 *
 * The split is by whether the tool touches members' words. Content-bearing
 * tools (archived messages, moderation cases, the audit trail) write one
 * `audit_events` row each. Structural tools (health, channels, roles,
 * members, the overview card) write one allowlisted info log line and no
 * audit row — an audit row per structural read would bury the
 * human-meaningful signal the audit trail exists to carry.
 *
 * What a record may carry is fixed by these types: guild id, tool action,
 * subject id, result count. There is no field a query string, a message
 * body or returned content could ride in on, by construction — a log of
 * what someone searched for is itself a record of member content.
 */

export const MCP_READ_SEARCH_MESSAGES = 'mcp.read.search_messages';
export const MCP_READ_READ_CHANNEL_HISTORY = 'mcp.read.read_channel_history';
export const MCP_READ_GET_MESSAGE = 'mcp.read.get_message';
export const MCP_READ_LIST_MOD_CASES = 'mcp.read.list_mod_cases';
export const MCP_READ_GET_MOD_CASE = 'mcp.read.get_mod_case';
export const MCP_READ_LIST_AUDIT_EVENTS = 'mcp.read.list_audit_events';
export const MCP_READ_GET_HEALTH = 'mcp.read.get_health';
export const MCP_READ_LIST_CHANNELS = 'mcp.read.list_channels';
export const MCP_READ_LIST_ROLES = 'mcp.read.list_roles';
export const MCP_READ_LIST_MEMBERS = 'mcp.read.list_members';
export const MCP_READ_LIST_THREADS = 'mcp.read.list_threads';
export const MCP_READ_GET_SERVER_OVERVIEW = 'mcp.read.get_server_overview';
export const MCP_READ_LIST_JOBS = 'mcp.read.list_jobs';
export const MCP_READ_GET_JOB = 'mcp.read.get_job';
export const MCP_READ_GET_MEMBER = 'mcp.read.get_member';
export const MCP_READ_SEARCH_MEMBERS = 'mcp.read.search_members';
export const MCP_READ_GET_SERVER_CONTEXT = 'mcp.read.get_server_context';
export const MCP_READ_SEARCH_RESOURCES = 'mcp.read.search_resources';
export const MCP_READ_OPEN_RESOURCE = 'mcp.read.open_resource';

/**
 * One durable audit row for a read that returned member content or
 * moderation history. `subjectType`/`subjectId` name the single thing read
 * when there is one (`channel`, `message`, `mod_case`) and fall back to
 * `guild` with no subject id for guild-wide reads (search, listings).
 */
export interface McpContentReadRecord {
  readonly kind: 'content';
  /** One of the `mcp.read.*` constants above; becomes the row's `action`. */
  readonly action: string;
  readonly guildId: GuildId;
  readonly subjectType: string;
  readonly subjectId: string | undefined;
  readonly resultCount: number;
}

/**
 * One info log line per guild for a read that returned structure only.
 * `get_health` takes no guild argument, so its record carries the whole
 * reachable set and the performer writes one line per guild (hard rule 2 —
 * every log line carries an explicit guild id).
 */
export interface McpStructuralReadRecord {
  readonly kind: 'structural';
  readonly action: string;
  readonly guildIds: readonly GuildId[];
  readonly resultCount: number | undefined;
}

export type McpReadRecord = McpContentReadRecord | McpStructuralReadRecord;

/**
 * The per-request port the daemon implements (`readAuditPortFor` in
 * `apps/daemon/src/mcp/wiring.ts`). The tool layer says *what* was read; the
 * port closes over *who* read it — the OAuth token id, account id and
 * client id never enter `packages/mcp`, and no repository handle crosses
 * this boundary either (ruling M4-D14 intact).
 */
export interface McpReadAuditPort {
  /** Writes one `audit_events` row. Throws are the caller's refusal. */
  readonly auditContentRead: (record: McpContentReadRecord) => void;
  /** Emits one allowlisted info log line. */
  readonly logStructuralRead: (input: {
    readonly guildId: GuildId;
    readonly action: string;
    readonly resultCount: number | undefined;
  }) => void;
}

/**
 * The single dispatch every tool handler in `server.ts` runs after a
 * successful read and before the answer is returned: one audit row for a
 * content read, one log line per guild for a structural read. Exactly one
 * call per successful tool call, so "a content-bearing read writes exactly
 * one audit row" holds by construction.
 */
export const performReadRecord = (port: McpReadAuditPort, record: McpReadRecord): void => {
  if (record.kind === 'content') {
    port.auditContentRead(record);
    return;
  }
  for (const guildId of record.guildIds) {
    port.logStructuralRead({ guildId, action: record.action, resultCount: record.resultCount });
  }
};
