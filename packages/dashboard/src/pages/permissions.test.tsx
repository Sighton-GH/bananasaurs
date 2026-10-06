// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { PermissionsPage } from './permissions.js';

/**
 * The central Permissions section (Bryan's lane). The properties under
 * test: every row shows its EFFECTIVE state (own row, via a category,
 * excluded, paused), the writers hit the same routes the specialised pages used
 * (so state can never fork), pausing archiving keeps history and never deletes,
 * exclusions degrade honestly for an account without the logging capability,
 * and the specialised surfaces are linked, not duplicated.
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

const stubAll = (opts?: {
  exclusions?: string[];
  exclusionsFail?: boolean;
  readEntries?: readonly {
    channelId: string;
    scopeKind: 'channel' | 'category';
    addedAt: number;
  }[];
  archive?: typeof ARCHIVE;
}) =>
  stubFetch([
    { url: '/api/guild/channels', body: CHANNELS },
    { url: '/api/archive/status', body: opts?.archive ?? ARCHIVE },
    { url: '/api/send-allowlist', body: ALLOWLIST },
    { url: '/api/read-scope', body: { entries: opts?.readEntries ?? [] } },
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
    // Categories start collapsed; opening Community reveals inherited states.
    fireEvent.click(await screen.findByRole('button', { name: /Community/ }));
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
    fireEvent.click(await screen.findByRole('button', { name: /Community/ }));
    expect(await screen.findByRole('button', { name: 'Restore access' })).toBeTruthy();
    // Legend term + column header + two No-access buttons + the excluded
    // channel's four badges (Read, Write, Archive, No access).
    expect(screen.getAllByText('No access').length).toBe(8);
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

  it('stopping the category pauses it (history kept) instead of deleting', async () => {
    const mock = stubAll();
    renderWithSession(<PermissionsPage />);
    const stop = await screen.findAllByRole('button', { name: 'Stop archiving' });
    fireEvent.click(stop[0]!);
    const pause = mock.mock.calls.find(
      (c) =>
        (c[1]?.method ?? 'GET') === 'POST' &&
        c[0] === '/api/archive/categories/999999999999999999/pause',
    );
    expect(pause).toBeTruthy();
    expect(mock.mock.calls.some((c) => (c[1]?.method ?? 'GET') === 'DELETE')).toBe(false);
  });

  it('exclusion toggle posts and deletes the exclusion', async () => {
    const mock = stubAll();
    renderWithSession(<PermissionsPage />);
    const excludeButtons = await screen.findAllByRole('button', { name: 'No access' });
    fireEvent.click(excludeButtons[0]!);
    const post = mock.mock.calls.find(
      (c) => (c[1]?.method ?? 'GET') === 'POST' && c[0] === '/api/log-exclusions',
    );
    expect(bodyOf(post ?? [])).toEqual({ channelId: '444444444444444444' });
  });

  it('hides the exclusion controls honestly when the account lacks the logging capability', async () => {
    stubAll({ exclusionsFail: true });
    renderWithSession(<PermissionsPage />);
    expect(await screen.findByText(/cannot see or change channel access overrides/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'No access' })).toBeNull();
  });

  it('shows the Read column with via-category state for a category-granted channel', async () => {
    stubAll({
      readEntries: [{ channelId: '999999999999999999', scopeKind: 'category', addedAt: 1 }],
    });
    renderWithSession(<PermissionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Community/ }));
    // Archive, Read and Write are each inherited from the Community category.
    expect((await screen.findAllByText('On, via Community')).length).toBe(3);
  });

  it('"Allow read" posts the channel to /api/read-scope', async () => {
    const mock = stubAll();
    renderWithSession(<PermissionsPage />);
    // Visible rows are Community, mod-log, announcements — each offers
    // Allow read; mod-log's is second.
    const allowButtons = await screen.findAllByRole('button', { name: 'Allow read' });
    fireEvent.click(allowButtons[1]!);
    const post = mock.mock.calls.find(
      (c) => (c[1]?.method ?? 'GET') === 'POST' && c[0] === '/api/read-scope',
    );
    expect(bodyOf(post ?? [])).toEqual({ channelId: '444444444444444444' });
  });

  it('"Stop archiving" pauses without opening a dialog', async () => {
    const mock = stubAll();
    renderWithSession(<PermissionsPage />);
    const stop = await screen.findAllByRole('button', { name: 'Stop archiving' });
    fireEvent.click(stop[0]!);
    const pause = mock.mock.calls.find(
      (c) =>
        (c[1]?.method ?? 'GET') === 'POST' &&
        c[0] === '/api/archive/categories/999999999999999999/pause',
    );
    expect(pause).toBeTruthy();
    // No destroy confirmation ever opens (the old dialog title is gone).
    expect(screen.queryByText('Stop archiving the Community category?')).toBeNull();
    expect(
      mock.mock.calls.some(
        (c) => (c[1]?.method ?? 'GET') === 'DELETE' && (c[0] as string).includes('/api/archive'),
      ),
    ).toBe(false);
  });

  it('a paused row shows "Off (history kept)" with "Resume archiving"', async () => {
    const mock = stubAll({
      archive: {
        channels: [
          archiveRow({
            channelId: '444444444444444444',
            scopeKind: 'channel',
            collecting: false,
            messageCount: 5,
          }),
        ],
        index: { state: 'ok' },
      },
    });
    renderWithSession(<PermissionsPage />);
    expect(await screen.findByText('Off (history kept)')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume archiving' }));
    const resume = mock.mock.calls.find(
      (c) =>
        (c[1]?.method ?? 'GET') === 'POST' &&
        c[0] === '/api/archive/channels/444444444444444444/resume',
    );
    expect(resume).toBeTruthy();
  });

  it('a channel paused under a collecting category still shows "Off (history kept)" with resume', async () => {
    const mock = stubAll({
      archive: {
        channels: [
          archiveRow({
            channelId: '999999999999999999',
            scopeKind: 'category',
            collecting: true,
            messageCount: 40,
          }),
          archiveRow({
            channelId: '333333333333333333',
            scopeKind: 'channel',
            collecting: false,
            messageCount: 12,
          }),
        ],
        index: { state: 'ok' },
      },
    });
    renderWithSession(<PermissionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Community/ }));
    // The own paused row wins over the collecting category: pause is a veto,
    // so the row reads Off with its own Resume button (I1).
    expect(await screen.findByText('Off (history kept)')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume archiving' }));
    const resume = mock.mock.calls.find(
      (c) =>
        (c[1]?.method ?? 'GET') === 'POST' &&
        c[0] === '/api/archive/channels/333333333333333333/resume',
    );
    expect(resume).toBeTruthy();
  });

  it('never issues DELETE against /api/archive', async () => {
    const mock = stubAll();
    renderWithSession(<PermissionsPage />);
    const stop = await screen.findAllByRole('button', { name: 'Stop archiving' });
    fireEvent.click(stop[0]!);
    expect(
      mock.mock.calls.some(
        (c) => (c[1]?.method ?? 'GET') === 'DELETE' && (c[0] as string).includes('/api/archive'),
      ),
    ).toBe(false);
  });

  it('a channel under a paused category shows inherited pause with no per-channel button', async () => {
    const mock = stubAll({
      archive: {
        channels: [
          archiveRow({
            channelId: '999999999999999999',
            scopeKind: 'category',
            collecting: false,
            messageCount: 40,
          }),
          archiveRow({
            channelId: '333333333333333333',
            scopeKind: 'derived',
            derivedFrom: '999999999999999999',
            messageCount: 12,
          }),
        ],
        index: { state: 'ok' },
      },
    });
    renderWithSession(<PermissionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Community/ }));
    // The derived channel inherits the category pause, with the category named.
    expect(await screen.findByText('Off (history kept), via Community')).toBeTruthy();
    // Only the paused category row offers Resume; the derived channel offers
    // no per-channel archive button at all.
    expect(screen.getAllByRole('button', { name: 'Resume archiving' }).length).toBe(1);
    expect(
      mock.mock.calls.some(
        (c) =>
          (c[1]?.method ?? 'GET') === 'POST' &&
          c[0] === '/api/archive/channels/333333333333333333/resume',
      ),
    ).toBe(false);
  });

  it('explains each switch in plain words', async () => {
    stubAll();
    renderWithSession(<PermissionsPage />);
    expect(
      await screen.findByText(
        'May look up recent messages live from Discord. Off: the bot only sees the message that tagged it, the one it replies to, and the archive.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'May post here, including answering when tagged. Off: the bot stays silent here.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Records new messages into a searchable copy. Turning it off stops recording; nothing is deleted. Delete archived messages on the Archive page.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Overrides everything above and hides archived copies. Moderation and automod still work.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'To switch one channel off inside a category that is on, turn the category off and turn on the channels you want, or mark the channel No access.',
      ),
    ).toBeTruthy();
  });
});
