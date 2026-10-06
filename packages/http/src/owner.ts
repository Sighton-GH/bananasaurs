import { accountRepo, authzRepo } from '@bananasaurs/storage';
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

/**
 * May this session manage the guild's club tasks (ADR 0130)? The instance
 * owner always may; any other enabled account needs `tasks.manage` in the
 * session's own guild. Read live from the rows, never from the session.
 */
export const canManageTasks = (deps: HttpDeps, session: SessionContext): boolean => {
  const account = accountRepo.findAccountById(deps.scopes.instance(), session.accountId);
  if (!account || account.disabled) return false;
  if (account.isOwner) return true;
  return authzRepo
    .listAccountCapabilities(session.scope, session.accountId)
    .includes('tasks.manage');
};
