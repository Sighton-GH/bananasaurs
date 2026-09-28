import { useCallback, type ReactElement } from 'react';
import { Link, useParams } from 'wouter';
import { ApiError } from '../api.js';
import { traceUrl, type TraceDetailResponse } from '../api/traces.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { MemberRef } from '../ui/MemberRef.js';
import { PageHeader } from '../ui/PageHeader.js';
import type { AssistantTrace } from '@bananasaurs/core';

const attemptTone = (outcome: string): 'ok' | 'hold' | 'danger' | 'neutral' =>
  outcome === 'ok'
    ? 'ok'
    : outcome === 'skipped'
      ? 'neutral'
      : outcome === 'error'
        ? 'danger'
        : 'hold';

const outcomeTone = (outcome: AssistantTrace['outcome']): 'ok' | 'hold' | 'danger' =>
  outcome === 'answered' ? 'ok' : outcome === 'refused' ? 'hold' : 'danger';

const argsText = (args: unknown): string => {
  if (args === undefined) return '—';
  try {
    return JSON.stringify(args, null, 2) ?? '—';
  } catch {
    return '—';
  }
};

export type TraceSection = TraceDetailResponse['trace']['sections'][number];
export type TraceToolCall = TraceDetailResponse['trace']['toolCalls'][number];

/**
 * Every prompt section as its own collapsible, with its size. `labelFor`
 * renames the summary — the Conversations panel passes its plain labels —
 * while History keeps the raw section name. Prompt text arrives empty when
 * the viewer lacks the configuration view grant; the section says so
 * instead of looking empty.
 */
