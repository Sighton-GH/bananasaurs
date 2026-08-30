import { z } from 'zod';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';

/**
 * `bananasaurs bootstrap reissue --confirm`.
 *
 * ADR 0012's documented recovery path, and the reason the owner is not a single
 * point of failure for dashboard access: *"the bootstrap path can be re-armed
 * from the host by someone with shell access, which the owner already has.
 * Document the recovery procedure and test it once."*
 *
 * The command is authorized the way every operator command is — by the socket's
 * group permissions (ADR 0024) — which is exactly right here. This is the
 * escape hatch for the case where nobody can log in, so gating it on a
 * dashboard credential would make it useless in the only situation it exists
 * for.
 *
 * **It refuses while any account exists.** Re-arming on a provisioned instance
 * would mean anyone with shell access could mint a second owner account without
 * touching the first, and the trail would show only a token issuance. The
 * documented path for a forgotten password is a password reset by the owner, or
 * — when there is no owner to ask — deleting the account rows deliberately,
 * which is a decision someone makes explicitly rather than a side effect of
 * running a recovery command.
 *
 * The plaintext token is returned to *this operator's terminal* and to the
 * journal, and never stored (`docs/19` §6.10 step 1). It is in the command's
 * `data` as well as its `text`, because `--json` is the agent-readable form of
 * the same answer — and both go back over the socket to the human who asked.
 */

export const bootstrapReissueCommand = defineCommand<Record<string, never>>({
  name: 'bootstrap reissue',
  write: true,
  summary: 're-arm the first-account setup page when no dashboard account exists',
  args: z.object({}),

  run(ctx: OpsContext): OpsWriteResult {
    const outcome = ctx.instance.reissueBootstrapToken();

    if (!outcome.ok) {
      throw new Error(
        outcome.reason === 'accounts-exist'
          ? `this instance already has ${String(outcome.accountCount)} dashboard account(s), so ` +
              `the setup page will not re-arm. Re-arming here would let anyone with shell access ` +
              `mint a second owner account. To reset a forgotten password, have an owner change ` +
              `it from the dashboard; if there is no owner left, remove the account rows ` +
              `deliberately and run this again.`
          : `this instance is running with BANANASAURS_READONLY set, so it cannot issue a ` +
              `token. Restart without it and run this again.`,
      );
    }

    const expiresInMin = Math.round((outcome.expiresAt - ctx.now()) / 60_000);

    return {
      text:
        `══ Bananasaurs first-run setup ══\n` +
        `Open http://127.0.0.1:${String(outcome.port)}/bootstrap?token=${outcome.token}\n` +
        `Expires in ${String(expiresInMin)} minutes. Not shown again; run this command to reissue.\n` +
        `\n` +
        `The setup page is registered at startup, so **restart the daemon** before opening\n` +
        `that link — a running process decided /bootstrap did not exist and will keep\n` +
        `answering 404.\n` +
        `\n` +
        `Reaching 127.0.0.1 from your laptop: ssh -L ${String(outcome.port)}:127.0.0.1:${String(outcome.port)} <host>`,
      data: {
        // The token is the point of the command; it is returned to the operator
        // who asked, over the socket their group membership already gated.
        token: outcome.token,
        expiresAt: outcome.expiresAt,
        port: outcome.port,
        restartRequired: true,
      },
      audit: {
        action: 'dashboard.bootstrap_reissued',
        subjectType: 'instance',
        subjectId: undefined,
        // Neither `before` nor `after` carries the token or its hash. The trail
        // records that the setup page was re-armed and when it expires; it is
        // not a place to keep a credential, and an audit row is exactly the
        // sort of thing that ends up in an export.
        before: { armed: false },
        after: { armed: true, expiresAt: outcome.expiresAt },
      },
    };
  },
});
