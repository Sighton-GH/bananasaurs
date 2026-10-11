import type { RunEvent, RunEventRow, RunRow } from '@bananasaurs/core';

/**
 * The dashboard's side of the live-runs contract (ADR 0129 §7). The In
 * progress panel polls `activeRunsUrl()`; the trace page's Step log polls
 * `runEventsUrl()` incrementally.
 */

export const RUNS_URL = '/api/assistant/runs';

export const activeRunsUrl = (): string => `${RUNS_URL}?active=1&limit=50`;

export const runEventsUrl = (runId: string, after: number): string =>
  `${RUNS_URL}/${encodeURIComponent(runId)}/events?after=${String(after)}`;

export interface LiveRun extends RunRow {
  readonly label: string;
  readonly stalled: boolean;
  readonly member: { readonly username: string; readonly displayName: string } | null;
}

export interface RunListResponse {
  readonly runs: readonly LiveRun[];
  readonly nextBefore?: number;
}

export interface RunEventsResponse {
  readonly events: readonly RunEventRow[];
}

const num = (n: number): string => n.toLocaleString('en-US');

const msText = (ms: number): string => `${num(ms)} ms`;

/** One plain-English line per event, for the step log. Pure. */
export const describeRunEvent: (event: RunEvent) => string = (event) => {
  switch (event.kind) {
    case 'queued':
      return `Queued (${event.via})`;
    case 'started':
      return `Started (attempt ${num(event.attempt)}, waited ${msText(event.queueWaitMs)} in queue)`;
    case 'conversation':
      return `${event.continued ? 'Continued' : 'New'} conversation, ${num(event.historyTurns)} earlier turns`;
    case 'context-built': {
      const tokens = event.sections.reduce((sum, s) => sum + s.estTokens, 0);
      return (
        `Built the prompt: ${num(event.sections.length)} sections, ~${num(tokens)} tokens, ` +
        `${num(event.snippetChunks)} club-source snippets, ${num(event.memories)} memories, ` +
        `${num(event.channelMessages)} channel messages, ` +
        `${num(event.toolsOffered.length)} tools offered`
      );
    }
    case 'model-call':
      return `Asked ${event.model} (model ${num(event.position + 1)} of ${num(event.of)}, round ${num(event.round)})`;
    case 'model-result': {
      if (!event.ok) {
        let text = `${event.model} failed: ${event.code ?? 'failed'}`;
        if (event.httpStatus !== undefined) text += ` · HTTP ${num(event.httpStatus)}`;
        if (event.netCode !== undefined) text += ` · ${event.netCode}`;
        if (event.finishReason !== undefined) text += ` · finish ${event.finishReason}`;
        text += ` · ${msText(event.ms)}`;
        if (event.providerMessage !== undefined) text += ` · ${event.providerMessage}`;
        return text;
      }
      let text = `${event.model} answered in ${msText(event.ms)}`;
      if (event.promptTokens !== undefined && event.completionTokens !== undefined) {
        text += `, ${num(event.promptTokens)} in / ${num(event.completionTokens)} out tokens`;
      }
      if (event.reasoningTokens !== undefined) text += `, ${num(event.reasoningTokens)} reasoning`;
      if (event.finishReason !== undefined) text += `, finish ${event.finishReason}`;
      if (event.toolCalls !== undefined && event.toolCalls > 0) {
        text += `, ${num(event.toolCalls)} tool calls`;
      }
      return text;
    }
    case 'model-skipped':
      return `Skipped ${event.model}: ${event.reason}`;
    case 'tool-call':
      return `Calling tool ${event.tool}`;
    case 'tool-result':
      return event.ok
        ? `Tool ${event.tool} ok, ${num(event.resultChars)} chars, ${msText(event.ms)}`
        : `Tool ${event.tool} refused: ${event.refused ?? 'failed'}`;
    case 'guard': {
      const text = `Output guard removed ${num(event.removed)} item(s)`;
      return event.blocked === undefined ? text : `${text}, blocked ${event.blocked}`;
    }
    case 'retry-scheduled': {
      const at = new Date(event.retryAt);
      const pad = (n: number): string => String(n).padStart(2, '0');
      const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
      return `Retry ${num(event.attempt + 1)} scheduled for ${time} after ${event.code}`;
    }
    case 'delivering':
      return `Posting the answer (${num(event.parts)} part(s))`;
    case 'delivered':
      return `Posted ${num(event.messageIds.length)} message(s)`;
    case 'finished': {
      let text = `Finished: ${event.outcome}`;
      if (event.code !== undefined) text += ` (${event.code})`;
      text += ` in ${msText(event.durationMs)}`;
      if (event.totalTokens !== undefined) text += `, ${num(event.totalTokens)} tokens`;
      return text;
    }
    case 'routed':
      // Minimal placeholder; S6-T15 replaces it with the plain-words text.
      return `Routed to the ${event.tier} tier (${event.reason})`;
    default: {
      // A new event kind fails typecheck here; at runtime (a daemon newer
      // than this page) the row still renders instead of crashing.
      const unknownEvent: never = event;
      return `Recorded step (${String((unknownEvent as { readonly kind?: unknown }).kind)})`;
    }
  }
};
