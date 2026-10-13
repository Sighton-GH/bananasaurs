import './messages-assistant/test-support.js';
import userEvent from '@testing-library/user-event';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AssistantConversationsPage } from './assistant-conversations.js';

/** Stored rows as data: fixed ids and timestamps, no narrative. */
const ROW_NEW = {
  conversationId: 'conv-new',
  channelId: '333333333333333333',
  behaviourId: 'club',
  startedBy: '100000000000000001',
  title: 'Where is the handbook',
  source: 'discord',
  status: 'open',
  createdAt: 1_790_000_001_000,
  lastActivityAt: 1_790_000_003_000,
  turnCount: 3,
  people: ['Bryan', 'Sasha'],
  member: { username: 'bryan', displayName: 'Bryan' },
};
const ROW_OLD = {
  conversationId: 'conv-old',
  channelId: '444444444444444444',
  behaviourId: 'help',
  startedBy: '100000000000000002',
  title: 'When is the meeting',
  source: 'dashboard-test',
  status: 'ended',
  createdAt: 1_790_000_000_000,
  lastActivityAt: 1_790_000_000_500,
  turnCount: 1,
  people: ['Sasha'],
  member: null,
};

const RETENTION = { days: 182 };

const stubs = (list: unknown, retention: unknown = RETENTION) => [
  { url: '/api/assistant/runs?active=1&limit=50', body: { runs: [] } },
  { url: '/api/assistant/conversation-retention', body: retention },
  { url: '/api/assistant/conversations?sort=last-activity&order=desc&limit=50', body: list },
];

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AssistantConversationsPage', () => {
  it('shows the auto-delete card with the four choices and the daily explanation', async () => {
    stubFetch(stubs({ conversations: [ROW_NEW, ROW_OLD] }));
    renderWithSession(<AssistantConversationsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Conversations' })).toBeTruthy();
    const select = await screen.findByLabelText('Delete conversations older than');
    select.focus();
    await userEvent.keyboard('{Enter}');
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['2 months', '6 months', '12 months', 'Keep forever']);
    expect(
      screen.getByText(
        'Bananasaurs checks once a day and deletes older conversations and their details.',
      ),
    ).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(select.textContent).toContain('6 months');
  });

  it('saves the chosen auto-delete window', async () => {
    const mock = stubFetch([
      ...stubs({ conversations: [ROW_NEW] }),
      { method: 'PUT', url: '/api/assistant/conversation-retention', body: { days: 61 } },
    ]);
    renderWithSession(<AssistantConversationsPage />);
    const select = await screen.findByLabelText('Delete conversations older than');
    await act(async () => {
      select.focus();
      await userEvent.keyboard('{Enter}');
      await userEvent.click(screen.getByRole('option', { name: '2 months' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    const call = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/conversation-retention' &&
        (c[1] as RequestInit)?.method === 'PUT',
    );
    expect(call).toBeTruthy();
    expect(bodyOf(call!)).toEqual({ days: 61 });
    expect(await screen.findByText('Saved auto-delete setting.')).toBeTruthy();
  });

  it('offers the four sort orders and reloads with the chosen one', async () => {
    const mock = stubFetch([
      ...stubs({ conversations: [ROW_NEW, ROW_OLD] }),
      {
        url: '/api/assistant/conversations?sort=turns&order=desc&limit=50',
        body: { conversations: [ROW_NEW, ROW_OLD] },
      },
    ]);
    renderWithSession(<AssistantConversationsPage />);
    const select = await screen.findByLabelText('Sort');
    select.focus();
    await userEvent.keyboard('{Enter}');
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual([
      'Newest activity',
      'Oldest activity',
      'Recently started',
      'Most turns',
    ]);
    await act(async () => {
      await userEvent.click(screen.getByRole('option', { name: 'Most turns' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/assistant/conversations?sort=turns&order=desc&limit=50',
      ),
    ).toBe(true);
  });

  it('renders one row per conversation with the specified columns', async () => {
    stubFetch(stubs({ conversations: [ROW_NEW, ROW_OLD] }));
    renderWithSession(<AssistantConversationsPage />);
    const table = await screen.findByRole('table', { name: 'Conversations' });
    const headers = Array.from(table.querySelectorAll('thead th')).map((h) => h.textContent);
    expect(headers).toEqual([
      'Title',
      'Channel',
      'Started by',
      'People',
      'Turns',
      'Last activity',
      'Behaviour',
    ]);
    expect(
      within(table).getByRole('link', { name: 'Where is the handbook' }).getAttribute('href'),
    ).toBe('/assistant/conversations/conv-new');
    expect(within(table).getByText('Bryan, Sasha')).toBeTruthy();
    expect(within(table).getByText('Bryan')).toBeTruthy();
    expect(within(table).getByText('club')).toBeTruthy();
  });

  it('filters by channel and search text', async () => {
    const mock = stubFetch([
      ...stubs({ conversations: [ROW_NEW, ROW_OLD] }),
      {
        url: '/api/assistant/conversations?sort=last-activity&order=desc&limit=50&channelId=333333333333333333&search=handbook',
        body: { conversations: [ROW_NEW] },
      },
    ]);
    renderWithSession(<AssistantConversationsPage />);
    await screen.findByRole('table', { name: 'Conversations' });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Channel'), {
        target: { value: '333333333333333333' },
      });
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'handbook' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(
      mock.mock.calls.some(
        (c) =>
          (c[0] as string) ===
          '/api/assistant/conversations?sort=last-activity&order=desc&limit=50&channelId=333333333333333333&search=handbook',
      ),
    ).toBe(true);
  });

  it('says plainly when no conversation exists yet', async () => {
    stubFetch(stubs({ conversations: [] }));
    renderWithSession(<AssistantConversationsPage />);
    expect(
      await screen.findByText(
        'No conversations yet — they appear here after someone talks to the bot.',
      ),
    ).toBeTruthy();
  });
});

it('shows the daily digests list under the conversations', async () => {
  stubFetch([
    ...stubs({ conversations: [ROW_NEW] }),
    {
      url: '/api/assistant/digests',
      body: {
        digests: [
          {
            day: '2026-10-09',
            createdAt: 1_790_000_000_000,
            updatedAt: 1_790_000_000_000,
            topics: 'Talked about the build night.',
          },
        ],
      },
    },
  ]);
  renderWithSession(<AssistantConversationsPage />);
  expect(await screen.findByRole('heading', { name: 'Daily digests' })).toBeTruthy();
  expect(await screen.findByText('2026-10-09')).toBeTruthy();
});

const DIGEST_ROWS = ['2026-10-09', '2026-10-10'].map((day) => ({
  day,
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_000,
  topics: `Topics for ${day}`,
}));
const digestStubs = () => [
  ...stubs({ conversations: [] }),
  { url: '/api/assistant/digests', body: { digests: DIGEST_ROWS } },
];
const digestDetail = (day: string, summary: string) => ({
  digest: { day, daySummary: summary, proposals: [], conversations: [] },
});

it('opens the selected daily summary', async () => {
  stubFetch([
    ...digestStubs(),
    {
      url: '/api/assistant/digests/2026-10-09',
      body: digestDetail('2026-10-09', 'Build night summary.'),
    },
  ]);
  renderWithSession(<AssistantConversationsPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Open' }))[0]!);
  expect(await screen.findByText('Build night summary.')).toBeTruthy();
});

it('shows a detail error and allows retry', async () => {
  stubFetch([
    ...digestStubs(),
    { url: '/api/assistant/digests/2026-10-09', status: 503, body: { error: 'unavailable' } },
  ]);
  renderWithSession(<AssistantConversationsPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Open' }))[0]!);
  expect(await screen.findByText("Couldn't load daily digest detail")).toBeTruthy();
  const mock = stubFetch([
    ...digestStubs(),
    {
      url: '/api/assistant/digests/2026-10-09',
      body: digestDetail('2026-10-09', 'Recovered summary.'),
    },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Recovered summary.')).toBeTruthy();
  expect(mock.mock.calls.some((c) => c[0] === '/api/assistant/digests/2026-10-09')).toBe(true);
});

it('clears the previous detail and ignores a late response for another day', async () => {
  const mock = stubFetch(digestStubs());
  let finishFirst!: (response: Response) => void;
  let finishSecond!: (response: Response) => void;
  const fallback = mock.getMockImplementation()!;
  mock.mockImplementation((input, init) => {
    if (input === '/api/assistant/digests/2026-10-09')
      return new Promise((resolve) => {
        finishFirst = resolve;
      });
    if (input === '/api/assistant/digests/2026-10-10')
      return new Promise((resolve) => {
        finishSecond = resolve;
      });
    return fallback(input, init);
  });
  renderWithSession(<AssistantConversationsPage />);
  const buttons = await screen.findAllByRole('button', { name: 'Open' });
  await act(async () => {
    fireEvent.click(buttons[0]!);
  });
  await act(async () => {
    fireEvent.click(buttons[1]!);
  });
  expect(screen.queryByText('First summary.')).toBeNull();
  // The kit's Loading appears only after 1 s (no flash), so assert nothing is shown yet.
  expect(screen.queryByText('Second summary.')).toBeNull();
  await act(async () => {
    finishSecond(new Response(JSON.stringify(digestDetail('2026-10-10', 'Second summary.'))));
  });
  expect(await screen.findByText('Second summary.')).toBeTruthy();
  await act(async () => {
    finishFirst(new Response(JSON.stringify(digestDetail('2026-10-09', 'First summary.'))));
  });
  expect(screen.queryByText('First summary.')).toBeNull();
  expect(screen.getByText('Second summary.')).toBeTruthy();
});

it('shows denied audit access as permission denied, never an empty list or retryable outage', async () => {
  stubFetch(
    stubs({ conversations: [] }).map((route) =>
      route.url.includes('/conversations?')
        ? {
            ...route,
            status: 403,
            body: {
              error: 'no-grant',
              title: 'Audit access needed',
              message: 'This page needs audit.read.',
            },
          }
        : route,
    ),
  );
  renderWithSession(<AssistantConversationsPage />);
  expect(await screen.findByText('Audit access needed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.queryByText('No conversations yet')).toBeNull();
});
