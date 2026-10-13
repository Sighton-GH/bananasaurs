// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { Route } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../api.js';
import { SessionProvider } from '../../app/session.js';
import type { Resource } from '../../hooks/useResource.js';
import { TEST_SESSION } from '../../test-support.js';
import { AssistantPage } from '../assistant.js';
import { AssistantBehaviourDetailPage } from './detail.js';
import { useStickyResource, type Tagged } from './sticky-resource.js';

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

describe('B1: a stale prompt draft is never sent with a reloaded revision', () => {
  const MINE = 'My unsaved rewrite.';
  const conflictFlow = () => {
    at('/assistant/behaviours/club?tab=prompt');
    const s = scripted((url, init, gets) => {
      if (init?.method === 'PUT')
        return {
          status: 409,
          body: { error: 'conflict', title: 'Changed elsewhere', message: 'Revision moved.' },
        };
      if (url === '/api/assistant')
        return {
          body:
            gets === 1
              ? data()
              : data(club({ systemPrompt: 'Someone else wrote this.', promptVersion: 2 })),
        };
      return { status: 404, body: {} };
    });
    detail();
    return s;
  };

  it('holds the draft, blocks Save and sends nothing after a 409 and reload', async () => {
    const s = conflictFlow();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    expect(await screen.findByText('These instructions changed elsewhere.')).toBeTruthy();
    expect(promptBox().value).toBe(MINE);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save instructions' }).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    expect(s.puts()).toHaveLength(1);
  });

  it('Use the latest instructions resets the box to the reloaded text', async () => {
    conflictFlow();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use the latest instructions' }));
    expect(promptBox().value).toBe('Someone else wrote this.');
    expect(screen.queryByText('These instructions changed elsewhere.')).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save instructions' }).disabled,
    ).toBe(true);
  });

  it('Keep my text re-bases the draft on the latest revision, and only then can it be sent', async () => {
    const s = conflictFlow();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keep my text on the latest revision' }),
    );
    expect(promptBox().value).toBe(MINE);
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    await waitFor(() => expect(s.puts()).toHaveLength(2));
    expect(s.puts()[1]!.body).toMatchObject({ systemPrompt: MINE, promptVersion: 2 });
  });

  it('an ordinary toggle reload keeps the draft and raises no conflict', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return { body: gets === 1 ? data() : data(club({ enabled: false })) };
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off - members will get no answer' }));
    await screen.findByText('Club assistant disabled');
    await screen.findByRole('button', { name: 'Turn on assistant' });
    expect(promptBox().value).toBe(MINE);
    expect(screen.queryByText('These instructions changed elsewhere.')).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save instructions' }).disabled,
    ).toBe(false);
  });

  it('a successful own save reloads without a conflict and shows the saved text', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    const s = scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return {
        body: gets === 1 ? data() : data(club({ systemPrompt: MINE, promptVersion: 2 })),
      };
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.change(promptBox(), { target: { value: MINE } });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    await screen.findByText('Club assistant prompt saved');
    await waitFor(() => expect(screen.getByText(/Revision 2/)).toBeTruthy());
    expect(screen.queryByText('These instructions changed elsewhere.')).toBeNull();
    expect(promptBox().value).toBe(MINE);
    expect(s.puts()).toHaveLength(1);
  });

  it('an access draft survives a reload (last-write-wins by design, no version check)', async () => {
    at('/assistant/behaviours/club?tab=access');
    scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return { body: gets === 1 ? data() : data(club({ enabled: false })) };
    });
    detail();
    const region = await screen.findByRole('region', { name: 'Caller roles' });
    expect(within(region).getByRole('checkbox', { name: 'Club Member' })).toBeTruthy();
  });
});

describe('B2: sticky data belongs to one identity and never survives an error', () => {
  type R = Resource<Tagged<string>>;
  const ready = (d: string, identity = 'acct|g1'): R => ({
    state: 'ready',
    data: { identity, data: d },
  });
  const loading: R = { state: 'loading' };
  const error: R = {
    state: 'error',
    request: 'x',
    message: 'm',
    error: new Error('m'),
    retry: () => undefined,
  };
  const run = (steps: readonly [R, string][]) => {
    const { result, rerender } = renderHook(
      ({ r, id }: { r: R; id: string }) => useStickyResource(r, id),
      { initialProps: { r: steps[0]![0], id: steps[0]![1] } },
    );
    const seen = [result.current];
    for (const [r, id] of steps.slice(1)) {
      rerender({ r, id });
      seen.push(result.current);
    }
    return seen;
  };

  it('keeps the previous data while the same identity reloads', () => {
    const seen = run([
      [ready('A'), 'acct|g1'],
      [loading, 'acct|g1'],
    ]);
    expect(seen[1]).toEqual({ state: 'ready', data: 'A' });
  });

  it('shows loading, not the old guild, when the identity changes', () => {
    const seen = run([
      [ready('A'), 'acct|g1'],
      [loading, 'acct|g2'],
    ]);
    expect(seen[1]!.state).toBe('loading');
  });

  it('treats a ready result stamped with another identity as loading (the one stale render)', () => {
    const seen = run([
      [ready('A'), 'acct|g1'],
      [ready('A'), 'acct|g2'],
    ]);
    expect(seen[1]!.state).toBe('loading');
  });

  it('shows loading on a retry after an error, not the data from before it', () => {
    const seen = run([
      [ready('A'), 'acct|g1'],
      [error, 'acct|g1'],
      [loading, 'acct|g1'],
    ]);
    expect(seen[1]!.state).toBe('error');
    expect(seen[2]!.state).toBe('loading');
  });

  it('page: a guild switch never shows the previous guild as ready', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    const second = deferred<{ body: unknown }>();
    scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return gets === 1 ? { body: data() } : second.promise;
    });
    const view = detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    view.rerender(
      <SessionProvider
        session={{ ...TEST_SESSION, guildId: 'other-guild' }}
        onLoggedOut={() => undefined}
      >
        <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />
      </SessionProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Club assistant' })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: /Turn off|Turn on/ })).toBeNull();
    await act(async () => {
      second.resolve({ body: data(club({ id: 'club', name: 'Other guild club' })) });
    });
    expect(await screen.findByRole('heading', { name: 'Other guild club' })).toBeTruthy();
  });

  it('page: a failed reload then retry shows loading, not the older ready data', async () => {
    at('/assistant/behaviours/club?tab=prompt');
    const third = deferred<{ body: unknown }>();
    scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      if (gets === 1) return { body: data() };
      if (gets === 2) return { status: 500, body: { error: 'boom' } };
      return third.promise;
    });
    detail();
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off - members will get no answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Club assistant' })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: /Turn off|Turn on/ })).toBeNull();
    await act(async () => {
      third.resolve({ body: data() });
    });
    expect(await screen.findByRole('heading', { name: 'Club assistant' })).toBeTruthy();
  });
});

