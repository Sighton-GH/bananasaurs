// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { WhatTheAiSaw } from './what-the-ai-saw.js';

/** One stored run as data: the first ok attempt answers, with labelled sections. */
const TRACE = {
  traceId: 'trace-1',
  at: 1_790_000_000_000,
  userId: '100000000000000001',
  behaviourId: 'club',
  command: 'ask',
  source: 'mention',
  question: 'where is the handbook?',
  answer: 'In the resources.',
  outcome: 'answered',
  durationMs: 850,
  attempts: [
    { provider: 'gemini', model: 'busy-model', outcome: 'busy', reason: 'overloaded', ms: 50 },
    { provider: 'openrouter', model: 'panel-model', outcome: 'ok', ms: 800 },
  ],
  finishReason: 'stop',
  usage: { promptTokens: 120, completionTokens: 25, thinkingTokens: 5 },
  sections: [
    { name: 'user-message', chars: 22, estTokens: 6, text: 'where is the handbook?' },
    { name: 'resources', chars: 14, estTokens: 4, text: 'Handbook text.' },
    { name: 'custom-block', chars: 3, estTokens: 1, text: 'xyz' },
  ],
  toolCalls: [
    {
      round: 1,
      name: 'search_sources',
      args: { query: 'handbook' },
      ok: true,
      ms: 60,
      preview: 'Handbook page 3',
    },
  ],
  guard: { removed: [] },
  timeline: [],
  discordMessageIds: [],
  sources: [],
  flags: [],
  included: {
    toolsOffered: ['search_sources', 'read_chunk'],
    snippetChunkIds: ['chunk-1', 'chunk-2'],
    quote: true,
    historyTurns: 2,
  },
};

const TRACE_URL = '/api/assistant/traces/trace-1';

function renderPanel(trace: unknown = TRACE) {
  const mock = stubFetch([{ url: TRACE_URL, body: { trace } }]);
  renderWithSession(<WhatTheAiSaw traceId="trace-1" />);
  return mock;
}

const traceCalls = (mock: ReturnType<typeof stubFetch>) =>
  mock.mock.calls.filter((c) => (c[0] as string) === TRACE_URL);

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('WhatTheAiSaw', () => {
  it('stays collapsed without fetching the trace', async () => {
    const mock = renderPanel();
    expect(await screen.findByRole('button', { name: 'What the AI saw' })).toBeTruthy();
    expect(traceCalls(mock)).toHaveLength(0);
    expect(screen.queryByText('panel-model')).toBeNull();
  });

  it('opens to show the labelled sections, the tool call with its result, and the model', async () => {
    const mock = renderPanel();
    await screen.findByRole('button', { name: 'What the AI saw' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'What the AI saw' }));
    });
    expect(traceCalls(mock)).toHaveLength(1);
    // The model is the first ok attempt, not the busy one before it.
    expect(await screen.findByText('panel-model')).toBeTruthy();
    expect(screen.queryByText('busy-model')).toBeNull();
    expect(screen.getByText(/120 prompt/)).toBeTruthy();
    // Sections render under their plain labels; unknown names keep the raw name.
    expect(
      screen.getByText("The member's message and evidence · 22 characters · about 6 tokens"),
    ).toBeTruthy();
    expect(screen.getByText('where is the handbook?')).toBeTruthy();
    expect(screen.getByText('Club sources · 14 characters · about 4 tokens')).toBeTruthy();
    expect(screen.getByText('custom-block · 3 characters · about 1 token')).toBeTruthy();
    // The tool call shows its name, arguments and result text.
    expect(screen.getAllByText('search_sources').length).toBeGreaterThan(0);
    expect(screen.getByText(/"query": "handbook"/)).toBeTruthy();
    expect(screen.getByText('Handbook page 3')).toBeTruthy();
    // The included blocks render when the trace carries them.
    expect(screen.getByText('What was included')).toBeTruthy();
    expect(screen.getByText('chunk-1, chunk-2')).toBeTruthy();
  });

  it('renders a trace without included blocks', async () => {
    const { included: _dropped, ...bare } = TRACE;
    expect(_dropped).toBeTruthy();
    renderPanel(bare);
    await screen.findByRole('button', { name: 'What the AI saw' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'What the AI saw' }));
    });
    expect(await screen.findByText('panel-model')).toBeTruthy();
    expect(
      screen.getByText("The member's message and evidence · 22 characters · about 6 tokens"),
    ).toBeTruthy();
    expect(screen.queryByText('What was included')).toBeNull();
  });

  it('shows the standard error state when the trace cannot load', async () => {
    stubFetch([{ url: TRACE_URL, status: 500, body: { error: 'boom' } }]);
    renderWithSession(<WhatTheAiSaw traceId="trace-1" />);
    await screen.findByRole('button', { name: 'What the AI saw' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'What the AI saw' }));
    });
    expect(await screen.findByText(/Could not load assistant run/)).toBeTruthy();
  });
});
