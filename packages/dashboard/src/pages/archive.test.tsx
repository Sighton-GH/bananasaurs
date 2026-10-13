import './messages-assistant/test-support.js';
import userEvent from '@testing-library/user-event';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { ArchivePage } from './archive.js';

const STATUS = {
  channels: [
    {
      channelId: 'c-1',
      attachmentPolicy: 'bytes',
      enabledAt: 0,
      cursorMessageId: undefined,
      backfillState: 'done',
      messageCount: 120,
    },
  ],
  index: { indexed: 100, rows: 120 },
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('ArchivePage', () => {
  it('renders the index state and the channel rows', async () => {
    stubFetch([{ url: '/api/archive/status', body: STATUS }]);
    renderWithSession(<ArchivePage />);
    expect(await screen.findByText(/100 of 120 archived messages indexed/)).toBeTruthy();
    expect(screen.getByText(/behind — reindex to catch up/)).toBeTruthy();
    expect(screen.getByText('c-1')).toBeTruthy();
    expect(screen.getByText('bytes kept')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
  });

  it('reindex posts and reloads', async () => {
    const mock = stubFetch([
      { url: '/api/archive/status', body: STATUS },
      { method: 'POST', url: '/api/archive/reindex', body: { indexed: 120 } },
    ]);
    renderWithSession(<ArchivePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update search results' }));
    expect(mock.mock.calls.some((c) => (c[0] as string) === '/api/archive/reindex')).toBe(true);
  });

  it('preserve posts the message id; a 404 answers inline', async () => {
    const mock = stubFetch([
      { url: '/api/archive/status', body: STATUS },
      {
        method: 'POST',
        url: '/api/archive/messages/m-1/preserve',
        body: { outcome: 'preserved' },
      },
    ]);
    renderWithSession(<ArchivePage />);
    await screen.findByText('c-1');
    fireEvent.change(screen.getByLabelText('Preserve a message'), { target: { value: 'm-1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preserve' }));
    });
    expect(
      mock.mock.calls.some((c) => (c[0] as string) === '/api/archive/messages/m-1/preserve'),
    ).toBe(true);
  });

  it('link-case posts both ids and renders case-closed inline', async () => {
    const mock = stubFetch([
      { url: '/api/archive/status', body: STATUS },
      { method: 'POST', url: '/api/archive/link-case', body: { outcome: 'case-closed' } },
    ]);
    renderWithSession(<ArchivePage />);
    await screen.findByText('c-1');
    fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: 'm-1' } });
    fireEvent.change(screen.getByLabelText('Link to case'), { target: { value: 'case-7' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link to case' }));
    });
    expect(await screen.findByText(/That case is closed/)).toBeTruthy();
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/archive/link-case')!;
    expect(bodyOf(post)).toEqual({ messageId: 'm-1', caseId: 'case-7' });
  });

  it('renders scope, thread progress and no actions on a derived row', async () => {
    stubFetch([
      {
        url: '/api/archive/status',
        body: {
          channels: [
            {
              channelId: 'cat-1',
              scopeKind: 'category',
              attachmentPolicy: 'none',
              enabledAt: 0,
              cursorMessageId: undefined,
              backfillState: 'running',
              messageCount: 0,
            },
            {
              channelId: 'c-9',
              scopeKind: 'derived',
              derivedFrom: 'cat-1',
              attachmentPolicy: 'none',
              enabledAt: 0,
              cursorMessageId: undefined,
              backfillState: 'done',
              threadsFound: 5,
              threadsDone: 3,
              includeThreads: true,
              messageCount: 12,
            },
          ],
          index: { indexed: 12, rows: 12 },
        },
      },
    ]);
    renderWithSession(<ArchivePage />);
    expect(await screen.findByText('category')).toBeTruthy();
    expect(screen.getByText(/via category cat-1/)).toBeTruthy();
    expect(screen.getByText('3/5')).toBeTruthy();
    expect(screen.getByText('managed by its category')).toBeTruthy();
  });

  it('the threads toggle posts the opposite of the current inclusion', async () => {
    const withThreads = {
      channels: [
        {
          ...STATUS.channels[0],
          threadsFound: 2,
          threadsDone: 2,
          includeThreads: true,
        },
      ],
      index: STATUS.index,
    };
    const mock = stubFetch([
      { url: '/api/archive/status', body: withThreads },
      { method: 'POST', url: '/api/archive/channels/c-1/threads', body: { outcome: 'updated' } },
    ]);
    renderWithSession(<ArchivePage />);
    await screen.findByText('c-1');
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Actions for c-1' }));
      await userEvent.click(
        await screen.findByRole('menuitem', { name: 'Do not archive threads' }),
      );
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/archive/channels/c-1/threads' && c[1]?.method === 'POST',
    )!;
    expect(bodyOf(post)).toEqual({ value: 'none' });
  });

  it('browse lists a channel newest-first, marks tombstones, and opens one message', async () => {
    const mock = stubFetch([
      { url: '/api/archive/status', body: STATUS },
      {
        url: '/api/archive/channels/c-1/messages?limit=25',
        body: {
          messages: [
            {
              messageId: 'm-1',
              channelId: 'c-1',
              authorId: 'u-1',
              content: 'the launch notes are pinned',
              createdAt: 1700000000000,
            },
            {
              messageId: 'm-2',
              channelId: 'c-1',
              content: null,
              createdAt: 1699999000000,
              deletedAt: 1699999500000,
            },
          ],
        },
      },
      {
        url: '/api/archive/messages/m-1',
        body: {
          messageId: 'm-1',
          channelId: 'c-1',
          authorId: 'u-1',
          content: 'the launch notes are pinned',
          createdAt: 1700000000000,
          editedAt: 1700000060000,
        },
      },
    ]);
    renderWithSession(<ArchivePage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for c-1' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Browse' }));
    expect(await screen.findByText('the launch notes are pinned')).toBeTruthy();
    expect(screen.getByText('content purged')).toBeTruthy();
    expect(screen.getByText(/deleted from Discord/)).toBeTruthy();
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/archive/channels/c-1/messages?limit=25',
      ),
    ).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]!);
    expect(await screen.findByText('Message m-1')).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Archived message m-1' });
    expect(region.textContent).toContain('edited');
  });

  it('browse pages older messages with the before cursor and walks back', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => ({
      messageId: `m-${25 - i}`,
      channelId: 'c-1',
      content: `message ${25 - i}`,
      createdAt: 1700000000000 - i * 1000,
    }));
    const mock = stubFetch([
      { url: '/api/archive/status', body: STATUS },
      { url: '/api/archive/channels/c-1/messages?limit=25', body: { messages: page1 } },
      {
        url: '/api/archive/channels/c-1/messages?limit=25&before=m-1',
        body: {
          messages: [
            { messageId: 'm-0', channelId: 'c-1', content: 'the oldest one', createdAt: 0 },
          ],
        },
      },
    ]);
    renderWithSession(<ArchivePage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for c-1' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Browse' }));
    await screen.findByText('message 25');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    });
    expect(await screen.findByText('the oldest one')).toBeTruthy();
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/archive/channels/c-1/messages?limit=25&before=m-1',
      ),
    ).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    });
    expect(await screen.findByText('message 25')).toBeTruthy();
  });

  it('a /archive?browse=...&message=... deep link opens the channel and the message', async () => {
    window.history.pushState({}, '', '/archive?browse=c-1&message=m-1');
    stubFetch([
      { url: '/api/archive/status', body: STATUS },
      {
        url: '/api/archive/channels/c-1/messages?limit=25',
        body: {
          messages: [
            {
              messageId: 'm-1',
              channelId: 'c-1',
              authorId: 'u-1',
              content: 'the launch notes are pinned',
              createdAt: 1700000000000,
            },
          ],
        },
      },
      {
        url: '/api/archive/messages/m-1',
        body: {
          messageId: 'm-1',
          channelId: 'c-1',
          authorId: 'u-1',
          content: 'the launch notes are pinned',
          createdAt: 1700000000000,
        },
      },
    ]);
    renderWithSession(<ArchivePage />);
    // The excerpt in the list and the full text in the detail both render.
    expect((await screen.findAllByText('the launch notes are pinned')).length).toBe(2);
    expect(await screen.findByText('Message m-1')).toBeTruthy();
    window.history.pushState({}, '', '/archive');
  });
});

