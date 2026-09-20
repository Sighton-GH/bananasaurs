import { useCallback, useState } from 'react';
import type { Enqueued, PanelDetail, PanelSummary, PublishResult } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * `/panels`: `panel list` and `panel show` as a page, with the two actions
 * the operator CLI gates behind `--confirm` (ADR 0051 D3/D4). Publish posts
 * or edits the panel's Discord message right now — a live side effect, so it
 * states its scope first. Reconcile only enqueues a job: the worker
 * reconciles against Discord under the current kill switch and dry-run
 * state, which is the observe-safe half.
 */
export function PanelsPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<PanelSummary[]>('/api/panels'), [session]);
  const panels = useResource('the role panels', load);

  const [selected, setSelected] = useState<PanelDetail | undefined>(undefined);
  const [detailError, setDetailError] = useState<string | undefined>(undefined);
  const [publishing, setPublishing] = useState<PanelDetail | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const view = async (panel: PanelSummary) => {
    setDetailError(undefined);
    try {
      setSelected(
        await session.read<PanelDetail>(`/api/panels/${encodeURIComponent(panel.panelId)}`),
      );
    } catch (err) {
      setSelected(undefined);
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  };

  const publish = async () => {
    if (publishing === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<PublishResult>(
        `/api/panels/${encodeURIComponent(publishing.panelId)}/publish`,
        {},
      );
      if (result !== undefined) {
        const failed = result.reactionsFailed.length;
        toast({
          tone: result.action === 'not-managed' || failed > 0 ? 'hold' : 'ok',
          title:
            result.action === 'not-managed'
              ? 'Panel not managed — Discord refused the edit'
              : `Panel ${result.action}`,
          ...(failed > 0
            ? {
                message: `${String(failed)} emoji refused: ${result.reactionsFailed.map((f) => f.emojiKey).join(', ')}.`,
              }
            : {}),
        });
        panels.reload();
        if (selected !== undefined) await view(selected);
      }
    } finally {
      setBusy(false);
      setPublishing(undefined);
    }
  };

  const reconcile = async (panel: PanelDetail) => {
    const result = await session.write<Enqueued>(
      `/api/panels/${encodeURIComponent(panel.panelId)}/reconcile`,
      {},
    );
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title: result.enqueued
          ? `Reconcile enqueued for ${panel.panelId}`
          : 'A reconcile was already pending',
        ...(result.jobId !== undefined ? { message: `job #${String(result.jobId)}` } : {}),
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Role panels"
        purpose="Self-service role menus posted in Discord: what is configured, whether Discord still agrees, and the publish and reconcile levers."
      />
      <DataState
        resource={panels.resource}
        isEmpty={(p) => p.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No panels configured. Create one with the operator CLI.
          </p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Role panels"
            rows={rows}
            rowKey={(p) => p.panelId}
            columns={[
              { key: 'id', header: 'Panel', cell: (p) => p.panelId },
              {
                key: 'shape',
                header: 'Kind',
                cell: (p) => `${p.kind}/${p.component}/${p.behaviour}`,
              },
              { key: 'status', header: 'Status', cell: (p) => p.status },
              { key: 'options', header: 'Options', cell: (p) => p.optionCount, numeric: true },
              {
                key: 'actions',
                header: '',
                cell: (p) => <Button onClick={() => void view(p)}>Manage</Button>,
              },
            ]}
          />
        )}
      </DataState>
      {detailError !== undefined && (
        <p role="alert" className="mt-3 text-sm text-danger">
          Could not load the panel: {detailError}
        </p>
      )}
      {selected !== undefined && (
        <div className="mt-4 grid max-w-4xl gap-3">
          <Card title={`Panel ${selected.panelId}`}>
            <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-muted">Channel</dt>
              <dd>{selected.channelId}</dd>
              <dt className="text-ink-muted">Status</dt>
              <dd>{selected.status}</dd>
              <dt className="text-ink-muted">Message</dt>
              <dd>{selected.messageId ?? 'not posted'}</dd>
              <dt className="text-ink-muted">Max roles per member</dt>
              <dd>{selected.maxRoles !== undefined ? String(selected.maxRoles) : 'no limit'}</dd>
              <dt className="text-ink-muted">Required role</dt>
              <dd>{selected.requiredRoleId ?? 'none'}</dd>
              <dt className="text-ink-muted">Blocked roles</dt>
              <dd>
                {selected.blockedRoleIds.length === 0 ? 'none' : selected.blockedRoleIds.join(', ')}
              </dd>
              <dt className="text-ink-muted">Adoption</dt>
              <dd>
                {selected.adoptionPassState}
                {selected.adoptionBlockedCount > 0 && (
                  <Badge tone="hold">{String(selected.adoptionBlockedCount)} blocked</Badge>
                )}
              </dd>
            </dl>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" busy={busy} onClick={() => setPublishing(selected)}>
                Publish to Discord
              </Button>
              <Button busy={busy} onClick={() => void reconcile(selected)}>
                Enqueue reconcile
              </Button>
            </div>
          </Card>
          <Card title="Options">
            {selected.options.length === 0 ? (
              <p className="text-sm text-ink-muted">No options configured.</p>
            ) : (
              <DataTable
                caption={`Options of panel ${selected.panelId}`}
                rows={selected.options}
                rowKey={(o) => o.optionId}
                columns={[
                  { key: 'option', header: 'Option', cell: (o) => o.optionId },
                  { key: 'role', header: 'Role', cell: (o) => o.roleId },
                  {
                    key: 'face',
                    header: 'Shown as',
                    cell: (o) => o.emojiKey ?? o.label ?? <span className="text-ink-muted">—</span>,
                  },
                ]}
              />
            )}
          </Card>
        </div>
      )}
      <ConfirmDialog
        open={publishing !== undefined}
        title={`Publish panel ${publishing?.panelId ?? ''}?`}
        scope={
          <p>
            Posts or edits the panel&apos;s message in Discord channel {publishing?.channelId ?? ''}{' '}
            right now — members see the result immediately. To check drift without touching Discord,
            enqueue a reconcile instead.
          </p>
        }
        confirmLabel="Publish to Discord"
        busy={busy}
        onConfirm={() => void publish()}
        onCancel={() => setPublishing(undefined)}
      />
    </>
  );
}
