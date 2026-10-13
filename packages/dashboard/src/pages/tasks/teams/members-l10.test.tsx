// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import { MembersSection } from './members.js';
import type { DirectoryMember, StoredMember } from './types.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

function renderMembers(members: StoredMember[], directory: DirectoryMember[]) {
  stubFetch([
    { url: '/api/tasks/teams/team-1/members', body: { members } },
    { url: '/api/guild/members?limit=100', body: { members: directory } },
  ]);
  renderWithSession(
    <Router>
      <MembersSection teamId="team-1" teamName="Tech" />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
}

describe('MembersSection member cell (L10)', () => {
  it('resolves a missing stored name from the live directory', async () => {
    renderMembers(
      [{ discordUserId: '111', kind: 'member', displayName: null }],
      [{ memberId: '111', username: 'ada', displayName: 'Ada', roleIds: [] }],
    );
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(await screen.findByText('@ada · 111')).toBeTruthy();
  });

  it('shows the bare id with an honest note when the directory has no entry', async () => {
    renderMembers([{ discordUserId: '111', kind: 'member', displayName: null }], []);
    expect(await screen.findByText('111')).toBeTruthy();
    expect(await screen.findByText('(not in the live member directory)')).toBeTruthy();
  });

  it('keeps a stored display name as-is without consulting the directory', async () => {
    renderMembers(
      [{ discordUserId: '333', kind: 'member', displayName: 'Grace' }],
      [{ memberId: '333', username: 'grace2', displayName: 'Directory Grace', roleIds: [] }],
    );
    expect(await screen.findByText('Grace')).toBeTruthy();
    expect(screen.queryByText('Directory Grace')).toBeNull();
    expect(screen.queryByText(/not in the live member directory/)).toBeNull();
  });
});
