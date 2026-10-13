import { useCallback, useState } from 'react';
import { isCustomEmojiKey, unicodeEmojiChars } from '@bananasaurs/core';
import type {
  Enqueued,
  GuildRoleInfo,
  PanelDetail,
  PanelSummary,
  PublishResult,
} from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DescriptionList } from '../ui/DescriptionList.js';
import { DataTable } from '../ui/DataTable.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorNotice } from '../ui/ErrorNotice.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';
import { PanelBuilder } from './panel-builder.js';

/**
 * `/panels`: `panel list` and `panel show` as a page, the role-panel builder
 * as the production creation path (ADR 0053), and the two actions the
 * operator CLI gates behind `--confirm` (ADR 0051 D3/D4). Publish posts
 * or edits the panel's Discord message right now — a live side effect, so it
 * states its scope first. For a reaction role (an adopted panel) the message
 * is someone else's, so publish adds the emoji and queues a re-check instead
 * (ADR 0139). "Re-check reactions" only enqueues that job: the worker
 * matches roles to the message's reactions under the current kill switch and
 * dry-run state. Button and dropdown panels have no reactions to re-check.
 */
export function PanelsPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<PanelSummary[]>('/api/panels'), [session]);
  const panels = useResource('the role panels', load);
  // Role names for the detail card; the ids alone mean nothing to a person.
  const loadRoles = useCallback(
    () => session.read<{ roles: readonly GuildRoleInfo[] }>('/api/guild/roles'),
    [session],
  );
  const roles = useResource('the role list', loadRoles);
  const roleName = (roleId: string) =>
    (roles.resource.state === 'ready'
      ? roles.resource.data.roles.find((r) => r.roleId === roleId)?.name
      : undefined) ?? roleId;

  const [building, setBuilding] = useState(false);
  const [selected, setSelected] = useState<PanelDetail | undefined>(undefined);
  const [detailError, setDetailError] = useState<unknown>(undefined);
  const [publishing, setPublishing] = useState<PanelDetail | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const viewById = async (panelId: string) => {
    setDetailError(undefined);
    try {
      setSelected(await session.read<PanelDetail>(`/api/panels/${encodeURIComponent(panelId)}`));
    } catch (err) {
      // A load failure renders the server's answer, not the bare message.
      setSelected(undefined);
      setDetailError(err);
    }
  };

  const view = (panel: PanelSummary) => viewById(panel.panelId);

  // Straight from the builder's created state to the new panel's detail card,
  // where the publish lever sits — creation and publishing stay two
  // deliberate steps (ADR 0053).
  const created = async (panelId: string) => {
    setBuilding(false);
    panels.reload();
    await viewById(panelId);
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
        // `not-managed` is an adopted panel's normal answer, not a refusal: the
        // bot may not edit someone else's message, so it only adds the emoji.
        const adopted = result.action === 'not-managed';
        const detail = [
          ...(adopted
            ? [
                'The emoji are on the existing message; its text is unchanged.' +
                  (result.reconcileJobId !== null
                    ? ` Anyone who had already reacted gets their role shortly (job #${String(result.reconcileJobId)}).`
                    : ''),
              ]
            : []),
          ...(failed > 0
            ? [
                `${String(failed)} emoji refused: ${result.reactionsFailed.map((f) => f.emojiKey).join(', ')}.`,
              ]
            : []),
        ];
        toast({
          tone: failed > 0 ? 'hold' : 'ok',
          title: adopted ? 'Reaction role is live' : `Panel ${result.action}`,
          ...(detail.length > 0 ? { message: detail.join(' ') } : {}),
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
          ? `Re-checking the reactions on ${panel.panelId}`
          : 'A re-check was already queued',
        ...(result.jobId !== undefined ? { message: `job #${String(result.jobId)}` } : {}),
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Role panels"
        purpose="Let members give themselves roles, by reacting with an emoji or by using buttons or a dropdown on a message the bot posts. Build panels here, then publish them to Discord."
        actions={
          building ? undefined : (
            <Button variant="primary" onClick={() => setBuilding(true)}>
              New reaction role or role panel
            </Button>
          )
        }
      />
      {building && (
        <div className="mb-4">
          <PanelBuilder
            onCreated={(panelId) => void created(panelId)}
            onCancel={() => setBuilding(false)}
          />
        </div>
      )}
      <DataState
        resource={panels.resource}
        isEmpty={(p) => p.length === 0}
        empty={
          <EmptyState
            title="Nothing set up yet"
            detail="Build the first one here — pick a reaction role or a role panel, and nothing reaches Discord until you publish."
            action={
              <Button variant="primary" onClick={() => setBuilding(true)}>
                Build the first one
              </Button>
            }
          />
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
                // Plain words, not the storage triple: the format a member
                // sees, then the behaviour.
                cell: (p) => {
                  const format =
                    p.component === 'reaction'
                      ? 'Emoji reactions'
                      : p.component === 'button'
                        ? 'Buttons'
                        : 'Dropdown';
                  const behaviour =
                    p.behaviour === 'single_choice'
                      ? 'single choice'
                      : p.behaviour.replace('_', ' ');
                  return `${format} · ${behaviour}`;
                },
              },
              {
                key: 'status',
                header: 'Status',
                cell: (p) => <Badge tone={p.status === 'posted' ? 'ok' : 'hold'}>{p.status}</Badge>,
              },
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
        <div className="mt-3">
          <ErrorNotice error={detailError} />
        </div>
      )}
      {selected !== undefined && (
        <div className="mt-4 grid max-w-4xl gap-3">
          <Card title={selected.panelId}>
            <DescriptionList
              columns={2}
              items={[
                { term: 'Channel', value: selected.channelId },
                {
                  term: 'Status',
                  value: (
                    <Badge tone={selected.status === 'posted' ? 'ok' : 'hold'}>
                      {selected.status}
                    </Badge>
                  ),
                },
                { term: 'Message', value: selected.messageId ?? 'not posted' },
                {
                  term: 'Message text',
                  value: (
                    <span className="whitespace-pre-wrap">
                      {selected.content ?? 'Pick your roles. (the default)'}
                    </span>
                  ),
                },
                {
                  term: 'Max roles per member',
                  value: selected.maxRoles !== undefined ? String(selected.maxRoles) : 'no limit',
                },
                {
                  term: 'Requires role first',
                  value:
                    selected.requiredRoleId === undefined
                      ? 'none'
                      : roleName(selected.requiredRoleId),
                },
                {
                  term: 'Blocks roles',
                  value:
                    selected.blockedRoleIds.length === 0
                      ? 'none'
                      : selected.blockedRoleIds.map(roleName).join(', '),
                },
                ...(selected.kind === 'adopted'
                  ? [
                      {
                        term: 'Adoption',
                        value: (
                          <>
                            {selected.adoptionPassState}
                            {selected.adoptionBlockedCount > 0 && (
                              <Badge tone="hold">
                                {String(selected.adoptionBlockedCount)} blocked
                              </Badge>
                            )}
                          </>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            <div className="mt-3 flex gap-2">
              <Button variant="primary" busy={busy} onClick={() => setPublishing(selected)}>
                Publish to Discord
              </Button>
              {selected.kind === 'adopted' && (
                <Button busy={busy} onClick={() => void reconcile(selected)}>
                  Re-check reactions
                </Button>
              )}
            </div>
            {selected.kind === 'adopted' && (
              <p className="mt-2 text-sm text-ink-muted">
                Re-check reactions brings members&apos; roles back in line with their reactions on
                the message, for reactions added or removed while the bot was offline. It also runs
                on its own after a publish and whenever the bot reconnects to Discord.
              </p>
            )}
          </Card>
          <Card title="Options">
            {selected.options.length === 0 ? (
              <p className="text-small text-ink-muted">No options configured.</p>
            ) : (
              <DataTable
                caption={`Options of panel ${selected.panelId}`}
                rows={selected.options}
                rowKey={(o) => o.optionId}
                columns={[
                  { key: 'option', header: 'Option', cell: (o) => o.optionId },
                  { key: 'role', header: 'Role', cell: (o) => roleName(o.roleId) },
                  {
                    key: 'face',
                    header: 'Shown as',
                    // What members see: the emoji itself for unicode keys, the
                    // key for custom ones (their image needs a live guild).
                    cell: (o) =>
                      o.emojiKey !== undefined
                        ? isCustomEmojiKey(o.emojiKey)
                          ? o.emojiKey
                          : unicodeEmojiChars(o.emojiKey)
                        : (o.label ?? <span className="text-ink-muted">—</span>),
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
          publishing?.kind === 'adopted' ? (
            <p>
              Adds this reaction role&apos;s emoji to the existing message in Discord channel{' '}
              {publishing.channelId} right now, then re-checks its reactions so anyone who already
              reacted gets their role. The message text is not changed.
            </p>
          ) : (
            <p>
              Posts or edits the panel&apos;s message in Discord channel{' '}
              {publishing?.channelId ?? ''} right now — members see the result immediately.
            </p>
          )
        }
        confirmLabel="Publish to Discord"
        busy={busy}
        onConfirm={() => void publish()}
        onCancel={() => setPublishing(undefined)}
      />
    </>
  );
}
