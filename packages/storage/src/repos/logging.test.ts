import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { logExcludedChannels, logRoutes } from '../schema.js';
import { write } from '../write.js';
import { upsertGuild } from './guilds.js';
import { findRoute, isChannelExcluded } from './logging.js';

/**
 * `log_routes` and `log_excluded_channels` have no writer yet — nothing in
 * Release 1 configures them except a future operator CLI (WP5 slice 13) — so
 * tests seed rows directly, the same way `write.test.ts` and `columns.test.ts`
 * do for tables with no repo setter.
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

const excludeChannel = (scope: GuildScope, channelId: string) =>
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
    excludeChannel(a, CHANNEL_A);
    expect(isChannelExcluded(a, CHANNEL_A)).toBe(true);
  });

  it('does not exclude a different channel', () => {
    excludeChannel(a, CHANNEL_A);
    expect(isChannelExcluded(a, CHANNEL_B)).toBe(false);
  });

  it('is scoped: an exclusion in one guild does not apply to another', () => {
    excludeChannel(a, CHANNEL_A);
    expect(isChannelExcluded(b, CHANNEL_A)).toBe(false);
  });
});
