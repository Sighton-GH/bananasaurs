import { z } from 'zod';
import { CAPABILITIES } from '../../authz.js';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';

/**
 * `bananasaurs account …` (ADR 0045 D6, ADR 0027).
 *
 * The operator's hand on the dashboard-account lever: listing, disabling,
 * re-enabling, deleting, and granting capabilities. Instance-level
 * throughout — `dashboard_accounts` is instance-level (ADR 0027) — so these
 * read `ctx.instance`, not `ctx.ports`. Authorised by the socket like
 * everything here (ADR 0024), which is the point: this lever must work when
 * the dashboard is exactly what is compromised, so no dashboard credential
 * is involved.
 *
 * Neither `disable` nor `delete` guards "the last owner account" (ruling
 * M3b-R2): both are recoverable from the same terminal — a disabled account
 * is re-enabled with `account enable`, and deleting the last account is the
 * recovery path `bootstrap reissue` documents. What the commands owe the
 * operator instead is an honest warning line.
 */

const iso = (ms: number): string => new Date(ms).toISOString();

// The dashboard's own username rules (`packages/http/src/policy.ts`): an
// owner-provisioned local account, narrow by design, so every command names
// an account exactly the way the bootstrap form created it.
const username = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9._-]+$/,
    'a username may contain lowercase letters, digits, dot, dash, underscore',
  );

const accountNameArgs = z.object({ username });

// --- account list ------------------------------------------------------------

export const accountListCommand = defineCommand<Record<string, never>>({
  name: 'account list',
  write: false,
  summary: 'every dashboard account, oldest first (usernames and ids only — never a hash)',
  args: z.object({}),

  run(ctx: OpsContext): OpsCommandResult {
    const accounts = ctx.instance.accountList();
    if (accounts.length === 0) {
      return { text: 'no dashboard accounts', data: [] };
    }
    return {
      text: accounts
        .map((account) => {
          const line =
            `${account.username}  ${account.accountId}  ` +
            `${account.isOwner ? 'owner' : 'member'}  ` +
            `${account.disabled ? 'DISABLED' : 'enabled'}  ` +
            `created ${iso(account.createdAt)}`;
          // A lockout that already elapsed is not a fact about the account
          // any more, so only a live one is shown.
          return account.lockedUntil !== null && account.lockedUntil > ctx.now()
            ? `${line}  locked until ${iso(account.lockedUntil)}`
            : line;
        })
        .join('\n'),
      data: accounts.map((account) => ({
        accountId: account.accountId,
        username: account.username,
        isOwner: account.isOwner,
        disabled: account.disabled,
        lockedUntil: account.lockedUntil,
        createdAt: account.createdAt,
      })),
    };
  },
});

// --- account disable / account enable ----------------------------------------

export const accountDisableCommand = defineCommand<z.infer<typeof accountNameArgs>>({
  name: 'account disable',
  write: true,
  summary: 'disable a dashboard account; its sessions and approved tokens stop verifying',
  positional: [{ name: 'username', required: true, describe: 'the dashboard account username' }],
  args: accountNameArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.instance.accountSetDisabled(args.username, true);

    // A throw is the existing convention for a write that changed nothing
    // because there was nothing to change: an unknown name is a usage
    // mistake, not an answer, and a throw produces no audit row for a state
    // that did not change.
    if (outcome === 'no-such-account') {
      throw new Error(`no dashboard account ${args.username}`);
    }

    if (!outcome.changed) {
      // A usage answer, not a fault — but a write command must return an
      // audit record (the type enforces it), so the row says what happened:
      // the account was already disabled, and nothing changed.
      return {
        text: `${args.username} is already disabled; nothing changed`,
        data: { username: args.username, disabled: true, changed: false },
        audit: {
          action: 'account.disabled',
          subjectType: 'account',
          subjectId: args.username,
          before: { disabled: true },
          after: { disabled: true, changed: false },
        },
      };
    }

    const lines = [
      `disabled ${args.username}`,
      `every dashboard session and every OAuth token this account approved stops verifying for as long as it stays disabled`,
      `this is a pause, not a rotation: \`account enable\` restores every one of those credentials intact. ` +
        `To end them for good, use \`account delete\`.`,
    ];
    if (outcome.isOwner && outcome.changed && outcome.enabledOwnersRemaining === 0) {
      lines.push(
        `WARNING: that was the last enabled owner account. Nobody can sign in to the dashboard. ` +
          `Re-enable it with \`bananasaurs account enable ${args.username} --confirm\`.`,
      );
    } else if (outcome.changed && outcome.enabledOwnersRemaining === 0) {
      lines.push(
        `note: no enabled owner account remains on this instance; ${args.username} is not an owner, ` +
          `so enabling it would not restore dashboard sign-in.`,
      );
    }
    return {
      text: lines.join('\n'),
      data: {
        username: args.username,
        disabled: true,
        changed: true,
        enabledOwnersRemaining: outcome.enabledOwnersRemaining,
      },
      audit: {
        action: 'account.disabled',
        subjectType: 'account',
        subjectId: args.username,
        before: { disabled: false },
        after: { disabled: true, changed: true },
      },
    };
  },
});

