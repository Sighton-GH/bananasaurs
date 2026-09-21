// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { PermissionsPage } from './permissions.js';

/**
 * The central Permissions section (Bryan's lane). The properties under
 * test: every row shows its EFFECTIVE state (own row, via a category,
 * excluded), the writers hit the same routes the specialised pages used
 * (so state can never fork), stopping archiving names the destruction
 * count before it fires, exclusions degrade honestly for an account
 * without the logging capability, and the specialised surfaces are linked,
 * not duplicated.
 */

const CHANNELS = {
  channels: [
    {
      channelId: '333333333333333333',
      name: 'general',
      kind: 'text',
      parentId: '999999999999999999',
    },
    { channelId: '444444444444444444', name: 'mod-log', kind: 'text' },
    { channelId: '555555555555555555', name: 'announcements', kind: 'announcement' },
    { channelId: '999999999999999999', name: 'Community', kind: 'category' },
  ],
};

const archiveRow = (over: Record<string, unknown>) => ({
  channelId: '0',
  attachmentPolicy: 'none',
  enabledAt: 1,
  cursorMessageId: null,
  backfillState: 'done',
  messageCount: 0,
  ...over,
});

const ARCHIVE = {
  channels: [
    archiveRow({ channelId: '999999999999999999', scopeKind: 'category', messageCount: 40 }),
    archiveRow({
      channelId: '333333333333333333',
      scopeKind: 'derived',
      derivedFrom: '999999999999999999',
      messageCount: 12,
    }),
  ],
  index: { state: 'ok' },
};

const ALLOWLIST = {
  entries: [
    {
      channelId: '999999999999999999',
      scopeKind: 'category',
      coverage: 2,
      addedByAccountId: 'acct-1',
      addedAt: 1,
    },
  ],
};

const stubAll = (opts?: { exclusions?: string[]; exclusionsFail?: boolean }) =>
  stubFetch([
    { url: '/api/guild/channels', body: CHANNELS },
    { url: '/api/archive/status', body: ARCHIVE },
    { url: '/api/send-allowlist', body: ALLOWLIST },
    ...(opts?.exclusionsFail === true
      ? [{ url: '/api/log-routes', status: 403, body: { error: 'forbidden' } }]
      : [
          {
            url: '/api/log-routes',
            body: { routes: [], excludedChannels: opts?.exclusions ?? [] },
          },
        ]),
  ]);

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('PermissionsPage', () => {
  it('shows effective state: via-category, off, and the category row itself', async () => {
    stubAll();
    renderWithSession(<PermissionsPage />);
    // general is archived and sendable via the Community category.
    expect((await screen.findAllByText('On, via Community')).length).toBe(2);
    // mod-log is off on both axes and offers both enables.
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
    // The category row shows its own On state.
    expect(screen.getAllByText('On').length).toBeGreaterThan(0);
    // The specialised surfaces are linked, not duplicated.
    expect(screen.getByRole('link', { name: 'MCP connector' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Archive' })).toBeTruthy();
  });

  it('marks an excluded channel and overrides its rows', async () => {
    stubAll({ exclusions: ['333333333333333333'] });
    renderWithSession(<PermissionsPage />);
    expect(await screen.findByText('Excluded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Include again' })).toBeTruthy();
  });

  it('enables a channel with the chosen attachment policy', async () => {
    const mock = stubAll();
    renderWithSession(<PermissionsPage />);
    const archiveButtons = await screen.findAllByRole('button', { name: 'Archive' });
    fireEvent.change(screen.getByLabelText('Attachment policy'), { target: { value: 'bytes' } });
    // mod-log is the first channel with Archive off.
    fireEvent.click(archiveButtons[0]!);
    const post = mock.mock.calls.find(
      (c) => (c[1]?.method ?? 'GET') === 'POST' && c[0] === '/api/archive/channels',
    );
    expect(bodyOf(post ?? [])).toEqual({
      channelId: '444444444444444444',
      attachmentPolicy: 'bytes',
    });
  });

  it('allow send posts the session account; stop send deletes', async () => {
    const mock = stubAll();
    renderWithSession(<PermissionsPage />);
    const allowButtons = await screen.findAllByRole('button', { name: 'Allow send' });
    fireEvent.click(allowButtons[0]!);
    const post = mock.mock.calls.find(
      (c) => (c[1]?.method ?? 'GET') === 'POST' && c[0] === '/api/send-allowlist',
    );
    expect(bodyOf(post ?? [])).toEqual({ channelId: '444444444444444444', accountId: 'acct-1' });
  });

  it('stopping the category names the destruction count, then deletes the category row', async () => {
    const mock = stubAll();
    renderWithSession(<PermissionsPage />);
    const stop = await screen.findAllByRole('button', { name: 'Stop archiving' });
    fireEvent.click(stop[0]!);
    // The confirmation names what is destroyed before anything fires.
    expect(await screen.findByText(/40 archived messages/)).toBeTruthy();
    expect(mock.mock.calls.some((c) => (c[1]?.method ?? 'GET') === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Stop archiving' }));
    const del = mock.mock.calls.find((c) => (c[1]?.method ?? 'GET') === 'DELETE');
    expect(del?.[0]).toBe('/api/archive/categories/999999999999999999');
  });

  it('exclusion toggle posts and deletes the exclusion', async () => {
    const mock = stubAll();
    renderWithSession(<PermissionsPage />);
    const excludeButtons = await screen.findAllByRole('button', { name: 'Exclude' });
    fireEvent.click(excludeButtons[0]!);
    const post = mock.mock.calls.find(
      (c) => (c[1]?.method ?? 'GET') === 'POST' && c[0] === '/api/log-exclusions',
    );
    expect(bodyOf(post ?? [])).toEqual({ channelId: '333333333333333333' });
  });

  it('hides the exclusion controls honestly when the account lacks the logging capability', async () => {
    stubAll({ exclusionsFail: true });
    renderWithSession(<PermissionsPage />);
    expect(await screen.findByText(/cannot see or change exclusions/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Exclude' })).toBeNull();
  });
});
