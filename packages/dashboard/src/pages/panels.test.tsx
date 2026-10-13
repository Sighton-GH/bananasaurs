// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { PanelsPage } from './panels.js';

const PANELS = [
  {
    panelId: 'p1',
    kind: 'roles',
    component: 'select',
    behaviour: 'toggle',
    status: 'posted',
    messageId: 'm',
    optionCount: 3,
  },
  {
    panelId: 'p2',
    kind: 'roles',
    component: 'button',
    behaviour: 'single_choice',
    status: 'draft',
    optionCount: 1,
  },
];
const DETAIL = {
  ...PANELS[0],
  channelId: 'c-1',
  maxRoles: 2,
  requiredRoleId: undefined,
  blockedRoleIds: [],
  adoptionPassState: 'passing',
  adoptionBlockedCount: 0,
  options: [{ optionId: 'o1', roleId: 'r1', emojiKey: undefined, label: 'Team A' }],
};
const ROLES = { url: '/api/guild/roles', body: { roles: [{ roleId: 'r1', name: 'Team A role' }] } };

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('PanelsPage (7c)', () => {
  it('is titled Role panels and no longer says Self-granted roles', async () => {
    stubFetch([{ url: '/api/panels', body: PANELS }, ROLES]);
    renderWithSession(<PanelsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Role panels' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('Self-granted');
    expect(screen.getByRole('table', { name: 'Role panels' })).toBeTruthy();
  });

  it('status is a badge with words: posted is ok, anything else is held', async () => {
    stubFetch([{ url: '/api/panels', body: PANELS }, ROLES]);
    renderWithSession(<PanelsPage />);
    expect((await screen.findByText('posted')).className).toContain('border-tone-ok');
    expect(screen.getByText('draft').className).toContain('border-tone-hold');
  });

  it('manage shows the detail as a description list with the status badge and role names', async () => {
    stubFetch([
      { url: '/api/panels', body: PANELS },
      { url: '/api/panels/p1', body: DETAIL },
      ROLES,
    ]);
    renderWithSession(<PanelsPage />);
    await screen.findByText('p1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage' })[0]!);
    const channel = await screen.findByText('c-1');
    expect(channel.closest('dl')).toBeTruthy();
    expect(channel.closest('dl')?.className).not.toContain('text-sm');
    expect(screen.getAllByText('posted')).toHaveLength(2);
    expect(await screen.findByText('Team A role')).toBeTruthy();
  });

  it('publish keeps its live-Discord scope and sends the same empty POST body', async () => {
    const mock = stubFetch([
      { url: '/api/panels', body: PANELS },
      { url: '/api/panels/p1', body: DETAIL },
      ROLES,
      {
        method: 'POST',
        url: '/api/panels/p1/publish',
        body: { action: 'edited', messageId: 'm', reactionsSeeded: 0, reactionsFailed: [] },
      },
    ]);
    renderWithSession(<PanelsPage />);
    await screen.findByText('p1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage' })[0]!);
    await screen.findByText('c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Discord' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Discord channel c-1');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Publish to Discord' }));
    });
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/panels/p1/publish')!;
    expect(bodyOf(post)).toEqual({});
  });

  it('an empty list offers the first build; failures are never an empty list', async () => {
    stubFetch([{ url: '/api/panels', body: [] }, ROLES]);
    renderWithSession(<PanelsPage />);
    expect(await screen.findByText('Nothing set up yet')).toBeTruthy();
    cleanup();
    stubFetch([{ url: '/api/panels', status: 500, body: { error: 'boom' } }, ROLES]);
    renderWithSession(<PanelsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Nothing set up yet')).toBeNull();
    cleanup();
    stubFetch([{ url: '/api/panels', status: 403, body: { error: 'forbidden' } }, ROLES]);
    renderWithSession(<PanelsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Nothing set up yet')).toBeNull();
  });
});
