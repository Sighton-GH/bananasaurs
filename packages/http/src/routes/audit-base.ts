import type { OpsAuditWrite } from '@bananasaurs/core';
import type { SessionContext } from '../auth.js';

/** The one fact every dashboard write route needs to build its audit row's attribution. */
export const dashboardAuditBase = (
  session: SessionContext,
  now: number,
): Pick<
  OpsAuditWrite,
  'at' | 'actorType' | 'actorId' | 'actorUnixUserClaimed' | 'via' | 'dryRun'
> => ({
  at: now,
  actorType: 'dashboard',
  // Verified: session.accountId is the primary key of a session row this
  // server issued after checking an Argon2id hash, not a claim the caller
  // sent (ADR 0031) — the opposite reasoning from the CLI's actorId, which
  // stays undefined because it has none to verify.
  actorId: session.accountId,
  actorUnixUserClaimed: undefined,
  via: 'http',
  dryRun: false,
});
