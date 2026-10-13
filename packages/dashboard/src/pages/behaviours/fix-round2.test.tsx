// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Route } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../api.js';
import { SessionProvider } from '../../app/session.js';
import { TEST_SESSION } from '../../test-support.js';
import { AssistantPage } from '../assistant.js';
import { AssistantBehaviourDetailPage } from './detail.js';
import userEvent from '@testing-library/user-event';

const { Element: DomElement } = globalThis as unknown as {
  Element: {
    prototype: {
      hasPointerCapture?: (pointerId: number) => boolean;
      releasePointerCapture?: (pointerId: number) => void;
      scrollIntoView?: () => void;
    };
  };
};
if (!DomElement.prototype.hasPointerCapture) DomElement.prototype.hasPointerCapture = () => false;
if (!DomElement.prototype.releasePointerCapture)
  DomElement.prototype.releasePointerCapture = () => undefined;
if (!DomElement.prototype.scrollIntoView) DomElement.prototype.scrollIntoView = () => undefined;
if (!('ResizeObserver' in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => window.history.pushState({}, '', '/'));

const club = (over: Record<string, unknown> = {}) => ({
  id: 'club',
  guildId: '1540816150026518620',
  surface: 'bananasaurs',
  mentionRoleId: 'role-club-assistant',
  name: 'Club assistant',
  systemPrompt: 'Answer with reviewed club knowledge only.',
  promptVersion: 1,
  preferredSkillIds: [],
  resourceIds: [],
  enabled: true,
  callerRoleIds: ['role-club-member'],
  ...over,
});
const data = (behaviour: Record<string, unknown> = club()) => ({
  behaviours: [behaviour],
  resources: [],
  reminders: [],
  skills: [],
  activity: [],
  roles: [{ id: 'role-club-member', name: 'Club Member', position: 10 }],
  channels: [
    { id: 'chan-it', name: 'it-services' },
    { id: 'chan-general', name: 'general' },
  ],
  settings: {},
});

type Reply = { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;
/** A fetch whose answers come from a handler that sees how many GETs have happened. */
function scripted(handler: (url: string, init: RequestInit | undefined, gets: number) => Reply) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let gets = 0;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') gets += 1;
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = await handler(url, init, gets);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, puts: () => calls.filter((c) => c.method === 'PUT') };
}
const deferred = <T,>() => {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const detail = (info: SessionInfo = TEST_SESSION) =>
  render(
    <SessionProvider session={info} onLoggedOut={() => undefined}>
      <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />
    </SessionProvider>,
  );
const at = (path: string) => window.history.pushState({}, '', path);
const promptBox = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Instructions the assistant follows' });

const MINE = 'My unsaved rewrite.';
const savePrompt = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Save instructions' });

async function pickOption(option: string | RegExp, name: string | RegExp) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('R1: the server bumps promptVersion on every write; that alone is never a conflict', () => {
  it('own toggle (version bumped, same text) keeps the draft, no conflict, and Save sends the new version', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    const s = scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return {
        body: gets === 1 ? data() : data(club({ enabled: false, promptVersion: 2 })),
      };
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off - members will get no answer' }));
    await screen.findByRole('button', { name: 'Turn on assistant' });
    expect(promptBox().value).toBe(MINE);
    expect(screen.queryByText('These instructions changed elsewhere.')).toBeNull();
    expect(savePrompt().disabled).toBe(false);
    fireEvent.click(savePrompt());
    await waitFor(() => expect(s.puts()).toHaveLength(2));
    expect(s.puts()[1]!.body).toMatchObject({ systemPrompt: MINE, promptVersion: 2 });
  });

  it('own access save (version bumped, same text) keeps the prompt draft, no conflict', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    const s = scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return {
        body: gets === 1 ? data() : data(club({ callerRoleIds: [], promptVersion: 2 })),
      };
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Access/ }));
    const region = await screen.findByRole('region', { name: 'Caller roles' });
    fireEvent.click(within(region).getByRole('checkbox', { name: 'Club Member' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await screen.findByText('Club assistant access saved');
    await waitFor(() =>
      expect(s.calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(1),
    );
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Prompt/ }));
    await waitFor(() => expect(screen.getByText(/Revision 2/)).toBeTruthy());
    expect(promptBox().value).toBe(MINE);
    expect(screen.queryByText('These instructions changed elsewhere.')).toBeNull();
    expect(savePrompt().disabled).toBe(false);
  });

  it('a competing TEXT change with an edited draft is still a conflict', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    const s = scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return {
        body:
          gets === 1
            ? data()
            : data(
                club({
                  systemPrompt: 'Someone else wrote this.',
                  promptVersion: 2,
                  enabled: false,
                }),
              ),
      };
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off - members will get no answer' }));
    expect(await screen.findByText('These instructions changed elsewhere.')).toBeTruthy();
    expect(savePrompt().disabled).toBe(true);
    expect(promptBox().value).toBe(MINE);
    expect(s.puts()).toHaveLength(1);
  });

  it('the conflict preview is a kit CodeBlock with a Copy button', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    scripted((_url, init, gets) => {
      if (init?.method === 'PUT')
        return { status: 409, body: { error: 'conflict', title: 'x', message: 'y' } };
      return {
        body:
          gets === 1
            ? data()
            : data(club({ systemPrompt: 'Someone else wrote this.', promptVersion: 2 })),
      };
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(savePrompt());
    await screen.findByText('These instructions changed elsewhere.');
    const region = screen.getByRole('region', { name: 'Latest instructions' });
    expect(within(region).getByText('Someone else wrote this.')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});

describe('R2: the 409 message does not promise retention it cannot guarantee', () => {
  it('says nothing was saved and that the text is only kept while the reload works', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    scripted((_url, init, gets) => {
      if (init?.method === 'PUT')
        return { status: 409, body: { error: 'conflict', title: 'x', message: 'y' } };
      return gets === 1 ? { body: data() } : { status: 500, body: { error: 'boom' } };
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(savePrompt());
    const msg = await screen.findByText(/Nothing was saved/);
    expect(msg.textContent).toMatch(/unless/);
    expect(screen.queryByText(/Your text is kept; review it/)).toBeNull();
  });
});

describe('R3: after a successful prompt save, Save is off until the reload lands', () => {
  it('a second click before the reload sends no second PUT', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    const refresh = deferred<{ body: unknown }>();
    const s = scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return gets === 1 ? { body: data() } : refresh.promise;
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(savePrompt());
    await screen.findByText('Club assistant prompt saved');
    expect(savePrompt().disabled).toBe(true);
    fireEvent.click(savePrompt());
    expect(s.puts()).toHaveLength(1);
    await act(async () => {
      refresh.resolve({ body: data(club({ systemPrompt: MINE, promptVersion: 2 })) });
    });
    await waitFor(() => expect(screen.getByText(/Revision 2/)).toBeTruthy());
    expect(promptBox().value).toBe(MINE);
    expect(savePrompt().disabled).toBe(true);
    expect(s.puts()).toHaveLength(1);
  });

  it('a failed save keeps the draft and Save stays available', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    const s = scripted((_url, init, gets) => {
      if (init?.method === 'PUT')
        return { status: 400, body: { error: 'bad', title: 'No', message: 'No.' } };
      return { body: gets === 1 ? data() : data() };
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(savePrompt());
    await waitFor(() => expect(s.puts()).toHaveLength(1));
    await waitFor(() => expect(savePrompt().disabled).toBe(false));
    expect(promptBox().value).toBe(MINE);
  });
});

describe('R4: a reload that lands honours the newer server value', () => {
  const settingsPage = () =>
    render(
      <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
        <AssistantPage />
      </SessionProvider>,
    );
  const LOG = 'Post every assistant request to';
  const TAG = 'When someone tags @Bananasaurs, answer with';
  const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

  it('another admin changed the field first: the select shows the server value after the refresh', async () => {
    at('/assistant?tab=settings');
    const refresh = deferred<{ body: unknown }>();
    const s = scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return gets === 1 ? { body: data() } : refresh.promise;
    });
    settingsPage();
    await pickOption('#it-services', LOG);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    await screen.findByText('Assistant requests now log to #it-services');
    expect(screen.getByRole('combobox', { name: LOG }).textContent).toContain('#it-services');
    await act(async () => {
      refresh.resolve({ body: { ...data(), settings: { logChannelId: 'chan-general' } } });
    });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: LOG }).textContent).toContain('#general'),
    );
    expect(bar()).toBeNull();
    expect(s.puts()).toHaveLength(1);
  });

  it('a still-unsaved failed field survives the refresh while the saved one takes the server value', async () => {
    at('/assistant?tab=settings');
    const refresh = deferred<{ body: unknown }>();
    const s = scripted((url, init, gets) => {
      if (url === '/api/assistant/bot-tag')
        return {
          status: 409,
          body: { error: 'behaviour-disabled', title: 'Off', message: 'Off.' },
        };
      if (init?.method === 'PUT') return { body: { ok: true } };
      return gets === 1 ? { body: data() } : refresh.promise;
    });
    settingsPage();
    await pickOption('Club assistant', TAG);
    await pickOption('#it-services', LOG);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    await screen.findByText('Assistant requests now log to #it-services');
    await act(async () => {
      refresh.resolve({ body: { ...data(), settings: { logChannelId: 'chan-general' } } });
    });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: LOG }).textContent).toContain('#general'),
    );
    expect(screen.getByRole('combobox', { name: TAG }).textContent).toContain('Club assistant');
    expect(within(bar()!).getByText('1 unsaved change')).toBeTruthy();
    expect(s.puts()).toHaveLength(2);
  });

  it('while the refresh is pending or failed, the saved value stays shown and nothing is re-sent', async () => {
    at('/assistant?tab=settings');
    const s = scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return gets === 1 ? { body: data() } : { status: 500, body: { error: 'boom' } };
    });
    settingsPage();
    await pickOption('#it-services', LOG);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    await screen.findByText('Assistant requests now log to #it-services');
    await screen.findByRole('button', { name: 'Try again' });
    expect(s.puts()).toHaveLength(1);
  });
});
