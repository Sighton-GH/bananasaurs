import { z } from 'zod';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';

/**
 * The three Release 1 write commands that cause Discord side effects:
 * `panel sync`, `undo`, `adoption allow`.
 *
 * **None of them awaits the unbounded part** (ADR 0026). Role effects go
 * through a per-source rate cap, sequentially and on purpose, so a thirty-effect
 * undo takes ninety seconds at the default cap and the CLI gives up after
 * thirty. A synchronous version would print a timeout at the terminal and keep
 * reversing role grants in the background — leaving the operator unable to say
 * whether the command ran, on the command whose whole purpose is to repair
 * state during an incident.
 *
 * So each one does the bounded work now — validate, refuse, report the size,
 * post a message — and queues the rest as a durable job.
 *
 * Nothing here reaches Discord directly. `panel sync` calls `publishPanel`, and
 * the queued jobs call the same `applyRoleEffect` a member's click does, so the
 * kill switch, the breaker, the hierarchy check, the rate cap and dry run all
 * still apply. An operator command that could bypass any of those would be a
 * second, unaudited way to change roles.
 */

const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** How to watch work this command could not wait for. */
const watchWith = (jobId: number | undefined): string =>
  jobId === undefined
    ? '  The same work was already queued, so nothing new was added.'
    : `  Queued as job ${String(jobId)}. Watch it with \`bananasaurs jobs list\`,\n` +
      `  and see what it did with \`bananasaurs audit tail\`.`;

// --- panel sync --------------------------------------------------------------

const panelSyncArgs = z.object({ panelId: z.string().min(1).max(64) });

export const panelSyncCommand = defineCommand<z.infer<typeof panelSyncArgs>>({
  name: 'panel sync',
  write: true,
  summary: 'make Discord match one panel: post or edit it, re-seed it, reconcile it',
  positional: [{ name: 'panelId', required: true, describe: 'the panel id from `panel list`' }],
  args: panelSyncArgs,

  async run(ctx: OpsContext, args): Promise<OpsWriteResult> {
    const panel = ctx.ports.findPanel(args.panelId);
    if (panel === undefined) throw new Error(`no panel ${args.panelId} in guild ${ctx.guildId}`);

    // Refused rather than attempted. A disabled panel was taken out of service
    // by `doctor` or by an owner, and posting its message would put a control
    // back in front of members that something decided should not be there.
    if (panel.status !== 'enabled') {
      throw new Error(
        `panel ${args.panelId} is ${panel.status}, so syncing it would put a panel back in\n` +
          `  front of members that something took out of service. Re-enable it first.`,
      );
    }

    const published = await ctx.ports.publishPanel(args.panelId);

    // Only adopted panels have a reconciliation: `reconcileGuild` walks
    // reactions, and a managed panel is driven by buttons or a select menu,
    // which carry no state to drift.
    const queued = panel.kind === 'adopted' ? ctx.ports.enqueueReconcile(args.panelId) : undefined;

    const lines: string[] = [];
    switch (published.action) {
      case 'posted':
        lines.push(`Posted panel ${args.panelId} as message ${published.messageId ?? '?'}.`);
        break;
      case 'edited':
        lines.push(`Rewrote panel ${args.panelId}'s message to match its configuration.`);
        break;
      case 'not-managed':
        // Not a failure. A bot may only edit its own messages, and that
        // asymmetry is the entire reason adopted panels are reaction-driven.
        lines.push(
          `Panel ${args.panelId} is adopted, so its message belongs to someone else and\n` +
            `  cannot be rewritten. Its reactions and its members are still synced.`,
        );
        break;
    }

    if (published.reactionsSeeded > 0) {
      lines.push(
        `  Re-seeded ${String(published.reactionsSeeded)} reaction(s); adding one that is` +
          ` already there is a no-op at Discord.`,
      );
    }
    for (const failure of published.reactionsFailed) {
      lines.push(`  Discord refused ${failure.emojiKey}: ${failure.error}`);
    }
    if (queued !== undefined) lines.push(watchWith(queued.jobId));

    return {
      text: lines.join('\n'),
      data: {
        panelId: args.panelId,
        action: published.action,
        messageId: published.messageId ?? null,
        reactionsSeeded: published.reactionsSeeded,
        reactionsFailed: published.reactionsFailed.map((f) => ({ ...f })),
        reconcileJobId: queued?.jobId ?? null,
      },
      audit: {
        action: 'panel.synced',
        subjectType: 'panel',
        subjectId: args.panelId,
        after: {
          publish: published.action,
          reactionsSeeded: published.reactionsSeeded,
          reconcileJobId: queued?.jobId ?? null,
        },
      },
    };
  },
});

