import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import type { ClubResource } from '@bananasaurs/core';
import {
  ASSISTANT_URL,
  GITHUB_IMPORT_URL,
  GITHUB_PREVIEW_URL,
  RESOURCE_FRESHNESS_URL,
  RESOURCE_REFRESH_ALL_URL,
  resourceEnabledUrl,
  resourceRefreshUrl,
  resourceUrl,
  type AssistantData,
  type GithubImportResult,
  type GithubPreview,
  type ResourceFreshnessResponse,
  type ResourceFreshnessRow,
} from '../api/assistant.js';
import { useSession, type Session } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { fieldError } from '../api/describe-error.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorNotice } from '../ui/ErrorNotice.js';
import { Field, Input } from '../ui/Field.js';
import { HelpTip } from '../ui/HelpTip.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

const KINDS = ['website', 'document', 'discord-channel', 'repository', 'note'] as const;

/** `bytes` as a short human size — mirrors `backups.tsx`'s own local `formatSize` (not shared: pages here do not import from one another). */
const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${String(bytes)} B`;
};

/** "12 minutes ago" style freshness, coarse enough that a page left open for a while does not need to re-render to stay accurate. */
const relativeTime = (atMs: number, nowMs: number): string => {
  const diffMs = Math.max(0, nowMs - atMs);
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
};

type ResourceCacheStatus = 'ready' | 'needs-attention' | 'off';

/**
 * Ready: enabled, cached, and the last refresh succeeded. Off: the operator
 * disabled it (the assistant never reads it, cached or not — a resource with
 * no fetch trouble at all is still "Off" once disabled, not "Ready"). Needs
 * attention: enabled but either never cached yet or its last refresh errored.
 */
const cacheStatusOf = (
  resource: ClubResource,
  freshness: ResourceFreshnessRow | undefined,
): ResourceCacheStatus => {
  if (!resource.enabled) return 'off';
  if (freshness === undefined || freshness.lastError !== undefined) return 'needs-attention';
  return 'ready';
};

function StatusPill({ status }: { readonly status: ResourceCacheStatus }) {
  if (status === 'ready') return <Badge tone="ok">Ready</Badge>;
  if (status === 'off') return <Badge tone="neutral">Off</Badge>;
  return <Badge tone="danger">Needs attention</Badge>;
}

/**
 * "Add from GitHub" (Task 17): paste a repo or organisation URL, preview
 * what would be imported, pick files or repositories, add. The preview comes
 * from the server (which holds the token); this panel only ever sees names,
 * file paths and counts — never the token.
 */
function GithubPanel({
  session,
  onSaved,
  onClose,
}: {
  readonly session: Session;
  readonly onSaved: () => void;
  readonly onClose: () => void;
}) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<GithubPreview | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [checkedFiles, setCheckedFiles] = useState<readonly string[] | undefined>(undefined);
  const [fileFilter, setFileFilter] = useState('');

  const runPreview = async () => {
    setPreviewBusy(true);
    setError(undefined);
    setPreview(undefined);
    setCheckedFiles(undefined);
    setFileFilter('');
    try {
      const result = await session.writeOrThrow<GithubPreview>(GITHUB_PREVIEW_URL, { url }, 'POST');
      // `undefined` means the session already toasted the reason.
      if (result === undefined) return;
      setPreview(result);
      if (result.files !== undefined) setCheckedFiles(result.files);
    } catch (err) {
      setError(err);
    } finally {
      setPreviewBusy(false);
    }
  };

  const runImport = async (body: Record<string, unknown>) => {
    setImportBusy(true);
    setError(undefined);
    try {
      const result = await session.writeOrThrow<GithubImportResult>(
        GITHUB_IMPORT_URL,
        body,
        'POST',
      );
      // `undefined` means the session already toasted the reason.
      if (result === undefined) return;
      toast({
        tone: 'ok',
        title: 'GitHub import added',
        message: `${String(result.created)} resource${result.created === 1 ? '' : 's'} queued to refresh into the cache now.`,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setImportBusy(false);
    }
  };

  const toggleIn = (list: readonly string[], name: string): readonly string[] =>
    list.includes(name) ? list.filter((item) => item !== name) : [...list, name];

  const isOrg = preview?.target.kind === 'org';
  const files = preview?.files ?? [];
  const visibleFiles =
    fileFilter.trim() === ''
      ? files
      : files.filter((path) => path.toLowerCase().includes(fileFilter.trim().toLowerCase()));
  const allFiles = preview?.files ?? [];
  const filesSelection = checkedFiles ?? allFiles;
  // ADR 0084: an organisation import takes every repository the token can
  // see. The preview list is read-only — no forks/archived toggles and no
  // per-repository checkboxes.
  const orgRepos = preview?.repos ?? [];
  const showsPrivateNotice =
    preview?.private === true || (preview?.repos ?? []).some((repo) => repo.private === true);
  const urlProblem = fieldError(error, 'url');

  return (
    <div className="mt-3 rounded-md border border-line bg-canvas p-3">
      <div className="grid gap-3">
        <Field
          label="GitHub URL"
          hint="A repository or organisation, for example https://github.com/acme/widget. Private repositories need a GitHub token that can read them."
          {...(urlProblem === undefined ? {} : { error: urlProblem })}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            required
            placeholder="https://github.com/"
          />
        </Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={previewBusy} onClick={() => void runPreview()}>
          Preview
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
      {error !== undefined && (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      )}
      {preview !== undefined && (
        <div className="mt-3">
          {showsPrivateNotice && (
            <p role="note" className="text-sm">
              Private repositories: club members will be able to ask about them, and their text is
              sent to your AI providers, which may train on it.
            </p>
          )}
          {!preview.authenticated && (
            <p className="text-sm text-ink-muted">
              Without a GitHub token, only the README is read and organisations refresh once a day.
              Add a token on the{' '}
              <Link href="/assistant/setup" className="underline">
                AI setup page
              </Link>
              .
            </p>
          )}
          {isOrg ? (
            <>
              <p className="text-sm">
                {`${String(orgRepos.length)} repositor${orgRepos.length === 1 ? 'y' : 'ies'}. All of them are added, and new ones are added automatically.`}
              </p>
              {preview.truncated === true && (
                <p className="text-sm text-ink-muted">Showing the first 500 repositories.</p>
              )}
              {orgRepos.length === 0 ? (
                <p className="mt-2 text-sm">
                  This organisation has no repositories this token can see.
                </p>
              ) : (
                <>
                  <ul className="mt-2 grid gap-1">
                    {orgRepos.map((repo) => (
                      <li key={repo.name} className="flex flex-wrap items-center gap-2 text-sm">
                        <span>{repo.name}</span>
                        {repo.private === true && <Badge tone="hold">Private</Badge>}
                        {repo.description !== null && (
                          <span className="text-ink-muted">{repo.description}</span>
                        )}
                        {repo.fork && <span className="text-ink-muted">fork</span>}
                        {repo.archived && <span className="text-ink-muted">archived</span>}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="primary"
                      busy={importBusy}
                      onClick={() => void runImport({ url })}
                    >
                      Import organisation
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="mt-2">
                <Field label="Filter files">
                  <Input
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                    placeholder="docs/"
                  />
                </Field>
              </div>
              <ul className="mt-2 grid gap-1">
                {visibleFiles.map((path) => (
                  <li key={path}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={filesSelection.includes(path)}
                        onChange={() => setCheckedFiles(toggleIn(filesSelection, path))}
                      />
                      {path}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  busy={importBusy}
                  disabled={filesSelection.length === 0}
                  onClick={() =>
                    void runImport(
                      filesSelection.length === allFiles.length
                        ? { url }
                        : { url, include: filesSelection },
                    )
                  }
                >
                  Add
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One resource row, shared by top-level items and organisation children (ADR 0084). */
function ResourceRow({
  resource,
  freshnessRow,
  githubTokenConfigured,
  refreshingId,
  onUpdateNow,
  onEdit,
  onToggleEnabled,
}: {
  readonly resource: ClubResource;
  readonly freshnessRow: ResourceFreshnessRow | undefined;
  readonly githubTokenConfigured: boolean | undefined;
  readonly refreshingId: string | undefined;
  readonly onUpdateNow: (resource: ClubResource) => void;
  readonly onEdit: (resource: ClubResource) => void;
  readonly onToggleEnabled: (resource: ClubResource) => void;
}) {
  const row = freshnessRow;
  const status = cacheStatusOf(resource, row);
  // GitHub rows have no Edit button: their title, URL and files come from GitHub.
  const editable = resource.kind !== 'github-repo' && resource.kind !== 'github-org';
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 font-medium">{resource.title}</p>
        <StatusPill status={status} />
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
      <p className="mt-1 break-all text-xs text-ink-muted">{resource.url}</p>
      <p className="mt-1 text-xs text-ink-muted">
        {resource.kind} · reviewed {new Date(resource.reviewedAt).toLocaleDateString('en-CA')}
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        {row?.fetchedAt === undefined
          ? 'Never updated'
          : `Updated ${relativeTime(row.fetchedAt, Date.now())}`}
        {row !== undefined && ` · ${String(row.chunks)} chunk${row.chunks === 1 ? '' : 's'}`}
        {row !== undefined && ` · ${formatSize(row.bytes)}`}
      </p>
      {row?.lastError !== undefined &&
        (row.errorExplain === undefined ? (
          <p className="mt-1 text-xs text-danger">{row.lastError}</p>
        ) : (
          <div className="mt-1 text-xs">
            <p className="font-medium text-danger">{row.errorExplain.title}</p>
            <p className="text-ink-muted">{row.errorExplain.explanation}</p>
            <p className="text-ink-muted">What to do: {row.errorExplain.hint}</p>
            {row.errorCode !== undefined && <p className="text-ink-muted">{row.errorCode}</p>}
          </div>
        ))}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Badge tone={resource.enabled ? 'ok' : 'neutral'}>
          {resource.enabled ? 'enabled' : 'disabled'}
        </Badge>
        <span className="flex flex-wrap gap-1">
          <Button busy={refreshingId === resource.id} onClick={() => void onUpdateNow(resource)}>
            Update now
          </Button>
          {editable && <Button onClick={() => onEdit(resource)}>Edit</Button>}
          <Button onClick={() => void onToggleEnabled(resource)}>
            {resource.enabled ? 'Disable' : 'Enable'}
          </Button>
        </span>
      </div>
    </>
  );
}

/** Reviewed resources: add, edit, enable, and the persistent cache's health per resource (ADR 0073). */
function ResourcesCard({
  resources,
  freshness,
  githubTokenConfigured,
  session,
  onSaved,
}: {
  readonly resources: readonly ClubResource[];
  readonly freshness: readonly ResourceFreshnessRow[];
  readonly githubTokenConfigured: boolean | undefined;
  readonly session: Session;
  readonly onSaved: () => void;
}) {
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

  const freshnessOf = (resourceId: string): ResourceFreshnessRow | undefined =>
    freshness.find((row) => row.resourceId === resourceId);

  const openForm = (target: ClubResource | 'new') => {
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
              ? "Attach it to a behaviour on the Assistant page before the model can use it. It's queued to be fetched into the cache now."
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

  const titleProblem = fieldError(error, 'title');
  const kindProblem = fieldError(error, 'kind');
  const urlProblem = fieldError(error, 'url');
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
  const childResourcesOf = (id: string): readonly ClubResource[] =>
    resources.filter((r) => r.parentId === id);

  return (
    <Card title="Reviewed sources">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm text-ink-muted">
          Sources an operator has reviewed for this server. The assistant may read attached, enabled
          sources when it answers; retrieved text stays labelled as untrusted evidence.{' '}
          <HelpTip label="fetch health">
            Ready means the cache has this source's latest content. Needs attention means the last
            refresh failed, or it has not been fetched yet — the assistant answers without that
            source until a refresh succeeds. Off means an operator disabled it; the assistant never
            reads it while off, whatever the cache holds.
          </HelpTip>
        </p>
        <span className="flex shrink-0 gap-2">
          {resources.length > 0 && (
            <Button busy={refreshingAll} onClick={() => void updateAll()}>
              Update all
            </Button>
          )}
          <Button onClick={() => openForm('new')}>Add resource</Button>
          <Button onClick={() => setGithubOpen(true)}>Add from GitHub</Button>
        </span>
      </div>
      {githubOpen && (
        <GithubPanel session={session} onSaved={onSaved} onClose={() => setGithubOpen(false)} />
      )}
      {editing !== undefined && (
        <form
          className="mt-3 rounded-md border border-line bg-canvas p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Title" {...(titleProblem === undefined ? {} : { error: titleProblem })}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </Field>
            <Field label="Kind" {...(kindProblem === undefined ? {} : { error: kindProblem })}>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as ClubResource['kind'])}
                className="mt-1 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mt-3">
            <Field
              label="URL"
              hint="HTTPS addresses only; private and local addresses are refused."
              {...(urlProblem === undefined ? {} : { error: urlProblem })}
            >
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                type="url"
                required
                placeholder="https://"
              />
            </Field>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
          {error !== undefined && (
            <div className="mt-3">
              <ErrorNotice error={error} />
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" busy={busy} type="submit">
              {editing === 'new' ? 'Add resource' : 'Save resource'}
            </Button>
            <Button onClick={() => setEditing(undefined)}>Cancel</Button>
          </div>
        </form>
      )}
      {showReadmeOnlyWarning && (
        <div role="status" className="mt-3 rounded-md border border-hold p-3 text-sm">
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
        <ul className="mt-3 grid gap-3 md:grid-cols-3">
          {topLevelResources.map((resource) => {
            if (resource.kind === 'github-org') {
              const kids = childResourcesOf(resource.id);
              const privateCount = kids.filter((kid) => kid.meta?.private === true).length;
              const offCount = kids.filter((kid) => !kid.enabled).length;
              return (
                <li key={resource.id} className="rounded-md border border-line bg-canvas p-3">
                  <details>
                    <summary>
                      {`${resource.title} — ${String(kids.length)} repositor${kids.length === 1 ? 'y' : 'ies'}`}
                      {privateCount > 0 && ` · ${String(privateCount)} private`}
                      {offCount > 0 && ` · ${String(offCount)} turned off`}
                    </summary>
                    <div className="mt-2">
                      <ResourceRow
                        resource={resource}
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
                        <li key={kid.id} className="rounded-md border border-line bg-canvas p-3">
                          <ResourceRow
                            resource={kid}
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
                </li>
              );
            }
            return (
              <li key={resource.id} className="rounded-md border border-line bg-canvas p-3">
                <ResourceRow
                  resource={resource}
                  freshnessRow={freshnessOf(resource.id)}
                  githubTokenConfigured={githubTokenConfigured}
                  refreshingId={refreshingId}
                  onUpdateNow={(item) => void updateNow(item)}
                  onEdit={openForm}
                  onToggleEnabled={(item) => void toggleEnabled(item)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * `/assistant/resources`: reviewed sources with scope, freshness and fetch
 * health, plus the add/edit/enable controls (ADR 0060), and the persistent
 * resource cache's per-resource status and manual refresh (ADR 0073).
 */
export function AssistantResourcesPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant resources', load);
  const loadFreshness = useCallback(
    () => session.read<ResourceFreshnessResponse>(RESOURCE_FRESHNESS_URL),
    [session],
  );
  const freshness = useResource('resource cache freshness', loadFreshness);

  const reloadBoth = () => {
    assistant.reload();
    freshness.reload();
  };

  const freshnessRows =
    freshness.resource.state === 'ready' ? freshness.resource.data.freshness : [];
  const githubTokenConfigured =
    freshness.resource.state === 'ready'
      ? freshness.resource.data.githubTokenConfigured
      : undefined;

  return (
    <>
      <PageHeader
        title="Resources"
        purpose="Reviewed sources the assistant may read, how fresh the cache is, and whether fetching them is working."
      />
      <DataState
        resource={assistant.resource}
        isEmpty={(data) => data.resources.length === 0}
        empty={
          <ResourcesCard
            resources={[]}
            freshness={freshnessRows}
            githubTokenConfigured={githubTokenConfigured}
            session={session}
            onSaved={reloadBoth}
          />
        }
      >
        {(data) => (
          <ResourcesCard
            resources={data.resources}
            freshness={freshnessRows}
            githubTokenConfigured={githubTokenConfigured}
            session={session}
            onSaved={reloadBoth}
          />
        )}
      </DataState>
    </>
  );
}
