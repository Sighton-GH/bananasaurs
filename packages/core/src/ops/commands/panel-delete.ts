import { z } from 'zod';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';

/**
 * `panel delete` — deletes the panel's Discord message, then its rows.
 *
 * The shape is `panel sync`'s (`effects.ts`): a positional panel id, a throw
 * for an unknown one, and the Discord side effect through an ops port —
 * `unpublishPanel` — rather than reached for directly. The port deletes the
 * message first and the rows after, so a Discord failure throws with the rows
 * still in place and a retry can finish.
 *
 * Deleting a message that is already gone is a no-op — `unpublishPanel`
 * treats unknown-message as success — so retrying this command is safe. That
 * idempotency is the rule-6 argument for a destructive command that would
 * otherwise be frightening to re-run.
 *
 * An adopted panel's message belongs to someone else and is never touched:
 * the port deletes the rows only. Roles stay in `managed_roles` either way,
 * and members keep whatever they hold.
 */

const panelDeleteArgs = z.object({ panelId: z.string().min(1).max(64) });

export const panelDeleteCommand = defineCommand<z.infer<typeof panelDeleteArgs>>({
  name: 'panel delete',
  write: true,
  summary: 'delete a panel: remove its Discord message, then its rows',
  positional: [{ name: 'panelId', required: true, describe: 'the panel id from `panel list`' }],
  args: panelDeleteArgs,

  async run(ctx: OpsContext, args): Promise<OpsWriteResult> {
    const panel = ctx.ports.findPanel(args.panelId);
    if (panel === undefined) throw new Error(`no panel ${args.panelId} in guild ${ctx.guildId}`);

    const posted = panel.messageId !== undefined;
    const managed = panel.kind === 'managed';
    const messageDeleted = managed && posted;

    await ctx.ports.unpublishPanel(args.panelId);

    let text: string;
    if (messageDeleted) {
      text =
        `Deleted panel ${args.panelId}: removed its Discord message ${panel.messageId} ` +
        `from <#${panel.channelId}> and deleted its configuration.\n` +
        `  Its roles stay allowlisted and members keep whatever they hold — ` +
        `deleting a panel revokes nothing.`;
    } else if (posted) {
      // Adopted, by elimination: only a managed posted panel deletes its
      // message. Somebody else's message is not ours to remove.
      text =
        `Deleted panel ${args.panelId}'s configuration, and left its message in place: ` +
        `it is adopted, so message ${panel.messageId} belongs to someone else.\n` +
        `  Its roles stay allowlisted and members keep whatever they hold.`;
    } else {
      text =
        `Deleted panel ${args.panelId}'s configuration. It was never posted, ` +
        `so there was no message to remove.\n` +
        `  Its roles stay allowlisted and members keep whatever they hold.`;
    }

    return {
      text,
      data: {
        panelId: args.panelId,
        messageDeleted,
        messageId: panel.messageId ?? null,
      },
      audit: {
        action: 'panel.deleted',
        subjectType: 'panel',
        subjectId: args.panelId,
        before: {
          kind: panel.kind,
          channelId: panel.channelId,
          messageId: panel.messageId ?? null,
        },
        after: { messageDeleted },
      },
    };
  },
});
