// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { BackupsPage } from './backups.js';

const BACKUPS = {
  backups: [
    {
      fileName: 'bananasaurs-2026-09-19.db',
      sizeBytes: 2 * 1024 * 1024,
      createdAtMs: 0,
      hasChecksum: true,
    },
    { fileName: 'bananasaurs-2026-09-18.db', sizeBytes: 512, createdAtMs: 0, hasChecksum: false },
  ],
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('BackupsPage', () => {
  it('lists every backup with size, date and checksum state', async () => {
    stubFetch([{ url: '/api/backups', body: BACKUPS }]);
    renderWithSession(<BackupsPage />);
    expect(await screen.findByText('bananasaurs-2026-09-19.db')).toBeTruthy();
    expect(screen.getByText('2.0 MB')).toBeTruthy();
    expect(screen.getByText('512 B')).toBeTruthy();
    expect(screen.getByText('recorded')).toBeTruthy();
    expect(screen.getByText('missing')).toBeTruthy();
  });

  it('says restore lives on the host, not here', async () => {
    stubFetch([{ url: '/api/backups', body: BACKUPS }]);
    renderWithSession(<BackupsPage />);
    expect(await screen.findByText(/Restore is deliberately not here/)).toBeTruthy();
  });

  it('back up now states its scope, posts and reloads the list', async () => {
    const mock = stubFetch([
      { url: '/api/backups', body: BACKUPS },
      {
        method: 'POST',
        url: '/api/backup-now',
        body: {
          ok: true,
          fileName: 'bananasaurs-2026-09-20.db',
          sizeBytes: 1024,
          sha256: 'x',
          prunedCount: 1,
        },
      },
    ]);
    renderWithSession(<BackupsPage />);
    await screen.findByText('bananasaurs-2026-09-19.db');
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('retention');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Back up now' }));
    });
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/backup-now')!;
    expect(bodyOf(post)).toEqual({});
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/backups')).toHaveLength(2);
  });

  it('shows created as relative time with the absolute time on hover, and the checksum as a badge', async () => {
    stubFetch([
      {
        url: '/api/backups',
        body: {
          backups: [
            {
              fileName: 'a.db',
              sizeBytes: 1,
              createdAtMs: Date.now() - 2 * 86_400_000,
              hasChecksum: false,
            },
          ],
        },
      },
    ]);
    renderWithSession(<BackupsPage />);
    const when = await screen.findByText('2 days ago');
    expect(when.getAttribute('title')).toMatch(/\d/);
    expect(screen.getByText('missing').className).toContain('border-tone-hold');
  });

  it('an empty list offers the first backup; a 500 is unavailable and a 403 forbidden', async () => {
    stubFetch([{ url: '/api/backups', body: { backups: [] } }]);
    renderWithSession(<BackupsPage />);
    expect(await screen.findByText('No backups on disk')).toBeTruthy();
    cleanup();
    stubFetch([{ url: '/api/backups', status: 500, body: { error: 'boom' } }]);
    renderWithSession(<BackupsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No backups on disk')).toBeNull();
    cleanup();
    stubFetch([{ url: '/api/backups', status: 403, body: { error: 'forbidden' } }]);
    renderWithSession(<BackupsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No backups on disk')).toBeNull();
  });
});
