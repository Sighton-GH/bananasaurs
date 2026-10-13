import type {
  ArchiveChannelStatus,
  GuildChannelInfo,
  ReadScopeEntry,
  SendAllowlistEntry,
} from '../../api/ops.js';

/** One display row: a category heading or a channel, with its effective state. */
export interface ScopeRow {
  readonly id: string;
  readonly kind: 'channel' | 'category';
  readonly name: string;
  readonly channelKind?: string;
  /** Effective archive state. `paused` is collecting === false: off, history kept. */
  readonly archive: 'on' | 'via-category' | 'off' | 'paused' | 'paused-via-category' | 'excluded';
  /** Name of the category a `via-category` or `paused-via-category` state comes from. */
  readonly archiveVia?: string;
  readonly read: 'on' | 'via-category' | 'off' | 'excluded';
  readonly readVia?: string;
  readonly send: 'on' | 'via-category' | 'off' | 'excluded';
  readonly sendVia?: string;
  readonly excluded: boolean;
  readonly depth: 0 | 1;
}

/** Build the display rows from the five reads, categories first with their channels beneath. */
export const buildRows = (
  channels: readonly GuildChannelInfo[],
  archiveChannels: readonly ArchiveChannelStatus[],
  allowlist: readonly SendAllowlistEntry[],
  readScope: readonly ReadScopeEntry[],
  excludedChannels: readonly string[],
): ScopeRow[] => {
  const archiveById = new Map(archiveChannels.map((a) => [a.channelId, a]));
  const allowById = new Map(allowlist.map((e) => [e.channelId, e]));
  const readById = new Map(readScope.map((e) => [e.channelId, e]));
  const nameOf = (id: string): string => channels.find((c) => c.channelId === id)?.name ?? id;
  const categoryArchiveOn = (id: string | undefined): boolean =>
    id !== undefined && (archiveById.get(id)?.scopeKind ?? 'channel') === 'category';
  const categorySendOn = (id: string | undefined): boolean =>
    id !== undefined && (allowById.get(id)?.scopeKind ?? 'channel') === 'category';
  const categoryReadOn = (id: string | undefined): boolean =>
    id !== undefined && (readById.get(id)?.scopeKind ?? 'channel') === 'category';

  const rows: ScopeRow[] = [];
  const categories = channels.filter((c) => c.kind === 'category');
  const texts = channels.filter((c) => c.kind !== 'category');

  const channelRow = (channel: GuildChannelInfo, depth: 0 | 1): ScopeRow => {
    const excluded = excludedChannels.includes(channel.channelId);
    const own = archiveById.get(channel.channelId);
    const ownRow = own !== undefined && (own.scopeKind ?? 'channel') === 'channel';
    const viaArchive =
      (own?.scopeKind === 'derived' ? own.derivedFrom : undefined) ??
      (categoryArchiveOn(channel.parentId) ? channel.parentId : undefined);
    const ownPaused = ownRow && own?.collecting === false;
    const viaPaused = viaArchive !== undefined && archiveById.get(viaArchive)?.collecting === false;
    const allowOwn = allowById.get(channel.channelId);
    const viaSend = categorySendOn(channel.parentId) ? channel.parentId : undefined;
    const readOwn = readById.get(channel.channelId);
    const viaRead = categoryReadOn(channel.parentId) ? channel.parentId : undefined;
    const archive: ScopeRow['archive'] = excluded
      ? 'excluded'
      : ownPaused
        ? 'paused'
        : ownRow
          ? 'on'
          : viaPaused
            ? 'paused-via-category'
            : viaArchive !== undefined
              ? 'via-category'
              : 'off';
    return {
      id: channel.channelId,
      kind: 'channel',
      name: channel.name,
      channelKind: channel.kind,
      archive,
      ...(archive === 'via-category' || archive === 'paused-via-category'
        ? { archiveVia: nameOf(viaArchive as string) }
        : {}),
      read: excluded
        ? 'excluded'
        : readOwn !== undefined
          ? 'on'
          : viaRead !== undefined
            ? 'via-category'
            : 'off',
      ...(!excluded && viaRead !== undefined && readOwn === undefined
        ? { readVia: nameOf(viaRead) }
        : {}),
      send: excluded
        ? 'excluded'
        : allowOwn !== undefined
          ? 'on'
          : viaSend !== undefined
            ? 'via-category'
            : 'off',
      ...(!excluded && viaSend !== undefined && allowOwn === undefined
        ? { sendVia: nameOf(viaSend) }
        : {}),
      excluded,
      depth,
    };
  };

  const grouped = new Set<string>();
  for (const category of categories) {
    const arch = archiveById.get(category.channelId);
    const allow = allowById.get(category.channelId);
    const read = readById.get(category.channelId);
    const archiveOn = (arch?.scopeKind ?? 'channel') === 'category';
    rows.push({
      id: category.channelId,
      kind: 'category',
      name: category.name,
      archive: archiveOn ? (arch?.collecting === false ? 'paused' : 'on') : 'off',
      read: (read?.scopeKind ?? 'channel') === 'category' ? 'on' : 'off',
      send: (allow?.scopeKind ?? 'channel') === 'category' ? 'on' : 'off',
      excluded: false,
      depth: 0,
    });
    for (const channel of texts.filter((c) => c.parentId === category.channelId)) {
      grouped.add(channel.channelId);
      rows.push(channelRow(channel, 1));
    }
  }
  for (const channel of texts.filter((c) => !grouped.has(c.channelId))) {
    rows.push(channelRow(channel, 0));
  }
  return rows;
};
