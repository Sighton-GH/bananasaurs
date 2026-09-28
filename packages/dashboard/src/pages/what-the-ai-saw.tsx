import { useCallback, useState, type ReactElement } from 'react';
import type { AssistantTrace } from '@bananasaurs/core';
import { ApiError } from '../api.js';
import { traceUrl, type TraceDetailResponse } from '../api/traces.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { TraceSectionsList, TraceToolCallsTable } from './assistant-history-detail.js';

/**
 * The prompt-section names the inline panel groups under plain labels.
 * Anything unknown keeps its raw name.
 */
export const aiSawSectionLabel = (name: string): string => {
  switch (name) {
    case 'surface':
    case 'behaviour-prompt':
      return 'How it was set up';
    case 'safety-suffix':
    case 'output-rules':
      return 'Rules';
    case 'skills':
      return 'What it can do';
    case 'resources':
      return 'Club sources';
    case 'server-card':
      return 'Server card';
    case 'history':
      return 'Earlier in this conversation';
    case 'user-message':
      return "The member's message and evidence";
    default:
      return name;
  }
};

/**
 * The context blocks a trace records as included (ADR 0088 decision 2).
 * Every field is optional and older traces carry no `included` at all, so
 * the panel renders nothing for it then.
 */
export interface TraceIncluded {
  readonly toolsOffered?: readonly string[];
  readonly snippetChunkIds?: readonly string[];
  readonly quote?: boolean;
  readonly historyTurns?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asStringList = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    items.push(item);
  }
  return items;
};

/** Reads `trace.included` defensively: the field postdates this branch's `AssistantTrace`. */
export const includedOf = (trace: AssistantTrace): TraceIncluded | undefined => {
  if (!('included' in trace)) return undefined;
  const raw: unknown = trace.included;
  if (!isRecord(raw)) return undefined;
  const toolsOffered = asStringList(raw['toolsOffered']);
  const snippetChunkIds = asStringList(raw['snippetChunkIds']);
  const quoteValue: unknown = raw['quote'];
  const turnsValue: unknown = raw['historyTurns'];
  return {
    ...(toolsOffered !== undefined ? { toolsOffered } : {}),
    ...(snippetChunkIds !== undefined ? { snippetChunkIds } : {}),
    ...(typeof quoteValue === 'boolean' ? { quote: quoteValue } : {}),
    ...(typeof turnsValue === 'number' && Number.isInteger(turnsValue)
      ? { historyTurns: turnsValue }
      : {}),
  };
};

const orDash = (value: string): string => (value === '' ? '—' : value);

function WhatTheAiSawTrace({ trace }: { readonly trace: TraceDetailResponse['trace'] }) {
  const firstOk = trace.attempts.find((a) => a.outcome === 'ok');
  const included = includedOf(trace);
  return (
    <div className="mt-2 grid gap-3 rounded-sm border border-line bg-canvas px-3 py-2">
      <dl className="grid gap-1 text-sm">
        <div>
          <dt className="inline text-ink-muted">Model </dt>
          <dd className="inline">
            {firstOk === undefined ? (
              <span className="text-ink-muted">No attempt finished.</span>
            ) : (
              <span className="font-mono text-xs">{firstOk.model}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="inline text-ink-muted">Tokens: </dt>
          <dd className="inline">
            {trace.usage.promptTokens ?? '—'} prompt · {trace.usage.completionTokens ?? '—'}{' '}
            answer · {trace.usage.thinkingTokens ?? '—'} thinking
          </dd>
        </div>
      </dl>
      <section aria-label="Prompt sections">
        <h4 className="text-sm font-medium">Prompt</h4>
        <div className="mt-1">
          <TraceSectionsList sections={trace.sections} labelFor={aiSawSectionLabel} />
        </div>
      </section>
      <section aria-label="Tool calls">
        <h4 className="text-sm font-medium">Tool calls</h4>
        <div className="mt-1">
          <TraceToolCallsTable toolCalls={trace.toolCalls} />
        </div>
      </section>
      {included !== undefined && (
        <section aria-label="Included context">
          <h4 className="text-sm font-medium">What was included</h4>
          <dl className="mt-1 grid gap-1 text-sm">
            <div>
              <dt className="inline text-ink-muted">Tools offered: </dt>
              <dd className="inline">
                {included.toolsOffered !== undefined && included.toolsOffered.length > 0
                  ? included.toolsOffered.join(', ')
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">Evidence chunks: </dt>
              <dd className="inline">
                {included.snippetChunkIds !== undefined && included.snippetChunkIds.length > 0
                  ? included.snippetChunkIds.join(', ')
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">Quoted message: </dt>
              <dd className="inline">
                {included.quote === undefined ? '—' : included.quote ? 'yes' : 'no'}
              </dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">History turns: </dt>
              <dd className="inline">
                {included.historyTurns === undefined
                  ? '—'
                  : orDash(String(included.historyTurns))}
              </dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}

function WhatTheAiSawBody({ traceId }: { readonly traceId: string }): ReactElement {
  const session = useSession();
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
    <DataState resource={detail.resource}>
      {({ trace }) => <WhatTheAiSawTrace trace={trace} />}
    </DataState>
  );
}

/**
 * The inline "What the AI saw" panel for one bot turn: collapsed behind a
 * button, fetching its trace only once opened. Renders nothing until then.
 */
export function WhatTheAiSaw({ traceId }: { readonly traceId: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button onClick={() => setOpen((was) => !was)} aria-expanded={open}>
        What the AI saw
      </Button>
      {open && <WhatTheAiSawBody traceId={traceId} />}
    </div>
  );
}
