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
});
