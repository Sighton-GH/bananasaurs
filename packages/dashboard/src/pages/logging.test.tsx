// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_ACTION_CATALOG } from '@bananasaurs/core';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { LoggingPage } from './logging.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const CHANNELS = {
  channels: [
    { channelId: '42', name: 'mod-log', kind: 'text' },
    { channelId: '77', name: 'staff-chat', kind: 'text' },
  ],
};

const ROUTE = {
  routeId: 'r1',
  name: 'mod log',
  channelId: '42',
  enabled: true,
  includeContent: true,
  createdAtMs: 1,
  eventKinds: ['message_delete', 'message_edit', 'member_join'],
  excludedChannelIds: ['77'],
};

const stubPage = (
  routesBody: unknown,
  extra: { method?: string; url: string; body: unknown }[] = [],
) =>
  stubFetch([
    { url: '/api/log-routes', body: routesBody },
    { url: '/api/guild/channels', body: CHANNELS },
    ...extra,
  ]);

const openNewRoute = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'New route' }));
  expect(await screen.findByText('New route')).toBeTruthy();
};

const checkOf = (name: string): HTMLInputElement => {
  const el = screen.getByLabelText(name);
  if (!(el instanceof HTMLInputElement)) throw new Error(`expected a checkbox for ${name}`);
  return el;
};

describe('LoggingPage routes', () => {
  it('renders a route card with resolved channel name, grouped actions, skips and content', async () => {
    stubPage({ routes: [ROUTE], excludedChannels: [] });
    renderWithSession(<LoggingPage />);
    expect(await screen.findByText('mod log')).toBeTruthy();
    expect(screen.getByText('→ #mod-log')).toBeTruthy();
    expect(
      screen.getByText('Messages: Message edited, Message deleted · Members: Member joined'),
    ).toBeTruthy();
    expect(screen.getByText('Skips: #staff-chat (and their threads)')).toBeTruthy();
    expect(screen.getByText('Message content: included')).toBeTruthy();
  });

  it('shows a disabled route as Off with its content line', async () => {
    stubPage({
      routes: [{ ...ROUTE, enabled: false, includeContent: false, excludedChannelIds: [] }],
      excludedChannels: [],
    });
    renderWithSession(<LoggingPage />);
    expect(await screen.findByText('mod log')).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText('Message content: not included')).toBeTruthy();
    expect(screen.getByText('Skips: nothing')).toBeTruthy();
  });

  it('shows the empty state', async () => {
    stubPage({ routes: [], excludedChannels: [] });
    renderWithSession(<LoggingPage />);
    expect(
      await screen.findByText('No routes yet. Create one to start posting actions to a channel.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New route' })).toBeTruthy();
  });

  it('the On/Off control posts { enabled: false } to /enabled', async () => {
    const mock = stubPage({ routes: [ROUTE], excludedChannels: [] }, [
      { method: 'POST', url: '/api/log-routes/r1/enabled', body: { ok: true } },
    ]);
    renderWithSession(<LoggingPage />);
    await screen.findByText('mod log');
    await act(async () => {
      fireEvent.click(checkOf('mod log on'));
    });
    const toggle = mock.mock.calls.find((c) => (c[0] as string).includes('/enabled'))!;
    expect(bodyOf(toggle)).toEqual({ enabled: false });
  });

  it('Delete asks for confirmation; Cancel sends nothing, confirming sends DELETE', async () => {
    const mock = stubPage({ routes: [ROUTE], excludedChannels: [] }, [
      { method: 'DELETE', url: '/api/log-routes/r1', body: { ok: true } },
    ]);
    renderWithSession(<LoggingPage />);
    await screen.findByText('mod log');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete route "mod log"?');
    expect(dialog.textContent).toContain("It stops posting immediately. This can't be undone.");
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(mock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'DELETE')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete route' }));
    });
    const del = mock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'DELETE');
    expect(del?.[0]).toBe('/api/log-routes/r1');
  });
});

