import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { LOG_ACTION_CATALOG, LOG_ACTION_GROUPS, logActionInfo } from '@bananasaurs/core';
import type { GuildChannelInfo, LogRoute, LogRoutesResponse } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ChannelPicker } from '../ui/ChannelPicker.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * `/logging`: named log routes as cards, each posting its ticked actions to
 * one channel. A route is the actions you tick (with Select all) + one
 * destination + channels it skips of its own. Routes can be created, edited,
 * turned on/off and deleted. The guild-wide "No access" list lives on the
 * Permissions page; this page only notes how many channels it holds.
 */

function actionSummary(eventKinds: readonly string[]): string {
  const wanted = new Set(eventKinds);
  const parts: string[] = [];
  for (const group of LOG_ACTION_GROUPS) {
    const labels = LOG_ACTION_CATALOG.filter((a) => a.group === group && wanted.has(a.kind)).map(
      (a) => a.label,
    );
    if (labels.length > 0) parts.push(`${group}: ${labels.join(', ')}`);
  }
  const unknown = eventKinds.filter((k) => logActionInfo(k) === undefined);
  if (unknown.length > 0) parts.push(unknown.join(', '));
  return parts.length > 0 ? parts.join(' · ') : 'No actions';
}

/** A checkbox that renders the indeterminate state while partly selected. */
function TriCheckbox({
  label,
  checked,
  indeterminate,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly indeterminate: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        ref={(el) => {
          if (el !== null) el.indeterminate = indeterminate;
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function RouteForm({
  route,
  channelName,
  onClose,
  onSaved,
}: {
  readonly route?: LogRoute | undefined;
  readonly channelName: (id: string) => string;
  readonly onClose: () => void;
  readonly onSaved: (message: string) => void;
}) {
  const session = useSession();
  const [selected, setSelected] = useState<readonly string[]>(route?.eventKinds ?? []);
  const [destination, setDestination] = useState(route?.channelId ?? '');
  const [skips, setSkips] = useState<readonly string[]>(route?.excludedChannelIds ?? []);
  const [skipPick, setSkipPick] = useState('');
  const [includeContent, setIncludeContent] = useState(route?.includeContent ?? true);
  const [name, setName] = useState(route?.name ?? '');
  const [actionsError, setActionsError] = useState<string | undefined>(undefined);
  const [destinationError, setDestinationError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const allKinds = LOG_ACTION_CATALOG.map((a) => a.kind);
  const allSelected = allKinds.every((k) => selected.includes(k));
  const someSelected = allKinds.some((k) => selected.includes(k));

  const setGroup = (kinds: readonly string[], checked: boolean) => {
    setSelected((prev) =>
      checked
        ? [...prev, ...kinds.filter((k) => !prev.includes(k))]
        : prev.filter((k) => !kinds.includes(k)),
    );
  };

  const displayOf = (id: string): string => {
    const resolved = channelName(id);
    return resolved.startsWith('#') ? resolved : `#${id}`;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const dest = destination.trim();
    const nextActionsError = selected.length === 0 ? 'Pick at least one action.' : undefined;
    const nextDestinationError =
      dest === ''
        ? 'Pick a channel to post to.'
        : skips.includes(dest)
          ? "The channel you post to can't also be skipped."
          : undefined;
    setActionsError(nextActionsError);
    setDestinationError(nextDestinationError);
    if (nextActionsError !== undefined || nextDestinationError !== undefined) return;
    setBusy(true);
    try {
      const trimmedName = name.trim();
      const body = {
        name: trimmedName === '' ? `→ ${channelName(dest)}` : trimmedName,
        channelId: dest,
        includeContent,
        enabled: route?.enabled ?? true,
        eventKinds: [...selected],
        excludedChannelIds: [...skips],
      };
      const result =
        route === undefined
          ? await session.write<{ ok: boolean; route: LogRoute }>('/api/log-routes', body)
          : await session.write<{ ok: boolean; route: LogRoute }>(
              `/api/log-routes/${encodeURIComponent(route.routeId)}`,
              body,
              'PUT',
            );
      if (result !== undefined) {
        onSaved(route === undefined ? 'Route created' : 'Route saved');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-md gap-3">
      <Field label="Actions" {...(actionsError !== undefined ? { error: actionsError } : {})}>
        <div className="grid gap-2">
          <TriCheckbox
            label="Select all"
            checked={allSelected}
            indeterminate={!allSelected && someSelected}
            onChange={(checked) => setSelected(checked ? allKinds : [])}
          />
          {LOG_ACTION_GROUPS.map((group) => {
            const actions = LOG_ACTION_CATALOG.filter((a) => a.group === group);
            if (actions.length === 0) return null;
            const kinds = actions.map((a) => a.kind);
            const groupChecked = kinds.every((k) => selected.includes(k));
            const groupSome = kinds.some((k) => selected.includes(k));
            return (
              <div key={group} className="grid gap-1">
                <TriCheckbox
                  label={group}
                  checked={groupChecked}
                  indeterminate={!groupChecked && groupSome}
                  onChange={(checked) => setGroup(kinds, checked)}
                />
                <div className="ml-6 grid gap-1">
                  {actions.map((action) => (
                    <Checkbox
                      key={action.kind}
                      label={action.label}
                      checked={selected.includes(action.kind)}
                      onChange={(e) => setGroup([action.kind], e.target.checked)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Field>
      <ChannelPicker
        label="Post to"
        kinds={['text', 'announcement']}
        value={destination}
        onChange={(id) => {
          setDestination(id);
          setDestinationError(undefined);
        }}
        {...(destinationError !== undefined ? { error: destinationError } : {})}
      />
      <div className="grid gap-2">
        <ChannelPicker
          label="Don't log from"
          hint="Threads in these channels are skipped too. This only applies to actions that happen in a channel (messages)."
          kinds={['text', 'announcement', 'forum', 'voice', 'stage']}
          value={skipPick}
          onChange={setSkipPick}
        />
        <div>
          <Button
            onClick={() => {
              const id = skipPick.trim();
              if (id !== '' && !skips.includes(id)) setSkips([...skips, id]);
              setSkipPick('');
            }}
            disabled={skipPick.trim() === ''}
          >
            Add
          </Button>
        </div>
        {skips.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {skips.map((id) => (
              <li
                key={id}
                className="inline-flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1 text-sm"
              >
                <span>{displayOf(id)}</span>
                <Button
                  aria-label={`Remove ${displayOf(id)}`}
                  onClick={() => setSkips(skips.filter((s) => s !== id))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <Checkbox
          label="Include message content"
          checked={includeContent}
          onChange={(e) => setIncludeContent(e.target.checked)}
        />
      </div>
      <Field
        label="Name"
        hint="Optional. Left empty, the route is named after its destination channel."
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. mod log"
          autoComplete="off"
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={busy}>
          {route === undefined ? 'Create route' : 'Save route'}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

export function LoggingPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<LogRoutesResponse>('/api/log-routes'), [session]);
  const routes = useResource('the log routes', load);
  const loadChannels = useCallback(
    () => session.read<{ channels: readonly GuildChannelInfo[] }>('/api/guild/channels'),
    [session],
  );
  const channelDirectory = useResource('the channel list', loadChannels);
  const channelName = (id: string): string => {
    if (channelDirectory.resource.state !== 'ready') return id;
    const found = channelDirectory.resource.data.channels.find((c) => c.channelId === id);
    return found === undefined ? id : `#${found.name}`;
  };
  const displayOf = (id: string): string => {
    const resolved = channelName(id);
    return resolved.startsWith('#') ? resolved : `#${id}`;
  };

  const [form, setForm] = useState<{ mode: 'new' } | { mode: 'edit'; route: LogRoute } | undefined>(
    undefined,
  );
  const [deleting, setDeleting] = useState<LogRoute | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const closeSaved = (message: string) => {
    toast({ tone: 'ok', title: message });
    setForm(undefined);
    routes.reload();
  };

  const setEnabled = async (route: LogRoute, enabled: boolean) => {
    const result = await session.write<{ ok: boolean }>(
      `/api/log-routes/${encodeURIComponent(route.routeId)}/enabled`,
      { enabled },
    );
    if (result !== undefined) {
      toast({ tone: 'ok', title: `Route "${route.name}" turned ${enabled ? 'on' : 'off'}` });
      routes.reload();
    }
  };

  const confirmDelete = async () => {
    if (deleting === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean }>(
        `/api/log-routes/${encodeURIComponent(deleting.routeId)}`,
        undefined,
        'DELETE',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: 'Route deleted' });
        setDeleting(undefined);
        routes.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const excludedCount =
    routes.resource.state === 'ready' ? (routes.resource.data.excludedChannels ?? []).length : 0;

  return (
    <>
      <PageHeader
        title="Logging"
        purpose="Routes post chosen actions to a channel. Each route can skip channels of its own."
      />
      <div className="grid max-w-4xl gap-3">
        <DataState
          resource={routes.resource}
          isEmpty={(data) => data.routes.length === 0}
          empty={
            <p className="text-sm text-ink-muted">
              No routes yet. Create one to start posting actions to a channel.
            </p>
          }
        >
          {(data) => (
            <div className="grid gap-3">
              {data.routes.map((route) => (
                <Card key={route.routeId} title={route.name}>
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-ink-muted">{`→ ${channelName(route.channelId)}`}</span>
                      {!route.enabled && <Badge tone="neutral">Off</Badge>}
                      <span className="ml-auto flex flex-wrap items-center gap-2">
                        <Checkbox
                          label={`${route.name} on`}
                          checked={route.enabled}
                          onChange={(e) => void setEnabled(route, e.target.checked)}
                        />
                        <Button onClick={() => setForm({ mode: 'edit', route })}>Edit</Button>
                        <Button onClick={() => setDeleting(route)}>Delete</Button>
                      </span>
                    </div>
                    <p className="text-sm">{actionSummary(route.eventKinds)}</p>
                    <p className="text-sm text-ink-muted">
                      {route.excludedChannelIds.length === 0
                        ? 'Skips: nothing'
                        : `Skips: ${route.excludedChannelIds.map(displayOf).join(', ')} (and their threads)`}
                    </p>
                    <p className="text-sm text-ink-muted">
                      {`Message content: ${route.includeContent ? 'included' : 'not included'}`}
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </DataState>
        {form === undefined && (
          <div>
            <Button variant="primary" onClick={() => setForm({ mode: 'new' })}>
              New route
            </Button>
          </div>
        )}
        {form !== undefined && (
          <Card title={form.mode === 'new' ? 'New route' : 'Edit route'}>
            <RouteForm
              key={form.mode === 'new' ? 'new' : form.route.routeId}
              {...(form.mode === 'edit' ? { route: form.route } : {})}
              channelName={channelName}
              onClose={() => setForm(undefined)}
              onSaved={closeSaved}
            />
          </Card>
        )}
        {excludedCount > 0 && (
          <p className="text-sm text-ink-muted">
            {excludedCount} channel(s) have No access and are never logged, whatever a route says.{' '}
            <Link href="/permissions" className="underline">
              Manage on Permissions
            </Link>
          </p>
        )}
      </div>
      <ConfirmDialog
        open={deleting !== undefined}
        title={`Delete route "${deleting?.name ?? ''}"?`}
        scope={<p>It stops posting immediately. This can&apos;t be undone.</p>}
        confirmLabel="Delete route"
        danger
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(undefined)}
      />
    </>
  );
}
