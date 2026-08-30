import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { logExcludedChannels, logRoutes } from '../schema.js';
import { write } from '../write.js';
import { upsertGuild } from './guilds.js';
import { recordAudit } from './effects.js';
import {
  claimedCountFor,
  findMessageDeleteAttribution,
  findRoute,
  incrementClaimedCount,
  isChannelExcluded,
  listEnabledLogChannels,
  listExcludedChannels,
  listRoutes,
  excludeChannel,
  setRoute,
  setRouteEnabled,
  unexcludeChannel,
} from './logging.js';

/**
 * `log_routes` and `log_excluded_channels`, read and written.
 *
 * WP4 shipped the reads with the note that nothing configured either table
 * except a future operator CLI. That CLI is WP5 slice 13, so the writers are
 * here now — and the read tests still seed rows directly rather than through
 * them, so a writer bug cannot hide behind a reader that shares it.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL_A = '333333333333333333';
const CHANNEL_B = '444444444444444444';

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

const seedRoute = (
  scope: GuildScope,
  eventKind: string,
  over: { channelId?: string; includeContent?: boolean; enabled?: boolean } = {},
) =>
  write(scope, ({ db }) => {
    db.insert(logRoutes)
      .values({
        guildId: scope.guildId,
        eventKind,
        channelId: over.channelId ?? CHANNEL_A,
        includeContent: (over.includeContent ?? true) ? 1 : 0,
        enabled: (over.enabled ?? true) ? 1 : 0,
      })
      .run();
  });

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

describe('findRoute', () => {
  it('is undefined when no route is configured for this event kind', () => {
    expect(findRoute(a, 'message_delete')).toBeUndefined();
  });

  it('returns the configured route', () => {
    seedRoute(a, 'message_delete', { channelId: CHANNEL_A, includeContent: true, enabled: true });
    expect(findRoute(a, 'message_delete')).toEqual({
      guildId: a.guildId,
      eventKind: 'message_delete',
      channelId: CHANNEL_A,
      includeContent: true,
      enabled: true,
    });
  });

  it('reports enabled: false rather than hiding a disabled route', () => {
    // A disabled route is a distinct fact from "unconfigured" — the caller
    // needs to tell "nobody asked for this" from "an owner turned it off".
    seedRoute(a, 'message_delete', { enabled: false });
    expect(findRoute(a, 'message_delete')?.enabled).toBe(false);
  });

  it('reports includeContent: false when the owner turned content off', () => {
    seedRoute(a, 'message_delete', { includeContent: false });
    expect(findRoute(a, 'message_delete')?.includeContent).toBe(false);
  });

  it('does not confuse two event kinds in the same guild', () => {
    seedRoute(a, 'message_delete', { channelId: CHANNEL_A });
    expect(findRoute(a, 'message_edit')).toBeUndefined();
  });

  it('is scoped: a route in one guild is invisible from another', () => {
    seedRoute(a, 'message_delete', { channelId: CHANNEL_A });
    expect(findRoute(b, 'message_delete')).toBeUndefined();
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

describe('listEnabledLogChannels', () => {
  it('is empty when nothing is configured', () => {
    expect(listEnabledLogChannels(a)).toEqual([]);
  });

  it('lists a configured, enabled channel', () => {
    seedRoute(a, 'message_delete', { channelId: CHANNEL_A });
    expect(listEnabledLogChannels(a)).toEqual([CHANNEL_A]);
  });

  it('excludes a disabled route', () => {
    seedRoute(a, 'message_delete', { channelId: CHANNEL_A, enabled: false });
    expect(listEnabledLogChannels(a)).toEqual([]);
  });

  it('deduplicates a channel shared by two event kinds', () => {
    seedRoute(a, 'message_delete', { channelId: CHANNEL_A });
    seedRoute(a, 'message_edit', { channelId: CHANNEL_A });
    expect(listEnabledLogChannels(a)).toEqual([CHANNEL_A]);
  });

  it('lists two distinct channels', () => {
    seedRoute(a, 'message_delete', { channelId: CHANNEL_A });
    seedRoute(a, 'member_join', { channelId: CHANNEL_B });
    expect(listEnabledLogChannels(a).sort()).toEqual([CHANNEL_A, CHANNEL_B].sort());
  });

  it('is scoped: a route in one guild is invisible from another', () => {
    seedRoute(a, 'message_delete', { channelId: CHANNEL_A });
    expect(listEnabledLogChannels(b)).toEqual([]);
  });
});

describe('listRoutes and listExcludedChannels', () => {
  it('lists every configured route, ordered by event kind', () => {
    seedRoute(a, 'member_join', { channelId: CHANNEL_B });
    seedRoute(a, 'message_delete', { channelId: CHANNEL_A });
    expect(listRoutes(a).map((r) => r.eventKind)).toEqual(['member_join', 'message_delete']);
  });

  it('reports enabled and include_content as booleans, not as ones and zeros', () => {
    seedRoute(a, 'message_edit', { channelId: CHANNEL_A, enabled: false, includeContent: false });
    expect(listRoutes(a)[0]).toMatchObject({ enabled: false, includeContent: false });
  });

  it('lists a disabled route too, because an operator needs to see it to re-enable it', () => {
    seedRoute(a, 'message_edit', { channelId: CHANNEL_A, enabled: false });
    expect(listRoutes(a)).toHaveLength(1);
  });

  it("does not see another guild's routes", () => {
    seedRoute(b, 'member_join', { channelId: CHANNEL_A });
    expect(listRoutes(a)).toEqual([]);
    expect(listRoutes(b)).toHaveLength(1);
  });

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
 * The writers `bananasaurs log routing set|off|exclude|unexclude` calls.
 *
 * Every one is idempotent and every one is guild-scoped, and both properties
 * are asserted rather than assumed: an operator re-running a command after a
 * dropped SSH connection is the ordinary case, not the edge one.
 */
