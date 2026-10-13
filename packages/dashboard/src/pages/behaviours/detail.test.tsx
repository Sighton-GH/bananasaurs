// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../../test-support.js';
import { AssistantBehaviourDetailPage } from './detail.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const CLUB = {
  id: 'club',
  guildId: '1540816150026518620',
  surface: 'bananasaurs',
  mentionRoleId: 'role-club-assistant',
  name: 'Club assistant',
  systemPrompt: 'Answer with reviewed club knowledge only.',
  promptVersion: 1,
  preferredSkillIds: ['search-club'],
  resourceIds: [],
  enabled: true,
  callerRoleIds: ['role-club-member'],
};
const IT = {
  ...CLUB,
  id: 'it',
  surface: 'it-services',
  mentionRoleId: 'role-it-help',
  name: 'IT services',
  systemPrompt: 'Answer infrastructure questions.',
  enabled: false,
  callerRoleIds: [],
  ticket: { reviewerRoleIds: [] },
};
const bodyOfBehaviour = (b: { guildId: string }) => {
  const rest: Record<string, unknown> = { ...b };
  delete rest['guildId'];
  return rest;
};
const DATA = {
  behaviours: [CLUB, IT],
  resources: [],
  reminders: [],
  skills: [],
  activity: [],
  roles: [
    { id: 'role-club-member', name: 'Club Member', position: 10 },
    { id: 'role-onboarding', name: 'Onboarding', position: 5 },
  ],
};

function open(path: string, routes: Parameters<typeof stubFetch>[0] = []) {
  window.history.pushState({}, '', path);
  const mock = stubFetch([
    { url: '/api/assistant', body: DATA },
    { method: 'PUT', url: '/api/assistant/behaviours/club', body: { ok: true } },
    { method: 'PUT', url: '/api/assistant/behaviours/it', body: { ok: true } },
    ...routes,
  ]);
  renderWithSession(
    <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />,
  );
  return mock;
}
beforeEach(() => window.history.pushState({}, '', '/'));

