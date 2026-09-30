import { describe, expect, it, vi } from 'vitest';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import { STRUCTURED_NOTE } from '../structured.js';
import { MCP_READ_GET_MEMBER, MCP_READ_SEARCH_MEMBERS } from '../read-audit.js';
import {
  GET_MEMBER_TOOL_NAME,
  SEARCH_MEMBERS_TOOL_NAME,
  getMemberText,
  searchMembersText,
  type McpMemberProfile,
  type McpMembersPort,
} from './members.js';
import type { McpGuildPort, McpGuildRole } from './guild.js';

/**
 * Task 5, tool layer: `get_member` / `search_members` over fakes — the same
 * seam the daemon's real port implements, so the guard behaviour pinned here
 * (refusals, role-name resolution, inactivity from the archive, paging) holds
 * whichever implementation sits behind it.
 */

const GUILD = parseGuildId('111111111111111111');
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_789_000_000_000;

const R1 = '222222222222222221';
const R2 = '222222222222222222';
const R3 = '222222222222222223';

const M1 = '333333333333333331';
const M2 = '333333333333333332';
const M3 = '333333333333333333';
const M4 = '333333333333333334';
const M5 = '333333333333333335';

const principal: McpPrincipal = {
  accountId: 'acct_test',
  reachableGuilds: [GUILD],
  scopes: ['bananasaurs:read'],
};

const roles: readonly McpGuildRole[] = [
  { id: R1, name: 'Car Team A', position: 3, color: 0, managedByBananasaurs: false },
  { id: R2, name: 'Club Member', position: 2, color: 0, managedByBananasaurs: false },
  { id: R3, name: 'Tech Team', position: 1, color: 0, managedByBananasaurs: false },
];

const member = (over: Partial<McpMemberProfile> & { readonly id: string }): McpMemberProfile => ({
  username: 'user',
  displayName: 'User',
  nickname: undefined,
  roleIds: [],
  joinedAt: 1_700_000_000_000,
  ...over,
});

const fiveMembers = (): readonly McpMemberProfile[] => [
  member({ id: M1, username: 'ana', displayName: 'Ana', roleIds: [R1, R2] }),
  member({
    id: M2,
    username: 'bo',
    displayName: 'Bo',
    nickname: 'Bobo',
    roleIds: [R1],
  }),
  member({ id: M3, username: 'cy', displayName: 'Cy', roleIds: [R1], joinedAt: undefined }),
  member({ id: M4, username: 'di', displayName: 'Di', roleIds: [R2, R3] }),
  member({
    id: M5,
    username: 'ed',
    displayName: 'Ed',
    roleIds: [R3],
    joinedAt: Date.parse('2026-09-20T00:00:00.000Z'),
  }),
];

const lastById = (): ReadonlyMap<string, number> =>
  new Map<string, number>([
    [M1, NOW - DAY_MS],
    [M2, NOW - 20 * DAY_MS],
    [M4, NOW - 2 * DAY_MS],
    [M5, NOW - DAY_MS],
  ]);

const portWith = (
  members: readonly McpMemberProfile[],
  over: {
    readonly last?: ReadonlyMap<string, number>;
    readonly truncated?: boolean;
    readonly now?: number;
  } = {},
): McpMembersPort & { readonly seenLast: string[][] } => {
  const seenLast: string[][] = [];
  const last = over.last ?? lastById();
  return {
    seenLast,
    listAllMembers: (_guildId: GuildId) =>
      Promise.resolve({ members, truncated: over.truncated ?? false }),
    lastMessageAt: (_guildId: GuildId, authorIds: readonly string[]) => {
      seenLast.push([...authorIds]);
      const out = new Map<string, number>();
      for (const id of authorIds) {
        const at = last.get(id);
        if (at !== undefined) out.set(id, at);
      }
      return out;
    },
    now: () => over.now ?? NOW,
  };
};

const guildWith = (roleList: readonly McpGuildRole[] = roles): McpGuildPort => ({
  listChannels: () => [],
  listThreads: async () => [],
  listRoles: () => roleList,
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 0,
});

const jsonOf = (text: string): Record<string, unknown> => {
  const lines = text.split('\n');
  expect(lines[1]).toBe(STRUCTURED_NOTE);
  return JSON.parse(lines[2] ?? '') as Record<string, unknown>;
};

const headOf = (text: string): string => text.split('\n')[0] ?? '';