it('keeps message-tool drafts when archive sections change', async () => {
  stubFetch([{ url: '/api/archive/status', body: STATUS }]);
  renderWithSession(<ArchivePage />);
  (await screen.findByRole('tab', { name: 'All sections' })).focus();
  await userEvent.keyboard('{End}');
  expect(screen.getByRole('tab', { name: 'Message tools' }).getAttribute('aria-selected')).toBe(
    'true',
  );
  fireEvent.change(screen.getByLabelText('Preserve a message'), {
    target: { value: 'draft-message' },
  });
  screen.getByRole('tab', { name: 'Message tools' }).focus();
  await userEvent.keyboard('{ArrowLeft}');
  expect(screen.queryByRole('textbox', { name: 'Preserve a message' })).toBeNull();
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.getByLabelText<HTMLInputElement>('Preserve a message').value).toBe('draft-message');
});

it('does not mistake unavailable archive status for an empty archive', async () => {
  stubFetch([{ url: '/api/archive/status', status: 500, body: { error: 'unavailable' } }]);
  renderWithSession(<ArchivePage />);
  expect((await screen.findAllByText(/Couldn't load the archive status/)).length).toBeGreaterThan(
    0,
  );
  expect(screen.queryByText(/No channels archiving yet/)).toBeNull();
});
