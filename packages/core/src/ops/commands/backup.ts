import { z } from 'zod';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';
import { OPS_AUDIT_ACTIONS } from '../audit-actions.js';

/**
 * `bananasaurs backup now --confirm` and `bananasaurs backup list` (ADR 0034).
 *
 * Both on `ctx.instance`, not `ctx.ports`: a backup is `VACUUM INTO` against
 * the one database file the whole process shares, not a query scoped to any
 * guild — the same reason `bootstrap reissue` and `config get`'s environment
 * half live there. `backup now` is safe to run while the daemon is up, which
 * is the entire argument for choosing `VACUUM INTO` in ADR 0034; there is no
 * `restore` command here, and there should never be one — restore needs the
 * daemon stopped, which makes a socket command the wrong shape for it by
 * construction (see `scripts/restore.mjs`).
 */

const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

export const backupNowCommand = defineCommand<Record<string, never>>({
  name: 'backup now',
  write: true,
  summary: 'take a backup immediately and apply retention',
  args: z.object({}),

  run(ctx: OpsContext): OpsWriteResult {
    const before = ctx.instance.backupList().length;
    const outcome = ctx.instance.backupNow();

    if (!outcome.ok) {
      throw new Error(`backup failed: ${outcome.error}`);
    }

    return {
      text:
        `backup written: ${outcome.fileName} (${kb(outcome.sizeBytes)}, sha256 ${outcome.sha256})\n` +
        (outcome.prunedCount > 0
          ? `retention removed ${String(outcome.prunedCount)} older backup(s)`
          : 'retention removed nothing'),
      data: {
        fileName: outcome.fileName,
        sizeBytes: outcome.sizeBytes,
        sha256: outcome.sha256,
        prunedCount: outcome.prunedCount,
      },
      audit: {
        action: OPS_AUDIT_ACTIONS.backupCreated,
        subjectType: 'instance',
        subjectId: undefined,
        before: { backupCount: before },
        after: { backupCount: before + 1 - outcome.prunedCount, fileName: outcome.fileName },
      },
    };
  },
});

export const backupListCommand = defineCommand<Record<string, never>>({
  name: 'backup list',
  write: false,
  summary: 'every backup on disk, oldest first',
  args: z.object({}),

  run(ctx: OpsContext): OpsCommandResult {
    const backups = ctx.instance.backupList();

    return {
      text:
        backups.length === 0
          ? 'no backups yet — the timer takes one on daemon startup and on its configured interval'
          : backups
              .map(
                (b) =>
                  `${iso(b.createdAtMs)}  ${b.fileName.padEnd(40)} ${kb(b.sizeBytes).padStart(10)}` +
                  `${b.hasChecksum ? '' : '   MISSING CHECKSUM'}`,
              )
              .join('\n'),
      data: backups.map((b) => ({
        fileName: b.fileName,
        sizeBytes: b.sizeBytes,
        createdAtMs: b.createdAtMs,
        hasChecksum: b.hasChecksum,
      })),
    };
  },
});
