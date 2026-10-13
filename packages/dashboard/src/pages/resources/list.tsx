import type { ClubResource } from '@bananasaurs/core';
import { useRef, useState } from 'react';
import {
  RESOURCE_REFRESH_ALL_URL,
  resourceEnabledUrl,
  resourceRefreshUrl,
  resourceUrl,
  type ResourceFreshnessRow,
} from '../../api/assistant.js';
import { type Session } from '../../app/session.js';
import { relativeTime } from '../../lib/relative-time.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Field } from '../../ui/Field.js';
import { HelpTip } from '../../ui/HelpTip.js';
import { Link } from '../../ui/Link.js';
import { useToast } from '../../ui/Toast.js';

import { DataTable } from '../../ui/DataTable.js';
import { DropdownMenu } from '../../ui/DropdownMenu.js';
import { Select } from '../../ui/Select.js';
import { ResourceForm } from './form.js';
import { GithubPanel } from './github-import.js';
import { cacheStatusOf, formatSize, KINDS, StatusPill } from './helpers.js';
/** One resource row, shared by top-level items and organisation children (ADR 0084). */
function ResourceRow({
  resource,
  freshnessRow,
  freshnessAvailable,
  githubTokenConfigured,
  refreshingId,
  onUpdateNow,
  onEdit,
  onToggleEnabled,
}: {
  readonly resource: ClubResource;
  readonly freshnessRow: ResourceFreshnessRow | undefined;
  readonly freshnessAvailable: boolean;
  readonly githubTokenConfigured: boolean | undefined;
  readonly refreshingId: string | undefined;
  readonly onUpdateNow: (resource: ClubResource) => void;
  readonly onEdit: (resource: ClubResource, target?: HTMLElement | null) => void;
  readonly onToggleEnabled: (resource: ClubResource) => void;
}) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const row = freshnessRow;
  const status = cacheStatusOf(resource, row);
  // GitHub rows have no Edit button: their title, URL and files come from GitHub.
  const editable = resource.kind !== 'github-repo' && resource.kind !== 'github-org';
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 max-w-full font-medium [overflow-wrap:anywhere]">{resource.title}</p>
        <span className="min-w-0 max-w-full">
          {freshnessAvailable || !resource.enabled ? (
            <StatusPill status={status} />
          ) : (
            <Badge tone="hold" wrap>
              Cache status unavailable
            </Badge>
          )}
        </span>
      </div>
      {resource.meta?.autoDiscovered === true && (
        <p className="mt-1">
          <Badge tone="neutral">New — found automatically</Badge>
        </p>
      )}
      {resource.meta?.private === true && (
        <p className="mt-1">
          <Badge tone="hold">Private</Badge>
        </p>
      )}
      {(resource.kind === 'github-repo' || resource.kind === 'github-org') &&
        githubTokenConfigured === false && (
          <p className="mt-1">
            <Badge tone="hold">README only</Badge>
          </p>
        )}
      <Link href={resource.url} className="break-all text-caption">
        {resource.url}
      </Link>
      <p className="mt-1 text-caption text-ink-muted">
        {resource.kind} · reviewed {new Date(resource.reviewedAt).toLocaleDateString('en-CA')}
      </p>
      <p
        title={row?.fetchedAt === undefined ? undefined : new Date(row.fetchedAt).toLocaleString()}
        className="mt-1 text-caption text-ink-muted"
      >
        {!freshnessAvailable
          ? 'Freshness unavailable'
          : row?.fetchedAt === undefined
            ? 'Never updated'
            : `Updated ${relativeTime(row.fetchedAt, Date.now())}`}
        {row !== undefined && ` · ${String(row.chunks)} chunk${row.chunks === 1 ? '' : 's'}`}
        {row !== undefined && ` · ${formatSize(row.bytes)}`}
      </p>
      {row?.lastError !== undefined &&
        (row.errorExplain === undefined ? (
          <p className="mt-1 text-caption text-tone-danger-ink">{row.lastError}</p>
        ) : (
          <div className="mt-1 text-caption">
            <p className="font-medium text-tone-danger-ink">{row.errorExplain.title}</p>
            <p className="text-ink-muted">{row.errorExplain.explanation}</p>
            <p className="text-ink-muted">What to do: {row.errorExplain.hint}</p>
            {row.errorCode !== undefined && <p className="text-ink-muted">{row.errorCode}</p>}
          </div>
        ))}
      <div ref={actionsRef} className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Badge tone={resource.enabled ? 'ok' : 'neutral'}>
          {resource.enabled ? 'enabled' : 'disabled'}
        </Badge>
        <DropdownMenu
          label={`Actions for ${resource.title}`}
          items={[
            {
              label: 'Update now',
              disabled: refreshingId === resource.id,
              onSelect: () => onUpdateNow(resource),
            },
            ...(editable
              ? [
                  {
                    label: 'Edit',
                    onSelect: () =>
                      onEdit(
                        resource,
                        actionsRef.current?.querySelector<HTMLButtonElement>(
                          'button[aria-haspopup="menu"]',
                        ),
                      ),
                  },
                ]
              : []),
            {
              label: resource.enabled ? 'Disable' : 'Enable',
              onSelect: () => onToggleEnabled(resource),
            },
          ]}
        />
      </div>
    </>
  );
}

