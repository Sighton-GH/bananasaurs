import { accountRepo } from '@bananasaurs/storage';
import type { SessionContext } from './auth.js';
import type { HttpDeps } from './server.js';

/**
 * Instance owner, read from the account row rather than any capability: the
 * provider's cost statement and terms record are facts about the whole
 * daemon (ADR 0061), and no per-guild grant can confer them.
 *
 * Lives here rather than in `routes/assistant.ts` so `server.ts` can answer
 * `instanceOwner` on `/api/session` without importing a route module.
 */
export const isInstanceOwner = (deps: HttpDeps, session: SessionContext): boolean =>
  accountRepo.findAccountById(deps.scopes.instance(), session.accountId)?.isOwner === true;
