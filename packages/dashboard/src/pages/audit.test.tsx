// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AuditPage } from './audit.js';

const NOW = Date.now();
const ROW = {
  auditId: 1,
  at: NOW - 2 * 3_600_000,
  actorType: 'owner',
  actorId: 'acct-1',
  actorUnixUserClaimed: null,
  via: 'http',
  action: 'config.update',
  subjectType: 'config',
  subjectId: null,
  dryRun: false,
};

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuditPage (unit 7c)', () => {
  it('shows when as relative time with the absolute time on hover', async () => {
    stubFetch([{ url: '/api/audit?limit=50', body: [ROW] }]);
    renderWithSession(<AuditPage />);
    const when = await screen.findByText('2 hours ago');
    expect(when.getAttribute('title')).toMatch(/\d/);
  });

  it('a filter that matches nothing says so and Clear filters restores the full request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const mock = stubFetch([
      { url: '/api/audit?limit=50', body: [ROW] },
      { url: `/api/audit?limit=50&sinceMs=${String(NOW - 1_800_000)}`, body: [] },
    ]);
    renderWithSession(<AuditPage />);
    await screen.findByText('config.update');
    fireEvent.change(screen.getByLabelText(/Since/), { target: { value: '30m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('No audit rows match these filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('config.update')).toBeTruthy();
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/audit?limit=50')).toHaveLength(
      2,
    );
    expect(screen.getByLabelText<HTMLInputElement>(/Since/).value).toBe('');
  });

  it('a 500 is unavailable and a 403 is forbidden, never an empty log', async () => {
    stubFetch([{ url: '/api/audit?limit=50', status: 500, body: { error: 'boom' } }]);
    renderWithSession(<AuditPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No audit activity yet')).toBeNull();
    cleanup();
    stubFetch([{ url: '/api/audit?limit=50', status: 403, body: { error: 'forbidden' } }]);
    renderWithSession(<AuditPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No audit activity yet')).toBeNull();
  });

  it('an invalid duration keeps the typed input and names the fix', async () => {
    stubFetch([{ url: '/api/audit?limit=50', body: [ROW] }]);
    renderWithSession(<AuditPage />);
    await screen.findByText('config.update');
    fireEvent.change(screen.getByLabelText(/Since/), { target: { value: 'soon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(/Use a duration like 30m/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>(/Since/).value).toBe('soon');
  });
});
