/**
 * The discord.js adapter.
 *
 * This entry point carries client construction and, from slice 6b, gateway
 * event translation. The REST port lives behind the `@bananasaurs/discord/rest`
 * subpath, which `package.json` `exports` makes the only reachable path into
 * it — the fifth layer of the permission model in `docs/19` §5, and ADR 0014 §4.
 * Nothing here re-exports it.
 */

export { attachGatewayTranslation, emitConnectionEvents, type TranslationDeps } from './events.js';

export {
  CACHE_LIMITS,
  REST_OPTIONS,
  ClientOptionsError,
  PRIVILEGED_INTENTS,
  REQUIRED_INTENTS,
  REQUIRED_PARTIALS,
  UNLIMITABLE_CACHE_MANAGERS,
  assertClientOptions,
  buildCacheSettings,
  buildClientOptions,
  buildSweeperSettings,
  createDiscordClient,
  type CacheSettings,
  type SweeperSettings,
} from './client.js';
