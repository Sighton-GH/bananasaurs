import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { safeName, structuredText } from '../structured.js';
import type { McpGuildChannel, McpGuildPort, McpGuildRole } from '../tools/guild.js';
import type { McpOverviewPanel, McpOverviewRule, McpRecordsPort } from '../tools/records.js';
import { MCP_READ_GET_SERVER_OVERVIEW, type McpReadRecord } from '../read-audit.js';

/**
 * The overview resource (slice M4, Task 6 absorbing Task 8):
 * `bananasaurs://guild/{guildId}/overview`, the same server card as
 * `get_server_overview` through a second door.
 *
 * Ruling M4-D13 — one card builder, two independently guarded doors.
 * `buildOverviewCard` below is the single function both doors call; the
 * property that matters is that each door resolves its guild through
 * `requireReachableGuild` itself. The `{guildId}` in the URI is untrusted
 * input exactly like a tool argument — parsed, resolved, refused the same
 * way — and a resource that skipped the check would be the hole ADR 0044
 * obligation 1 exists to close, reached by a different path. Step 5 of this
 * task proves the independence by removing the resource's guard and watching
 * only the resource tests go red.
 */

export const OVERVIEW_RESOURCE_NAME = 'server_overview';
export const OVERVIEW_RESOURCE_URI_TEMPLATE = 'bananasaurs://guild/{guildId}/overview';
export const OVERVIEW_RESOURCE_DESCRIPTION =
  'One compact server card: channels grouped by category, roles, member ' +
  'count, panels, and automod rule counts. The same card `get_server_overview` ' +
  'returns, for clients that prefer resources. ' +
  'Refuses when the guild is unreachable.';

export interface OverviewCardInput {
  readonly guildId: GuildId;
  readonly channels: readonly McpGuildChannel[];
  readonly roles: readonly McpGuildRole[];
  /**
   * The gateway scalar (`guild.memberCount`), never a listing size — the
   * member cache is capped and a paged listing is a sample (ruling M4-D10).
   */
  readonly memberCount: number;
  readonly rules: readonly McpOverviewRule[];
  readonly panels: readonly McpOverviewPanel[];
}

/**
 * A successful read carries the same structural record the tool door
 * carries (ADR 0050): the card is structure, not content, so the read is
 * logged, never audited. A refusal carries none.
 */
export type OverviewOutcome =
  | { readonly ok: true; readonly text: string; readonly read: McpReadRecord }
  | { readonly ok: false; readonly message: string };

/** One channel row in the card's JSON: names escaped, topics omitted, `archive` only when true, `type` omitted for plain text channels. */
const channelRow = (
  channel: McpGuildChannel,
): {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly archive?: boolean;
} => ({
  id: channel.id,
  name: safeName(channel.name),
  ...(channel.type === 'GuildText' ? {} : { type: channel.type }),
  ...(channel.archiveEnabled ? { archive: true as const } : {}),
});

const byNameThenId = (a: { name: string; id: string }, b: { name: string; id: string }): number =>
  a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);

/**
 * The one card builder both doors call. The head line carries counts and the
 * guild id only; everything else is one line of JSON: channels grouped by
 * category, then the unparented channels, roles, panels and rule counts
 * (ADR 0113). Every name a human typed rides in the JSON as an escaped
 * string via `safeName`, never in unframed prose. Topics are not in the
 * overview — `list_channels` carries them. Roles are listed highest-first
 * as `{ id, name }` with `managed: true` only when Bananasaurs manages the
 * role; colour and position live in `list_roles`. Channel entries omit
 * `type` when the channel is a plain text channel — the head line says so —
 * and every other channel type keeps it.
 */
export const buildOverviewCard = (input: OverviewCardInput): string => {
  const head =
    `Server overview for guild ${input.guildId}: ${String(input.memberCount)} members, ` +
    `${String(input.channels.length)} channels, ${String(input.roles.length)} roles, ` +
    `${String(input.panels.length)} panels, ${String(input.rules.length)} rules. ` +
    'Channels without a type are text channels.';
  const categoryChannels = input.channels.filter((channel) => channel.type === 'GuildCategory');
  const knownCategoryIds = new Set(categoryChannels.map((channel) => channel.id));
  const childChannels = input.channels.filter((channel) => channel.type !== 'GuildCategory');
  const rowsByCategory = new Map<string, McpGuildChannel[]>();
  for (const channel of childChannels) {
    if (channel.parentId === undefined) continue;
    const rows = rowsByCategory.get(channel.parentId) ?? [];
    rows.push(channel);
    rowsByCategory.set(channel.parentId, rows);
  }
  const categoryNameById = new Map<string, string>();
  for (const channel of categoryChannels) {
    categoryNameById.set(channel.id, channel.name);
  }
  for (const channel of childChannels) {
    if (channel.parentId !== undefined && !knownCategoryIds.has(channel.parentId)) {
      // A channel whose parent names a category absent from the list: the
      // card synthesises the category entry from the child's locator.
      if (!categoryNameById.has(channel.parentId)) {
        categoryNameById.set(channel.parentId, channel.parentName ?? '');
      }
    }
  }
  const categories = [...categoryNameById.entries()]
    .map(([id, name]) => ({
      id,
      name: safeName(name),
      channels: (rowsByCategory.get(id) ?? []).map(channelRow).sort(byNameThenId),
    }))
    .sort(byNameThenId);
  const uncategorised = childChannels
    .filter((channel) => channel.parentId === undefined)
    .map(channelRow)
    .sort(byNameThenId);
  const data = {
    guild: { id: input.guildId, memberCount: input.memberCount },
    categories,
    uncategorised,
    roles: [...input.roles]
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: safeName(r.name),
        ...(r.managedByBananasaurs ? { managed: true as const } : {}),
      })),
    panels: input.panels.map((p) => ({ id: p.panelId })),
    rules: {
      total: input.rules.length,
      enabled: input.rules.filter((rule) => rule.enabled).length,
    },
  };
  return structuredText(head, data);
};

/**
 * Read the overview for the guild named in the resource URI. Never throws:
 * a malformed template variable is the argument-fault message (ruling
 * M4-D18 — the shape check below runs before the guild gate, so it has
 * consulted nothing about which guilds exist), and anything unexpected (a
 * port fault) is the shared refusal rather than an exception out of the
 * handler — the server turns a refused outcome into a thrown error at the
 * registration boundary, so the client sees the message either way.
 */
export const readOverviewResource = (
  principal: McpPrincipal,
  guildPort: McpGuildPort,
  recordsPort: McpRecordsPort,
  rawGuildId: unknown,
): OverviewOutcome => {
  try {
    if (typeof rawGuildId !== 'string') {
      return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
    }
    // The resource's own guard (ruling M4-D13): identical to the tool's, and
    // deliberately not shared with it — removing this call must open exactly
    // this door and no other.
    const gate = requireReachableGuild(principal, rawGuildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    return {
      ok: true,
      read: {
        kind: 'structural',
        action: MCP_READ_GET_SERVER_OVERVIEW,
        guildIds: [gate.guildId],
        resultCount: undefined,
      },
      text: buildOverviewCard({
        guildId: gate.guildId,
        channels: guildPort.listChannels(gate.guildId),
        roles: guildPort.listRoles(gate.guildId),
        memberCount: guildPort.memberCount(gate.guildId),
        rules: recordsPort.listRules(gate.guildId),
        panels: recordsPort.listPanels(gate.guildId),
      }),
    };
  } catch {
    return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  }
};