const textOf = async (
  outcome: { readonly ok: boolean; readonly text?: string },
): Promise<string> => {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('expected ok:true');
  return (outcome as { readonly text: string }).text;
};

describe('member tools refuse without a reachable guild', () => {
  it('unreachable guild is the shared refusal and listAllMembers is not called', async () => {
    const listAllMembers = vi.fn(
      (_guildId: GuildId): Promise<{ members: readonly McpMemberProfile[]; truncated: boolean }> =>
        Promise.resolve({ members: fiveMembers(), truncated: false }),
    );
    const port: McpMembersPort = {
      listAllMembers,
      lastMessageAt: () => new Map(),
      now: () => NOW,
    };
    const stranger: McpPrincipal = { ...principal, reachableGuilds: [] };
    await expect(
      getMemberText(stranger, port, guildWith(), { guildId: String(GUILD), member: M1 }),
    ).resolves.toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    await expect(
      searchMembersText(stranger, port, guildWith(), { guildId: String(GUILD) }),
    ).resolves.toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(listAllMembers).not.toHaveBeenCalled();
  });
});

describe('get_member', () => {
  it('finds m4 by id with role names Club Member and Tech Team', async () => {
    const outcome = await getMemberText(principal, portWith(fiveMembers()), guildWith(), {
      guildId: String(GUILD),
      member: M4,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = jsonOf(outcome.text);
    const row = data['member'] as Record<string, unknown>;
    expect(row['id']).toBe(M4);
    const roleNames = (row['roles'] as ReadonlyArray<{ id: string; name: string }>).map(
      (r) => r.name,
    );
    expect(roleNames).toEqual(['Club Member', 'Tech Team']);
    expect(row['lastMessageAt']).toBe(new Date(NOW - 2 * DAY_MS).toISOString());
  });

  it("matches '@bobo' by nickname and 'Ana' by display, case-insensitively", async () => {
    const port = portWith(fiveMembers());
    const byNick = await getMemberText(principal, port, guildWith(), {
      guildId: String(GUILD),
      member: '@bobo',
    });
    expect(byNick.ok).toBe(true);
    if (!byNick.ok) return;
    expect((jsonOf(byNick.text)['member'] as Record<string, unknown>)['id']).toBe(M2);

    const byDisplay = await getMemberText(principal, port, guildWith(), {
      guildId: String(GUILD),
      member: 'Ana',
    });
    expect(byDisplay.ok).toBe(true);
    if (!byDisplay.ok) return;
    expect((jsonOf(byDisplay.text)['member'] as Record<string, unknown>)['id']).toBe(M1);
  });

  it('ambiguous display answers candidates and tells the caller to pass an id', async () => {
    const sams: readonly McpMemberProfile[] = [
      member({ id: M1, username: 'sam-one', displayName: 'Sam' }),
      member({ id: M2, username: 'sam-two', displayName: 'sam' }),
      member({ id: M3, username: 'other', displayName: 'Other' }),
    ];
    const outcome = await getMemberText(principal, portWith(sams), guildWith(), {
      guildId: String(GUILD),
      member: 'sam',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = jsonOf(await textOf(outcome));
    expect(data['member']).toBeNull();
    const candidates = data['candidates'] as ReadonlyArray<Record<string, unknown>>;
    expect(candidates.map((c) => c['id']).sort()).toEqual([M1, M2].sort());
    expect(headOf(outcome.text)).toContain('Pass an id');
  });

  it('no match answers a null member', async () => {
    const outcome = await getMemberText(principal, portWith(fiveMembers()), guildWith(), {
      guildId: String(GUILD),
      member: 'zz',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(headOf(outcome.text)).toBe('No member matches "zz".');
    expect(jsonOf(outcome.text)).toMatchObject({ member: null });
  });
});

describe('search_members', () => {
  it('who has Car Team A but not Club Member: exactly m2 and m3', async () => {
    const outcome = await searchMembersText(principal, portWith(fiveMembers()), guildWith(), {
      guildId: String(GUILD),
      hasRoles: ['Car Team A'],
      lacksRoles: ['@club member'],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = jsonOf(outcome.text);
    const members = data['members'] as ReadonlyArray<Record<string, unknown>>;
    expect(members.map((m) => m['id']).sort()).toEqual([M2, M3].sort());
  });

  it('inactiveDays 14 finds m2 and m3; null counts as inactive', async () => {
    const outcome = await searchMembersText(principal, portWith(fiveMembers()), guildWith(), {
      guildId: String(GUILD),
      inactiveDays: 14,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = jsonOf(outcome.text);
    const members = data['members'] as ReadonlyArray<Record<string, unknown>>;
    expect(members.map((m) => m['id']).sort()).toEqual([M2, M3].sort());
  });

  it("nameContains 'b' matches username, displayName or nickname only", async () => {
    const outcome = await searchMembersText(principal, portWith(fiveMembers()), guildWith(), {
      guildId: String(GUILD),
      nameContains: 'b',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = jsonOf(outcome.text);
    const members = data['members'] as ReadonlyArray<Record<string, unknown>>;
    expect(members.map((m) => m['id'])).toEqual([M2]);
  });

  it('joinedAfter filters on joinedAt and excludes unknown joinedAt', async () => {
    const outcome = await searchMembersText(principal, portWith(fiveMembers()), guildWith(), {
      guildId: String(GUILD),
      joinedAfter: Date.parse('2026-09-01T00:00:00.000Z'),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = jsonOf(outcome.text);
    const members = data['members'] as ReadonlyArray<Record<string, unknown>>;
    expect(members.map((m) => m['id'])).toEqual([M5]);
  });

  it('an unknown role name answers the resolver message as ok:false', async () => {
    const outcome = await searchMembersText(principal, portWith(fiveMembers()), guildWith(), {
      guildId: String(GUILD),
      hasRoles: ['No Such Role'],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('No role named');
  });

  it('pages with limit/offset sorted by displayName then id', async () => {
    const port = portWith(fiveMembers());
    const first = await searchMembersText(principal, port, guildWith(), {
      guildId: String(GUILD),
      limit: 2,
      offset: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstData = jsonOf(first.text);
    const firstRows = firstData['members'] as ReadonlyArray<Record<string, unknown>>;
    expect(firstRows.map((m) => m['id'])).toEqual([M1, M2]);
    expect(headOf(first.text)).toContain('Next offset: 2.');

    const last = await searchMembersText(principal, port, guildWith(), {
      guildId: String(GUILD),
      limit: 2,
      offset: 4,
    });
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    const lastData = jsonOf(last.text);
    expect((lastData['members'] as ReadonlyArray<unknown>)).toHaveLength(1);
    expect(headOf(last.text)).not.toContain('Next offset');
  });

  it('a capped listing says so in the head', async () => {
    const outcome = await searchMembersText(
      principal,
      portWith(fiveMembers(), { truncated: true }),
      guildWith(),
      { guildId: String(GUILD) },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(headOf(outcome.text)).toContain('member listing was capped at 5,000');
  });
});

describe('member read records', () => {
  it('get_member records a structural read with one row', async () => {
    const outcome = await getMemberText(principal, portWith(fiveMembers()), guildWith(), {
      guildId: String(GUILD),
      member: M4,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.read).toEqual({
      kind: 'structural',
      action: MCP_READ_GET_MEMBER,
      guildIds: [GUILD],
      resultCount: 1,
    });
  });

  it('search_members records a structural read with the row count', async () => {
    const outcome = await searchMembersText(principal, portWith(fiveMembers()), guildWith(), {
      guildId: String(GUILD),
      hasRoles: ['Car Team A'],
      lacksRoles: ['@club member'],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.read).toEqual({
      kind: 'structural',
      action: MCP_READ_SEARCH_MEMBERS,
      guildIds: [GUILD],
      resultCount: 2,
    });
  });
});

describe('member argument faults', () => {
  it('bad search args are the argument fault', async () => {
    const port = portWith(fiveMembers());
    const guild = guildWith();
    await expect(
      searchMembersText(principal, port, guild, { guildId: String(GUILD), limit: 0 }),
    ).resolves.toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    await expect(
      searchMembersText(principal, port, guild, { guildId: String(GUILD), limit: 201 }),
    ).resolves.toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    await expect(
      searchMembersText(principal, port, guild, { guildId: String(GUILD), inactiveDays: 31 }),
    ).resolves.toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    await expect(
      searchMembersText(principal, port, guild, {
        guildId: String(GUILD),
        hasRoles: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
      }),
    ).resolves.toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
  });
});

describe('member tool names', () => {
  it('registers under get_member and search_members', () => {
    expect(GET_MEMBER_TOOL_NAME).toBe('get_member');
    expect(SEARCH_MEMBERS_TOOL_NAME).toBe('search_members');
  });
});
