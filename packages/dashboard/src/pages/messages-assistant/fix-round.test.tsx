// @vitest-environment jsdom
import './test-support.js';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../../test-support.js';
import { AssistantMemoryPage } from '../assistant-memory.js';
import { SearchPage } from '../search.js';
import { AssistantHistoryPage } from '../assistant-history.js';
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
it('empty members is not a filter miss', async () => {
  stubFetch([{ url: '/api/assistant', body: { serverCard: '', memories: [], members: [] } }]);
  renderWithSession(<AssistantMemoryPage />);
  expect(await screen.findByText('No members loaded')).toBeTruthy();
  expect(screen.queryByText('No loaded members match')).toBeNull();
});
it('filtered memory miss has one clear action and no writes', async () => {
  const mock = stubFetch([
    {
      url: '/api/assistant',
      body: {
        serverCard: '',
        members: [],
        memories: Array.from({ length: 21 }, (_, i) => ({
          id: String(i),
          section: 'Goals',
          content: 'Reviewed fact',
        })),
      },
    },
  ]);
  renderWithSession(<AssistantMemoryPage />);
  fireEvent.change(await screen.findByLabelText('Filter loaded memory'), {
    target: { value: 'notfound' },
  });
  expect(screen.getAllByRole('button', { name: 'Clear filters' })).toHaveLength(1);
  // The page also reads the digest settings; the point is that nothing is written.
  expect(mock.mock.calls.filter((c) => (c[1]?.method ?? 'GET') !== 'GET')).toHaveLength(0);
});
it('search failure has one visible summary, mapped q focus and clears without read', async () => {
  const mock = stubFetch([
    { url: '/api/guild/channels', body: { channels: [] } },
    {
      url: '/api/archive/search?q=test&limit=50',
      status: 400,
      body: { error: 'invalid', fields: [{ path: 'q', problem: 'Choose a phrase' }] },
    },
  ]);
  renderWithSession(<SearchPage />);
  fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByRole('link', { name: 'Choose a phrase' });
  const repeated = screen
    .getAllByText('Choose a phrase')
    .filter((el) => !el.classList.contains('sr-only'));
  expect(repeated).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Choose a phrase' }).getAttribute('href')).toBe(
    '#field-q',
  );
  const before = mock.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.queryByRole('link', { name: 'Choose a phrase' })).toBeNull();
  expect(mock.mock.calls).toHaveLength(before);
});
it('two memory drafts open one route leave dialog', async () => {
  stubFetch([
    { url: '/api/assistant', body: { serverCard: 'original', members: [], memories: [] } },
  ]);
  renderWithSession(<AssistantMemoryPage />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Server card' }), {
    target: { value: 'draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
  fireEvent.change(screen.getByLabelText('Memory'), { target: { value: 'new fact' } });
  const anchor = document.createElement('a');
  anchor.href = '/assistant';
  anchor.textContent = 'Leave page';
  document.body.append(anchor);
  fireEvent.click(anchor);
  expect(await screen.findAllByRole('dialog')).toHaveLength(1);
  anchor.remove();
});
it('unfiltered history empty has only form clear, no empty clear action', async () => {
  stubFetch([
    { url: '/api/assistant/traces?limit=50', body: { traces: [] } },
    { url: '/api/assistant/runs?active=1&limit=50', body: { runs: [] } },
    { url: '/api/assistant/usage?days=14', body: { days: [] } },
    { url: '/api/assistant/model-health?window=24h', body: { models: [] } },
    { url: '/api/assistant', body: { activity: [] } },
  ]);
  renderWithSession(<AssistantHistoryPage />);
  await screen.findByText('No assistant runs yet');
  expect(screen.getAllByRole('button', { name: 'Clear filters' })).toHaveLength(1);
});
