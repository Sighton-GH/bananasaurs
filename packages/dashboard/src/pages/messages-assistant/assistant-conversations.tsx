import { DraftFooter } from './draft-footer.js';
import { FormSection } from '../../ui/FormSection.js';
import { absoluteMoment } from './time.js';
import { useFieldErrors } from '../../hooks/useFieldErrors.js';
import { ErrorSummary } from '../../ui/ErrorSummary.js';
import { Select } from '../../ui/Select.js';
import { Empty } from '../../ui/states.js';
import { relativeTime } from '../../lib/relative-time.js';
import { useCallback, useState } from 'react';
import { Link } from '../../ui/Link.js';
import { ApiError } from '../../api.js';
import {
  EMPTY_CONVERSATION_FILTERS,
  RETENTION_URL,
  SORT_OPTIONS,
  conversationListUrl,
  conversationPageUrl,
  type ConversationFilters,
  type ConversationListResponse,
  type ConversationRow,
  type ConversationSort,
  type RetentionDays,
  type RetentionResponse,
} from '../../api/conversations.js';
import { AssistantDigestList } from '../../components/assistant-digest-list.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable } from '../../ui/DataTable.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { Field, Input } from '../../ui/Field.js';
import { MemberRef } from '../../ui/MemberRef.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { useToast } from '../../ui/Toast.js';
import { InProgressPanel } from '../assistant-live.js';

/** 403 carries `no-grant`; the sentence names the plain meaning, the id second. */
const conversationsError = (err: unknown): Error => {
  if (err instanceof ApiError) return err;
  return err instanceof Error ? err : new Error(String(err));
};

const RETENTION_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '61', label: '2 months' },
  { value: '182', label: '6 months' },
  { value: '365', label: '12 months' },
  { value: '', label: 'Keep forever' },
];

function RetentionForm({
  initial,
  reload,
}: {
  readonly initial: RetentionDays;
  readonly reload: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const fields = useFieldErrors();
  const [error, setError] = useState<unknown>();
  const [value, setValue] = useState<string>(initial === null ? '' : String(initial));
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState(initial === null ? '' : String(initial));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const days = value === '' ? null : Number(value);
      fields.clear();
      setError(undefined);
      const saved = await session.writeOrThrow<RetentionResponse>(RETENTION_URL, { days }, 'PUT');
      if (saved !== undefined) {
        setBaseline(value);
        toast({ tone: 'ok', title: 'Saved auto-delete setting.' });
        reload();
      }
    } catch (err) {
      fields.capture(err);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form id="retention-form" onSubmit={(e) => void save(e)} className="grid max-w-2xl gap-3">
      <FormSection title="Conversation retention">
        <ErrorSummary errors={fields.summary} />
        {error !== undefined && <ErrorNotice error={error} />}
        <Field
          label="Delete conversations older than"
          htmlFor="field-days"
          {...(fields.errorFor('days') === undefined ? {} : { error: fields.errorFor('days')! })}
        >
          <Select
            value={value === '' ? '__all' : value}
            onValueChange={(next) => setValue(next === '__all' ? '' : next)}
            options={RETENTION_OPTIONS.map((o) => ({
              ...o,
              value: o.value === '' ? '__all' : o.value,
            }))}
          />
        </Field>
        <p className="text-sm text-ink-muted">
          Bananasaurs checks once a day and deletes older conversations and their details.
        </p>
        <DraftFooter
          dirty={value !== baseline}
          busy={busy}
          onSave={() =>
            document.getElementById('retention-form') instanceof HTMLFormElement &&
            (document.getElementById('retention-form') as HTMLFormElement).requestSubmit()
          }
          onDiscard={() => {
            setValue(baseline);
            fields.clear();
            setError(undefined);
          }}
        />
        <div hidden={value !== baseline}>
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
        </div>
      </FormSection>
    </form>
  );
}

/** The auto-delete card: the current window, the four choices, and Save. */
function RetentionCard() {
  const session = useSession();
  const load = useCallback(
    () =>
      session.read<RetentionResponse>(RETENTION_URL).catch((err: unknown) => {
        throw conversationsError(err);
      }),
    [session],
  );
  const setting = useResource('auto-delete setting', load);
  return (
    <Card title="Auto-delete">
      <DataState resource={setting.resource}>
        {(data) => <RetentionForm initial={data.days} reload={setting.reload} />}
      </DataState>
    </Card>
  );
}

/**
 * `/assistant/conversations`: every stored conversation, last activity newest
 * first, with channel/member/behaviour/search filters, four sort orders and a
 * "Load older" cursor. A row opens its transcript at
 * `/assistant/conversations/:id`.
 */