describe('LoggingPage route form', () => {
  it('Select all checks every action and the submit POSTs the full catalogue with defaults', async () => {
    const mock = stubPage({ routes: [], excludedChannels: [] }, [
      { method: 'POST', url: '/api/log-routes', body: { ok: true, route: ROUTE } },
    ]);
    renderWithSession(<LoggingPage />);
    await openNewRoute();
    fireEvent.click(checkOf('Select all'));
    for (const action of LOG_ACTION_CATALOG) {
      expect(checkOf(action.label).checked).toBe(true);
    }
    // Content is on by default: no click needed.
    expect(checkOf('Include message content').checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Post to'), { target: { value: '42' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create route' }));
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/log-routes' && (c[1] as RequestInit)?.method === 'POST',
    )!;
    const allKinds = LOG_ACTION_CATALOG.map((a) => a.kind);
    expect(bodyOf(post)).toEqual({
      name: '→ #mod-log',
      channelId: '42',
      includeContent: true,
      enabled: true,
      eventKinds: allKinds,
      excludedChannelIds: [],
    });
  });

  it('a group checkbox selects only its group', async () => {
    stubPage({ routes: [], excludedChannels: [] });
    renderWithSession(<LoggingPage />);
    await openNewRoute();
    fireEvent.click(checkOf('Messages'));
    expect(checkOf('Message sent').checked).toBe(true);
    expect(checkOf('Message edited').checked).toBe(true);
    expect(checkOf('Message deleted').checked).toBe(true);
    expect(checkOf('Member joined').checked).toBe(false);
    expect(checkOf('Role created').checked).toBe(false);
    expect(checkOf('Select all').checked).toBe(false);
  });

  it('a partly selected group checkbox is indeterminate', async () => {
    stubPage({ routes: [], excludedChannels: [] });
    renderWithSession(<LoggingPage />);
    await openNewRoute();
    fireEvent.click(checkOf('Message deleted'));
    expect(checkOf('Messages').indeterminate).toBe(true);
    expect(checkOf('Select all').indeterminate).toBe(true);
    expect(checkOf('Messages').checked).toBe(false);
  });

  it('adds a skip channel as a chip and removes it again', async () => {
    stubPage({ routes: [], excludedChannels: [] });
    renderWithSession(<LoggingPage />);
    await openNewRoute();
    fireEvent.change(screen.getByLabelText("Don't log from"), { target: { value: '77' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Remove #staff-chat' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove #staff-chat' }));
    expect(screen.queryByRole('button', { name: 'Remove #staff-chat' })).toBeNull();
  });

  it('requires an action before sending', async () => {
    const mock = stubPage({ routes: [], excludedChannels: [] });
    renderWithSession(<LoggingPage />);
    await openNewRoute();
    fireEvent.change(screen.getByLabelText('Post to'), { target: { value: '42' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create route' }));
    });
    expect(await screen.findByText('Pick at least one action.')).toBeTruthy();
    expect(mock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST')).toHaveLength(0);
  });

  it('requires a destination before sending', async () => {
    const mock = stubPage({ routes: [], excludedChannels: [] });
    renderWithSession(<LoggingPage />);
    await openNewRoute();
    fireEvent.click(checkOf('Message deleted'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create route' }));
    });
    expect(await screen.findByText('Pick a channel to post to.')).toBeTruthy();
    expect(mock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST')).toHaveLength(0);
  });

  it('refuses a destination that is also skipped, without sending', async () => {
    const mock = stubPage({ routes: [], excludedChannels: [] });
    renderWithSession(<LoggingPage />);
    await openNewRoute();
    fireEvent.click(checkOf('Message deleted'));
    fireEvent.change(screen.getByLabelText('Post to'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText("Don't log from"), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create route' }));
    });
    expect(await screen.findByText("The channel you post to can't also be skipped.")).toBeTruthy();
    expect(mock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST')).toHaveLength(0);
  });

  it('Edit pre-fills the route and PUTs the edited body, keeping it enabled', async () => {
    const mock = stubPage({ routes: [ROUTE], excludedChannels: [] }, [
      { method: 'PUT', url: '/api/log-routes/r1', body: { ok: true, route: ROUTE } },
    ]);
    renderWithSession(<LoggingPage />);
    await screen.findByText('mod log');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('Edit route')).toBeTruthy();
    expect(checkOf('Message deleted').checked).toBe(true);
    expect(checkOf('Member joined').checked).toBe(true);
    expect(checkOf('Role created').checked).toBe(false);
    const dest = screen.getByLabelText('Post to');
    if (!(dest instanceof HTMLInputElement)) throw new Error('expected the Post to input');
    // The shared channel box shows a known channel by name and id (ADR 0122);
    // the PUT below proves the stored value is still the bare id.
    expect(dest.value).toBe('#mod-log (42)');
    expect(checkOf('Include message content').checked).toBe(true);
    fireEvent.click(checkOf('Member joined'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save route' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/log-routes/r1' && (c[1] as RequestInit)?.method === 'PUT',
    )!;
    expect(bodyOf(put)).toEqual({
      name: 'mod log',
      channelId: '42',
      includeContent: true,
      enabled: true,
      eventKinds: ['message_delete', 'message_edit'],
      excludedChannelIds: ['77'],
    });
  });
});

describe('LoggingPage No access line', () => {
  it('names the count and links to Permissions only when exclusions exist', async () => {
    stubPage({ routes: [], excludedChannels: ['99', '100'] });
    renderWithSession(<LoggingPage />);
    expect(await screen.findByText(/have No access/)).toBeTruthy();
    expect(
      screen.getByText(/2 channel\(s\) have No access and are never logged, whatever a route says/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage on Permissions' }).getAttribute('href')).toBe(
      '/permissions',
    );
    cleanup();
    stubPage({ routes: [], excludedChannels: [] });
    renderWithSession(<LoggingPage />);
    await screen.findByText(/No routes yet/);
    expect(screen.queryByText(/have No access/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Manage on Permissions' })).toBeNull();
  });
});
