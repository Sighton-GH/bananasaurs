// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AssistantConversationPage } from './assistant-conversation.js';
import { AssistantHistoryDetailPage } from './assistant-history-detail.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals);

/** A transcript whose assistant turn ended in a failed trace (ADR 0129 §1–3). */
const FAILED_TRANSCRIPT = {
  conversation: {
    conversationId: 'conv-1',
    channelId: '333333333333333333',
    behaviourId: 'club',
    startedBy: '100000000000000001',
    title: 'Where is the handbook',
    source: 'discord',
    status: 'open',
    createdAt: 1_790_000_000_000,
    lastActivityAt: 1_790_000_002_000,
    turnCount: 2,
  },
  turns: [
    {
      turnId: 't-user',
      at: 1_790_000_001_000,
      role: 'user',
      authorId: '100000000000000001',
      authorName: 'Bryan',
      text: 'where is the handbook?',
    },
    {
      turnId: 't-assistant',
      at: 1_790_000_002_000,
      role: 'assistant',
      authorName: 'Bananasaurs',
      text: 'Sorry, I could not answer that.',
      traceId: 'trace-fail-1',
      outcome: 'failed',
      failure: {
        code: 'provider-bad-model',
        title: 'This model is not available on this key',
        model: 'stealth/space-bunny-alpha',
        providerMessage:
          'openrouter request failed with HTTP 404 (code 404: No endpoints found for stealth/space-bunny-alpha.)',
      },
    },
  ],
  links: [],
  summary: null,
};

/** A trace body from before ADR 0129: no runId, no new attempt fields, no journal. */
const PRE_0129_DETAIL = {
  trace: {
    traceId: 'trace-1',
    at: 1_790_000_000_000,
    userId: '100000000000000001',
    channelId: '333333333333333333',
    behaviourId: 'club',
    command: 'ask',
    source: 'mention',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    question: 'When is the next club meeting?',
    answer: 'Thursday at 6 pm.',
    outcome: 'answered',
    durationMs: 1200,
    attempts: [{ provider: 'gemini', model: 'gemini-2.5-flash', outcome: 'ok', ms: 900 }],
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 20, thinkingTokens: 10 },
    sections: [{ name: 'system', chars: 12, estTokens: 3, text: 'Be helpful.' }],
    toolCalls: [],
    guard: { removed: [] },
    timeline: [{ label: 'posted', atMs: 1200 }],
    discordMessageIds: [],
    sources: [],
    flags: [],
  },
  member: { username: 'bryan', displayName: 'Bryan' },
};

const FAILED_ATTEMPT_DETAIL = {
  ...PRE_0129_DETAIL,
  trace: {
    ...PRE_0129_DETAIL.trace,
    traceId: 'trace-fail-1',
    runId: 'run-1',
    outcome: 'failed',
    durationMs: 800,
    attempts: [
      {
        provider: 'openrouter',
        model: 'stealth/space-bunny-alpha',
        outcome: 'error',
        reason: 'bad-model',
        ms: 700,
        code: 'provider-bad-model',
        providerMessage:
          'openrouter request failed with HTTP 404 (code 404: No endpoints found for stealth/space-bunny-alpha.)',
        finishReason: 'length',
        upstream: 'openai',
        completionTokens: 3,
        reasoningTokens: 120,
        httpStatus: 404,
        explain: {
          title: 'This model is not available on this key',
          explanation: 'The provider did not accept this model name for this key.',
          hint: "Check the model name in AI setup against the provider's model list.",
        },
      },
    ],
  },
  journal: { since: '2026-09-20T10:00:00.000Z', until: '2026-09-20T10:00:10.000Z' },
};

function renderConversation(detail: unknown = FAILED_TRANSCRIPT) {
  stubFetch([{ url: '/api/assistant/conversations/conv-1', body: detail }]);
  const { hook } = memoryLocation({ path: '/assistant/conversations/conv-1' });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/assistant/conversations/:id" component={AssistantConversationPage} />
    </Router>,
  );
}

function renderHistoryDetail(detail: unknown) {
  const traceId =
    (detail as { trace: { traceId: string } }).trace.traceId === 'trace-fail-1'
      ? 'trace-fail-1'
      : 'trace-1';
  stubFetch([{ url: `/api/assistant/traces/${traceId}`, body: detail }]);
  const { hook } = memoryLocation({ path: `/assistant/history/${traceId}` });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/assistant/history/:traceId" component={AssistantHistoryDetailPage} />
    </Router>,
  );
}

describe('assistant failure surfaces (ADR 0129)', () => {
  it('marks the failed transcript turn with its title and model', async () => {
    renderConversation();
    expect(await screen.findByText('Failed')).toBeTruthy();
    expect(screen.getByText('This model is not available on this key')).toBeTruthy();
    expect(screen.getByText('— stealth/space-bunny-alpha')).toBeTruthy();
    // The turn text itself still renders, exactly as an answered turn would.
    expect(screen.getByText('Sorry, I could not answer that.')).toBeTruthy();
  });

  it('renders a pre-0129 trace body without throwing', async () => {
    renderHistoryDetail(PRE_0129_DETAIL);
    expect(await screen.findByRole('heading', { level: 1, name: 'Assistant run' })).toBeTruthy();
    expect(screen.getByText('When is the next club meeting?')).toBeTruthy();
    expect(screen.getByText('gemini-2.5-flash')).toBeTruthy();
  });

  it('shows the failed attempt’s provider message and finish reason', async () => {
    renderHistoryDetail(FAILED_ATTEMPT_DETAIL);
    expect(await screen.findByText(/No endpoints found/)).toBeTruthy();
    expect(screen.getByText(/Finish: length/)).toBeTruthy();
  });
});
