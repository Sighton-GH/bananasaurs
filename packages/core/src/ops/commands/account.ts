import { z } from 'zod';
import { CAPABILITIES } from '../../authz.js';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';

/**
 * `bananasaurs account grant <username> <capability> --confirm` (ADR 0028).
 *
 * The ADR 0028 grant path for dashboard accounts: capabilities for accounts
 * are keyed `(guild_id, account_id, capability)`, so the guild is
 * `ctx.guildId` — resolved by the dispatcher from the global `--guild` flag —
 * and this command takes no `--guild` flag of its own. Authorised by the
 * socket like everything here (ADR 0024), which is the point: it exists for
 * the case where the dashboard cannot be used to issue the grant itself.
 */

const accountGrantArgs = z.object({
  // The dashboard's own username rules (`packages/http/src/policy.ts`): an
  // owner-provisioned local account, narrow by design, so the grant names an
  // account exactly the way the bootstrap form created it.
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(
      /^[a-z0-9._-]+$/,
      'a username may contain lowercase letters, digits, dot, dash, underscore',
    ),
  // `z.enum` over the live list, so an unknown capability is a validation
  // refusal naming the valid set rather than a row the authorizer ignores.
  capability: z.enum(CAPABILITIES),
});

export const accountGrantCommand = defineCommand<z.infer<typeof accountGrantArgs>>({
  name: 'account grant',
  write: true,
  summary: 'grant a dashboard account a capability in this guild',
  positional: [
    { name: 'username', required: true, describe: 'the dashboard account username' },
    { name: 'capability', required: true, describe: 'one of the known capabilities' },
  ],
  args: accountGrantArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.grantAccountCapability({
      username: args.username,
      capability: args.capability,
      // The claim, not a verified identity (amendment 2): recorded in the
      // audit row's `grantedBy` the way `unixUserClaimed` is recorded in the
      // trail, and consulted for nothing.
      grantedBy: ctx.actor.unixUserClaimed ?? 'operator_cli',
    });

    // Throws are usage mistakes that changed nothing, so they produce no
    // audit row: there is no such account, or the account cannot reach this
    // guild and the foreign key would have refused anyway.
    if (outcome === 'no-such-account') {
      throw new Error(`no dashboard account ${args.username}`);
    }
    if (outcome === 'no-guild-access') {
      throw new Error(
        `account ${args.username} cannot reach guild ${ctx.guildId}, ` +
          `so it cannot hold a capability there`,
      );
    }

    if (outcome === 'already-held') {
      // A usage answer, not a fault — but a write command must return an
      // audit record (the type enforces it), so the row says what happened:
      // the grant already held, and nothing changed.
      return {
        text:
          `${args.username} already holds ${args.capability} ` +
          `in guild ${ctx.guildId}; nothing changed`,
        data: {
          username: args.username,
          capability: args.capability,
          guildId: ctx.guildId,
          granted: false,
          reason: outcome,
        },
        audit: {
          action: 'account.capability.granted',
          subjectType: 'account',
          subjectId: args.username,
          before: { held: true },
          after: { held: true, capability: args.capability, changed: false },
        },
      };
    }

    return {
      text: `granted ${args.capability} to ${args.username} in guild ${ctx.guildId}`,
      data: {
        username: args.username,
        capability: args.capability,
        guildId: ctx.guildId,
        granted: true,
      },
      audit: {
        action: 'account.capability.granted',
        subjectType: 'account',
        subjectId: args.username,
        before: { held: false },
        after: { held: true, capability: args.capability },
      },
    };
  },
});
