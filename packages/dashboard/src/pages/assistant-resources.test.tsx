// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch, type StubRoute } from '../test-support.js';
import { AssistantResourcesPage } from './assistant-resources.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const FULL = {
  behaviours: [],
  resources: [
    {
      id: 'handbook',
      guildId: '1540816150026518620',
      title: 'Club handbook',
      url: 'https://example.com/handbook',
      kind: 'document',
      enabled: true,
      reviewedAt: '2026-09-01T12:00:00.000Z',
      fetchStatus: 'ok',
      lastFetchedAt: 1790000000000,
    },
  ],
  reminders: [],
  skills: [],
  activity: [],
  roles: [],
  members: [],
  channels: [],
  skillGrants: [],
  tickets: [],
  decisions: [],
};

const FRESH_ROW = { resourceId: 'handbook', fetchedAt: 1790000000000, chunks: 4, bytes: 2048 };

function renderPage(
  body: unknown = FULL,
  freshness: readonly unknown[] = [FRESH_ROW],
  extraRoutes: readonly StubRoute[] = [],
) {
  const mock = stubFetch([
    { url: '/api/assistant', body },
    { url: '/api/assistant/resources/freshness', body: { freshness } },
    { method: 'PUT', url: '/api/assistant/resources/handbook', body: { ok: true } },
    { method: 'POST', url: '/api/assistant/resources/handbook/refresh', body: { ok: true } },
    { method: 'POST', url: '/api/assistant/resources/refresh', body: { ok: true } },
    ...extraRoutes,
  ]);
  renderWithSession(<AssistantResourcesPage />);
  return mock;
}

describe('AssistantResourcesPage', () => {
  it('renders a resource with its title, URL, kind and reviewed date', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Resources' })).toBeTruthy();
    expect(screen.getByText('Club handbook')).toBeTruthy();
    expect(screen.getByText('https://example.com/handbook')).toBeTruthy();
    expect(screen.getByText(/document · reviewed 2026-09-01/)).toBeTruthy();
  });

  it('shows Ready with freshness, chunk count and size when the cache has a current document', async () => {
    renderPage();
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByText(/4 chunks/)).toBeTruthy();
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
  });

  it('shows Needs attention with the last error sentence when the cache has one', async () => {
    renderPage(FULL, [
      {
        resourceId: 'handbook',
        fetchedAt: 1790000000000,
        chunks: 0,
        bytes: 0,
        lastError: 'timeout: the reviewed resource could not be retrieved safely.',
      },
    ]);
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(
      screen.getByText('timeout: the reviewed resource could not be retrieved safely.'),
    ).toBeTruthy();
  });

  it('shows Needs attention and "Never updated" when the resource has no cached document yet', async () => {
    renderPage(FULL, []);
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('Never updated')).toBeTruthy();
  });

  it('shows Off for a disabled resource even when its cache is current', async () => {
    renderPage({ ...FULL, resources: [{ ...FULL.resources[0]!, enabled: false }] });
    expect(await screen.findByText('Off')).toBeTruthy();
  });

  it('Update now posts a manual refresh for that resource only', async () => {
    const mock = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    await screen.findByText('Update queued');
    const post = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/resources/handbook/refresh' && c[1]?.method === 'POST',
    );
    expect(post).toBeTruthy();
  });

  it('Update all posts to the guild-wide refresh route', async () => {
    const mock = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Update all' }));
    await screen.findByText('Update queued');
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/resources/refresh' && c[1]?.method === 'POST',
    );
    expect(post).toBeTruthy();
  });

  it('adds a resource through the reviewed endpoint and surfaces URL refusal inline', async () => {
    const NOW = 1750000000000;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const mock = stubFetch([
      { url: '/api/assistant', body: FULL },
      { url: '/api/assistant/resources/freshness', body: { freshness: [FRESH_ROW] } },
      {
        method: 'PUT',
        url: `/api/assistant/resources/res-${NOW.toString(36)}`,
        status: 400,
        body: { error: 'unsafe-resource-url' },
      },
    ]);
    renderWithSession(<AssistantResourcesPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add resource' }))[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Club website' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), {
      target: { value: 'http://169.254.169.254/meta' },
    });
    const submit = screen
      .getAllByRole('button', { name: 'Add resource' })
      .find((b) => b.getAttribute('type') === 'submit')!;
    fireEvent.click(submit);
    expect(
      await screen.findByText(
        'That address is not allowed: private and local addresses are refused.',
      ),
    ).toBeTruthy();
    const put = mock.mock.calls.find((c) =>
      (c[0] as string).startsWith('/api/assistant/resources/res-'),
    )!;
    expect(put[1]?.method).toBe('PUT');
    const sent = bodyOf(put) as { id: string; title: string; enabled: boolean };
    expect(sent.id).toMatch(/^res-/);
    expect(sent.title).toBe('Club website');
    expect(sent.enabled).toBe(true);
  });

  it('enables a disabled resource with a whole-object write', async () => {
    const mock = renderPage({
      ...FULL,
      resources: [{ ...FULL.resources[0]!, enabled: false }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/resources/handbook' && c[1]?.method === 'PUT',
    )!;
    expect((bodyOf(put) as { enabled: boolean }).enabled).toBe(true);
  });

  it('shows the empty state with an Add resource action when nothing is reviewed yet', async () => {
    renderPage({ ...FULL, resources: [] }, []);
    expect(await screen.findByText('No resources reviewed yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add resource' }).length).toBeGreaterThan(0);
    // No resources to refresh, so no "Update all" button.
    expect(screen.queryByRole('button', { name: 'Update all' })).toBeNull();
  });

  it('renders the error state when the load fails', async () => {
    stubFetch([]);
    renderWithSession(<AssistantResourcesPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Could not load assistant resources/)).toBeTruthy();
  });
});