describe('log routing writers', () => {
  it('creates a route', () => {
    setRoute(a, { eventKind: 'member_join', channelId: CHANNEL_A, includeContent: true });
    expect(findRoute(a, 'member_join')).toMatchObject({
      channelId: CHANNEL_A,
      includeContent: true,
      enabled: true,
    });
  });

  it('re-points an existing route rather than adding a second', () => {
    setRoute(a, { eventKind: 'member_join', channelId: CHANNEL_A, includeContent: true });
    setRoute(a, { eventKind: 'member_join', channelId: CHANNEL_B, includeContent: false });
    expect(listRoutes(a)).toHaveLength(1);
    expect(findRoute(a, 'member_join')).toMatchObject({
      channelId: CHANNEL_B,
      includeContent: false,
    });
  });

  it('re-enables a route that was turned off', () => {
    // The reason `off` disables rather than deletes: turning it back on must
    // not require the operator to remember the channel id.
    setRoute(a, { eventKind: 'member_join', channelId: CHANNEL_A, includeContent: true });
    expect(setRouteEnabled(a, 'member_join', false)).toBe(true);
    // The row survives with its channel; `enabled` is what the logging
    // subscriber checks, so the logging really has stopped.
    expect(findRoute(a, 'member_join')).toMatchObject({ enabled: false, channelId: CHANNEL_A });
    expect(listEnabledLogChannels(a)).toEqual([]);

    setRoute(a, { eventKind: 'member_join', channelId: CHANNEL_A, includeContent: true });
    expect(findRoute(a, 'member_join')).toMatchObject({ enabled: true });
    expect(listEnabledLogChannels(a)).toEqual([CHANNEL_A]);
  });

  it('reports that there was no route to turn off', () => {
    // Not silence. An operator who mistypes an event kind must not be told the
    // logging they asked to stop has stopped.
    expect(setRouteEnabled(a, 'member_join', false)).toBe(false);
  });

  it("setRoute does not touch another guild's route", () => {
    setRoute(a, { eventKind: 'member_join', channelId: CHANNEL_A, includeContent: true });
    setRoute(b, { eventKind: 'member_join', channelId: CHANNEL_B, includeContent: true });
    expect(findRoute(a, 'member_join')?.channelId).toBe(CHANNEL_A);
    expect(findRoute(b, 'member_join')?.channelId).toBe(CHANNEL_B);
  });

  it("setRouteEnabled does not disable another guild's route", () => {
    setRoute(b, { eventKind: 'member_join', channelId: CHANNEL_A, includeContent: true });
    expect(setRouteEnabled(a, 'member_join', false)).toBe(false);
    expect(findRoute(b, 'member_join')?.enabled).toBe(true);
  });

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
