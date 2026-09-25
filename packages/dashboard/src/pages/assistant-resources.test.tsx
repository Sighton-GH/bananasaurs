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
  it('states its purpose sentence', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Resources' })).toBeTruthy();
    expect(
      screen.getByText(
        'Reviewed sources the assistant may read, how fresh the cache is, and whether fetching them is working.',
      ),
    ).toBeTruthy();
  });

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

const ORG_PREVIEW = {
  target: { kind: 'org', owner: 'acme' },
  authenticated: true,
  repos: [
    { name: 'widget', description: 'Does things', fork: false, archived: false },
    { name: 'gadget', description: null, fork: false, archived: false },
    { name: 'forked', description: null, fork: true, archived: false },
  ],
  truncated: false,
};

const REPO_PREVIEW = {
  target: { kind: 'repo', owner: 'acme', repo: 'widget', branch: 'main' },
  authenticated: true,
  files: ['README.md', 'docs/guide.md'],
};

function renderGithub(previewBody: unknown, importBody: unknown = { created: 2 }) {
  const mock = stubFetch([
    { url: '/api/assistant', body: FULL },
    { url: '/api/assistant/resources/freshness', body: { freshness: [FRESH_ROW] } },
    { method: 'POST', url: '/api/assistant/github/preview', body: previewBody },
    { method: 'POST', url: '/api/assistant/github/import', body: importBody },
  ]);
  renderWithSession(<AssistantResourcesPage />);
  return mock;
}

async function openGithubPanel(url = 'https://github.com/acme/widget') {
  fireEvent.click(await screen.findByRole('button', { name: 'Add from GitHub' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'GitHub URL' }), {
    target: { value: url },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
}

describe('Add from GitHub', () => {
  it('previews a repo and adds it with the checked files only', async () => {
    const mock = renderGithub(REPO_PREVIEW, { created: 1 });
    await openGithubPanel();
    expect(await screen.findByText('README.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'docs/guide.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('GitHub import added');
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/github/import' && c[1]?.method === 'POST',
    )!;
    expect(bodyOf(post)).toEqual({
      url: 'https://github.com/acme/widget',
      include: ['README.md'],
    });
  });

  it('filters the repo file list without changing the selection', async () => {
    const mock = renderGithub(REPO_PREVIEW, { created: 1 });
    await openGithubPanel();
    await screen.findByText('docs/guide.md');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter files' }), {
      target: { value: 'guide' },
    });
    expect(screen.queryByText('README.md')).toBeNull();
    expect(screen.getByText('docs/guide.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('GitHub import added');
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/github/import' && c[1]?.method === 'POST',
    )!;
    // Everything still checked, so the default selection stands and no include is sent.
    expect(bodyOf(post)).toEqual({ url: 'https://github.com/acme/widget' });
  });

  it('previews an org with a count, hides forks until toggled, and imports the checked repos', async () => {
    const mock = renderGithub(ORG_PREVIEW, { created: 3 });
    await openGithubPanel('https://github.com/acme');
    await screen.findByText('3 public repositories');
    expect(screen.getByText('widget')).toBeTruthy();
    expect(screen.queryByText('forked')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include forks' }));
    expect(screen.getByText('forked')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'gadget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('GitHub import added');
    const post = mock.mock.calls
      .filter((c) => (c[0] as string) === '/api/assistant/github/import' && c[1]?.method === 'POST')
      .at(-1)!;
    expect(bodyOf(post)).toEqual({
      url: 'https://github.com/acme',
      repos: ['widget', 'forked'],
      includeForks: true,
      includeArchived: false,
    });
  });

  it('shows an empty org with no Add button', async () => {
    renderGithub({ ...ORG_PREVIEW, repos: [] });
    await openGithubPanel('https://github.com/acme');
    expect(await screen.findByText('This organisation has no public repositories.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('notes a truncated org list', async () => {
    renderGithub({ ...ORG_PREVIEW, truncated: true });
    await openGithubPanel('https://github.com/acme');
    expect(await screen.findByText('Showing the first 500 repositories.')).toBeTruthy();
  });

  it('explains the no-token limits with a HelpTip', async () => {
    renderGithub({ ...REPO_PREVIEW, authenticated: false });
    await openGithubPanel();
    await screen.findByText('README.md');
    fireEvent.click(screen.getByRole('button', { name: 'Help: GitHub token limits' }));
    expect(
      await screen.findByText(
        'Without a GitHub token only README files are read and organisations refresh once a day. Add a token on the AI setup page.',
      ),
    ).toBeTruthy();
    // README-only preview still offers the Add button.
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });

  it('reports a preview failure inline', async () => {
    stubFetch([
      { url: '/api/assistant', body: FULL },
      { url: '/api/assistant/resources/freshness', body: { freshness: [FRESH_ROW] } },
      {
        method: 'POST',
        url: '/api/assistant/github/preview',
        status: 400,
        body: { error: 'not-github' },
      },
    ]);
    renderWithSession(<AssistantResourcesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add from GitHub' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub URL' }), {
      target: { value: 'https://example.com/acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(
      await screen.findByText('That is not a GitHub repository or organisation URL.'),
    ).toBeTruthy();
  });

  it('marks auto-discovered children and counts an org’s repositories', async () => {
    renderPage(
      {
        ...FULL,
        resources: [
          {
            id: 'gh-acme',
            guildId: '1540816150026518620',
            title: 'acme',
            url: 'https://github.com/acme',
            kind: 'github-org',
            enabled: true,
            reviewedAt: '2026-09-01T12:00:00.000Z',
            meta: { owner: 'acme' },
          },
          {
            id: 'gh-acme-widget',
            guildId: '1540816150026518620',
            title: 'acme/widget',
            url: 'https://github.com/acme/widget',
            kind: 'github-repo',
            enabled: true,
            reviewedAt: '2026-09-01T12:00:00.000Z',
            parentId: 'gh-acme',
            meta: { owner: 'acme', repo: 'widget', branch: 'main', autoDiscovered: true },
          },
        ],
      },
      [],
    );
    expect(await screen.findByText('New — found automatically')).toBeTruthy();
    expect(screen.getByText('1 repository')).toBeTruthy();
  });
});
