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
 * re-enabling, deleting, granting capabilities, granting and revoking guild
 * access, and resetting passwords. Instance-level throughout —
 * `dashboard_accounts` is instance-level (ADR 0027) — so these read
 * `ctx.instance`, not `ctx.ports`, EXCEPT `grant-guild`/`revoke-guild`, whose
 * effect genuinely is guild-scoped (S13-D1) and therefore read `ctx.ports`.
 * Authorised by the socket like everything here (ADR 0024), which is the
 * point: this lever must work when the dashboard is exactly what is
 * compromised, so no dashboard credential is involved.
 *
 * Neither `disable` nor `delete` guards "the last owner account" (ruling
 * M3b-R2): both are recoverable from the same terminal — a disabled account
 * is re-enabled with `account enable`, and deleting the last account is the
 * recovery path `bootstrap reissue` documents. What the commands owe the
 * operator instead is an honest warning line. `revoke-guild` joins that
 * deliberate unguardedness (S13-D2): revoking your own last guild access
 * locks you out, recovery is delete + re-bootstrap, and the command warns
 * rather than refusing.
 */

const iso = (ms: number): string => new Date(ms).toISOString();

// The dashboard's own username rules (`packages/http/src/policy.ts`): an
// owner-provisioned local account, narrow by design, so every command names
// an account exactly the way the bootstrap form created it. The first
// character cannot be a dash: `packages/cli/src/args.ts` reads a leading `-`
// as a flag, so such an account could never be named back to `account delete`.
const username = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    'a username must start with a lowercase letter or digit, and may then contain ' +
      'lowercase letters, digits, dot, dash, underscore',
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
    if (
      outcome.wasOwner &&
      outcome.enabledOwnersRemaining === 0 &&
      outcome.accountsRemaining === 0
    ) {
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

// --- account revoke-credentials ----------------------------------------------

export const accountRevokeCredentialsCommand = defineCommand<z.infer<typeof accountNameArgs>>({
  name: 'account revoke-credentials',
  write: true,
  summary:
    'revoke every live dashboard session, OAuth token and authorization code, without disabling it',
  positional: [{ name: 'username', required: true, describe: 'the dashboard account username' }],
  args: accountNameArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.instance.accountRevokeCredentials(args.username);

    // The existing convention for a write that changed nothing because there
    // was nothing to change: an unknown name is a usage mistake, not an
    // answer, and a throw produces no audit row for a state that did not
    // change.
    if (outcome === 'no-such-account') {
      throw new Error(`no dashboard account ${args.username}`);
    }

    const lines = [
      `revoked ${String(outcome.sessionsRevoked)} dashboard session(s), ` +
        `${String(outcome.tokensRevoked)} OAuth token(s) and ` +
        `${String(outcome.codesDeleted)} unexchanged authorization code(s) for ` +
        `${outcome.username} across ${String(outcome.guildsTouched)} guild(s)`,
      outcome.stillEnabled
        ? `${outcome.username} is still enabled and can sign in again with its existing password. ` +
          `To stop it signing in at all, use \`account disable\`; to remove it, \`account delete\`.`
        : `${outcome.username} is disabled, so it cannot sign in regardless; ` +
          `these credentials will not work if it is re-enabled.`,
    ];
    return {
      text: lines.join('\n'),
      data: {
        username: outcome.username,
        accountId: outcome.accountId,
        sessionsRevoked: outcome.sessionsRevoked,
        tokensRevoked: outcome.tokensRevoked,
        codesDeleted: outcome.codesDeleted,
        guildsTouched: outcome.guildsTouched,
        stillEnabled: outcome.stillEnabled,
      },
      audit: {
        action: 'account.credentials.revoked',
        subjectType: 'account',
        subjectId: args.username,
        before: {},
        after: {
          sessionsRevoked: outcome.sessionsRevoked,
          tokensRevoked: outcome.tokensRevoked,
          codesDeleted: outcome.codesDeleted,
          guildsTouched: outcome.guildsTouched,
        },
      },
    };
  },
});