describe('S1: Settings save advances the baseline without waiting for the refresh', () => {
  const settingsPage = () =>
    render(
      <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
        <AssistantPage />
      </SessionProvider>,
    );
  const LOG = 'Post every assistant request to';
  const TAG = 'When someone tags @Bananasaurs, answer with';
  const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

  it('a second Save while the refresh is pending sends no second PUT', async () => {
    at('/assistant?tab=settings');
    const refresh = deferred<{ body: unknown }>();
    const s = scripted((_url, init, gets) => {
      if (init?.method === 'PUT') return { body: { ok: true } };
      return gets === 1 ? { body: data() } : refresh.promise;
    });
    settingsPage();
    fireEvent.change(await screen.findByLabelText(LOG), { target: { value: 'chan-it' } });
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    await screen.findByText('Assistant requests now log to #it-services');
    // The refresh has not returned, yet nothing is left to save.
    expect(bar()).toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>(LOG).value).toBe('chan-it');
    expect(s.puts()).toHaveLength(1);
    await act(async () => {
      refresh.resolve({ body: { ...data(), settings: { logChannelId: 'chan-it' } } });
    });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>(LOG).value).toBe('chan-it'),
    );
    expect(bar()).toBeNull();
    expect(s.puts()).toHaveLength(1);
  });

  it('partial failure (tag 409, log ok): only the failed field stays dirty while the refresh is pending', async () => {
    at('/assistant?tab=settings');
    const refresh = deferred<{ body: unknown }>();
    const s = scripted((url, init, gets) => {
      if (url === '/api/assistant/bot-tag')
        return {
          status: 409,
          body: { error: 'behaviour-disabled', title: 'That behaviour is off', message: 'Off.' },
        };
      if (init?.method === 'PUT') return { body: { ok: true } };
      return gets === 1 ? { body: data() } : refresh.promise;
    });
    settingsPage();
    fireEvent.change(await screen.findByLabelText(TAG), { target: { value: 'club' } });
    fireEvent.change(screen.getByLabelText(LOG), { target: { value: 'chan-general' } });
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    await screen.findByText('Assistant requests now log to #general');
    expect(await screen.findByText('That behaviour is off')).toBeTruthy();
    expect(within(bar()!).getByText('1 unsaved change')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>(TAG).value).toBe('club');
    // Retrying re-sends only the refused field.
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(s.puts()).toHaveLength(3));
    expect(s.puts().map((c) => c.url)).toEqual([
      '/api/assistant/bot-tag',
      '/api/assistant/log-channel',
      '/api/assistant/bot-tag',
    ]);
  });

  it('discard sends nothing, and a reload error keeps dirty drafts and says so', async () => {
    at('/assistant?tab=settings');
    const s = scripted((url, _init, gets) => {
      if (url === '/api/assistant/bot-tag') return { body: { ok: true } };
      if (url === '/api/assistant/log-channel') return { status: 500, body: { error: 'boom' } };
      if (gets === 1) return { body: data() };
      if (gets === 2) return { status: 500, body: { error: 'boom' } };
      return { body: data() };
    });
    settingsPage();
    fireEvent.change(await screen.findByLabelText(TAG), { target: { value: 'club' } });
    fireEvent.change(screen.getByLabelText(LOG), { target: { value: 'chan-it' } });
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    // Tag saved, log failed (draft kept), and the reload then errors.
    await screen.findByText(/You have unsaved Settings changes/);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText(LOG)).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>(LOG).value).toBe('chan-it');
    expect(within(bar()!).getByText('1 unsaved change')).toBeTruthy();
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Discard' }));
    expect(bar()).toBeNull();
    expect(s.puts().map((c) => c.url)).toEqual([
      '/api/assistant/bot-tag',
      '/api/assistant/log-channel',
    ]);
  });
});