/** Reviewed resources: add, edit, enable, and the persistent cache's health per resource (ADR 0073). */
export function ResourcesCard({
  resources,
  freshness,
  freshnessAvailable,
  githubTokenConfigured,
  session,
  onSaved,
  onFocusFallback,
}: {
  readonly resources: readonly ClubResource[];
  readonly freshness: readonly ResourceFreshnessRow[];
  readonly freshnessAvailable: boolean;
  readonly githubTokenConfigured: boolean | undefined;
  readonly session: Session;
  readonly onSaved: () => void;
  readonly onFocusFallback: () => void;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const toast = useToast();
  const [editing, setEditing] = useState<ClubResource | 'new' | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<ClubResource['kind']>('website');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | undefined>(undefined);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [sourceType, setSourceType] = useState('all');

  const freshnessOf = (resourceId: string): ResourceFreshnessRow | undefined =>
    freshness.find((row) => row.resourceId === resourceId);

  const openForm = (target: ClubResource | 'new', focusTarget?: HTMLElement | null) => {
    returnFocus.current =
      focusTarget ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setGithubOpen(false);
    setEditing(target);
    setError(undefined);
    setTitle(target === 'new' ? '' : target.title);
    setUrl(target === 'new' ? '' : target.url);
    setKind(target === 'new' ? 'website' : target.kind);
    setEnabled(target === 'new' ? true : target.enabled);
  };

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const id =
        editing !== undefined && editing !== 'new' ? editing.id : `res-${Date.now().toString(36)}`;
      const result = await session.writeOrThrow(
        resourceUrl(id),
        { id, title, url, kind, enabled, reviewedAt: new Date().toISOString() },
        'PUT',
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: editing === 'new' ? 'Resource added' : 'Resource saved',
          message:
            editing === 'new'
              ? "Attach it to a behaviour on the Behaviours page before the model can use it. It's queued to be fetched into the cache now."
              : "It's queued to refresh in the cache now.",
        });
        setEditing(undefined);
        onSaved();
      }
    } catch (err) {
      // writeOrThrow lets the server's 400/409 answers through; everything
      // else already became a toast. Render the answer with its field
      // problems rather than translating the code here.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (resource: ClubResource) => {
    const result = await session.write(
      resourceEnabledUrl(resource.id),
      { enabled: !resource.enabled },
      'PUT',
    );
    if (result !== undefined) onSaved();
  };

  const updateNow = async (resource: ClubResource) => {
    setRefreshingId(resource.id);
    try {
      const result = await session.write(resourceRefreshUrl(resource.id), {}, 'POST');
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: 'Update queued',
          message: `${resource.title} will refresh shortly.`,
        });
        onSaved();
      }
    } finally {
      setRefreshingId(undefined);
    }
  };

  const updateAll = async () => {
    setRefreshingAll(true);
    try {
      const result = await session.write(RESOURCE_REFRESH_ALL_URL, {}, 'POST');
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: 'Update queued',
          message: 'Every resource will refresh shortly.',
        });
        onSaved();
      }
    } finally {
      setRefreshingAll(false);
    }
  };

  const showReadmeOnlyWarning =
    githubTokenConfigured === false &&
    resources.some((r) => r.kind === 'github-repo' || r.kind === 'github-org');
  // ADR 0084: an organisation is a folder of its child repositories.
  // Top level holds resources with no parent, plus any child whose parent
  // names no existing resource — so nothing is ever hidden.
  const resourceIds = new Set(resources.map((r) => r.id));
  const topLevelResources = resources.filter(
    (r) => r.parentId === undefined || !resourceIds.has(r.parentId),
  );
  const visibleResources =
    sourceType === 'all'
      ? topLevelResources
      : resources.filter((resource) => resource.kind === sourceType);
  const childResourcesOf = (id: string): readonly ClubResource[] =>
    resources.filter((r) => r.parentId === id);

  return (
    <Card title="Reviewed sources">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 basis-64 text-small text-ink-muted">
          Sources an operator has reviewed for this server. The assistant may read attached, enabled
          sources when it answers; retrieved text stays labelled as untrusted evidence.{' '}
          <HelpTip label="fetch health">
            Ready means the last cache refresh succeeded. Needs attention means the last refresh
            failed, or it has not been fetched yet — the assistant answers without that source until
            a refresh succeeds. Off means an operator disabled it; the assistant never reads it
            while off, whatever the cache holds.
          </HelpTip>
        </p>
        <span className="flex min-w-0 max-w-full flex-wrap gap-2">
          {resources.length > 0 && (
            <Button className="shrink-0" busy={refreshingAll} onClick={() => void updateAll()}>
              Update all
            </Button>
          )}
          <Button className="shrink-0" onClick={() => openForm('new')}>
            Add resource
          </Button>
          <Button
            className="shrink-0"
            onClick={() => {
              setEditing(undefined);
              setGithubOpen(true);
            }}
          >
            Add from GitHub
          </Button>
        </span>
      </div>
      {githubOpen && (
        <GithubPanel session={session} onSaved={onSaved} onClose={() => setGithubOpen(false)} />
      )}
      {editing !== undefined && (
        <ResourceForm
          returnFocusTarget={returnFocus.current}
          onFocusFallback={onFocusFallback}
          editing={editing}
          title={title}
          url={url}
          kind={kind}
          enabled={enabled}
          error={error}
          busy={busy}
          onTitle={setTitle}
          onUrl={setUrl}
          onKind={setKind}
          onEnabled={setEnabled}
          onSubmit={() => void submit()}
          onClose={() => setEditing(undefined)}
        />
      )}
      {showReadmeOnlyWarning && (
        <div role="status" className="mt-3 rounded-panel border border-hold p-3 text-small">
          <p className="font-medium">GitHub repositories are caching their README only</p>
          <p className="mt-1 text-ink-muted">
            Without a GitHub token, Bananasaurs reads only each repository's README. Docs, notes and
            other Markdown files are skipped. Add a fine-grained token on the{' '}
            <Link href="/assistant/setup" className="underline">
              AI setup page
            </Link>
            . For public repositories it needs no permissions.
          </p>
        </div>
      )}
      {resources.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No resources reviewed yet"
            detail="Add a website, document, repository, Discord channel or note an operator has reviewed. The assistant only reads sources that are added here and attached to a behaviour."
            action={<Button onClick={() => openForm('new')}>Add resource</Button>}
          />
        </div>
      ) : (
        <div className="mt-3 grid gap-3">
          <div className="min-w-0">
            <Field label="Source type" htmlFor="resource-source-type">
              <Select
                value={sourceType}
                onValueChange={setSourceType}
                options={[
                  { value: 'all', label: 'All source types' },
                  ...[...KINDS, 'github-repo', 'github-org'].map((value) => ({
                    value,
                    label: value === 'website' ? 'Website' : value.replaceAll('-', ' '),
                  })),
                ]}
              />
            </Field>
          </div>
          {visibleResources.length === 0 ? (
            <EmptyState
              title="No resources match these filters"
              detail="Choose another source type or clear the filter."
              action={<Button onClick={() => setSourceType('all')}>Clear filters</Button>}
            />
          ) : (
            <DataTable
              caption="Reviewed sources"
              rows={visibleResources}
              rowKey={(resource) => resource.id}
              columns={[
                {
                  key: 'source',
                  header: 'Source',
                  cell: (resource) => {
                    if (resource.kind === 'github-org') {
                      const kids = childResourcesOf(resource.id);
                      const privateCount = kids.filter((kid) => kid.meta?.private === true).length;
                      const offCount = kids.filter((kid) => !kid.enabled).length;
                      return (
                        <div>
                          <details>
                            <summary>
                              {`${resource.title} — ${String(kids.length)} repositor${kids.length === 1 ? 'y' : 'ies'}`}
                              {privateCount > 0 && ` · ${String(privateCount)} private`}
                              {offCount > 0 && ` · ${String(offCount)} turned off`}
                            </summary>
                            <div className="mt-2">
                              <ResourceRow
                                resource={resource}
                                freshnessAvailable={freshnessAvailable}
                                freshnessRow={freshnessOf(resource.id)}
                                githubTokenConfigured={githubTokenConfigured}
                                refreshingId={refreshingId}
                                onUpdateNow={(item) => void updateNow(item)}
                                onEdit={openForm}
                                onToggleEnabled={(item) => void toggleEnabled(item)}
                              />
                            </div>
                            <ul className="mt-2 grid gap-2">
                              {kids.map((kid) => (
                                <li
                                  key={kid.id}
                                  className="rounded-panel border border-line bg-canvas p-3"
                                >
                                  <ResourceRow
                                    resource={kid}
                                    freshnessAvailable={freshnessAvailable}
                                    freshnessRow={freshnessOf(kid.id)}
                                    githubTokenConfigured={githubTokenConfigured}
                                    refreshingId={refreshingId}
                                    onUpdateNow={(item) => void updateNow(item)}
                                    onEdit={openForm}
                                    onToggleEnabled={(item) => void toggleEnabled(item)}
                                  />
                                </li>
                              ))}
                            </ul>
                          </details>
                        </div>
                      );
                    }
                    return (
                      <ResourceRow
                        resource={resource}
                        freshnessAvailable={freshnessAvailable}
                        freshnessRow={freshnessOf(resource.id)}
                        githubTokenConfigured={githubTokenConfigured}
                        refreshingId={refreshingId}
                        onUpdateNow={(item) => void updateNow(item)}
                        onEdit={openForm}
                        onToggleEnabled={(item) => void toggleEnabled(item)}
                      />
                    );
                  },
                },
              ]}
            />
          )}
        </div>
      )}
    </Card>
  );
}