describe('AssistantBehaviourDetailPage', () => {
  it('shows the behaviour with breadcrumb, wizard link and Prompt tab by default', async () => {
    open('/assistant/behaviours/club');
    expect(await screen.findByRole('heading', { name: 'Club assistant' })).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(crumbs).getByRole<HTMLAnchorElement>('link', { name: 'Behaviours' }).pathname,
    ).toBe('/assistant');
    const wizard = screen.getByRole<HTMLAnchorElement>('link', { name: 'Build with the wizard' });
    expect(wizard.pathname).toBe('/assistant/behaviours/club/wizard');
    expect(screen.getByRole('tab', { name: 'Prompt', selected: true })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Full prompt' }).textContent).toContain(
      'Answer with reviewed club knowledge only.',
    );
  });

  it('renders NotFound for an unknown id and never falls back to the first behaviour', async () => {
    open('/assistant/behaviours/nope');
    expect(await screen.findByText("This behaviour doesn't exist or was deleted")).toBeTruthy();
    expect(screen.queryByText('Club assistant')).toBeNull();
    expect(
      screen.getByRole<HTMLAnchorElement>('link', { name: 'Back to behaviours' }).pathname,
    ).toBe('/assistant');
  });

  it('picks the tab from the query string and writes it back when a tab is chosen', async () => {
    open('/assistant/behaviours/club?tab=access');
    expect(await screen.findByRole('tab', { name: 'Access', selected: true })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Caller roles' })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Try it' }));
    await waitFor(() => expect(window.location.search).toBe('?tab=try'));
    expect(screen.getByRole('textbox', { name: 'Try it question' })).toBeTruthy();
  });

  it('treats an unknown tab value as the Prompt tab', async () => {
    open('/assistant/behaviours/club?tab=bogus');
    expect(await screen.findByRole('tab', { name: 'Prompt', selected: true })).toBeTruthy();
  });

  it('saves the caller-role allowlist with the unchanged whole-object PUT body', async () => {
    const mock = open('/assistant/behaviours/club?tab=access');
    const region = await screen.findByRole('region', { name: 'Caller roles' });
    fireEvent.click(within(region).getByRole('checkbox', { name: 'Onboarding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await screen.findByText('Club assistant access saved');
    const put = mock.mock.calls.find(
      (c) => c[0] === '/api/assistant/behaviours/club' && c[1]?.method === 'PUT',
    )!;
    expect(bodyOf(put)).toEqual({
      ...bodyOfBehaviour(CLUB),
      callerRoleIds: ['role-club-member', 'role-onboarding'],
    });
  });

  it('toggles enablement only from the deliberate button, with the whole-object body', async () => {
    const mock = open('/assistant/behaviours/it');
    await screen.findByRole('heading', { name: 'IT services' });
    expect(mock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on assistant' }));
    await screen.findByText('IT services enabled');
    const put = mock.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(bodyOf(put)).toEqual({ ...bodyOfBehaviour(IT), enabled: true });
  });

  it("never carries one behaviour's prompt draft or Try answer onto another", async () => {
    open('/assistant/behaviours/club');
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions the assistant follows',
    });
    fireEvent.change(box, { target: { value: 'edited for club' } });
    window.history.pushState({}, '', '/assistant/behaviours/it');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'IT services' });
    const next = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions the assistant follows',
    });
    expect(next.value).toBe('Answer infrastructure questions.');
  });

  it('shows the load failure instead of a behaviour', async () => {
    window.history.pushState({}, '', '/assistant/behaviours/club');
    stubFetch([{ url: '/api/assistant', status: 500, body: { error: 'boom' } }]);
    renderWithSession(
      <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Club assistant' })).toBeNull();
  });

  it('keeps other query fields and the hash when choosing a tab, and Back returns to the previous tab', async () => {
    open('/assistant/behaviours/club?x=1#frag');
    await screen.findByRole('tab', { name: 'Prompt', selected: true });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Access' }));
    await screen.findByRole('tab', { name: 'Access', selected: true });
    const params = new URLSearchParams(window.location.search);
    expect(params.get('x')).toBe('1');
    expect(params.get('tab')).toBe('access');
    expect(window.location.hash).toBe('#frag');
    expect(window.location.pathname).toBe('/assistant/behaviours/club');
    window.history.back();
    await screen.findByRole('tab', { name: 'Prompt', selected: true });
    expect(window.location.search).toBe('?x=1');
    expect(window.location.hash).toBe('#frag');
  });

  it('does not render or load a tab body until that tab is opened', async () => {
    const mock = open('/assistant/behaviours/club');
    await screen.findByRole('heading', { name: 'Club assistant' });
    expect(screen.queryByRole('region', { name: 'Caller roles' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Try it question' })).toBeNull();
    expect(mock.mock.calls.map((c) => c[0])).toEqual(['/api/assistant']);
  });

  it('keeps a prompt draft and a Try answer across tab switches', async () => {
    const mock = open('/assistant/behaviours/club', [
      {
        method: 'POST',
        url: '/api/assistant/behaviours/club/try',
        body: { answer: 'Tried answer.', traceId: 'try_1', conversationId: 'try_c1' },
      },
    ]);
    const prompt = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions the assistant follows',
    });
    fireEvent.change(prompt, { target: { value: 'unsaved prompt draft' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Try it' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Try it question' }), {
      target: { value: 'when is the meeting?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    await screen.findByText('Tried answer.');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Prompt' }));
    await screen.findByRole('tab', { name: 'Prompt', selected: true });
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Instructions the assistant follows',
      }).value,
    ).toBe('unsaved prompt draft');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Try it' }));
    await screen.findByRole('tab', { name: 'Try it', selected: true });
    expect(screen.getByText('Tried answer.')).toBeTruthy();
    // Switching tabs never sent anything beyond the one Try request.
    expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1);
    expect(mock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);
  });

  it('keeps a pending access save and its result across tab switches', async () => {
    window.history.pushState({}, '', '/assistant/behaviours/club?tab=access');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const puts: unknown[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (init?.method === 'PUT') {
          puts.push([url, init]);
          await gate;
          return json({ ok: true });
        }
        return json(DATA);
      }),
    );
    renderWithSession(
      <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />,
    );
    const region = await screen.findByRole('region', { name: 'Caller roles' });
    fireEvent.click(within(region).getByRole('checkbox', { name: 'Onboarding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Prompt' }));
    await screen.findByRole('tab', { name: 'Prompt', selected: true });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Access' }));
    await screen.findByRole('tab', { name: 'Access', selected: true });
    expect(
      within(screen.getByRole('region', { name: 'Caller roles' })).getByRole<HTMLInputElement>(
        'checkbox',
        { name: 'Onboarding' },
      ).checked,
    ).toBe(true);
    release();
    await screen.findByText('Club assistant access saved');
    // One write only: flipping tabs did not trigger a second save.
    expect(puts).toHaveLength(1);
  });
});
