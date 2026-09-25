// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
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

function renderPage(body: unknown = FULL) {
  const mock = stubFetch([
    { url: '/api/assistant', body },
    { method: 'PUT', url: '/api/assistant/resources/handbook', body: { ok: true } },
  ]);
  renderWithSession(<AssistantResourcesPage />);
  return mock;
}

describe('AssistantResourcesPage', () => {
  it('states its purpose sentence (Task 9)', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Resources' })).toBeTruthy();
    expect(
      screen.getByText(
        'Resources are the websites, documents and GitHub repositories the assistant can read.',
      ),
    ).toBeTruthy();
  });

  it('renders sources with scope, freshness and fetch health', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Resources' })).toBeTruthy();
    expect(screen.getByText('Club handbook')).toBeTruthy();
    expect(screen.getByText('https://example.com/handbook')).toBeTruthy();
    expect(screen.getByText(/document · reviewed 2026-09-01/)).toBeTruthy();
    expect(screen.getByText(/Fetch: ok/)).toBeTruthy();
  });

  it('adds a resource through the reviewed endpoint and surfaces URL refusal inline', async () => {
    const NOW = 1750000000000;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const mock = stubFetch([
      { url: '/api/assistant', body: FULL },
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
      (c[0] as string).startsWith('/api/assistant/resources/'),
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

  it('still offers Add resource when nothing is reviewed yet', async () => {
    renderPage({ ...FULL, resources: [] });
    expect(await screen.findByText('No resources reviewed yet.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add resource' }).length).toBeGreaterThan(0);
  });

  it('renders the error state when the load fails', async () => {
    stubFetch([]);
    renderWithSession(<AssistantResourcesPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Could not load assistant resources/)).toBeTruthy();
  });
});