export const accountEnableCommand = defineCommand<z.infer<typeof accountNameArgs>>({
  name: 'account enable',
  write: true,
  summary: 're-enable a disabled dashboard account',
  positional: [{ name: 'username', required: true, describe: 'the dashboard account username' }],
  args: accountNameArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.instance.accountSetDisabled(args.username, false);

    if (outcome === 'no-such-account') {
      throw new Error(`no dashboard account ${args.username}`);
    }

    if (!outcome.changed) {
      return {
        text: `${args.username} is already enabled; nothing changed`,
        data: { username: args.username, disabled: false, changed: false },
        audit: {
          action: 'account.enabled',
          subjectType: 'account',
          subjectId: args.username,
          before: { disabled: false },
          after: { disabled: false, changed: false },
        },
      };
    }

    const lines = [`enabled ${args.username}`];
    // A lockout (ADR 0029) is orthogonal to disablement: enabling an account
    // neither clears nor sets it, so a live one is flagged, not hidden.
    if (outcome.lockedUntil !== null && outcome.lockedUntil > ctx.now()) {
      lines.push(
        `note: ${args.username} is locked out until ${iso(outcome.lockedUntil)}; ` +
          `enabling an account does not clear a lockout`,
      );
    }
    return {
      text: lines.join('\n'),
      data: {
        username: args.username,
        disabled: false,
        changed: true,
        enabledOwnersRemaining: outcome.enabledOwnersRemaining,
      },
      audit: {
        action: 'account.enabled',
        subjectType: 'account',
        subjectId: args.username,
        before: { disabled: true },
        after: { disabled: false, changed: true },
      },
    };
  },
});

// --- account delete ----------------------------------------------------------

const accountDeleteArgs = accountNameArgs;

export const accountDeleteCommand = defineCommand<z.infer<typeof accountDeleteArgs>>({
  name: 'account delete',
  write: true,
  summary: 'delete a dashboard account, revoking its tokens and codes with it',
  positional: [{ name: 'username', required: true, describe: 'the dashboard account username' }],
  args: accountDeleteArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.instance.accountDelete(args.username);

    if (outcome === 'no-such-account') {
      throw new Error(`no dashboard account ${args.username}`);
    }

    const lines = [
      `deleted ${args.username} (${outcome.accountId})`,
      `revoked ${String(outcome.tokensRevoked)} OAuth token(s) and removed ${String(outcome.codesDeleted)} ` +
        `unexchanged authorization code(s); guild access, capabilities and dashboard sessions cascaded`,
    ];
    if (outcome.wasOwner && outcome.enabledOwnersRemaining === 0 && outcome.accountsRemaining === 0) {
      lines.push(
        `WARNING: that was the last enabled owner account and the last account of any kind. ` +
          `Nobody can sign in to the dashboard. ` +
          `Run \`bananasaurs bootstrap reissue --confirm\` to re-arm the setup page.`,
      );
    } else if (outcome.wasOwner && outcome.enabledOwnersRemaining === 0) {
      lines.push(
        `WARNING: that was the last enabled owner account. Nobody can sign in to the dashboard, and ` +
          `\`bootstrap reissue\` will refuse while the remaining ${String(outcome.accountsRemaining)} ` +
          `account(s) exist — delete or enable them first.`,
      );
    } else if (outcome.enabledOwnersRemaining === 0) {
      lines.push(
        `note: no enabled owner account remains on this instance; ${args.username} is not an owner, ` +
          `so re-creating it would not restore dashboard sign-in.`,
      );
    }
    return {
      text: lines.join('\n'),
      data: {
        username: outcome.username,
        accountId: outcome.accountId,
        wasOwner: outcome.wasOwner,
        tokensRevoked: outcome.tokensRevoked,
        codesDeleted: outcome.codesDeleted,
        enabledOwnersRemaining: outcome.enabledOwnersRemaining,
        accountsRemaining: outcome.accountsRemaining,
      },
      audit: {
        action: 'account.deleted',
        subjectType: 'account',
        subjectId: args.username,
        before: { exists: true, isOwner: outcome.wasOwner },
        after: {
          exists: false,
          tokensRevoked: outcome.tokensRevoked,
          codesDeleted: outcome.codesDeleted,
        },
      },
    };
  },
});

// --- account grant -----------------------------------------------------------

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
  username,
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
