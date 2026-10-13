import { useCallback, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ASSISTANT_URL, type AssistantData } from '../../api/assistant.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { useStickyResource, type Tagged } from './sticky-resource.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable, type Column } from '../../ui/DataTable.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { SaveBar } from '../../ui/SaveBar.js';
import { Tabs } from '../../ui/Tabs.js';
import { SetupTracker } from '../assistant-setup-tracker.js';
import { DecisionsCard } from './access.js';
import { NewBehaviourDialog } from './create-dialog.js';
import {
  BotTagCard,
  LogChannelCard,
  useSettingsDraftState,
  useSettingsDrafts,
  type SettingsDraftState,
} from './settings.js';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard.js';
import { VisitedPanels, tabHref } from './tab-panels.js';

/**
 * `/assistant`: the invocation behaviours - how members reach the assistant
 * (tag or direct command), who may use each one, and what it hands to people.
 * Each row opens its own page (`/assistant/behaviours/:id`). Skills,
 * schedules and resources have their own pages (ADR 0060).
 */

const TABS = [
  { value: 'behaviours', label: 'Behaviours' },
  { value: 'settings', label: 'Settings' },
] as const;

type Behaviour = AssistantData['behaviours'][number];

function whoCanUse(item: Behaviour, data: AssistantData): string {
  // `undefined` is a server build that does not expose the allowlist; an empty
  // list fails closed. Neither is ever described as "everyone".
  if (item.callerRoleIds === undefined) return 'Not shown by this server';
  if (item.callerRoleIds.length === 0) return 'Nobody yet';
  return item.callerRoleIds
    .map((id) => data.roles?.find((role) => role.id === id)?.name ?? 'a role that no longer exists')
    .join(', ');
}

function BehavioursTable({ data }: { readonly data: AssistantData }) {
  const roleName = (id: string | undefined) =>
    id === undefined ? undefined : data.roles?.find((role) => role.id === id)?.name;
  const columns: readonly Column<Behaviour>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (item) => {
        const mention =
          item.surface === 'direct-command'
            ? 'Direct command: members tag @Bananasaurs'
            : (() => {
                const name = roleName(item.mentionRoleId);
                return name === undefined ? 'Mention role not set' : `Members mention @${name}`;
              })();
        return (
          <span className="flex min-w-0 flex-col">
            <Link href={`/assistant/behaviours/${item.id}`} className="font-medium underline">
              {item.name}
            </Link>
            <span className="text-xs text-ink-muted">{mention}</span>
          </span>
        );
      },
    },
    { key: 'who', header: 'Who can use it', cell: (item) => whoCanUse(item, data) },
    {
      key: 'skills',
      header: 'Skills',
      cell: (item) =>
        item.preferredSkillIds.length === 0
          ? 'None preferred'
          : item.preferredSkillIds
              .map((id) => data.skills.find((skill) => skill.id === id)?.name ?? id)
              .join(', '),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (item) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={item.enabled ? 'ok' : 'neutral'}>{item.enabled ? 'On' : 'Off'}</Badge>
          {item.answersBotTag === true && <Badge tone="ok">Tag @Bananasaurs</Badge>}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      caption="Assistant behaviours"
      columns={columns}
      rows={data.behaviours}
      rowKey={(item) => item.id}
    />
  );
}

function BehavioursBody({
  data,
  session,
  reload,
  creating,
  onCreateDone,
  settings,
}: {
  readonly settings: SettingsDraftState;
  readonly data: AssistantData;
  readonly session: ReturnType<typeof useSession>;
  readonly reload: () => void;
  readonly creating: boolean;
  readonly onCreateDone: () => void;
}) {
  const search = useSearch();
  const [, navigate] = useLocation();
  const raw = new URLSearchParams(search).get('tab');
  const tab = TABS.find((entry) => entry.value === raw)?.value ?? 'behaviours';
  const drafts = useSettingsDrafts(settings, data, session, reload);
  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(next) => navigate(tabHref(next, 'behaviours'))}
        tabs={TABS}
        aria-label="Behaviours page sections"
      >
        <VisitedPanels
          active={tab}
          panels={[
            {
              value: 'behaviours',
              body: (
                <div className="pt-4">
                  {data.behaviours.length === 0 ? (
                    <EmptyState
                      title="No behaviours yet"
                      detail="Step 4 creates the club assistant, which members reach by tagging @Bananasaurs. To set up a tagged helper like @it-services instead, create a behaviour."
                    />
                  ) : (
                    <BehavioursTable data={data} />
                  )}
                </div>
              ),
            },
            {
              value: 'settings',
              body: (
                <div className="space-y-5 pt-4">
                  <BotTagCard {...drafts.cards} />
                  <LogChannelCard {...drafts.cards} />
                  {data.decisions !== undefined && (
                    <DecisionsCard
                      decisions={data.decisions}
                      data={data}
                      session={session}
                      onSaved={reload}
                    />
                  )}
                </div>
              ),
            },
          ]}
        />
      </Tabs>
      <div className="mt-4">
        <SaveBar
          dirtyCount={drafts.dirtyCount}
          onSave={drafts.save}
          onDiscard={drafts.discard}
          busy={drafts.busy}
        />
      </div>
      {creating && (
        <NewBehaviourDialog
          data={data}
          session={session}
          onCreated={(id) => {
            onCreateDone();
            reload();
            navigate(`/assistant/behaviours/${id}`);
          }}
          onCancel={onCreateDone}
        />
      )}
    </>
  );
}

export function AssistantPage() {
  const session = useSession();
  const identity = `${session.info.accountId}|${session.info.guildId}`;
  const load = useCallback(
    () =>
      session
        .read<AssistantData>(ASSISTANT_URL)
        .then((data): Tagged<AssistantData> => ({ identity, data })),
    [session, identity],
  );
  const assistant = useResource('assistant settings', load);
  const shown = useStickyResource(assistant.resource, identity);
  const settings = useSettingsDraftState(identity);
  const guard = useUnsavedGuard(settings.dirty);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Behaviours"
        purpose="Behaviours decide who answers, how they sound, and who may ask."
        actions={
          <>
            <Link href="/assistant/history">
              <Button>Assistant history</Button>
            </Link>
            <Button variant="primary" onClick={() => setCreating(true)} disabled={creating}>
              New behaviour
            </Button>
          </>
        }
      />
      {shown.state === 'ready' && shown.data.setup !== undefined && (
        <div className="mb-5">
          <SetupTracker data={shown.data} session={session} reload={assistant.reload} />
        </div>
      )}
      {shown.state !== 'ready' && settings.dirty && (
        <p role="status" className="mb-3 text-sm text-hold">
          You have unsaved Settings changes. They are kept and come back when the page loads.
        </p>
      )}
      {guard}
      <DataState resource={shown}>
        {(data) => (
          <BehavioursBody
            data={data}
            session={session}
            reload={assistant.reload}
            creating={creating}
            settings={settings}
            onCreateDone={() => setCreating(false)}
          />
        )}
      </DataState>
    </>
  );
}