// --- account grant-guild / account revoke-guild (S13-D1/D2) -------------------

/**
 * `bananasaurs account grant-guild <username> --confirm` (slice 13).
 *
 * The guild-access lever `bootstrap` never grew: a fresh account reaches only
 * `deps.guildIds[0]`, and until this command nothing could grant it the
 * others. Guild-scoped — the odd one out beside the instance-level commands
 * above — so this reads `ctx.ports`, not `ctx.instance`: the closure IS the
 * guild being granted, resolved by the dispatcher from the global `--guild`
 * flag, and the command takes no guild of its own (one guild id on the line,
 * never two).
 */
export const accountGrantGuildCommand = defineCommand<z.infer<typeof accountNameArgs>>({
  name: 'account grant-guild',
  write: true,
  summary:
    'grant a dashboard account access to a guild — the global --guild IS the guild granted, not just the audit destination',
  positional: [{ name: 'username', required: true, describe: 'the dashboard account username' }],
  args: accountNameArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.accountGrantGuild(args.username);

    // A throw is the existing convention for a write that changed nothing
    // because there was nothing to change: an unknown name is a usage
    // mistake, not an answer, and a throw produces no audit row for a state
    // that did not change.
    if (outcome === 'no-such-account') {
      throw new Error(`no dashboard account ${args.username}`);
    }

    if (outcome === 'already-had-it') {
      // A usage answer, not a fault — but a write command must return an
      // audit record (the type enforces it), so the row says what happened:
      // the access already held, and nothing changed.
      return {
        text: `${args.username} already has access to guild ${ctx.guildId}; nothing changed`,
        data: {
          username: args.username,
          guildId: ctx.guildId,
          granted: false,
          reason: outcome,
        },
        audit: {
          action: 'account.guild.granted',
          subjectType: 'account',
          subjectId: args.username,
          before: { hadAccess: true },
          after: { hadAccess: true, changed: false },
        },
      };
    }

    return {
      text: [
        `granted ${args.username} access to guild ${ctx.guildId}`,
        `here --guild selected the guild granted, not just the audit trail: unlike every ` +
          `other account command, this one's effect is guild-scoped`,
      ].join('\n'),
      data: {
        username: args.username,
        guildId: ctx.guildId,
        granted: true,
      },
      audit: {
        action: 'account.guild.granted',
        subjectType: 'account',
        subjectId: args.username,
        before: { hadAccess: false },
        after: { hadAccess: true, changed: true },
      },
    };
  },
});

/**
 * `bananasaurs account revoke-guild <username> --confirm` (slice 13).
 *
 * The mirror of `grant-guild` above: guild-scoped, `--guild` is the target,
 * capabilities held in this guild cascade away with the access row (ADR
 * 0028). No guard against revoking your own last guild access (S13-D2,
 * following `account delete`'s A3-3 precedent) — the output warns instead,
 * naming what was done and the recovery, because the CLI has no verified
 * identity (ADR 0024 amendment 2) and cannot know whether the revoked access
 * was the operator's own.
 */
