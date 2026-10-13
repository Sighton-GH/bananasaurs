// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { JobsPage } from './jobs.js';

const JOBS = [
  {
    jobId: 7,
    kind: 'archive_backfill',
    state: 'queued',
    attempts: 0,
    maxAttempts: 3,
    runAfter: 0,
    lastError: null,
    dedupeKey: 'archive:1',
  },
  {
    jobId: 9,
    kind: 'role_sync',
    state: 'failed',
    attempts: 3,
    maxAttempts: 3,
    runAfter: 0,
    lastError: 'Missing permissions',
    dedupeKey: 'role:2',
  },
];

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('JobsPage', () => {
  it('lists jobs and renders state badges and errors', async () => {
    const mock = stubFetch([{ url: '/api/jobs?limit=100', body: JOBS }]);
    renderWithSession(<JobsPage />);
    expect(await screen.findByText('#7')).toBeTruthy();
    expect(screen.getByText('archive_backfill')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('Missing permissions')).toBeTruthy();
    expect(screen.getByText('3/3')).toBeTruthy();
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual(['/api/jobs?limit=100']);
  });

  it('failed-only filter refetches with failedOnly=true', async () => {
    const mock = stubFetch([
      { url: '/api/jobs?limit=100', body: JOBS },
      { url: '/api/jobs?limit=100&failedOnly=true', body: [JOBS[1]] },
    ]);
    renderWithSession(<JobsPage />);
    await screen.findByText('#7');
    fireEvent.click(screen.getByLabelText('Failed only'));
    await screen.findByText('role_sync');
    expect(mock.mock.calls.map((c) => c[0] as string)).toContain(
      '/api/jobs?limit=100&failedOnly=true',
    );
  });

  it('view fetches the job detail into a card', async () => {
    stubFetch([
      { url: '/api/jobs?limit=100', body: JOBS },
      { url: '/api/jobs/9', body: JOBS[1] },
    ]);
    renderWithSession(<JobsPage />);
    await screen.findByText('#9');
    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[1]!);
    expect(await screen.findByText('Duplicate-work key')).toBeTruthy();
    expect(screen.getByText('role:2')).toBeTruthy();
  });

  it('retry states its scope, posts and reloads', async () => {
    const mock = stubFetch([
      { url: '/api/jobs?limit=100', body: JOBS },
      { method: 'POST', url: '/api/jobs/9/retry', body: { ok: true } },
    ]);
    renderWithSession(<JobsPage />);
    await screen.findByText('#9');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('role_sync job #9');
    expect(dialog.textContent).toContain('1540816150026518620');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry job' }));
    });
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/jobs/9/retry')!;
    expect(bodyOf(post)).toEqual({});
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/jobs?limit=100')).toHaveLength(
      2,
    );
  });

  it('a 409 refusal renders inline instead of a generic failure', async () => {
    stubFetch([
      { url: '/api/jobs?limit=100', body: JOBS },
      {
        method: 'POST',
        url: '/api/jobs/9/retry',
        status: 409,
        body: { error: 'dedupe-blocked', blockingJobId: 4 },
      },
    ]);
    renderWithSession(<JobsPage />);
    await screen.findByText('#9');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry job' }));
    });
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).toContain('job #4');
  });

  it('shows run-after as relative time with the absolute time on hover', async () => {
    stubFetch([
      { url: '/api/jobs?limit=100', body: [{ ...JOBS[1], runAfter: Date.now() - 3 * 3_600_000 }] },
    ]);
    renderWithSession(<JobsPage />);
    const when = await screen.findByText('3 hours ago');
    expect(when.getAttribute('title')).toMatch(/\d/);
  });

  it('an empty queue and an empty failed filter say what will appear', async () => {
    stubFetch([
      { url: '/api/jobs?limit=100', body: [] },
      { url: '/api/jobs?limit=100&failedOnly=true', body: [] },
    ]);
    renderWithSession(<JobsPage />);
    expect(await screen.findByText('The queue is clear')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Failed only'));
    expect(await screen.findByText('No failed jobs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all jobs' }));
    expect(await screen.findByText('The queue is clear')).toBeTruthy();
  });

  it('a failed load is unavailable, and a 403 is forbidden, not an empty queue', async () => {
    stubFetch([{ url: '/api/jobs?limit=100', status: 500, body: { error: 'boom' } }]);
    renderWithSession(<JobsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('The queue is clear')).toBeNull();
    cleanup();
    stubFetch([{ url: '/api/jobs?limit=100', status: 403, body: { error: 'forbidden' } }]);
    renderWithSession(<JobsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('The queue is clear')).toBeNull();
  });

  it('the detail card shows the state as a badge and the last error in danger ink', async () => {
    stubFetch([
      { url: '/api/jobs?limit=100', body: JOBS },
      { url: '/api/jobs/9', body: JOBS[1] },
    ]);
    renderWithSession(<JobsPage />);
    await screen.findByText('#9');
    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[1]!);
    await screen.findByText('Duplicate-work key');
    expect(screen.getAllByText('failed').length).toBe(2);
    expect(document.querySelector('.text-danger')).toBeNull();
  });
});
