/**
 * The Discord REST port — the one module that may reach Discord's REST API.
 *
 * `package.json` `exports` makes `@bananasaurs/discord/rest` the only importable
 * path to it, and `eslint.config.js` limits *who* may import that path to
 * `packages/core/src/effects` (the effect gateway) and the composition root in
 * `apps/daemon`. Between them: `exports` handles "no sneaking in by file path",
 * the lint rule handles "who" (ADR 0014 §4, `docs/19` §5 layer 5).
 *
 * Even code holding a forged authorization witness cannot reach Discord except
 * through the effect gateway, where the kill switch, breaker, rate cap,
 * hierarchy check, idempotency and dry run all live.
 */

export { createDiscordRestPort, type RestPortDeps } from './port.js';
export { toDiscordApiError } from './errors.js';
