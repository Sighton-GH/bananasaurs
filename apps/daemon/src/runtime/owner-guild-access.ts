import { CAPABILITIES, safeLogFields, type Logger } from '@bananasaurs/core';
import { accountRepo, effectRepo, type GuildScope, type InstanceScope } from '@bananasaurs/storage';

/**
 * ADR 0124: every enabled owner reaches every allowlisted guild.
 *
 * `bootstrap` grants access and every capability in the guilds the allowlist
 * named when the owner account was created; a guild added afterwards got
 * nothing, and the owner had to run twelve CLI commands to see it. This makes
 * the same grants, at startup, for any enabled owner with **no access row** in
 * this guild. An owner who already reaches the guild is left alone, so a
 * capability they deliberately revoked stays revoked.
 *
 * Runs after `applyConfiguredDryRun`, which seeds the guild row the access
 * table's foreign key needs. Skipped in read-only mode for the same reason that
 * function skips: the process cannot write. Returns the account ids granted.
 */
export function ensureOwnerGuildAccess(input: {
  scope: GuildScope;
  instance: InstanceScope;
  readonly: boolean;
  logger: Logger;
  now: number;
}): readonly string[] {
  if (input.readonly) return [];

  const granted: string[] = [];
  for (const accountId of accountRepo.listEnabledOwnerIds(input.instance)) {
    if (accountRepo.hasGuildAccess(input.scope, accountId)) continue;

    accountRepo.grantGuildAccess(input.scope, accountId);
    accountRepo.grantAllCapabilities(input.scope, {
      accountId,
      capabilities: CAPABILITIES,
      grantedBy: 'startup-owner-sync',
      now: input.now,
    });
    effectRepo.recordAudit(input.scope, {
      at: input.now,
      actorType: 'system',
      actorId: undefined,
      action: 'account.guild_granted',
      subjectType: 'account',
      subjectId: accountId,
      before: { hadAccess: false },
      after: { hadAccess: true, capabilities: [...CAPABILITIES], reason: 'startup-owner-sync' },
      // An account grant is not a Discord side effect; dry run governs nothing here.
      dryRun: false,
    });
    input.logger.info(
      safeLogFields({
        component: 'startup',
        guildId: input.scope.guildId,
        accountId,
        outcome: 'owner-guild-access-granted',
      }),
      'owner given access and every capability in a newly allowlisted guild',
    );
    granted.push(accountId);
  }
  return granted;
}
