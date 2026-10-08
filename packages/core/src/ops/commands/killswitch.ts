import { z } from 'zod';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';
import { OPS_AUDIT_ACTIONS } from '../audit-actions.js';

/**
 * `bananasaurs killswitch on|off --confirm` (`docs/17` §1).
 *
 * ADR 0013 §4: "The kill switch is reachable from the CLI. Being able to stop
 * the bot from a phone over SSH is a feature." Until this slice, `docs/21` told
 * the operator that Ctrl-C on the process was the emergency brake, because
 * `guilds.killswitch` was checked as layer 2 of the effect gateway and nothing
 * exposed it.
 *
 * It flips one column. Everything that makes it a *control* already exists: the
 * gateway reads that column before every Discord side effect, so a member
 * clicking a role button, a reconciliation pass and an operator's own `undo`
 * are all stopped by the same check, and none of them can route around it
 * (ADR 0014).
 */

const stateSchema = z.object({
  state: z.enum(['on', 'off'], {
    errorMap: () => ({ message: 'must be exactly `on` or `off`' }),
  }),
});

export const killswitchCommand = defineCommand<z.infer<typeof stateSchema>>({
  name: 'killswitch',
  write: true,
  summary: 'stop or resume every Discord side effect for this guild',
  positional: [{ name: 'state', required: true, describe: '`on` to stop acting, `off` to resume' }],
  args: stateSchema,

  run(ctx: OpsContext, args): OpsWriteResult {
    const before = ctx.ports.safetyState();
    if (before === undefined) {
      // `guilds` holds dry-run, the breaker and the rate limits as well. A
      // command that created the row would be choosing this guild's safety
      // defaults as a side effect of an unrelated action — so it refuses, and
      // the refusal names the actual problem.
      throw new Error(
        `guild ${ctx.guildId} has no row in \`guilds\`, so it has no kill switch to set. ` +
          `The daemon writes that row at startup; this usually means it has never ` +
          `started for this guild.`,
      );
    }

    const on = args.state === 'on';
    const wasAlready = before.killswitch === on;
    ctx.ports.setKillswitch(on);

    const text = on
      ? `Kill switch ON${wasAlready ? ' (it was already on)' : ''}.\n` +
        `  No Discord side effect will be performed for ${ctx.guildId}. Events are still\n` +
        `  received, recorded and logged; nothing is written back to Discord.`
      : `Kill switch OFF${wasAlready ? ' (it was already off)' : ''}.\n` +
        `  Discord side effects are live again for ${ctx.guildId}.` +
        (before.dryRun
          ? '\n  Note: dry run is still ON, so nothing will reach Discord anyway.'
          : '');

    return {
      text,
      data: { guildId: ctx.guildId, killswitch: on, changed: !wasAlready },
      audit: {
        // Named for the transition rather than the command, so the trail reads
        // as a history of states and not of keystrokes.
        action: on ? OPS_AUDIT_ACTIONS.killswitchEnabled : OPS_AUDIT_ACTIONS.killswitchDisabled,
        subjectType: 'guild',
        subjectId: ctx.guildId,
        before: { killswitch: before.killswitch },
        after: { killswitch: on },
      },
    };
  },
});
