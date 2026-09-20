import { useCallback, useState } from 'react';
import type { BackupListing, BackupRunOutcome } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${String(bytes)} B`;
};

/**
 * `/backups`: `bananasaurs backup list` and `backup now --confirm` as a page
 * (ADR 0051 D3). Restore stays on the host with the daemon stopped
 * (docs/17 — a socket command can never guarantee the daemon stopped itself),
 * so this page says so rather than offering it.
 */
export function BackupsPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(
    () => session.read<{ backups: BackupListing[] }>('/api/backups').then((r) => r.backups),
    [session],
  );
  const backups = useResource('the backups', load);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const backupNow = async () => {
    setBusy(true);
    try {
      const result = await session.write<BackupRunOutcome>('/api/backup-now', {});
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `Backup written: ${result.fileName}`,
          message: `${formatSize(result.sizeBytes)}, ${String(result.prunedCount)} pruned by retention.`,
        });
        backups.reload();
      }
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Backups"
        purpose="Every backup on disk, oldest first, and the button that takes one now and applies retention."
        actions={
          <Button variant="primary" onClick={() => setConfirming(true)}>
            Back up now
          </Button>
        }
      />
      <DataState
        resource={backups.resource}
        isEmpty={(rows) => rows.length === 0}
        empty={<p className="text-sm text-ink-muted">No backups yet. Take one now.</p>}
      >
        {(rows) => (
          <div className="max-w-4xl">
            <DataTable
              caption="Backups on disk"
              rows={rows}
              rowKey={(b) => b.fileName}
              columns={[
                { key: 'file', header: 'File', cell: (b) => b.fileName },
                {
                  key: 'size',
                  header: 'Size',
                  cell: (b) => formatSize(b.sizeBytes),
                  numeric: true,
                },
                {
                  key: 'created',
                  header: 'Created',
                  cell: (b) => new Date(b.createdAtMs).toLocaleString(),
                },
                {
                  key: 'checksum',
                  header: 'Checksum',
                  cell: (b) => (b.hasChecksum ? 'recorded' : 'missing'),
                },
              ]}
            />
          </div>
        )}
      </DataState>
      <div className="mt-4 max-w-4xl">
        <Card title="Restore">
          <p className="text-sm">
            Restore is deliberately not here: it needs the daemon stopped, which a running daemon
            can never guarantee about itself. On the host, with the daemon stopped:{' '}
            <code className="text-xs">npm run restore -- &lt;backup-file&gt; --confirm</code>. The
            drill is in <code className="text-xs">docs/SMOKE_TESTS.md</code>.
          </p>
        </Card>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Take a backup now?"
        scope={
          <p>
            Writes a full backup of this instance's database to disk and applies the retention
            policy, which may delete older backups.
          </p>
        }
        confirmLabel="Back up now"
        busy={busy}
        onConfirm={() => void backupNow()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