export function TraceSectionsList({
  sections,
  labelFor = (name: string): string => name,
}: {
  readonly sections: readonly TraceSection[];
  readonly labelFor?: (name: string) => string;
}): ReactElement {
  if (sections.length === 0) {
    return <p className="text-sm text-ink-muted">No prompt sections were recorded.</p>;
  }
  return (
    <div className="grid gap-2">
      {sections.map((s) => (
        <details key={s.name} className="rounded-sm border border-line px-3 py-2">
          <summary className="cursor-pointer text-sm">
            {labelFor(s.name)} · {s.chars} characters · about {s.estTokens} tokens
          </summary>
          {s.text === '' && s.chars > 0 ? (
            <p className="mt-1 text-sm text-ink-muted">
              Prompt text is withheld: your account does not hold the configuration view grant
              (config.read).
            </p>
          ) : (
            <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
              {s.text}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}

/**
 * Every tool call in order: its round, name, arguments, the result text the
 * model received, and whether the call was allowed. Shared by History and
 * the Conversations panel's inline view.
 */
export function TraceToolCallsTable({
  toolCalls,
}: {
  readonly toolCalls: readonly TraceToolCall[];
}): ReactElement {
  if (toolCalls.length === 0) {
    return <p className="text-sm text-ink-muted">No tool calls were made.</p>;
  }
  return (
    <DataTable
      caption="Tool calls"
      rows={toolCalls}
      rowKey={(r) => `${r.round}-${r.name}-${r.ms}`}
      columns={[
        { key: 'round', header: 'Round', numeric: true, cell: (r) => r.round },
        {
          key: 'tool',
          header: 'Tool',
          cell: (r) => <span className="font-mono text-xs">{r.name}</span>,
        },
        {
          key: 'args',
          header: 'Arguments',
          cell: (r) => <pre className="text-xs whitespace-pre-wrap">{argsText(r.args)}</pre>,
        },
        {
          key: 'preview',
          header: 'Result preview',
          cell: (r) => <pre className="text-xs whitespace-pre-wrap">{r.preview}</pre>,
        },
        {
          key: 'result',
          header: 'Result',
          cell: (r) =>
            r.ok ? (
              <Badge tone="ok">ok</Badge>
            ) : (
              <>
                <Badge tone="danger">refused</Badge>
                {r.refused !== undefined && (
                  <span className="ml-2 text-xs text-ink-muted">{r.refused}</span>
                )}
              </>
            ),
        },
        { key: 'ms', header: 'Duration', numeric: true, cell: (r) => `${r.ms} ms` },
      ]}
    />
  );
}

/**
 * `/assistant/history/:traceId`: one stored run — the question and the answer
 * as posted, each model tried in order, every prompt section, every tool
 * call, the timeline and any error. Prompt text arrives empty when the viewer
 * lacks the configuration view grant; the section says so instead of looking
 * empty.
 */
export function AssistantHistoryDetailPage() {
  const { traceId } = useParams<{ traceId: string }>();
  const session = useSession();
  const guildId = session.info.guildId;
  const load = useCallback(() => {
    return session.read<TraceDetailResponse>(traceUrl(traceId)).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) {
        throw new Error('no run with this id is stored for this server');
      }
      if (err instanceof ApiError && err.status === 403) {
        throw new Error('your account does not hold the audit view grant (audit.read)');
      }
      throw err;
    });
  }, [session, traceId]);
  const detail = useResource('assistant run', load);

  return (
    <>
      <PageHeader
        title="Assistant run"
        purpose="What one assistant run saw, called and cost."
        actions={
          <Link href="/assistant/history">
            <Button>History</Button>
          </Link>
        }
      />
      <DataState resource={detail.resource}>
        {({ trace, member }) => {
          const messageId = trace.discordMessageIds[0];
          const discordUrl =
            trace.channelId !== undefined && messageId !== undefined
              ? `https://discord.com/channels/${guildId}/${trace.channelId}/${messageId}`
              : undefined;
          return (
            <div className="grid gap-4">
              <Card title="Summary">
                <dl className="grid gap-2 text-sm">
                  <div>
                    <dt className="text-ink-muted">Question</dt>
                    <dd className="whitespace-pre-wrap">{trace.question}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Answer, as posted</dt>
                    <dd className="whitespace-pre-wrap">
                      {trace.answer ?? (
                        <span className="text-ink-muted">No answer was posted.</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <span>
                      <span className="text-ink-muted">Outcome </span>
                      <Badge tone={outcomeTone(trace.outcome)}>{trace.outcome}</Badge>
                    </span>
                    <span>
                      <span className="text-ink-muted">Asked by </span>
                      <MemberRef id={trace.userId} member={member} />
                    </span>
                    <span>
                      <span className="text-ink-muted">Behaviour </span>
                      {trace.behaviourId}
                    </span>
                    <span>
                      <span className="text-ink-muted">When </span>
                      {new Date(trace.at).toLocaleString('en-CA')}
                    </span>
                    <span>
                      <span className="text-ink-muted">Duration </span>
                      {trace.durationMs} ms
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {trace.conversationId !== undefined && (
                      <Link
                        href={`/assistant/conversations/${encodeURIComponent(trace.conversationId)}`}
                      >
                        Open the conversation
                      </Link>
                    )}
                    {discordUrl !== undefined && (
                      <a href={discordUrl} target="_blank" rel="noreferrer">
                        Open in Discord
                      </a>
                    )}
                  </div>
                </dl>
              </Card>
              <Card title="Model">
                <DataTable
                  caption="Model attempts"
                  rows={trace.attempts.map((a, i) => ({ ...a, n: i + 1 }))}
                  rowKey={(r) => String(r.n)}
                  columns={[
                    { key: 'n', header: 'Attempt', numeric: true, cell: (r) => r.n },
                    { key: 'provider', header: 'Provider', cell: (r) => r.provider },
                    {
                      key: 'model',
                      header: 'Model',
                      cell: (r) => (
                        <span className="font-mono text-xs">
                          {r.model}
                          {r.keyLabel !== undefined && (
                            <span className="text-ink-muted"> via {r.keyLabel}</span>
                          )}
                        </span>
                      ),
                    },
                    {
                      key: 'outcome',
                      header: 'Outcome',
                      cell: (r) => <Badge tone={attemptTone(r.outcome)}>{r.outcome}</Badge>,
                    },
                    {
                      key: 'reason',
                      header: 'Reason',
                      cell: (r) => r.reason ?? <span className="text-ink-muted">—</span>,
                    },
                    {
                      key: 'why',
                      header: 'Why',
                      cell: (r) => {
                        if (r.explain === undefined) {
                          return r.reason ?? <span className="text-ink-muted">—</span>;
                        }
                        const parts: string[] = [];
                        if (r.host !== undefined && r.host !== '') parts.push(r.host);
                        if (r.httpStatus !== undefined) parts.push(`HTTP ${String(r.httpStatus)}`);
                        if (r.netCode !== undefined && r.netCode !== '') parts.push(r.netCode);
                        if (
                          (r.code === 'local-rpm-limit' || r.code === 'local-rpd-limit') &&
                          r.availableAt !== undefined
                        ) {
                          parts.push(`frees up ${new Date(r.availableAt).toLocaleString('en-CA')}`);
                        }
                        return (
                          <div className="grid gap-1 text-sm">
                            <strong>{r.explain.title}</strong>
                            <p>{r.explain.explanation}</p>
                            <p>
                              <span className="text-ink-muted">What to do: </span>
                              {r.explain.hint}
                            </p>
                            {parts.length > 0 && (
                              <p className="text-xs text-ink-muted">{parts.join(' · ')}</p>
                            )}
                          </div>
                        );
                      },
                    },
                    { key: 'ms', header: 'Duration', numeric: true, cell: (r) => `${r.ms} ms` },
                  ]}
                />
                <dl className="mt-2 grid gap-1 text-sm">
                  <div>
                    <dt className="inline text-ink-muted">Finish reason: </dt>
                    <dd className="inline">{trace.finishReason ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="inline text-ink-muted">Tokens: </dt>
                    <dd className="inline">
                      {trace.usage.promptTokens ?? '—'} prompt ·{' '}
                      {trace.usage.completionTokens ?? '—'} answer ·{' '}
                      {trace.usage.thinkingTokens ?? '—'} thinking
                    </dd>
                  </div>
                </dl>
              </Card>
              <Card title="Prompt">
                <TraceSectionsList sections={trace.sections} />
              </Card>
              <Card title="Tool calls">
                <p className="mb-2 text-sm">
                  <span className="text-ink-muted">Tools offered: </span>
                  {trace.toolsOffered === undefined ? (
                    <span className="text-ink-muted">not recorded</span>
                  ) : trace.toolsOffered.length > 0 ? (
                    <span className="font-mono text-xs">{trace.toolsOffered.join(', ')}</span>
                  ) : (
                    <span className="text-ink-muted">none</span>
                  )}
                </p>
                <TraceToolCallsTable toolCalls={trace.toolCalls} />
              </Card>
              <Card title="Timeline">
                {trace.timeline.length === 0 ? (
                  <p className="text-sm text-ink-muted">No timeline entries were recorded.</p>
                ) : (
                  <ol className="grid gap-1 text-sm">
                    {[...trace.timeline]
                      .sort((a, b) => a.atMs - b.atMs)
                      .map((t) => (
                        <li key={`${t.label}-${t.atMs}`}>
                          {t.label} <span className="text-ink-muted">· {t.atMs} ms</span>
                        </li>
                      ))}
                  </ol>
                )}
              </Card>
              {trace.error !== undefined && (
                <Card title="Errors">
                  <dl className="grid gap-1 text-sm">
                    <div>
                      <dt className="inline text-ink-muted">Kind: </dt>
                      <dd className="inline font-mono text-xs">{trace.error.kind}</dd>
                    </div>
                    <div>
                      <dt className="inline text-ink-muted">Message: </dt>
                      <dd className="inline">{trace.error.message}</dd>
                    </div>
                  </dl>
                </Card>
              )}
              {trace.flags.length > 0 && (
                <Card title="Flags">
                  <ul className="flex flex-wrap gap-2">
                    {trace.flags.map((f) => (
                      <li key={f}>
                        <Badge>{f}</Badge>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {trace.sources.length > 0 && (
                <Card title="Sources">
                  <ul className="grid gap-1 text-sm">
                    {trace.sources.map((s) => (
                      <li key={s.url}>
                        <a href={s.url} target="_blank" rel="noreferrer">
                          {s.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          );
        }}
      </DataState>
    </>
  );
}