// --- undo --------------------------------------------------------------------

const undoArgs = z.object({
  batch: z.string().min(1).max(64),
  reason: z.string().min(1).max(200).optional(),
});

export const undoCommand = defineCommand<z.infer<typeof undoArgs>>({
  name: 'undo',
  write: true,
  summary: 'reverse one batch of role effects',
  positional: [
    { name: 'batch', required: true, describe: 'the batch id from `audit tail --json`' },
  ],
  flags: [{ name: 'reason', kind: 'string', describe: 'recorded on every reversing effect' }],
  args: undoArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const batch = ctx.ports.findBatch(args.batch);
    if (batch === undefined) {
      throw new Error(
        `no batch ${args.batch} in guild ${ctx.guildId}.\n` +
          `  Batch ids come from \`bananasaurs audit tail --json\`.`,
      );
    }
    if (batch.undoneAt !== null) {
      // Refused, not repeated. Undoing an undone batch would push the inverse
      // through a second time, and the inverse of the inverse is the original
      // change — so a careless repeat would silently re-apply what was undone.
      throw new Error(
        `batch ${args.batch} was already undone at ${iso(batch.undoneAt)}.\n` +
          `  Undoing it again would re-apply the very changes that undo reversed.`,
      );
    }

    const counted = ctx.ports.countUndoable(args.batch);
    if (counted.reversible === 0) {
      throw new Error(
        `batch ${args.batch} has ${String(counted.total)} effect(s) and none of them can be\n` +
          `  reversed: they were refused, dry-run, or changed nothing because the member\n` +
          `  already held the role. There is nothing to undo.`,
      );
    }

    const reason = args.reason ?? `operator undo of batch ${args.batch}`;
    const queued = ctx.ports.enqueueUndo({ batchId: args.batch, reason });

    return {
      text:
        `Undoing batch ${args.batch}: ${String(counted.reversible)} of ` +
        `${String(counted.total)} effect(s) will be reversed.\n` +
        `  It goes through the same gateway the original changes did, so the kill switch,\n` +
        `  the breaker, the hierarchy check and the rate cap all still apply.\n` +
        watchWith(queued.jobId),
      data: {
        batchId: args.batch,
        total: counted.total,
        reversible: counted.reversible,
        jobId: queued.jobId ?? null,
        enqueued: queued.enqueued,
      },
      audit: {
        action: 'batch.undo_requested',
        subjectType: 'batch',
        subjectId: args.batch,
        before: { undoneAt: null, reversible: counted.reversible },
        // Requested, not done. The reversals are audited one by one by the
        // gateway when the job runs; this row records who asked and when.
        after: { jobId: queued.jobId ?? null, reason },
      },
    };
  },
});

// --- adoption allow ----------------------------------------------------------

const adoptionAllowArgs = z.object({ count: z.coerce.number().int().positive().max(10_000) });

export const adoptionAllowCommand = defineCommand<z.infer<typeof adoptionAllowArgs>>({
  name: 'adoption allow',
  write: true,
  summary: 'approve a sized batch of adoption role changes',
  positional: [
    {
      name: 'count',
      required: true,
      describe: 'how many changes you approve; size it from `panel show`',
    },
  ],
  args: adoptionAllowArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const before = ctx.ports.adoptionAllowance();
    ctx.ports.grantAdoptionAllowance(args.count);
    const after = ctx.ports.adoptionAllowance();

    return {
      text:
        `Approved ${String(args.count)} adoption change(s); the allowance is now ` +
        `${String(after)}.\n` +
        `  An allowance is a count, not a rate: it is consumed and does not renew, and\n` +
        `  anything beyond it trips the breaker normally.\n` +
        `  It lives in this process's memory, so a restart loses whatever is unspent.\n` +
        `  Size the next one from \`bananasaurs panel show <id>\`, which reports how many\n` +
        `  changes are waiting.`,
      data: { granted: args.count, allowanceBefore: before, allowanceAfter: after },
      audit: {
        action: 'adoption.allowance_granted',
        subjectType: 'guild',
        subjectId: ctx.guildId,
        before: { allowance: before },
        after: { allowance: after },
      },
    };
  },
});
