import { useCallback, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { ASSISTANT_URL, behaviourUrl, type AssistantData } from '../../api/assistant.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { useStickyResource, type Tagged } from './sticky-resource.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { CodeBlock } from '../../ui/CodeBlock.js';
import { DataState } from '../../ui/DataState.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Tabs } from '../../ui/Tabs.js';
import { NotFound } from '../../ui/states.js';
import { useToast } from '../../ui/Toast.js';
import { behaviourBody } from '../assistant-shared.js';
import { BehaviourAccessEditor, TicketsCard } from './access.js';
import { BehaviourPromptCard } from './prompt.js';
import { VisitedPanels, tabHref } from './tab-panels.js';
import { BehaviourPreviewPanel, TryItBox } from './try.js';

const TABS = [
  { value: 'prompt', label: 'Prompt' },
  { value: 'access', label: 'Access' },
  { value: 'try', label: 'Try it' },
] as const;
type TabValue = (typeof TABS)[number]['value'];

function tabFrom(search: string): TabValue {
  const raw = new URLSearchParams(search).get('tab');
  return TABS.find((tab) => tab.value === raw)?.value ?? 'prompt';
}

/** The compiled prompt preview: fetched only when asked for, from the existing preview endpoint. */
function PreviewToggle({ behaviourId }: { readonly behaviourId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Button onClick={() => setOpen((value) => !value)}>Preview the full prompt</Button>
      {open && <BehaviourPreviewPanel behaviourId={behaviourId} onClose={() => setOpen(false)} />}
    </div>
  );
}

function DetailTabs({
  tab,
  onTab,
  panels,
}: {
  readonly tab: TabValue;
  readonly onTab: (next: string) => void;
  readonly panels: readonly { readonly value: string; readonly body: ReactNode }[];
}) {
  return (
    <Tabs value={tab} onValueChange={onTab} tabs={TABS} aria-label="Behaviour sections">
      <VisitedPanels active={tab} panels={panels} />
    </Tabs>
  );
}

/**
 * `/assistant/behaviours/:id`: one behaviour. The id is resolved against the
 * same authorized `/api/assistant` snapshot the list uses (no new endpoint);
 * an id that is not in it is NotFound, never the first behaviour. Each
 * tab's state is keyed by behaviour id so one behaviour's draft or answer can
 * never be shown or sent as another's.
 */
export function AssistantBehaviourDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
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
  const search = useSearch();
  const [, navigate] = useLocation();
  const toast = useToast();
  const tab = tabFrom(search);
  const behaviour =
    shown.state === 'ready' ? shown.data.behaviours.find((b) => b.id === id) : undefined;

  const toggleEnabled = async () => {
    if (behaviour === undefined) return;
    const result = await session.write(
      behaviourUrl(behaviour.id),
      behaviourBody(behaviour, { enabled: !behaviour.enabled }),
      'PUT',
    );
    if (result !== undefined) {
      toast({
        tone: behaviour.enabled ? 'hold' : 'ok',
        title: behaviour.enabled ? `${behaviour.name} disabled` : `${behaviour.name} enabled`,
      });
      assistant.reload();
    }
  };

  return (
    <DataState
      resource={shown}
      notFound={
        <NotFound what="This behaviour" backHref="/assistant" backLabel="Back to behaviours" />
      }
    >
      {(data) => {
        const current = data.behaviours.find((b) => b.id === id);
        if (current === undefined) {
          return (
            <NotFound what="This behaviour" backHref="/assistant" backLabel="Back to behaviours" />
          );
        }
        return (
          <>
            <PageHeader
              title={current.name}
              purpose="One behaviour: the instructions it follows, who may use it, and a way to try it."
              crumbs={[{ label: 'Behaviours', href: '/assistant' }]}
              status={
                <Badge tone={current.enabled ? 'ok' : 'neutral'}>
                  {current.enabled ? 'On' : 'Off'}
                </Badge>
              }
              actions={
                <Link href={`/assistant/behaviours/${current.id}/wizard`}>
                  <Button>Build with the wizard</Button>
                </Link>
              }
            />
            <DetailTabs
              key={current.id}
              tab={tab}
              onTab={(next) => navigate(tabHref(next, 'prompt'))}
              panels={[
                {
                  value: 'prompt',
                  body: (
                    <div className="space-y-5 pt-4">
                      <CodeBlock label="Full prompt" code={current.systemPrompt} />
                      <PreviewToggle key={`preview-${current.id}`} behaviourId={current.id} />
                      <BehaviourPromptCard
                        key={`prompt-${current.id}`}
                        behaviour={current}
                        session={session}
                        reload={assistant.reload}
                        onToggle={() => void toggleEnabled()}
                      />
                    </div>
                  ),
                },
                {
                  value: 'access',
                  body: (
                    <div className="space-y-5 pt-4">
                      <BehaviourAccessEditor
                        key={`access-${current.id}`}
                        behaviour={current}
                        data={data}
                        onSaved={assistant.reload}
                      />
                      {data.tickets !== undefined && current.surface === 'it-services' && (
                        <TicketsCard tickets={data.tickets} behaviour={current} data={data} />
                      )}
                    </div>
                  ),
                },
                {
                  value: 'try',
                  body: (
                    <div className="pt-4">
                      <TryItBox key={`try-${current.id}`} behaviourId={current.id} />
                    </div>
                  ),
                },
              ]}
            />
          </>
        );
      }}
    </DataState>
  );
}
