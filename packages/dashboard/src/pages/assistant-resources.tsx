import { useCallback, useState } from 'react';
import type { ClubResource } from '@bananasaurs/core';
import {
  ASSISTANT_URL,
  GITHUB_IMPORT_URL,
  GITHUB_PREVIEW_URL,
  RESOURCE_FRESHNESS_URL,
  RESOURCE_REFRESH_ALL_URL,
  resourceRefreshUrl,
  resourceUrl,
  type AssistantData,
  type GithubImportResult,
  type GithubPreview,
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
  const [checkedRepos, setCheckedRepos] = useState<readonly string[] | undefined>(undefined);
  const [includeForks, setIncludeForks] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);

  const runPreview = async () => {
    setPreviewBusy(true);
    setError(undefined);
    setPreview(undefined);
    setCheckedFiles(undefined);
    setCheckedRepos(undefined);
    setFileFilter('');
    try {
      const result = await session.writeOrThrow<GithubPreview>(GITHUB_PREVIEW_URL, { url }, 'POST');
      // `undefined` means the session already toasted the reason.
      if (result === undefined) return;
      setPreview(result);
      if (result.files !== undefined) setCheckedFiles(result.files);
      if (result.repos !== undefined) setCheckedRepos(result.repos.map((r) => r.name));
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
  const shownRepos = (preview?.repos ?? []).filter(
    (repo) => (includeForks || !repo.fork) && (includeArchived || !repo.archived),
  );
  const shownNames = new Set(shownRepos.map((repo) => repo.name));
  const reposSelection = (checkedRepos ?? []).filter((name) => shownNames.has(name));
  const urlProblem = fieldError(error, 'url');

  return (
    <div className="mt-3 rounded-md border border-line bg-canvas p-3">
      <div className="grid gap-3">
        <Field
          label="GitHub URL"
          hint="A public repository or organisation, for example https://github.com/acme/widget."
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
          {!preview.authenticated && (
            <p className="text-sm text-ink-muted">
              <HelpTip label="GitHub token limits">
                Without a GitHub token only README files are read and organisations refresh once a
                day. Add a token on the AI setup page.
              </HelpTip>
            </p>
          )}
          {isOrg ? (
            <>
              <p className="text-sm">
                {`${String(preview.repos?.length ?? 0)} public repositor${(preview.repos?.length ?? 0) === 1 ? 'y' : 'ies'}`}
              </p>
              {preview.truncated === true && (
                <p className="text-sm text-ink-muted">Showing the first 500 repositories.</p>
              )}
              {(preview.repos?.length ?? 0) === 0 ? (
                <p className="mt-2 text-sm">This organisation has no public repositories.</p>
              ) : (
                <>
                  <div className="mt-2 flex flex-wrap gap-4 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={includeForks}
                        onChange={(e) => setIncludeForks(e.target.checked)}
                      />
                      Include forks
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={includeArchived}
                        onChange={(e) => setIncludeArchived(e.target.checked)}
                      />
                      Include archived
                    </label>
                  </div>
                  <ul className="mt-2 grid gap-1">
                    {shownRepos.map((repo) => (
                      <li key={repo.name}>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={(checkedRepos ?? []).includes(repo.name)}
                            onChange={() =>
                              setCheckedRepos(toggleIn(checkedRepos ?? [], repo.name))
                            }
                          />
                          <span>{repo.name}</span>
                          {repo.description !== null && (
                            <span className="text-ink-muted">{repo.description}</span>
                          )}
                          {repo.fork && <span className="text-ink-muted">fork</span>}
                          {repo.archived && <span className="text-ink-muted">archived</span>}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="primary"
                      busy={importBusy}
                      disabled={reposSelection.length === 0}
                      onClick={() =>
                        void runImport({
                          url,
                          repos: reposSelection,
                          includeForks,
                          includeArchived,
                        })
                      }
                    >
                      Add
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

/** Reviewed resources: add, edit, enable, and the persistent cache's health per resource (ADR 0073). */
function ResourcesCard({
  resources,
  freshness,
  session,
  onSaved,
}: {
  readonly resources: readonly ClubResource[];
  readonly freshness: readonly ResourceFreshnessRow[];
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
      resourceUrl(resource.id),
      { ...resource, enabled: !resource.enabled },
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
            <Field
              label="Title"
              {...(titleProblem === undefined ? {} : { error: titleProblem })}
            >
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
          {resources.map((resource) => {
            const row = freshnessOf(resource.id);
            const status = cacheStatusOf(resource, row);
            const childCount =
              resource.kind === 'github-org'
                ? resources.filter((r) => r.parentId === resource.id).length
                : undefined;
            return (
              <li key={resource.id} className="rounded-md border border-line bg-canvas p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 font-medium">{resource.title}</p>
                  <StatusPill status={status} />
                </div>
                {resource.meta?.autoDiscovered === true && (
                  <p className="mt-1">
                    <Badge tone="neutral">New — found automatically</Badge>
                  </p>
                )}
                <p className="mt-1 break-all text-xs text-ink-muted">{resource.url}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {resource.kind} · reviewed{' '}
                  {new Date(resource.reviewedAt).toLocaleDateString('en-CA')}
                </p>
                {childCount !== undefined && (
                  <p className="mt-1 text-xs text-ink-muted">
                    {`${String(childCount)} repositor${childCount === 1 ? 'y' : 'ies'}`}
                  </p>
                )}
                <p className="mt-1 text-xs text-ink-muted">
                  {row?.fetchedAt === undefined
                    ? 'Never updated'
                    : `Updated ${relativeTime(row.fetchedAt, Date.now())}`}
                  {row !== undefined &&
                    ` · ${String(row.chunks)} chunk${row.chunks === 1 ? '' : 's'}`}
                  {row !== undefined && ` · ${formatSize(row.bytes)}`}
                </p>
                {row?.lastError !== undefined && (
                  <p className="mt-1 text-xs text-danger">{row.lastError}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <Badge tone={resource.enabled ? 'ok' : 'neutral'}>
                    {resource.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                  <span className="flex flex-wrap gap-1">
                    <Button
                      busy={refreshingId === resource.id}
                      onClick={() => void updateNow(resource)}
                    >
                      Update now
                    </Button>
                    <Button onClick={() => openForm(resource)}>Edit</Button>
                    <Button onClick={() => void toggleEnabled(resource)}>
                      {resource.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </span>
                </div>
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
    () => session.read<{ freshness: readonly ResourceFreshnessRow[] }>(RESOURCE_FRESHNESS_URL),
    [session],
  );
  const freshness = useResource('resource cache freshness', loadFreshness);

  const reloadBoth = () => {
    assistant.reload();
    freshness.reload();
  };

  const freshnessRows =
    freshness.resource.state === 'ready' ? freshness.resource.data.freshness : [];

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
            session={session}
            onSaved={reloadBoth}
          />
        }
      >
        {(data) => (
          <ResourcesCard
            resources={data.resources}
            freshness={freshnessRows}
            session={session}
            onSaved={reloadBoth}
          />
        )}
      </DataState>
    </>
  );
}