export const accountRevokeGuildCommand = defineCommand<z.infer<typeof accountNameArgs>>({
  name: 'account revoke-guild',
  write: true,
  summary:
    "revoke a dashboard account's access to a guild — the global --guild IS the guild revoked, not just the audit destination",
  positional: [{ name: 'username', required: true, describe: 'the dashboard account username' }],
  args: accountNameArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.accountRevokeGuild(args.username);

    if (outcome === 'no-such-account') {
      throw new Error(`no dashboard account ${args.username}`);
    }

    if (outcome === 'did-not-have-it') {
      return {
        text: `${args.username} has no access to guild ${ctx.guildId}; nothing changed`,
        data: {
          username: args.username,
          guildId: ctx.guildId,
          revoked: false,
          reason: outcome,
        },
        audit: {
          action: 'account.guild.revoked',
          subjectType: 'account',
          subjectId: args.username,
          before: { hadAccess: false },
          after: { hadAccess: false, changed: false },
        },
      };
    }

    return {
      text: [
        `revoked ${args.username}'s access to guild ${ctx.guildId}; ` +
          `capabilities it held in this guild cascaded away with the access`,
        `WARNING: there is no guard against revoking your own last guild access — ` +
          `if that was you, you can no longer sign in to the dashboard. ` +
          `Recovery is delete + re-bootstrap: ` +
          `\`bananasaurs account delete ${args.username} --confirm\`, then ` +
          `\`bananasaurs bootstrap reissue --confirm\`.`,
      ].join('\n'),
      data: {
        username: args.username,
        guildId: ctx.guildId,
        revoked: true,
      },
      audit: {
        action: 'account.guild.revoked',
        subjectType: 'account',
        subjectId: args.username,
        before: { hadAccess: true },
        after: { hadAccess: false, changed: true },
      },
    };
  },
});

// --- account set-password (S13-D3/D4) ----------------------------------------

/**
 * `bananasaurs account set-password <username> --confirm` (slice 13).
 *
 * The password reset ADR 0045 Amendment 4 named as a gap: until this command,
 * a forgotten password meant `account delete` plus re-bootstrap, revoking
 * every OAuth token the account approved. This generates the replacement
 * (S13-D3 — it takes no password argument, because an argument lands in
 * shell history and `ps` output), prints it once, and revokes the account's
 * dashboard sessions in every guild — but not its OAuth tokens, which are
 * bound to the account rather than the password (S13-D4). The output says
 * which happened and names `account revoke-credentials` for the other half.
 *
 * Instance-level like the other account commands: the account predates any
 * guild choice. Async — `defineCommand` permits it, and `effects.ts`
 * (`panel sync`) is the precedent — because the port hashes with Argon2id.
 *
 * Rule 4, stated plainly: the generated password goes into `text` and
 * nowhere else. Not into `data` (whose shape above carries every neighbouring
 * field but the secret), not into the audit row (which records THAT the
 * password changed, never the value), not into any log line.
 */
export const accountSetPasswordCommand = defineCommand<z.infer<typeof accountNameArgs>>({
  name: 'account set-password',
  write: true,
  summary:
    'generate a new password for a dashboard account, print it once, and revoke its dashboard sessions',
  positional: [{ name: 'username', required: true, describe: 'the dashboard account username' }],
  args: accountNameArgs,

  async run(ctx: OpsContext, args): Promise<OpsWriteResult> {
    const outcome = await ctx.instance.accountSetPassword(args.username);

    // The existing convention for a write that changed nothing because there
    // was nothing to change: an unknown name is a usage mistake, not an
    // answer, and a throw produces no audit row for a state that did not
    // change.
    if (outcome === 'no-such-account') {
      throw new Error(`no dashboard account ${args.username}`);
    }

    return {
      text: [
        `new password for ${outcome.username} (generated, shown once — it is not stored ` +
          `anywhere; copy it into a password manager now):`,
        outcome.password,
        `revoked ${String(outcome.sessionsRevoked)} dashboard session(s) across ` +
          `${String(outcome.guildsTouched)} guild(s); OAuth tokens were NOT touched — ` +
          `they are bound to the account, not the password. To revoke those too, run ` +
          `\`bananasaurs account revoke-credentials ${outcome.username} --confirm\`.`,
      ].join('\n'),
      data: {
        username: outcome.username,
        accountId: outcome.accountId,
        sessionsRevoked: outcome.sessionsRevoked,
        guildsTouched: outcome.guildsTouched,
      },
      audit: {
        action: 'account.password.changed',
        subjectType: 'account',
        subjectId: args.username,
        before: {},
        after: {
          passwordChanged: true,
          sessionsRevoked: outcome.sessionsRevoked,
          guildsTouched: outcome.guildsTouched,
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
