import type { GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, requireReachableGuild, type McpPrincipal } from '../scope.js';
import { envelope, type EvidenceItem } from '../envelope.js';
import type { McpGuildChannel, McpGuildPort, McpGuildRole } from '../tools/guild.js';
import type { McpOverviewPanel, McpOverviewRule, McpRecordsPort } from '../tools/records.js';

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
  'count, panels, and rules by mode. The same card `get_server_overview` ' +
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

export type OverviewOutcome =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/**
 * Channel and role rows reuse the guild tools' locator shape (guild, row id,
 * row name, order key) with the human-readable row as `content`, so a client
 * scanning for an id finds it without parsing prose. The mapping is
 * duplicated from `tools/guild.ts` rather than imported: those helpers are
 * module-private there, and the card owns its rendering.
 */
const channelToEvidenceItem = (guildId: GuildId, channel: McpGuildChannel): EvidenceItem => ({
  authorId: guildId,
  channelId: channel.id,
  messageId: channel.name,
  timestamp: channel.type,
  content: [
    `parent: ${channel.parentName !== undefined && channel.parentId !== undefined ? `${channel.parentName} (${channel.parentId})` : '(none)'}`,
    `topic: ${channel.topic ?? '(none)'}`,
    `archive-enabled: ${channel.archiveEnabled ? 'yes' : 'no'}`,
  ].join('\n'),
});

const toHexColor = (color: number): string => `#${color.toString(16).padStart(6, '0').slice(-6)}`;

const roleToEvidenceItem = (guildId: GuildId, role: McpGuildRole): EvidenceItem => ({
  authorId: guildId,
  channelId: role.id,
  messageId: role.name,
  timestamp: `position ${String(role.position)}`,
  content: [
    `color: ${toHexColor(role.color)}`,
    `managed-by-bananasaurs: ${role.managedByBananasaurs ? 'yes' : 'no'}`,
  ].join('\n'),
});

const panelToEvidenceItem = (guildId: GuildId, panel: McpOverviewPanel): EvidenceItem => ({
  authorId: guildId,
  channelId: '(panels)',
  messageId: panel.panelId,
  timestamp: 'panel',
  content: `panel: ${panel.panelId}`,
});

/** Channels grouped by category: categorised first by category name, then the unparented. */
const byCategoryThenName = (a: McpGuildChannel, b: McpGuildChannel): number => {
  if (a.parentName === undefined && b.parentName !== undefined) return 1;
  if (a.parentName !== undefined && b.parentName === undefined) return -1;
  return (
    (a.parentName ?? '').localeCompare(b.parentName ?? '') ||
    a.name.localeCompare(b.name) ||
    (a.id < b.id ? -1 : 1)
  );
};

const countByMode = (
  rules: readonly McpOverviewRule[],
  mode: string,
): { readonly total: number; readonly enabled: number } => {
  const inMode = rules.filter((rule) => rule.mode === mode);
  return { total: inMode.length, enabled: inMode.filter((rule) => rule.enabled).length };
};

/**
 * The one card builder both doors call. The header carries counts and the
 * guild id only — every name a human typed (channels, roles, panels) rides
 * inside the enveloped items below it, never in unframed prose.
 */
export const buildOverviewCard = (input: OverviewCardInput): string => {
  const channels = [...input.channels].sort(byCategoryThenName);
  const enabledChannels = channels.filter((channel) => channel.archiveEnabled).length;
  const categoryCount = new Set(channels.map((channel) => channel.parentId ?? '')).size;
  const managedRoles = input.roles.filter((role) => role.managedByBananasaurs).length;
  const test = countByMode(input.rules, 'test');
  const observe = countByMode(input.rules, 'observe');
  const enforce = countByMode(input.rules, 'enforce');
  const enabledRules = input.rules.filter((rule) => rule.enabled).length;
  const categoryNoun = categoryCount === 1 ? 'category' : 'categories';
  const lines = [
    `Server overview for guild ${input.guildId}:`,
    `members: ${String(input.memberCount)}`,
    `channels: ${String(channels.length)} (${String(enabledChannels)} archive-enabled) in ${String(categoryCount)} ${categoryNoun}`,
    `roles: ${String(input.roles.length)} (${String(managedRoles)} managed by Bananasaurs)`,
    `panels: ${String(input.panels.length)}`,
    `rules: ${String(input.rules.length)} total (${String(enabledRules)} enabled) — by mode: ` +
      `test: ${String(test.total)} (enabled: ${String(test.enabled)}), ` +
      `observe: ${String(observe.total)} (enabled: ${String(observe.enabled)}), ` +
      `enforce: ${String(enforce.total)} (enabled: ${String(enforce.enabled)})`,
  ];
  const items: EvidenceItem[] = [
    ...channels.map((channel) => channelToEvidenceItem(input.guildId, channel)),
    ...input.roles.map((role) => roleToEvidenceItem(input.guildId, role)),
    ...input.panels.map((panel) => panelToEvidenceItem(input.guildId, panel)),
  ];
  return `${lines.join('\n')}\n\n${envelope(items)}`;
};

/**
 * Read the overview for the guild named in the resource URI. Never throws:
 * a malformed template variable is the shared refusal, and anything
 * unexpected (a port fault) is the same refusal rather than an exception out
 * of the handler — the server turns a refused outcome into a thrown error at
 * the registration boundary, so the client sees the shared message either
 * way.
 */
export const readOverviewResource = (
  principal: McpPrincipal,
  guildPort: McpGuildPort,
  recordsPort: McpRecordsPort,
  rawGuildId: unknown,
): OverviewOutcome => {
  try {
    if (typeof rawGuildId !== 'string') {
      return { ok: false, message: GUILD_REFUSAL_MESSAGE };
    }
    // The resource's own guard (ruling M4-D13): identical to the tool's, and
    // deliberately not shared with it — removing this call must open exactly
    // this door and no other.
    const gate = requireReachableGuild(principal, rawGuildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    return {
      ok: true,
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
