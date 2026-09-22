import { useCallback, useState } from 'react';
import type { ClubResource } from '@bananasaurs/core';
import { ASSISTANT_URL, resourceUrl, type AssistantData } from '../api/assistant.js';
import { useSession, type Session } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { Field, Input } from '../ui/Field.js';
import { HelpTip } from '../ui/HelpTip.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

const KINDS = ['website', 'document', 'discord-channel', 'repository', 'note'] as const;

/** Reviewed resources: add, edit, enable. URL safety is enforced server-side. */
function ResourcesCard({
  resources,
  session,
  onSaved,
}: {
  readonly resources: readonly ClubResource[];
  readonly session: Session;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<ClubResource | 'new' | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<ClubResource['kind']>('website');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

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
          message: 'Attach it to a behaviour on the Assistant page before the model can use it.',
        });
        setEditing(undefined);
        onSaved();
      }
    } catch (err) {
      const body =
        err instanceof Error && 'body' in err
          ? (err as { body?: { error?: unknown } }).body
          : undefined;
      const code = typeof body?.error === 'string' ? body.error : '';
      setError(
        code === 'unsafe-resource-url'
          ? 'That address is not allowed: private and local addresses are refused.'
          : 'The server refused this resource. Check the fields and try again.',
      );
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

  return (
    <Card title="Reviewed sources">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm text-ink-muted">
          Sources an operator has reviewed for this server. The assistant may read attached, enabled
          sources when it answers; retrieved text stays labelled as untrusted evidence.{' '}
          <HelpTip label="fetch health">
            Fetch shows whether the bot could read the source last time it tried. A failed fetch
            means the assistant answers without that source until it can be read again; the source
            is never silently treated as current.
          </HelpTip>
        </p>
        <span className="shrink-0">
          <Button onClick={() => openForm('new')}>Add resource</Button>
        </span>
      </div>
      {editing !== undefined && (
        <form
          className="mt-3 rounded-md border border-line bg-canvas p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </Field>
            <Field label="Kind">
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
              {...(error !== undefined ? { error } : {})}
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
          <div className="mt-3 flex gap-2">
            <Button variant="primary" busy={busy} type="submit">
              {editing === 'new' ? 'Add resource' : 'Save resource'}
            </Button>
            <Button onClick={() => setEditing(undefined)}>Cancel</Button>
          </div>
        </form>
      )}
      {resources.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">No resources reviewed yet.</p>
      ) : (
        <ul className="mt-3 grid gap-3 md:grid-cols-3">
          {resources.map((resource) => (
            <li key={resource.id} className="rounded-md border border-line bg-canvas p-3">
              <p className="font-medium">{resource.title}</p>
              <p className="mt-1 break-all text-xs text-ink-muted">{resource.url}</p>
              <p className="mt-1 text-xs text-ink-muted">
                {resource.kind} · reviewed{' '}
                {new Date(resource.reviewedAt).toLocaleDateString('en-CA')}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                Fetch: {resource.fetchStatus ?? 'pending'}
                {resource.lastFetchedAt === undefined
                  ? ''
                  : ` · ${new Date(resource.lastFetchedAt).toLocaleString('en-CA')}`}
              </p>
              {resource.fetchDetail !== undefined && (
                <p className="mt-1 text-xs text-ink-muted">{resource.fetchDetail}</p>
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <Badge tone={resource.enabled ? 'ok' : 'neutral'}>
                  {resource.enabled ? 'enabled' : 'disabled'}
                </Badge>
                <span className="flex gap-1">
                  <Button onClick={() => openForm(resource)}>Edit</Button>
                  <Button onClick={() => void toggleEnabled(resource)}>
                    {resource.enabled ? 'Disable' : 'Enable'}
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * `/assistant/resources`: reviewed sources with scope, freshness and fetch
 * health, plus the add/edit/enable controls (ADR 0060).
 */
export function AssistantResourcesPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant resources', load);
  return (
    <>
      <PageHeader
        title="Resources"
        purpose="Reviewed sources the assistant may read, how fresh they are, and whether fetching them is working."
      />
      <DataState
        resource={assistant.resource}
        isEmpty={(data) => data.resources.length === 0}
        empty={<ResourcesCard resources={[]} session={session} onSaved={assistant.reload} />}
      >
        {(data) => (
          <ResourcesCard resources={data.resources} session={session} onSaved={assistant.reload} />
        )}
      </DataState>
    </>
  );
}
