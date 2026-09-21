// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { MembersPage } from './members.js';

const PAGE_ONE = {
  members: [
    {
      memberId: '100000000000000001',
      username: 'bryan',
      displayName: 'Bryan',
      roleIds: ['666666666666666666', '777777777777777777'],
      joinedAt: 1_600_000_000_000,
    },
    {
      memberId: '100000000000000003',
      username: 'kai',
      displayName: 'Kai',
      roleIds: [],
      joinedAt: null,
    },
  ],
  nextAfter: '100000000000000003',
};

const PAGE_TWO = {
  members: [
    {
      memberId: '100000000000000009',
      username: 'sasha',
      displayName: 'Sasha',
      roleIds: ['777777777777777777'],
      joinedAt: 1_650_000_000_000,
    },
  ],
  nextAfter: undefined,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MembersPage', () => {
  it('lists members with username, id, role count and a case-history link', async () => {
    stubFetch([{ url: '/api/guild/members', body: PAGE_ONE }]);
    renderWithSession(<MembersPage />);
    const bryan = await screen.findByText('Bryan');
    const row = bryan.closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText('@bryan')).toBeTruthy();
    expect(cells.getByText('100000000000000001')).toBeTruthy();
    expect(cells.getByText('2')).toBeTruthy();
    const link = cells.getByRole('link', { name: /case history/i });
    expect(link.getAttribute('href')).toBe('/members/100000000000000001');
    // A member who has not finished joining shows "unknown", not 1970.
    expect(screen.getByText('Kai').closest('tr')?.textContent).toContain('unknown');
  });

  it('pages forward with the cursor and back along the trail', async () => {
    const fetchMock = stubFetch([
      { url: '/api/guild/members', body: PAGE_ONE },
      { url: '/api/guild/members?after=100000000000000003', body: PAGE_TWO },
    ]);
    renderWithSession(<MembersPage />);
    const next = await screen.findByRole('button', { name: /next/i });
    expect(fetchMock).toHaveBeenCalledWith('/api/guild/members', expect.anything());
    next.click();
    await screen.findByText('Sasha');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/guild/members?after=100000000000000003',
      expect.anything(),
    );
    // Last page: Next is disabled, not gone — the pagination row stays put.
    const lastNext = screen.getByRole('button', { name: /next/i });
    expect(lastNext.hasAttribute('disabled')).toBe(true);
    screen.getByRole('button', { name: /previous/i }).click();
    await screen.findByText('Bryan');
  });
});
