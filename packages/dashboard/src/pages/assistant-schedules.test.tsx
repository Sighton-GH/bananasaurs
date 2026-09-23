// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AssistantSchedulesPage } from './assistant-schedules.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const FULL = {
  behaviours: [],
  resources: [],
  reminders: [
    {
      id: 'rem-1',
      text: 'Bring the robot battery',
      dueAt: 1790000000000,
      destinationId: 'chan-general',
      status: 'failed',
    },
    {
      id: 'rem-2',
      text: 'Submit the registration form',
      dueAt: 1790001000000,
      destinationId: '900000000000000099',
      status: 'scheduled',
    },
  ],
  skills: [],
  activity: [],
  roles: [],
  members: [],
  channels: [{ id: 'chan-general', name: 'general' }],
  skillGrants: [],
  tickets: [],
  decisions: [],
};

function renderPage(body: unknown = FULL) {
  const mock = stubFetch([
    { url: '/api/assistant', body },
    { method: 'POST', url: '/api/assistant/reminders/rem-2/cancel', body: { ok: true } },
    { method: 'PUT', url: '/api/assistant/reminders/rem-2/cancel', body: { ok: true } },
  ]);
  renderWithSession(<AssistantSchedulesPage />);
  return mock;
}

describe('AssistantSchedulesPage', () => {
  it('renders reminders with destination, run time, status and a failure summary', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Schedules' })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Assistant reminders' });
    expect(within(table).getByText('Bring the robot battery')).toBeTruthy();
    expect(within(table).getByText('#general')).toBeTruthy();
    // A destination the directory does not know stays a raw id, never a guess.
    expect(within(table).getByText('900000000000000099')).toBeTruthy();
    expect(within(table).getByText('failed')).toBeTruthy();
    expect(within(table).getByText('scheduled')).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });

  it('cancels a scheduled reminder through the cancel endpoint', async () => {
    const mock = renderPage();
    const table = await screen.findByRole('table', { name: 'Assistant reminders' });
    fireEvent.click(within(table).getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() =>
      expect(
        mock.mock.calls.some((c) => (c[0] as string).includes('/reminders/rem-2/cancel')),
      ).toBe(true),
    );
  });

  it('offers no cancel for a reminder that is not scheduled', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Assistant reminders' });
    expect(within(table).getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
  });

  it('explains the empty state without offering to create', async () => {
    renderPage({ ...FULL, reminders: [] });
    expect(await screen.findByText(/No reminders scheduled/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New reminder/ })).toBeNull();
  });

  it('renders the error state when the load fails', async () => {
    stubFetch([]);
    renderWithSession(<AssistantSchedulesPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Could not load assistant schedules/)).toBeTruthy();
  });
});
