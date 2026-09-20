// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
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
    fireEvent.click(await screen.findByRole('button', { name: 'Reindex' }));
    expect(mock.mock.calls.some((c) => (c[0] as string) === '/api/archive/reindex')).toBe(true);
  });

  it('enable posts the channel and policy; the guild veto renders inline', async () => {
    const mock = stubFetch([
      { url: '/api/archive/status', body: STATUS },
      { method: 'POST', url: '/api/archive/channels', body: { outcome: 'enabled' } },
    ]);
    renderWithSession(<ArchivePage />);
    await screen.findByText('c-1');
    fireEvent.change(screen.getByLabelText('Enable archiving for a channel'), {
      target: { value: 'c-2' },
    });
    fireEvent.change(screen.getByLabelText('Attachment policy'), { target: { value: 'bytes' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable archiving' }));
    });
    const post = mock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(bodyOf(post)).toEqual({ channelId: 'c-2', attachmentPolicy: 'bytes' });
  });

  it('disable names the destruction count before it fires', async () => {
    const mock = stubFetch([
      { url: '/api/archive/status', body: STATUS },
      {
        method: 'DELETE',
        url: '/api/archive/channels/c-1',
        body: { outcome: 'disabled', messageCount: 120 },
      },
    ]);
    renderWithSession(<ArchivePage />);
    await screen.findByText('c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('120');
    expect(dialog.textContent).toContain('archived messages, edits and attachments');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disable and destroy' }));
    });
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/archive/channels/c-1' && c[1]?.method === 'DELETE',
      ),
    ).toBe(true);
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
});
