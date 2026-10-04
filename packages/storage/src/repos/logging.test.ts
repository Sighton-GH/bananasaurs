import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import {
  logExcludedChannels,
  logMemberSnapshots,
  logRouteEvents,
  logRouteExclusions,
  logRoutes,
} from '../schema.js';
import { read, write } from '../write.js';
import { upsertGuild } from './guilds.js';
import { recordAudit } from './effects.js';
import {
  claimedCountFor,
  createRoute,
  deleteMemberSnapshot,
  deleteRoute,
  excludeChannel,
  findMessageDeleteAttribution,
  getMemberSnapshot,
  getRoute,
  incrementClaimedCount,
  isChannelExcluded,
  listEnabledLogChannels,
  listEnabledRoutesFor,
  listExcludedChannels,
  listRoutes,
  setRouteEnabled,
  unexcludeChannel,
  updateRoute,
  upsertMemberSnapshot,
  type LogRouteInput,
  type MemberSnapshot,
} from './logging.js';

/**
 * Named log routes with child rows, read and written.
 *
 * The read tests still seed rows directly rather than through the writers,
 * so a writer bug cannot hide behind a reader that shares it.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL_A = '333333333333333333';
const CHANNEL_B = '444444444444444444';
const USER_A = '555555555555555555';

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

const seedRoute = (
  scope: GuildScope,
  over: {
    routeId?: string;
    name?: string;
    channelId?: string;
    includeContent?: boolean;
    enabled?: boolean;
    createdAtMs?: number;
    eventKinds?: string[];
    excludedChannelIds?: string[];
  } = {},
) => {
  const routeId = over.routeId ?? randomUUID();
  write(scope, ({ db }) => {
    db.insert(logRoutes)
      .values({
        guildId: scope.guildId,
        routeId,
        name: over.name ?? 'seeded',
        channelId: over.channelId ?? CHANNEL_A,
        includeContent: (over.includeContent ?? true) ? 1 : 0,
        enabled: (over.enabled ?? true) ? 1 : 0,
        createdAtMs: over.createdAtMs ?? 1000,
      })
      .run();
    for (const eventKind of over.eventKinds ?? []) {
      db.insert(logRouteEvents).values({ guildId: scope.guildId, routeId, eventKind }).run();
    }
    for (const channelId of over.excludedChannelIds ?? []) {
      db.insert(logRouteExclusions).values({ guildId: scope.guildId, routeId, channelId }).run();
    }
  });
  return routeId;
};

const seedExclusion = (scope: GuildScope, channelId: string) =>
  write(scope, ({ db }) => {
    db.insert(logExcludedChannels).values({ guildId: scope.guildId, channelId }).run();
  });

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild a', now: 1000 });
  upsertGuild(b, { name: 'guild b', now: 1000 });
});
afterEach(() => {
  t.close();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROUTE_INPUT: LogRouteInput = {
  name: 'mod log',
  channelId: CHANNEL_A,
  includeContent: true,
  enabled: true,
  eventKinds: ['message_delete', 'message_edit'],
  excludedChannelIds: [CHANNEL_B],
};

describe('createRoute', () => {
  it('returns the stored route with sorted, de-duplicated lists and a UUID id', () => {
    const created = createRoute(a, {
      ...ROUTE_INPUT,
      eventKinds: ['message_edit', 'message_delete', 'message_delete'],
      excludedChannelIds: [CHANNEL_B, CHANNEL_B],
      nowMs: 2000,
    });
    expect(created.routeId).toMatch(UUID_RE);
    expect(created).toMatchObject({
      guildId: a.guildId,
      name: 'mod log',
      channelId: CHANNEL_A,
      includeContent: true,
      enabled: true,
      createdAtMs: 2000,
      eventKinds: ['message_delete', 'message_edit'],
      excludedChannelIds: [CHANNEL_B],
    });
    expect(getRoute(a, created.routeId)).toEqual(created);
  });

  it('gives two creates different ids', () => {
    const first = createRoute(a, { ...ROUTE_INPUT, nowMs: 2000 });
    const second = createRoute(a, { ...ROUTE_INPUT, nowMs: 2001 });
    expect(first.routeId).not.toBe(second.routeId);
  });

  it('creates a route with empty child lists', () => {
    const created = createRoute(a, {
      ...ROUTE_INPUT,
      eventKinds: [],
      excludedChannelIds: [],
      nowMs: 2000,
    });
    expect(created.eventKinds).toEqual([]);
    expect(created.excludedChannelIds).toEqual([]);
  });
});

describe('getRoute and listRoutes scoping', () => {
  it('getRoute is undefined for an unknown id', () => {
    expect(getRoute(a, 'no-such-route')).toBeUndefined();
  });

  it('reads a directly-seeded route with its child rows', () => {
    const routeId = seedRoute(a, {
      name: 'seeded',
      eventKinds: ['message_edit', 'message_delete'],
      excludedChannelIds: [CHANNEL_B],
      createdAtMs: 2000,
    });
    expect(getRoute(a, routeId)).toEqual({
      guildId: a.guildId,
      routeId,
      name: 'seeded',
      channelId: CHANNEL_A,
      includeContent: true,
      enabled: true,
      createdAtMs: 2000,
      eventKinds: ['message_delete', 'message_edit'],
      excludedChannelIds: [CHANNEL_B],
    });
  });

  it('a route created in one guild is invisible from another', () => {
    const routeId = seedRoute(a, { eventKinds: ['message_delete'] });
    expect(getRoute(b, routeId)).toBeUndefined();
    expect(listRoutes(b)).toEqual([]);
    expect(listEnabledRoutesFor(b, 'message_delete')).toEqual([]);
    expect(listEnabledLogChannels(b)).toEqual([]);
  });

  it('lists every route ordered by createdAtMs then routeId', () => {
    const newer = seedRoute(a, { name: 'newer', createdAtMs: 2001 });
    const older = seedRoute(a, { name: 'older', createdAtMs: 2000 });
    expect(listRoutes(a).map((r) => r.routeId)).toEqual([older, newer]);
  });
});

describe('updateRoute', () => {
  it('replaces every field and both child lists, keeping createdAtMs', () => {
    const created = createRoute(a, { ...ROUTE_INPUT, nowMs: 2000 });
    const updated = updateRoute(a, created.routeId, {
      name: 'renamed',
      channelId: CHANNEL_B,
      includeContent: false,
      enabled: false,
      eventKinds: ['member_join'],
      excludedChannelIds: [],
    });
    expect(updated).toMatchObject({
      routeId: created.routeId,
      guildId: a.guildId,
      name: 'renamed',
      channelId: CHANNEL_B,
      includeContent: false,
      enabled: false,
      createdAtMs: 2000,
      eventKinds: ['member_join'],
      excludedChannelIds: [],
    });
    // A removed kind is gone, an added one is present.
    expect(listEnabledRoutesFor(a, 'message_delete')).toEqual([]);
    expect(getRoute(a, created.routeId)).toEqual(updated);
  });

  it('returns undefined for an unknown id', () => {
    expect(updateRoute(a, 'no-such-route', ROUTE_INPUT)).toBeUndefined();
  });

  it('cannot update another guild’s route, and does not modify it', () => {
    const created = createRoute(a, { ...ROUTE_INPUT, nowMs: 2000 });
    expect(updateRoute(b, created.routeId, { ...ROUTE_INPUT, name: 'hijacked' })).toBeUndefined();
    expect(getRoute(a, created.routeId)?.name).toBe('mod log');
  });
});

describe('setRouteEnabled', () => {
  it('returns false for an unknown id', () => {
    expect(setRouteEnabled(a, 'no-such-route', false)).toBe(false);
  });

  it('toggles, and listEnabledRoutesFor excludes a disabled route', () => {
    const created = createRoute(a, { ...ROUTE_INPUT, nowMs: 2000 });
    expect(listEnabledRoutesFor(a, 'message_delete')).toHaveLength(1);
    expect(setRouteEnabled(a, created.routeId, false)).toBe(true);
    expect(getRoute(a, created.routeId)?.enabled).toBe(false);
    expect(listEnabledRoutesFor(a, 'message_delete')).toEqual([]);
    expect(listRoutes(a)).toHaveLength(1);
    expect(setRouteEnabled(a, created.routeId, true)).toBe(true);
    expect(listEnabledRoutesFor(a, 'message_delete')).toHaveLength(1);
  });

  it('does not disable another guild’s route', () => {
    const created = createRoute(b, { ...ROUTE_INPUT, nowMs: 2000 });
    expect(setRouteEnabled(a, created.routeId, false)).toBe(false);
    expect(getRoute(b, created.routeId)?.enabled).toBe(true);
  });
});

describe('deleteRoute', () => {
  it('removes the route and its child rows', () => {
    const created = createRoute(a, { ...ROUTE_INPUT, nowMs: 2000 });
    expect(deleteRoute(a, created.routeId)).toBe(true);
    expect(getRoute(a, created.routeId)).toBeUndefined();
    expect(listRoutes(a)).toEqual([]);
    expect(
      read(a, (db) => db.select().from(logRouteEvents).where(a.only(logRouteEvents)).all()),
    ).toEqual([]);
    expect(
      read(a, (db) => db.select().from(logRouteExclusions).where(a.only(logRouteExclusions)).all()),
    ).toEqual([]);
  });

  it('returns false the second time', () => {
    const created = createRoute(a, { ...ROUTE_INPUT, nowMs: 2000 });
    expect(deleteRoute(a, created.routeId)).toBe(true);
    expect(deleteRoute(a, created.routeId)).toBe(false);
  });

  it('cannot delete another guild’s route', () => {
    const created = createRoute(a, { ...ROUTE_INPUT, nowMs: 2000 });
    expect(deleteRoute(b, created.routeId)).toBe(false);
    expect(getRoute(a, created.routeId)?.routeId).toBe(created.routeId);
  });
});

describe('listEnabledRoutesFor', () => {
  it('returns only routes containing that kind', () => {
    seedRoute(a, { eventKinds: ['message_delete'], createdAtMs: 2000 });
    seedRoute(a, { eventKinds: ['member_join'], createdAtMs: 2001 });
    const found = listEnabledRoutesFor(a, 'message_delete');
    expect(found).toHaveLength(1);
    expect(found[0]?.eventKinds).toEqual(['message_delete']);
  });

  it('returns two routes with the same kind in createdAtMs order', () => {
    const older = seedRoute(a, {
      name: 'older',
      eventKinds: ['message_delete'],
      createdAtMs: 2000,
    });
    const newer = seedRoute(a, {
      name: 'newer',
      eventKinds: ['message_delete', 'member_join'],
      createdAtMs: 2001,
    });
    expect(listEnabledRoutesFor(a, 'message_delete').map((r) => r.routeId)).toEqual([older, newer]);
  });
});

describe('listEnabledLogChannels', () => {
  it('is empty when nothing is configured', () => {
    expect(listEnabledLogChannels(a)).toEqual([]);
  });

  it('lists distinct channels of enabled routes only', () => {
    seedRoute(a, { channelId: CHANNEL_A, eventKinds: ['message_delete'], createdAtMs: 2000 });
    // Same destination, second route: still listed once.
    seedRoute(a, { channelId: CHANNEL_A, eventKinds: ['member_join'], createdAtMs: 2001 });
    seedRoute(a, { channelId: CHANNEL_B, eventKinds: ['member_join'], createdAtMs: 2002 });
    // A disabled route's channel is not listed.
    seedRoute(a, {
      channelId: '555555555555555555',
      eventKinds: ['member_join'],
      enabled: false,
      createdAtMs: 2003,
    });
    expect(listEnabledLogChannels(a)).toEqual([CHANNEL_A, CHANNEL_B].sort());
  });
});

describe('member snapshots', () => {
  const SNAPSHOT: MemberSnapshot = {
    userId: USER_A,
    username: 'quokka',
    globalName: 'Quokka Fan',
    nickname: 'qk',
    avatarHash: 'aaa',
    guildAvatarHash: 'bbb',
    roleIds: ['444444444444444444', '333333333333333333'],
    updatedAtMs: 2000,
  };

  it('get is undefined before the first upsert', () => {
    expect(getMemberSnapshot(a, USER_A)).toBeUndefined();
  });

  it('upsert then get returns the snapshot with roleIds sorted', () => {
    upsertMemberSnapshot(a, SNAPSHOT);
    expect(getMemberSnapshot(a, USER_A)).toEqual({
      ...SNAPSHOT,
      roleIds: [...SNAPSHOT.roleIds].sort(),
    });
  });

  it('a second upsert replaces the row', () => {
    upsertMemberSnapshot(a, SNAPSHOT);
    upsertMemberSnapshot(a, {
      ...SNAPSHOT,
      nickname: undefined,
      roleIds: [],
      updatedAtMs: 3000,
    });
    expect(getMemberSnapshot(a, USER_A)).toMatchObject({
      nickname: undefined,
      roleIds: [],
      updatedAtMs: 3000,
    });
  });

  it('delete returns true then false', () => {
    upsertMemberSnapshot(a, SNAPSHOT);
    expect(deleteMemberSnapshot(a, USER_A)).toBe(true);
    expect(getMemberSnapshot(a, USER_A)).toBeUndefined();
    expect(deleteMemberSnapshot(a, USER_A)).toBe(false);
  });

  it('is scoped across guilds', () => {
    upsertMemberSnapshot(a, SNAPSHOT);
    expect(getMemberSnapshot(b, USER_A)).toBeUndefined();
    expect(deleteMemberSnapshot(b, USER_A)).toBe(false);
    expect(getMemberSnapshot(a, USER_A)).toBeDefined();
  });

  it('a corrupt role_ids value reads back as []', () => {
    write(a, ({ db }) => {
      db.insert(logMemberSnapshots)
        .values({
          guildId: a.guildId,
          userId: USER_A,
          username: 'quokka',
          roleIds: 'not json',
          updatedAtMs: 2000,
        })
        .run();
    });
    expect(getMemberSnapshot(a, USER_A)?.roleIds).toEqual([]);
  });
});

describe('isChannelExcluded', () => {
  it('is false for a channel nobody excluded', () => {
    expect(isChannelExcluded(a, CHANNEL_A)).toBe(false);
  });

  it('is true for an excluded channel', () => {
    seedExclusion(a, CHANNEL_A);
    expect(isChannelExcluded(a, CHANNEL_A)).toBe(true);
  });

  it('does not exclude a different channel', () => {
    seedExclusion(a, CHANNEL_A);
    expect(isChannelExcluded(a, CHANNEL_B)).toBe(false);
  });

  it('is scoped: an exclusion in one guild does not apply to another', () => {
    seedExclusion(a, CHANNEL_A);
    expect(isChannelExcluded(b, CHANNEL_A)).toBe(false);
  });
});

const ACTOR = '555555555555555555';
const OTHER_ACTOR = '666666666666666666';
const AUTHOR = '777777777777777777';
const RUN = { actorUserId: ACTOR, authorId: AUTHOR, channelId: CHANNEL_A };

describe('claimedCountFor / incrementClaimedCount', () => {
  it('is 0 for a run that has never been claimed against', () => {
    expect(claimedCountFor(a, RUN)).toBe(0);
  });

  it('increments by exactly one per call', () => {
    incrementClaimedCount(a, RUN);
    expect(claimedCountFor(a, RUN)).toBe(1);
    incrementClaimedCount(a, RUN);
    expect(claimedCountFor(a, RUN)).toBe(2);
  });

  it('does not confuse two different actors deleting the same author in the same channel', () => {
    incrementClaimedCount(a, RUN);
    expect(claimedCountFor(a, { ...RUN, actorUserId: OTHER_ACTOR })).toBe(0);
  });

  it('does not confuse two different channels', () => {
    incrementClaimedCount(a, RUN);
    expect(claimedCountFor(a, { ...RUN, channelId: CHANNEL_B })).toBe(0);
  });

  it('is scoped: a claim in one guild is invisible from another', () => {
    incrementClaimedCount(a, RUN);
    expect(claimedCountFor(b, RUN)).toBe(0);
  });
});

describe('findMessageDeleteAttribution', () => {
  const MESSAGE = '888888888888888888';

  it('is undefined when no attribution has been recorded for this message', () => {
    expect(findMessageDeleteAttribution(a, MESSAGE)).toBeUndefined();
  });

  it('returns the recorded actor and the inferred flag', () => {
    recordAudit(a, {
      at: 1000,
      actorType: 'member',
      actorId: ACTOR,
      action: 'message_delete',
      subjectType: 'message',
      subjectId: MESSAGE,
      dryRun: false,
      inferred: true,
    });
    expect(findMessageDeleteAttribution(a, MESSAGE)).toEqual({ actorId: ACTOR, inferred: true });
  });

  it('returns an undefined actor when the recorded outcome was unknown', () => {
    recordAudit(a, {
      at: 1000,
      actorType: 'system',
      actorId: undefined,
      action: 'message_delete',
      subjectType: 'message',
      subjectId: MESSAGE,
      dryRun: false,
      inferred: false,
    });
    expect(findMessageDeleteAttribution(a, MESSAGE)).toEqual({
      actorId: undefined,
      inferred: false,
    });
  });

  it('is scoped: an attribution in one guild is invisible from another', () => {
    recordAudit(a, {
      at: 1000,
      actorType: 'member',
      actorId: ACTOR,
      action: 'message_delete',
      subjectType: 'message',
      subjectId: MESSAGE,
      dryRun: false,
      inferred: true,
    });
    expect(findMessageDeleteAttribution(b, MESSAGE)).toBeUndefined();
  });
});

describe('listExcludedChannels', () => {
  it('lists excluded channels', () => {
    seedExclusion(a, CHANNEL_B);
    seedExclusion(a, CHANNEL_A);
    expect(listExcludedChannels(a)).toEqual([CHANNEL_A, CHANNEL_B].sort());
  });

  it("does not see another guild's exclusions", () => {
    seedExclusion(b, CHANNEL_A);
    expect(listExcludedChannels(a)).toEqual([]);
  });
});

/**
 * The writers `bananasaurs log routing exclude|unexclude` calls.
 *
 * Every one is idempotent and every one is guild-scoped, and both properties
 * are asserted rather than assumed: an operator re-running a command after a
 * dropped SSH connection is the ordinary case, not the edge one.
 */
describe('log routing exclusion writers', () => {
  it('excludes a channel, and says so only the first time', () => {
    expect(excludeChannel(a, CHANNEL_A)).toBe(true);
    expect(excludeChannel(a, CHANNEL_A)).toBe(false);
    expect(listExcludedChannels(a)).toEqual([CHANNEL_A]);
    expect(isChannelExcluded(a, CHANNEL_A)).toBe(true);
  });

  it('un-excludes a channel, and says so only when there was one', () => {
    excludeChannel(a, CHANNEL_A);
    expect(unexcludeChannel(a, CHANNEL_A)).toBe(true);
    expect(unexcludeChannel(a, CHANNEL_A)).toBe(false);
    expect(isChannelExcluded(a, CHANNEL_A)).toBe(false);
  });

  it("does not exclude a channel in another guild's name", () => {
    excludeChannel(a, CHANNEL_A);
    expect(isChannelExcluded(b, CHANNEL_A)).toBe(false);
  });

  it("does not un-exclude another guild's channel", () => {
    excludeChannel(b, CHANNEL_A);
    expect(unexcludeChannel(a, CHANNEL_A)).toBe(false);
    expect(isChannelExcluded(b, CHANNEL_A)).toBe(true);
  });
});