export function AssistantConversationsPage() {
  const session = useSession();
  const [draft, setDraft] = useState<ConversationFilters>(EMPTY_CONVERSATION_FILTERS);
  const [applied, setApplied] = useState<ConversationFilters>(EMPTY_CONVERSATION_FILTERS);
  const [sort, setSort] = useState<ConversationSort>('activity-desc');
  const [appended, setAppended] = useState<readonly ConversationRow[]>([]);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);

  const load = useCallback(() => {
    return session
      .read<ConversationListResponse>(conversationListUrl(applied, sort))
      .catch((err: unknown) => {
        throw conversationsError(err);
      });
  }, [session, applied, sort]);
  const first = useResource('conversations', load);
  const reloadList = first.reload;

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setApplied(draft);
    setAppended([]);
    setCursor(undefined);
    setAdvanced(false);
    setOlderError(undefined);
  };

  const loadOlder = async () => {
    const at =
      advanced || first.resource.state !== 'ready' ? cursor : first.resource.data.nextBefore;
    if (at === undefined || busy) return;
    setBusy(true);
    setOlderError(undefined);
    try {
      const page = await session.read<ConversationListResponse>(
        conversationListUrl(applied, sort, at),
      );
      setAppended((rows) => [...rows, ...page.conversations]);
      setAdvanced(true);
      setCursor(page.nextBefore);
    } catch (err: unknown) {
      // A "load older" failure renders the server's answer, not the message.
      setOlderError(err);
    } finally {
      setBusy(false);
    }
  };

  const loaded: readonly ConversationRow[] =
    first.resource.state === 'ready' ? [...first.resource.data.conversations, ...appended] : [];
  const behaviours = [...new Set(loaded.map((r) => r.behaviourId))].sort();
  const behaviourOptions = [
    ...new Set([...behaviours, applied.behaviourId].filter((b) => b !== '')),
  ].sort();
  const more =
    first.resource.state === 'ready' &&
    (advanced ? cursor : first.resource.data.nextBefore) !== undefined;

  const filtered = Object.values(applied).some((value) => value !== '');
  const clearFilters = () => {
    setDraft(EMPTY_CONVERSATION_FILTERS);
    setApplied(EMPTY_CONVERSATION_FILTERS);
    setAppended([]);
    setCursor(undefined);
    setAdvanced(false);
    setOlderError(undefined);
  };

  return (
    <>
      <PageHeader
        title="Conversations"
        purpose="Every conversation members have had with the assistant, newest first."
      />
      <div className="mb-4">
        <RetentionCard />
      </div>
      <div className="mb-4">
        <AssistantDigestList />
      </div>
      <form onSubmit={apply} className="mb-4 flex max-w-3xl flex-wrap items-end gap-3">
        <Field label="Channel" hint="The channel id. Empty means everywhere.">
          <Input
            value={draft.channelId}
            placeholder="Channel id"
            onChange={(e) => setDraft((d) => ({ ...d, channelId: e.target.value }))}
          />
        </Field>
        <Field label="Member" hint="The member id who started. Empty means everyone.">
          <Input
            value={draft.userId}
            placeholder="Member id"
            onChange={(e) => setDraft((d) => ({ ...d, userId: e.target.value }))}
          />
        </Field>
        <Field label="Behaviour">
          <Select
            value={draft.behaviourId === '' ? '__all' : draft.behaviourId}
            onValueChange={(next) =>
              setDraft((d) => ({ ...d, behaviourId: next === '__all' ? '' : next }))
            }
            options={[
              { value: '__all', label: 'All behaviours' },
              ...behaviourOptions.map((b) => ({ value: b, label: b })),
            ]}
          />
        </Field>
        <Field label="Search" hint="Titles only. Empty means everything.">
          <Input
            value={draft.search}
            placeholder="Search titles"
            onChange={(e) => setDraft((d) => ({ ...d, search: e.target.value }))}
          />
        </Field>
        <Field label="Sort">
          <Select
            value={sort}
            onValueChange={(next) => setSort(next as ConversationSort)}
            options={SORT_OPTIONS}
          />
        </Field>
        <Button type="submit" variant="primary">
          Apply
        </Button>
        <Button onClick={clearFilters}>Clear filters</Button>
      </form>
      <div className="mb-4">
        <InProgressPanel onFinished={() => reloadList()} />
      </div>
      <DataState
        resource={first.resource}
        isEmpty={(page) => page.conversations.length === 0 && appended.length === 0}
        empty={
          <Empty
            title={filtered ? 'No conversations match these filters' : 'No conversations yet'}
            detail={
              filtered
                ? 'Remove filters to see stored conversations.'
                : 'No conversations yet — they appear here after someone talks to the bot.'
            }
            action={filtered ? <Button onClick={clearFilters}>Clear filters</Button> : undefined}
          />
        }
      >
        {() => (
          <>
            <DataTable
              caption="Conversations"
              rows={loaded}
              rowKey={(r) => r.conversationId}
              columns={[
                {
                  key: 'title',
                  header: 'Title',
                  cell: (r) => (
                    <>
                      <Link href={conversationPageUrl(r.conversationId)}>{r.title}</Link>
                      {(r.failedTurns ?? 0) > 0 && (
                        <span className="ml-2">
                          <Badge tone="danger">{`${String(r.failedTurns)} failed`}</Badge>
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  key: 'channel',
                  header: 'Channel',
                  cell: (r) => <span className="font-mono text-xs">{r.channelId}</span>,
                },
                {
                  key: 'startedBy',
                  header: 'Started by',
                  cell: (r) => <MemberRef id={r.startedBy} member={r.member} />,
                },
                {
                  key: 'people',
                  header: 'People',
                  cell: (r) =>
                    r.people.length === 0 ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      r.people.join(', ')
                    ),
                },
                {
                  key: 'turns',
                  header: 'Turns',
                  numeric: true,
                  cell: (r) => r.turnCount,
                },
                {
                  key: 'lastActivity',
                  header: 'Last activity',
                  cell: (r) => (
                    <time
                      dateTime={new Date(r.lastActivityAt).toISOString()}
                      title={absoluteMoment(r.lastActivityAt)}
                    >
                      {relativeTime(r.lastActivityAt, Date.now())}
                    </time>
                  ),
                },
                { key: 'behaviour', header: 'Behaviour', cell: (r) => r.behaviourId },
              ]}
            />
            {more && (
              <div className="mt-3">
                <Button onClick={() => void loadOlder()} busy={busy}>
                  Load older
                </Button>
              </div>
            )}
            {olderError !== undefined && (
              <div className="mt-2">
                <ErrorNotice error={olderError} />
              </div>
            )}
          </>
        )}
      </DataState>
    </>
  );
}
