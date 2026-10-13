import './test-support.js';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import userEvent from '@testing-library/user-event';
import { ArchivePage } from '../archive.js';
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../../test-support.js';
import { AssistantHistoryPage } from '../assistant-history.js';
import { AssistantMemoryPage } from '../assistant-memory.js';
import { AssistantConversationsPage } from '../assistant-conversations.js';
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
it('shows independently scoped usage, model health and activity failures', async () => {
  stubFetch([
    { url: '/api/assistant/traces?limit=50', body: { traces: [] } },
    { url: '/api/assistant/runs?active=1&limit=50', body: { runs: [] } },
    { url: '/api/assistant/usage?days=14', status: 500, body: { error: 'unavailable' } },
    { url: '/api/assistant/model-health?window=24h', status: 500, body: { error: 'unavailable' } },
    { url: '/api/assistant', status: 500, body: { error: 'unavailable' } },
  ]);
  renderWithSession(<AssistantHistoryPage />);
  expect(await screen.findByText("Couldn't load assistant usage")).toBeTruthy();
  expect(await screen.findByText("Couldn't load model health")).toBeTruthy();
  expect(await screen.findByText("Couldn't load assistant skill activity")).toBeTruthy();
});
it('local memory discard restores the original server card without writing', async () => {
  const mock = stubFetch([
    { url: '/api/assistant', body: { serverCard: 'Original', memories: [], members: [] } },
  ]);
  renderWithSession(<AssistantMemoryPage />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Server card' }), {
    target: { value: 'Draft' },
  });
  const bar = screen.getByRole('region', { name: 'Unsaved changes' });
  fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Server card' }).value).toBe(
    'Original',
  );
  // The page also reads the digest settings; the point is that nothing is written.
  expect(mock.mock.calls.filter((c) => (c[1]?.method ?? 'GET') !== 'GET')).toHaveLength(0);
});
it('retention discard restores loaded days without writing', async () => {
  const mock = stubFetch([
    { url: '/api/assistant/conversation-retention', body: { days: 182 } },
    {
      url: '/api/assistant/conversations?sort=last-activity&order=desc&limit=50',
      body: { conversations: [] },
    },
    { url: '/api/assistant/runs?active=1&limit=50', body: { runs: [] } },
  ]);
  renderWithSession(<AssistantConversationsPage />);
  const select = await screen.findByLabelText('Delete conversations older than');
  await userEvent.click(select);
  await userEvent.click(await screen.findByRole('option', { name: '12 months' }));
  const bar = screen.getByRole('region', { name: 'Unsaved changes' });
  fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
  expect(screen.getByLabelText('Delete conversations older than').textContent).toContain(
    '6 months',
  );
  expect(mock.mock.calls.every((c) => ((c[1] as RequestInit)?.method ?? 'GET') === 'GET')).toBe(
    true,
  );
});

it('archive detail failure remains visible and failed read does not leave stale detail', async () => {
  const mock = stubFetch([
    { url: '/api/archive/status', body: { channels: [], index: { indexed: 0, rows: 0 } } },
    { url: '/api/archive/channels/c/messages?limit=25', body: { messages: [] } },
    { url: '/api/archive/messages/m', status: 500, body: { error: 'unavailable' } },
  ]);
  renderWithSession(
    <Router hook={memoryLocation({ path: '/archive?browse=c&message=m' }).hook}>
      <ArchivePage />
    </Router>,
  );
  expect(await screen.findByText("Couldn't load archived message detail")).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Archived message m' })).toBeNull();
  expect(
    mock.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('/messages/m')),
  ).toHaveLength(1);
});
it('empty usage, model and activity are named and refresh only their existing source', async () => {
  const mock = stubFetch([
    { url: '/api/assistant/traces?limit=50', body: { traces: [] } },
    { url: '/api/assistant/runs?active=1&limit=50', body: { runs: [] } },
    { url: '/api/assistant/usage?days=14', body: { days: [] } },
    { url: '/api/assistant/model-health?window=24h', body: { models: [] } },
    { url: '/api/assistant', body: { activity: [] } },
  ]);
  renderWithSession(<AssistantHistoryPage />);
  expect(await screen.findByText('No assistant usage recorded')).toBeTruthy();
  expect(await screen.findByText('No model calls in the last 24 hours.')).toBeTruthy();
  expect(await screen.findByText('No older assistant activity')).toBeTruthy();
  const before = mock.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh model health' }));
  await vi.waitFor(() => expect(mock.mock.calls).toHaveLength(before + 1));
  expect(mock.mock.calls.at(-1)?.[0]).toBe('/api/assistant/model-health?window=24h');
});
