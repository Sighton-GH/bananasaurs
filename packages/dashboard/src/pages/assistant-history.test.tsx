// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AssistantHistoryPage } from './assistant-history.js';

/** Stored rows as data: fixed ids and timestamps, no narrative. */
const ROW_NEW = {
  traceId: 'trace-new',
  at: 1_790_000_002_000,
  userId: '100000000000000001',
  channelId: '333333333333333333',
  behaviourId: 'club',
  outcome: 'answered',
  durationMs: 1200,
  model: 'gemini-2.5-flash',
  totalTokens: 130,
  member: { username: 'bryan', displayName: 'Bryan' },
};
const ROW_MID = {
  traceId: 'trace-mid',
  at: 1_790_000_001_000,
  userId: '199999999999999999',
  behaviourId: 'club',
  outcome: 'refused',
  durationMs: 300,
  totalTokens: null,
  member: null,
};
const ROW_OLD = {
  traceId: 'trace-old',
  at: 1_790_000_000_500,
  userId: '100000000000000001',
  behaviourId: 'help',
  outcome: 'failed',
  durationMs: 2100,
  model: 'other-model',
  totalTokens: 40,
  member: { username: 'bryan', displayName: 'Bryan' },
};

const USAGE = {
  days: [
    { day: '2026-09-20', answers: 3, failures: 1, fallbacks: 1, tokens: 400 },
    { day: '2026-09-21', answers: 0, failures: 0, fallbacks: 0, tokens: 0 },
  ],
};

const OLDER = {
  behaviours: [{ id: 'club', name: 'Club assistant' }],
  skills: [{ id: 'search-club', name: 'Search club knowledge' }],
  activity: [
    {
      id: 'act-1',
      at: 1_790_000_000_000,
      behaviourId: 'club',
      skillId: 'search-club',
      outcome: 'answered',
    },
  ],
};

const stubs = (first: unknown) => [
  { url: '/api/assistant/usage?days=14', body: USAGE },
  { url: '/api/assistant/traces?limit=50', body: first },
  { url: '/api/assistant', body: OLDER },
];

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AssistantHistoryPage', () => {
  it('renders rows, the usage strip and the older activity section', async () => {
    stubFetch(stubs({ traces: [ROW_NEW, ROW_MID], nextBefore: 1_790_000_001_000 }));
    renderWithSession(<AssistantHistoryPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'History' })).toBeTruthy();
    // The filter selects share words with the table; scope row assertions to it.
    const table = await screen.findByRole('table', { name: 'Assistant history' });
    expect(within(table).getByText('gemini-2.5-flash')).toBeTruthy();
    expect(within(table).getByText('answered')).toBeTruthy();
    expect(within(table).getByText('refused')).toBeTruthy();
    expect(within(table).getByText('Bryan')).toBeTruthy();
    // The member Discord no longer knows renders as a bare id with a note.
    expect(screen.getByText('199999999999999999')).toBeTruthy();
    // The 14-day strip: plain bars with accessible day labels.
    expect(screen.getByRole('img', { name: '2026-09-20: 3 answers, 1 failures' })).toBeTruthy();
    // The pre-trace rows stay reachable, collapsed.
    expect(screen.getByText('Older activity (before detailed history)')).toBeTruthy();
    expect(screen.getByText('Search club knowledge')).toBeTruthy();
  });

  it('loads older runs on demand and appends them', async () => {
    stubFetch([
      ...stubs({ traces: [ROW_NEW, ROW_MID], nextBefore: 1_790_000_001_000 }),
      {
        url: '/api/assistant/traces?limit=50&before=1790000001000',
        body: { traces: [ROW_OLD] },
      },
    ]);
    renderWithSession(<AssistantHistoryPage />);
    await screen.findByText('gemini-2.5-flash');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    });
    expect(await screen.findByText('other-model')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Assistant history' });
    expect(within(table).getByText('help')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
  });

  it('applies the outcome filter', async () => {
    const mock = stubFetch([
      ...stubs({ traces: [ROW_NEW, ROW_MID] }),
      { url: '/api/assistant/traces?limit=50&outcome=failed', body: { traces: [] } },
    ]);
    renderWithSession(<AssistantHistoryPage />);
    await screen.findByText('gemini-2.5-flash');
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'failed' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(await screen.findByText('No assistant runs yet')).toBeTruthy();
    expect(
      mock.mock.calls.some((c) => c[0] === '/api/assistant/traces?limit=50&outcome=failed'),
    ).toBe(true);
  });

  it('renders the empty state with its guidance', async () => {
    stubFetch(stubs({ traces: [] }));
    renderWithSession(<AssistantHistoryPage />);
    expect(await screen.findByText('No assistant runs yet')).toBeTruthy();
    expect(
      screen.getByText('Tag @Bananasaurs in Discord or use Try it on a behaviour.'),
    ).toBeTruthy();
  });

  it('renders the error state naming the request when the load fails', async () => {
    stubFetch([]);
    renderWithSession(<AssistantHistoryPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load assistant history');
  });
});
