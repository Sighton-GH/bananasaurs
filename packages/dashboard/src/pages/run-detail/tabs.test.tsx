// @vitest-environment jsdom
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch } from '../../test-support.js';
import { AssistantHistoryDetailPage } from '../assistant-history-detail.js';

const detail = {
  trace: {
    traceId: 'trace-1',
    at: 1790000000000,
    userId: '100000000000000001',
    behaviourId: 'club',
    command: 'ask',
    source: 'mention',
    question: 'Question',
    outcome: 'failed',
    durationMs: 20,
    attempts: [],
    usage: {},
    sections: [{ name: 'system', chars: 6, estTokens: 2, text: 'Prompt' }],
    toolCalls: [
      {
        round: 1,
        name: 'lookup',
        args: { query: 'meeting', limit: 2 },
        ok: true,
        ms: 10,
        preview: 'Found',
      },
    ],
    guard: { removed: [] },
    timeline: [],
    discordMessageIds: [],
    sources: [],
    error: { kind: 'timeout', message: 'Timed out' },
    flags: ['budget'],
  },
  member: null,
};
function renderPage(path = '/assistant/history/trace-1') {
  const location = memoryLocation({ path, record: true });
  renderWithSession(
    <Router hook={location.hook}>
      <Route path="/assistant/history/:traceId" component={AssistantHistoryDetailPage} />
    </Router>,
  );
  return location;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('run detail presentation', () => {
  it('opens deep links, preserves unrelated query values, and follows Back without another read', async () => {
    const fetch = stubFetch([{ url: '/api/assistant/traces/trace-1', body: detail }]);
    const location = renderPage('/assistant/history/trace-1?tab=prompt&from=history');
    const prompt = await screen.findByRole('tab', { name: 'Prompt' });
    expect(prompt.getAttribute('aria-selected')).toBe('true');
    expect(
      within(screen.getByRole('tabpanel')).getByText('Prompt', { selector: 'code' }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Sources' }));
    expect(location.history?.at(-1)).toBe('/assistant/history/trace-1?tab=sources&from=history');
    expect(screen.getByText('No sources were recorded.')).toBeTruthy();
    act(() => location.navigate(location.history[0]!));
    expect(screen.getByRole('tab', { name: 'Prompt' }).getAttribute('aria-selected')).toBe('true');
    expect(
      fetch.mock.calls.filter(([url]) => url === '/api/assistant/traces/trace-1'),
    ).toHaveLength(1);
  });
  it('keeps errors and flags above all tabs and toggles each authorized argument payload', async () => {
    stubFetch([{ url: '/api/assistant/traces/trace-1', body: detail }]);
    renderPage('/assistant/history/trace-1?tab=tool-calls');
    const tab = await screen.findByRole('tab', { name: 'Tool calls' });
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => a.textContent?.includes('Timed out'))).toBe(true);
    expect(alerts.some((a) => a.textContent?.includes('budget'))).toBe(true);
    expect(alerts[0]!.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByRole('rowheader', { name: 'Query' })).toBeTruthy();
    expect(screen.getByText('meeting')).toBeTruthy();
    expect(screen.queryByText(/"query": "meeting"/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show raw' }));
    expect(screen.getByRole('region', { name: 'Arguments for lookup, call 1' })).toBeTruthy();
    expect(screen.getByText(/"query": "meeting"/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show structured' }));
    expect(screen.getByRole('rowheader', { name: 'Query' })).toBeTruthy();
  });
  it('keeps the existing step-log read mounted while switching tabs', async () => {
    const fetch = stubFetch([
      {
        url: '/api/assistant/traces/trace-1',
        body: { ...detail, trace: { ...detail.trace, runId: 'run-1' } },
      },
      {
        url: '/api/assistant/runs/run-1/events?after=0',
        body: {
          events: [
            {
              seq: 1,
              at: 1790000000000,
              event: { kind: 'finished', outcome: 'failed', durationMs: 20 },
            },
          ],
        },
      },
    ]);
    renderPage();
    await screen.findByRole('heading', { name: 'Step log' });
    await userEvent.click(screen.getByRole('tab', { name: 'Prompt' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(
      fetch.mock.calls.filter(([url]) => url === '/api/assistant/runs/run-1/events?after=0'),
    ).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Step log' })).toBeTruthy();
  });
  it.each([
    ['prompt', 'No prompt sections were recorded.'],
    ['tool-calls', 'No tool calls were made.'],
    ['timeline', 'No timeline entries were recorded.'],
    ['sources', 'No sources were recorded.'],
  ])('keeps old trace optional fields absent on %s', async (tab, text) => {
    stubFetch([
      {
        url: '/api/assistant/traces/trace-1',
        body: {
          ...detail,
          trace: { ...detail.trace, sections: [], toolCalls: [], error: undefined, flags: [] },
        },
      },
    ]);
    renderPage(`/assistant/history/trace-1?tab=${tab}`);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText(/journalctl/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Open in Discord/ })).toBeNull();
  });
  it.each([403, 404, 503])('keeps HTTP %s distinct', async (status) => {
    stubFetch([
      {
        url: '/api/assistant/traces/trace-1',
        status,
        body: { error: status === 403 ? 'forbidden' : 'unavailable' },
      },
    ]);
    renderPage();
    if (status === 404) {
      expect(await screen.findByText("This run doesn't exist or was deleted")).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    } else if (status === 403) {
      expect(await screen.findByText(/audit.read/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    } else {
      expect(await screen.findByText("Couldn't load assistant run")).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(screen.queryByText(/doesn't exist/)).toBeNull();
    }
  });
});
