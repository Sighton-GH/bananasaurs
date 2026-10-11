import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'discord.js';
import { PermissionsBitField } from 'discord.js';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { guildRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { resolveReplyPings, type ReplyPingRequest } from './reply-ping-policy.js';

/**
 * ADR 0145: reply pings are decided by code. The answer says where; the
 * asker's own message (mention or typed name) says who. Fixtures are invented.
 */
const GUILD = parseGuildId('111111111111111111');
const CHANNEL = '444444444444444444';
const ASKER = '600000000000000001';
const SAM = '600000000000000002';
const ALEX = '600000000000000003';
const caps = { members: 5, roles: 3 };

interface FakeMember {
  id: string;
  displayName: string;
}
interface FakeRole {
  id: string;
  name: string;
  position: number;
  mentionable: boolean;
  managed?: boolean;
  permissions?: bigint;
}
interface Fixture {
  members?: FakeMember[];
  roles?: FakeRole[];
  askerBits?: bigint;
}

let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: 1 });
});
afterEach(() => {
  t.close();
});

const build = (fixture: Fixture = {}): { client: Client; searches: () => number } => {
  let searches = 0;
  const asker = { id: ASKER, displayName: 'Asker Q' };
  const members: FakeMember[] = [asker, ...(fixture.members ?? [])];
  const bits = fixture.askerBits ?? PermissionsBitField.Flags.SendMessages;
  const withPerms = (m: FakeMember): object => ({
    ...m,
    permissionsIn: () => ({ has: (p: bigint) => (bits & p) === p }),
  });
  const byId = new Map(members.map((m) => [m.id, withPerms(m)]));
  const roleMap = new Map(
    [
      { id: 'bot-role', name: 'Bot', position: 10, mentionable: false },
      ...(fixture.roles ?? []),
    ].map((r) => [r.id, { managed: false, permissions: 0n, ...r }] as const),
  );
  const roles = new Map(
    [...roleMap.entries()].map(([id, r]) => [
      id,
      { ...r, permissions: { bitfield: r.permissions } },
    ]),
  );
  const guild = {
    id: GUILD,
    roles: { cache: roles },
    members: {
      cache: byId,
      me: { roles: { highest: { position: 10 } } },
      fetch: (id: string) => {
        const hit = byId.get(id);
        return hit === undefined ? Promise.reject(new Error('unknown')) : Promise.resolve(hit);
      },
      search: ({ query, limit }: { query: string; limit?: number }) => {
        searches += 1;
        const hits = members.filter((m) =>
          m.displayName.toLowerCase().includes(query.toLowerCase()),
        );
        return Promise.resolve(
          new Map(hits.slice(0, limit ?? 25).map((m) => [m.id, withPerms(m)])),
        );
      },
    },
  };
  const client = { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
  return { client, searches: () => searches };
};

const run = (client: Client, input: Partial<ReplyPingRequest>) =>
  resolveReplyPings(client, t.scopes.forGuild(GUILD), caps, {
    askerId: ASKER,
    channelId: CHANNEL,
    text: '',
    askerText: '',
    mentionedUserIds: [],
    mentionedRoleIds: [],
    ...input,
  });

const sam = { id: SAM, displayName: 'Sam L' };
const alex = { id: ALEX, displayName: 'Alex P' };

describe('resolveReplyPings', () => {
  it('pings a member the asker mentioned by id', async () => {
    const { client } = build({ members: [sam] });
    const out = await run(client, {
      text: 'Ask @Sam L about it.',
      askerText: 'who owns this <@600000000000000002>',
      mentionedUserIds: [SAM],
    });
    expect(out).toEqual({ content: `Ask <@${SAM}> about it.`, userIds: [SAM], roles: [] });
  });

  it('keeps a never-mentioned, never-named name as plain text', async () => {
    const { client } = build({ members: [sam] });
    const out = await run(client, { text: 'Ask @Stranger', askerText: 'who owns this' });
    expect(out).toEqual({ content: 'Ask @Stranger', userIds: [], roles: [] });
  });

  it('does not ping or even search for a name only the answer introduced', async () => {
    const { client, searches } = build({ members: [alex] });
    const out = await run(client, {
      text: '@Alex P will handle it',
      askerText: 'remind everyone tomorrow',
    });
    expect(out).toEqual({ content: '@Alex P will handle it', userIds: [], roles: [] });
    expect(searches()).toBe(0);
  });

  it('pings a member the asker named in text, on one exact search hit', async () => {
    const { client, searches } = build({ members: [alex] });
    const out = await run(client, {
      text: '@Alex P has the build.',
      askerText: 'ping Alex P about the build',
    });
    expect(out.userIds).toEqual([ALEX]);
    expect(out.content).toBe(`<@${ALEX}> has the build.`);
    expect(searches()).toBe(1);
  });

  it('cuts the sixth member and the fourth role', async () => {
    const people = Array.from({ length: 6 }, (_, i) => ({
      id: `70000000000000000${i}`,
      displayName: `Person ${String.fromCharCode(65 + i)}`,
    }));
    const roleList: FakeRole[] = Array.from({ length: 4 }, (_, i) => ({
      id: `80000000000000000${i}`,
      name: `Crew ${String.fromCharCode(65 + i)}`,
      position: 1,
      mentionable: true,
    }));
    const { client } = build({ members: people, roles: roleList });
    const text = [
      ...people.map((p) => `@${p.displayName}`),
      ...roleList.map((r) => `@${r.name}`),
    ].join(' , ');
    const out = await run(client, {
      text,
      askerText: 'all of them',
      mentionedUserIds: people.map((p) => p.id),
      mentionedRoleIds: roleList.map((r) => r.id),
    });
    expect(out.userIds).toEqual(people.slice(0, 5).map((p) => p.id));
    expect(out.roles).toEqual(roleList.slice(0, 3).map((r) => r.id));
    expect(out.content).toContain('@Person F');
    expect(out.content).toContain('@Crew D');
  });

  it.each([
    ['above the bot', { position: 20, mentionable: true }],
    [
      'with a dangerous permission',
      { position: 1, mentionable: true, permissions: PermissionsBitField.Flags.Administrator },
    ],
  ])('refuses a role %s', async (_label, extra) => {
    const { client } = build({
      roles: [{ id: '800000000000000009', name: 'Car Team A', ...extra }],
    });
    const out = await run(client, {
      text: 'Tell @Car Team A',
      askerText: 'tell the team',
      mentionedRoleIds: ['800000000000000009'],
    });
    expect(out).toEqual({ content: 'Tell @Car Team A', userIds: [], roles: [] });
  });

  it('refuses a non-mentionable role without the asker’s Mention Everyone, allows it with', async () => {
    const role = { id: '800000000000000008', name: 'Quiet Crew', position: 1, mentionable: false };
    const input = {
      text: 'Tell @Quiet Crew',
      askerText: 'tell them',
      mentionedRoleIds: [role.id],
    };
    const denied = await run(build({ roles: [role] }).client, input);
    expect(denied.roles).toEqual([]);
    const allowed = await run(
      build({
        roles: [role],
        askerBits:
          PermissionsBitField.Flags.SendMessages | PermissionsBitField.Flags.MentionEveryone,
      }).client,
      input,
    );
    expect(allowed).toEqual({ content: `Tell <@&${role.id}>`, userIds: [], roles: [role.id] });
  });

  it('pings nothing when the asker lacks SendMessages in the channel', async () => {
    const { client } = build({ members: [sam], askerBits: 0n });
    const out = await run(client, {
      text: 'Ask @Sam L',
      askerText: 'x',
      mentionedUserIds: [SAM],
    });
    expect(out).toEqual({ content: 'Ask @Sam L', userIds: [], roles: [] });
  });

  it('fails closed with no channel (slash path)', async () => {
    const { client } = build({ members: [sam] });
    const out = await run(client, {
      channelId: undefined,
      text: 'Ask @Sam L',
      askerText: 'x',
      mentionedUserIds: [SAM],
    });
    expect(out).toEqual({ content: 'Ask @Sam L', userIds: [], roles: [] });
  });

  it('never pings @everyone or @here', async () => {
    const { client } = build({ members: [sam] });
    const out = await run(client, { text: '@everyone @here', askerText: 'everyone here' });
    expect(out).toEqual({ content: '@everyone @here', userIds: [], roles: [] });
  });

  it('pings neither member when two mentioned members share a display name (B1)', async () => {
    const { client } = build({
      members: [sam, { id: '600000000000000004', displayName: 'Sam L' }],
    });
    const out = await run(client, {
      text: 'Ask @Sam L about it.',
      askerText: 'who owns this',
      mentionedUserIds: [SAM, '600000000000000004'],
    });
    expect(out).toEqual({ content: 'Ask @Sam L about it.', userIds: [], roles: [] });
  });

  it('pings neither role when two mentioned roles share a name (B1)', async () => {
    const twins: FakeRole[] = [
      { id: '800000000000000010', name: 'Car Team A', position: 1, mentionable: true },
      { id: '800000000000000011', name: 'Car Team A', position: 1, mentionable: true },
    ];
    const { client } = build({ roles: twins });
    const out = await run(client, {
      text: 'Tell @Car Team A',
      askerText: 'tell them',
      mentionedRoleIds: twins.map((r) => r.id),
    });
    expect(out).toEqual({ content: 'Tell @Car Team A', userIds: [], roles: [] });
  });

  it('pings a uniquely named member when 5 other members prefix-match first (B2, page of 25)', async () => {
    const crowd: FakeMember[] = ['Pa', 'Pb', 'Pc', 'Pd', 'Pe'].map((suffix, i) => ({
      id: `60000000000000010${i}`,
      displayName: `Alex ${suffix}`,
    }));
    const exactAlex = { id: '600000000000000109', displayName: 'Alex P' };
    const { client } = build({ members: [...crowd, exactAlex] });
    const out = await run(client, {
      text: '@Alex P has the build.',
      askerText: 'ping Alex P about the build',
    });
    expect(out.userIds).toEqual([exactAlex.id]);
    expect(out.content).toBe(`<@${exactAlex.id}> has the build.`);
  });

  it('refuses when two search hits share the exact name (T1 pin: exact.length === 1)', async () => {
    const twins: FakeMember[] = [
      { id: '600000000000000110', displayName: 'Alex P' },
      { id: '600000000000000111', displayName: 'Alex P' },
    ];
    const { client } = build({ members: twins });
    const out = await run(client, {
      text: '@Alex P has the build.',
      askerText: 'ping Alex P about the build',
    });
    expect(out).toEqual({ content: '@Alex P has the build.', userIds: [], roles: [] });
  });

  it('refuses when two cached roles share the name the asker named (T2 pin: roleHits.length === 1)', async () => {
    const twins: FakeRole[] = [
      { id: '800000000000000012', name: 'Car Team A', position: 1, mentionable: true },
      { id: '800000000000000013', name: 'Car Team A', position: 1, mentionable: true },
    ];
    const { client } = build({ roles: twins });
    const out = await run(client, {
      text: 'Tell @Car Team A',
      askerText: 'ping Car Team A about the build',
    });
    expect(out).toEqual({ content: 'Tell @Car Team A', userIds: [], roles: [] });
  });
});
