// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../../test-support.js';
import { AssistantResourcesPage } from '../assistant-resources.js';

// These are structure/behaviour regressions, not JSDOM layout measurements.
// Actual viewport fit, button readability and focus visibility need native checks.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const resource = {
  id: 'handbook',
  guildId: '1540816150026518620',
  title: 'Club handbook',
  url: 'https://example.com/handbook',
  kind: 'document',
  enabled: true,
  reviewedAt: '2026-09-01T12:00:00.000Z',
};

function setup(resources = [resource], refreshStatus = 200) {
  const mock = stubFetch([
    { url: '/api/assistant', body: { resources } },
    { url: '/api/assistant/resources/freshness', body: { freshness: [] } },
    {
      method: 'POST',
      url: '/api/assistant/resources/refresh',
      status: refreshStatus,
      body:
        refreshStatus === 200
          ? { ok: true }
          : {
              error: 'refresh-refused',
              title: 'Refresh refused',
              message: 'The cache cannot be updated right now.',
            },
    },
  ]);
  renderWithSession(<AssistantResourcesPage />);
  return mock;
}

it.each(['loaded', 'empty'] as const)(
  'lets the %s header intro and action group wrap without shrinking action labels',
  async (state) => {
    setup(state === 'empty' ? [] : [resource]);
    const github = await screen.findByRole('button', { name: 'Add from GitHub' });
    const actions = github.parentElement!;
    const header = actions.parentElement!;
    const intro = header.querySelector('p')!;
    expect(header.classList.contains('flex-wrap')).toBe(true);
    expect(intro.classList.contains('flex-1')).toBe(true);
    expect(intro.classList.contains('basis-64')).toBe(true);
    expect(intro.classList.contains('min-w-0')).toBe(true);
    expect(actions.classList.contains('flex-wrap')).toBe(true);
    expect(actions.classList.contains('max-w-full')).toBe(true);
    expect(actions.classList.contains('min-w-0')).toBe(true);
    expect(actions.classList.contains('shrink-0')).toBe(false);
    expect(
      Array.from(actions.querySelectorAll('button')).map((button) => button.textContent),
    ).toEqual(
      state === 'empty'
        ? ['Add resource', 'Add from GitHub']
        : ['Update all', 'Add resource', 'Add from GitHub'],
    );
    for (const button of actions.querySelectorAll('button')) {
      expect(button.classList.contains('shrink-0')).toBe(true);
      expect(button.classList.contains('max-w-full')).toBe(true);
    }
    expect(intro.textContent).toContain('retrieved text stays labelled as untrusted evidence.');
  },
);

it('keeps both add entry points available without writing when opened', async () => {
  const mock = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Add resource' }));
  expect(screen.getByRole('dialog', { name: 'Add resource' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add from GitHub' }));
  expect(screen.getByRole('textbox', { name: 'GitHub URL' })).toBeTruthy();
  expect(
    mock.mock.calls.filter((call) =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(call[1]?.method ?? 'GET'),
    ),
  ).toHaveLength(0);
});

it('Update all sends exactly one existing POST with an empty body and CSRF header', async () => {
  const mock = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Update all' }));
  await screen.findByText('Update queued');
  const writes = mock.mock.calls.filter((call) => call[1]?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(writes[0]![0]).toBe('/api/assistant/resources/refresh');
  expect(bodyOf(writes[0]!)).toEqual({});
  expect(writes[0]![1]?.headers).toEqual(
    expect.objectContaining({ 'x-bananasaurs-csrf': 'csrf-test' }),
  );
});

it.each([400, 409, 500])(
  'Update all keeps the sources/actions and clears busy after HTTP %s refusal without reloading',
  async (status) => {
    const mock = setup([resource], status);
    const update = await screen.findByRole<HTMLButtonElement>('button', { name: 'Update all' });
    fireEvent.click(update);
    await screen.findByText('Refresh refused');
    await waitFor(() => expect(update.disabled).toBe(false));
    expect(screen.queryByText('Update queued')).toBeNull();
    expect(screen.getByText('Club handbook')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add resource' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add from GitHub' })).toBeTruthy();
    expect(mock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(mock.mock.calls.filter((call) => call[0] === '/api/assistant')).toHaveLength(1);
    expect(
      mock.mock.calls.filter((call) => call[0] === '/api/assistant/resources/freshness'),
    ).toHaveLength(1);
  },
);
