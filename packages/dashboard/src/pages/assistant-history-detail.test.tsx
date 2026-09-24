// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AssistantHistoryDetailPage } from './assistant-history-detail.js';

/** One stored run as data: fixed ids and timestamps, no narrative. */
const DETAIL = {
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
    attempts: [
      { provider: 'gemini', model: 'first-model', outcome: 'busy', reason: 'overloaded', ms: 50 },
      { provider: 'openrouter', model: 'second-model', outcome: 'ok', ms: 900 },
    ],
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 20, thinkingTokens: 10 },
    sections: [{ name: 'system', chars: 12, estTokens: 3, text: 'Be helpful.' }],
    toolCalls: [
      {
        round: 1,
        name: 'search_sources',
        args: { query: 'meeting' },
        ok: true,
        ms: 100,
        preview: 'Thursday 6 pm',
      },
      {
        round: 2,
        name: 'read_chunk',
        args: { id: 'unknown' },
        ok: false,
        refused: 'unknown handle',
        ms: 5,
        preview: '',
      },
    ],
    guard: { removed: ['member-email'] },
    timeline: [
      { label: 'queued', atMs: 0 },
      { label: 'posted', atMs: 1200 },
    ],
    error: { kind: 'provider-timeout', message: 'First model timed out; used the next.' },
    discordMessageIds: ['900000000000000002'],
    sources: [{ title: 'Meetings', url: 'https://example.com/meetings' }],
    flags: ['feedback:up'],
  },
  member: { username: 'bryan', displayName: 'Bryan' },
};

function renderDetail() {
  const { hook } = memoryLocation({ path: '/assistant/history/trace-1' });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/assistant/history/:traceId" component={AssistantHistoryDetailPage} />
    </Router>,
  );
}

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AssistantHistoryDetailPage', () => {
  it('renders every section of the run', async () => {
    stubFetch([{ url: '/api/assistant/traces/trace-1', body: DETAIL }]);
    renderDetail();
    expect(await screen.findByRole('heading', { level: 1, name: 'Assistant run' })).toBeTruthy();
    // Summary: the question, the answer as posted, and both links.
    expect(screen.getByText('When is the next club meeting?')).toBeTruthy();
    expect(screen.getByText('Thursday at 6 pm.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in Discord' }).getAttribute('href')).toBe(
      'https://discord.com/channels/1540816150026518620/333333333333333333/900000000000000002',
    );
    expect(screen.getByRole('link', { name: 'Open the conversation' }).getAttribute('href')).toBe(
      '/assistant/conversations/conv-1',
    );
    // Model: each attempt in order with the reason it moved on, plus usage.
    expect(screen.getByText('first-model')).toBeTruthy();
    expect(screen.getByText('second-model')).toBeTruthy();
    expect(screen.getByText('overloaded')).toBeTruthy();
    expect(screen.getByText(/100 prompt/)).toBeTruthy();
    // Prompt: each section expandable with its size.
    expect(screen.getByText('system · 12 characters · about 3 tokens')).toBeTruthy();
    expect(screen.getByText('Be helpful.')).toBeTruthy();
    // Tool calls: round, tool, arguments, preview, ok/refused with reason.
    expect(screen.getByText('search_sources')).toBeTruthy();
    expect(screen.getByText(/"query": "meeting"/)).toBeTruthy();
    expect(screen.getByText('unknown handle')).toBeTruthy();
    // Timeline, errors and flags.
    expect(screen.getByText('queued')).toBeTruthy();
    expect(screen.getByText('provider-timeout')).toBeTruthy();
    expect(screen.getByText('feedback:up')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Meetings' }).getAttribute('href')).toBe(
      'https://example.com/meetings',
    );
  });

  it('says the prompt text is withheld when it arrives empty', async () => {
    stubFetch([
      {
        url: '/api/assistant/traces/trace-1',
        body: {
          ...DETAIL,
          trace: {
            ...DETAIL.trace,
            sections: [{ name: 'system', chars: 12, estTokens: 3, text: '' }],
          },
        },
      },
    ]);
    renderDetail();
    expect(await screen.findByText(/Prompt text is withheld/)).toBeTruthy();
  });

  it('maps a missing run to a sentence', async () => {
    stubFetch([
      { url: '/api/assistant/traces/trace-1', status: 404, body: { error: 'not-found' } },
    ]);
    renderDetail();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no run with this id is stored for this server');
  });
});
