import type { Snowflake } from '../discord/port.js';
import { isNoAccess } from '../channels/scope.js';

/** One configured log route as the logging module sees it (ADR 0123). */
export interface LogRoute {
  routeId: string;
  channelId: Snowflake; // destination
  includeContent: boolean;
  enabled: boolean;
  excludedChannelIds: readonly Snowflake[];
}

/** Where an event happened, for events that have a source channel. */
export interface LogSource {
  channelId: Snowflake;
  parentChannelId: Snowflake | undefined; // thread parent, when known
  /** Category of the channel (or of the thread parent), when known. */
  categoryId: Snowflake | undefined;
}

/** The claim namespace for one route and one event kind. */
export const routeDedupeKind = (routeId: string, eventKind: string): string =>
  `log:r${routeId}:${eventKind}`;

/**
 * Whether this route takes an event from `source`. False when the route is
 * disabled; when the source channel or its thread parent is in the route's
 * exclusions; or when the source channel or its thread parent IS the route's
 * destination (a route never logs its own channel, ADR 0123 decision 5).
 * An event with no source channel (undefined) is always accepted by an enabled route.
 */
export function routeAccepts(route: LogRoute, source: LogSource | undefined): boolean {
  if (!route.enabled) return false;
  if (source === undefined) return true;
  const excluded = new Set(route.excludedChannelIds);
  if (excluded.has(source.channelId)) return false;
  if (source.parentChannelId !== undefined && excluded.has(source.parentChannelId)) return false;
  if (source.channelId === route.channelId) return false;
  if (source.parentChannelId !== undefined && source.parentChannelId === route.channelId)
    return false;
  return true;
}

/**
 * True when the source channel, its thread parent, or its category is on the
 * guild-wide exclusion list. Delegates to `isNoAccess` (ADR 0126) so the
 * logging veto shares the one channel → parent → category precedence every
 * other surface uses, instead of re-walking it here.
 */
export function isSourceExcluded(
  source: LogSource | undefined,
  isChannelExcluded: (channelId: Snowflake) => boolean,
): boolean {
  if (source === undefined) return false;
  return isNoAccess({
    channelId: source.channelId,
    parentChannelId: source.parentChannelId,
    categoryId: source.categoryId,
    isExcluded: isChannelExcluded,
  });
}
