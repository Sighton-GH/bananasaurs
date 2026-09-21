// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { SearchPage } from './search.js';

const CHANNELS = {
  channels: [{ channelId: 'c9', name: 'compressor-talk', kind: 'text' }],
};

const RESULT = {
  hits: [
    {
      messageId: 'm1',
      channelId: 'c1',
      authorId: 'a1',
      createdAt: 0,
      excerpt: 'the compressor schedule is out',
    },
  ],
  total: 1,
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('SearchPage', () => {
  it('searches nothing until the form is submitted', () => {
    const mock = stubFetch([{ url: '/api/guild/channels', body: CHANNELS }]);
    renderWithSession(<SearchPage />);
    expect(screen.getByRole('region', { name: 'Search the archive' })).toBeTruthy();
    // The channel picker loads its list, but nothing is searched yet.
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual(['/api/guild/channels']);
  });

  it('submits the query and renders hits best match first', async () => {
    const mock = stubFetch([
      { url: '/api/guild/channels', body: CHANNELS },
      { url: '/api/archive/search?q=compressor&limit=50', body: RESULT },
    ]);
    renderWithSession(<SearchPage />);
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'compressor' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    });
    expect(await screen.findByText('the compressor schedule is out')).toBeTruthy();
    expect(screen.getByText('1 match, best match first.')).toBeTruthy();
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual([
      '/api/guild/channels',
      '/api/archive/search?q=compressor&limit=50',
    ]);
  });

  it('passes channel and author filters and skips empty ones', async () => {
    const mock = stubFetch([
      { url: '/api/guild/channels', body: CHANNELS },
      { url: '/api/archive/search?q=compressor&channelId=c9&authorId=a7&limit=50', body: RESULT },
    ]);
    renderWithSession(<SearchPage />);
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'compressor' } });
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: ' c9 ' } });
    fireEvent.change(screen.getByLabelText('Author ID'), { target: { value: 'a7' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    });
    await screen.findByText('the compressor schedule is out');
    expect(mock.mock.calls[1]![0] as string).toBe(
      '/api/archive/search?q=compressor&channelId=c9&authorId=a7&limit=50',
    );
  });

  it('says so when nothing matched', async () => {
    stubFetch([{ url: '/api/archive/search?q=zzz&limit=50', body: { hits: [], total: 0 } }]);
    renderWithSession(<SearchPage />);
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'zzz' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    });
    expect(
      await screen.findByRole('region', { name: 'No archived messages matched' }),
    ).toBeTruthy();
  });

  it('each hit links to the archive browse view for that message', async () => {
    stubFetch([{ url: '/api/archive/search?q=compressor&limit=50', body: RESULT }]);
    renderWithSession(<SearchPage />);
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'compressor' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    });
    const link = await screen.findByRole('link', { name: 'Open' });
    expect(link.getAttribute('href')).toBe('/archive?browse=c1&message=m1');
  });
});
