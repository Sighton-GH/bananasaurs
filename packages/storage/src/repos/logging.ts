import { eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read } from '../write.js';
import { logExcludedChannels, logRoutes } from '../schema.js';

/**
 * Where a logged event kind goes, and which source channels never log.
 *
 * Read-only: nothing in Release 1 configures either table except the
 * operator CLI (`docs/19` slice 13, WP5), which does not exist yet. Tests
 * seed rows by inserting into the schema tables directly, the way
 * `write.test.ts` and `columns.test.ts` already do for tables with no writer.
 */

export interface LogRoute {
  guildId: string;
  eventKind: string;
  channelId: string;
  includeContent: boolean;
  enabled: boolean;
}

/** Undefined means "nobody configured this event kind" — treat as disabled. */
export const findRoute = (scope: GuildScope, eventKind: string): LogRoute | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(logRoutes)
      .where(scope.only(logRoutes, eq(logRoutes.eventKind, eventKind)))
      .get();
    if (!row) return undefined;
    return {
      guildId: row.guildId,
      eventKind: row.eventKind,
      channelId: row.channelId,
      includeContent: row.includeContent === 1,
      enabled: row.enabled === 1,
    };
  });

/** True when this source channel must never be logged from, whatever the routes say. */
export const isChannelExcluded = (scope: GuildScope, channelId: string): boolean =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(logExcludedChannels)
      .where(scope.only(logExcludedChannels, eq(logExcludedChannels.channelId, channelId)))
      .get();
    return row !== undefined;
  });
