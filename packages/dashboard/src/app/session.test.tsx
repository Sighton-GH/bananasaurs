// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.js';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { useSession } from './session.js';

afterEach(cleanup);

function Probe() {
  const session = useSession();
  return (
    <>
      <button onClick={() => void session.write('/api/killswitch', { on: true })}>write</button>
      <button onClick={() => void session.logout()}>logout</button>
    </>
  );
}

interface Settled {
  readonly value: unknown;
  readonly error: unknown;
}

function ThrowProbe({ onSettled }: { readonly onSettled: (settled: Settled) => void }) {
  const session = useSession();
  return (
    <button
      onClick={() =>
        void session.writeOrThrow('/api/killswitch', { on: true }).then(
          (value) => onSettled({ value, error: undefined }),
          (error: unknown) => onSettled({ value: undefined, error }),
        )
      }
    >
      write-or-throw
    </button>
  );
}

function RethrowProbe({ onSettled }: { readonly onSettled: (settled: Settled) => void }) {
  const session = useSession();
  return (
    <button
      onClick={() =>
        void session.writeOrThrow('/api/killswitch', { on: true }, 'POST', [429]).then(
          (value) => onSettled({ value, error: undefined }),
          (error: unknown) => onSettled({ value: undefined, error }),
        )
      }
    >
      write-or-rethrow-429
    </button>
  );
}

describe('SessionProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('write sends the CSRF header and JSON body', async () => {
    const fetchMock = stubFetch([
      { method: 'POST', url: '/api/killswitch', body: { ok: true, killswitch: true } },
    ]);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/api/killswitch');
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-bananasaurs-csrf']).toBe(
      TEST_SESSION.csrfToken,
    );
    expect(bodyOf(call)).toEqual({ on: true });
  });

  it('a read-only 503 becomes a hold toast carrying the server message, not a thrown error', async () => {
    stubFetch([
      {
        method: 'POST',
        url: '/api/killswitch',
        status: 503,
        body: { error: 'read-only', message: 'BANANASAURS_READONLY is set' },
      },
    ]);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    expect(screen.getByRole('alert').textContent).toContain('BANANASAURS_READONLY is set');
  });

  it('a 401 reauth-required opens the re-auth dialog; confirming posts /api/reauth then retries once', async () => {
    let attempts = 0;
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/killswitch') {
        attempts += 1;
        return attempts === 1
          ? new Response(JSON.stringify({ error: 'reauth-required' }), { status: 401 })
          : new Response(JSON.stringify({ ok: true, killswitch: true }), { status: 200 });
      }
      if (url === '/api/reauth') {
        expect(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')).toEqual({
          password: 'hunter22hunter22',
        });
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', mock);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    fireEvent.change(dialog.querySelector('input[type=password]')!, {
      target: { value: 'hunter22hunter22' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(attempts).toBe(2);
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual([
      '/api/killswitch',
      '/api/reauth',
      '/api/killswitch',
    ]);
  });

  it('a PATCH that hits reauth-required retries through the same dialog as a PUT', async () => {
    let attempts = 0;
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/assistant/keys/key_a') {
        attempts += 1;
        return attempts === 1
          ? new Response(JSON.stringify({ error: 'reauth-required' }), { status: 401 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === '/api/reauth') {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', mock);
    function PatchProbe() {
      const session = useSession();
      return (
        <button
          onClick={() =>
            void session.write('/api/assistant/keys/key_a', { enabled: false }, 'PATCH')
          }
        >
          write-patch
        </button>
      );
    }
    renderWithSession(<PatchProbe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write-patch'));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    fireEvent.change(dialog.querySelector('input[type=password]')!, {
      target: { value: 'hunter22hunter22' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(attempts).toBe(2);
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual([
      '/api/assistant/keys/key_a',
      '/api/reauth',
      '/api/assistant/keys/key_a',
    ]);
  });

  it('cancelling re-auth abandons the write with no retry and no reauth call', async () => {
    const mock = stubFetch([
      { method: 'POST', url: '/api/killswitch', status: 401, body: { error: 'reauth-required' } },
    ]);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual(['/api/killswitch']);
    expect(screen.getByRole('status').textContent).toContain('Cancelled');
    expect(screen.getByRole('status').textContent).not.toContain('The request failed');
  });

  it("a rejected password shows 'Password not accepted' and does not retry the write", async () => {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/killswitch') {
        return new Response(JSON.stringify({ error: 'reauth-required' }), { status: 401 });
      }
      if (url === '/api/reauth') {
        return new Response(JSON.stringify({ error: 'invalid-credentials' }), { status: 401 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', mock);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'hunter22hunter22' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual(['/api/killswitch', '/api/reauth']);
    expect(screen.getByRole('alert').textContent).toContain('Password not accepted');
  });

  it("an expired session on a write shows 'Signed out' and calls onLoggedOut", async () => {
    const mock = stubFetch([
      { method: 'POST', url: '/api/killswitch', status: 401, body: { error: 'unauthenticated' } },
    ]);
    const onLoggedOut = vi.fn();
    renderWithSession(<Probe />, { onLoggedOut });
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    expect(screen.getByRole('alert').textContent).toContain('Signed out');
    expect(onLoggedOut).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual(['/api/killswitch']);
  });

  it('two concurrent writes queue their re-auth prompts instead of overwriting each other', async () => {
    const attempts: Record<string, number> = { '/api/a': 0, '/api/b': 0 };
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/a' || url === '/api/b') {
        const seen = attempts[url] ?? 0;
        attempts[url] = seen + 1;
        return seen === 0
          ? new Response(JSON.stringify({ error: 'reauth-required' }), { status: 401 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === '/api/reauth') {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', mock);
    function TwoWriters() {
      const session = useSession();
      return (
        <>
          <button onClick={() => void session.write('/api/a', { from: 'a' })}>write-a</button>
          <button onClick={() => void session.write('/api/b', { from: 'b' })}>write-b</button>
        </>
      );
    }
    renderWithSession(<TwoWriters />);
    await act(async () => {
      fireEvent.click(screen.getByText('write-a'));
      fireEvent.click(screen.getByText('write-b'));
    });
    // One dialog at a time: the second prompt waits for the first.
    expect(screen.getAllByRole('dialog', { name: 'Confirm your password' })).toHaveLength(1);
    const confirm = async () => {
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'hunter22hunter22' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      });
    };
    await confirm();
    // Confirming the first prompt opens the second, rather than both writes
    // sharing (or losing) one resolver.
    await screen.findByRole('dialog', { name: 'Confirm your password' });
    await confirm();
    await act(async () => {
      await Promise.resolve();
    });
    expect(attempts).toEqual({ '/api/a': 2, '/api/b': 2 });
    expect(mock.mock.calls.filter((c) => c[0] === '/api/reauth')).toHaveLength(2);
  });

  it('writeOrThrow on an expired session shows Signed out, calls onLoggedOut, and resolves undefined', async () => {
    stubFetch([
      { method: 'POST', url: '/api/killswitch', status: 401, body: { error: 'unauthenticated' } },
    ]);
    const onSettled = vi.fn();
    const onLoggedOut = vi.fn();
    renderWithSession(<ThrowProbe onSettled={onSettled} />, { onLoggedOut });
    await act(async () => {
      fireEvent.click(screen.getByText('write-or-throw'));
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0]).toEqual({ value: undefined, error: undefined });
    expect(screen.getByRole('alert').textContent).toContain('Signed out');
    expect(onLoggedOut).toHaveBeenCalledTimes(1);
  });

  it.each([401, 204])(
    'N17 explicit401 opt-in preserves logout and distinguishes HTTP%s',
    async (status) => {
      const mock = vi.fn(() =>
        Promise.resolve(
          status === 204
            ? new Response(null, { status: 204 })
            : new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }),
        ),
      );
      vi.stubGlobal('fetch', mock);
      const onLoggedOut = vi.fn();
      const onSettled = vi.fn();
      function Explicit401Probe() {
        const session = useSession();
        return (
          <button
            onClick={() =>
              void session.writeOrThrow('/api/example', undefined, 'DELETE', [401]).then(
                (value) => {
                  onSettled({ value, error: undefined });
                },
                (error: unknown) => {
                  onSettled({ value: undefined, error });
                },
              )
            }
          >
            explicit401
          </button>
        );
      }
      renderWithSession(<Explicit401Probe />, { onLoggedOut });
      await act(async () => {
        fireEvent.click(screen.getByText('explicit401'));
      });
      expect(mock).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      const settled = onSettled.mock.calls[0]![0] as Settled;
      expect(settled.value).toBeUndefined();
      if (status === 401) {
        expect(settled.error).toBeInstanceOf(ApiError);
        expect(onLoggedOut).toHaveBeenCalledOnce();
        expect(screen.getAllByRole('alert')).toHaveLength(1);
        expect(screen.getByRole('alert').textContent).toContain('Signed out');
      } else {
        expect(settled.error).toBeUndefined();
        expect(onLoggedOut).not.toHaveBeenCalled();
        expect(screen.queryByRole('alert')).toBeNull();
      }
    },
  );

  it('writeOrThrow rethrows a 409 so the caller can render it', async () => {
    stubFetch([{ method: 'POST', url: '/api/killswitch', status: 409, body: { error: 'exists' } }]);
    const onSettled = vi.fn();
    renderWithSession(<ThrowProbe onSettled={onSettled} />);
    await act(async () => {
      fireEvent.click(screen.getByText('write-or-throw'));
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    const settled = onSettled.mock.calls[0]![0] as Settled;
    expect(settled.value).toBeUndefined();
    expect(settled.error).toBeInstanceOf(ApiError);
    expect((settled.error as ApiError).status).toBe(409);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('writeOrThrow rethrows a listed extra status without a toast', async () => {
    stubFetch([
      { method: 'POST', url: '/api/killswitch', status: 429, body: { error: 'rate-limited' } },
    ]);
    const onSettled = vi.fn();
    renderWithSession(<RethrowProbe onSettled={onSettled} />);
    await act(async () => {
      fireEvent.click(screen.getByText('write-or-rethrow-429'));
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    const settled = onSettled.mock.calls[0]![0] as Settled;
    expect(settled.value).toBeUndefined();
    expect(settled.error).toBeInstanceOf(ApiError);
    expect((settled.error as ApiError).status).toBe(429);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('writeOrThrow without the option still toasts a 429 and resolves undefined', async () => {
    stubFetch([
      { method: 'POST', url: '/api/killswitch', status: 429, body: { error: 'rate-limited' } },
    ]);
    const onSettled = vi.fn();
    renderWithSession(<ThrowProbe onSettled={onSettled} />);
    await act(async () => {
      fireEvent.click(screen.getByText('write-or-throw'));
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0]).toEqual({ value: undefined, error: undefined });
    expect(screen.getByRole('alert').textContent).not.toBe('');
  });

  it('writeOrThrow on a read-only 503 shows the hold toast and resolves undefined', async () => {
    stubFetch([
      {
        method: 'POST',
        url: '/api/killswitch',
        status: 503,
        body: { error: 'read-only', message: 'BANANASAURS_READONLY is set' },
      },
    ]);
    const onSettled = vi.fn();
    renderWithSession(<ThrowProbe onSettled={onSettled} />);
    await act(async () => {
      fireEvent.click(screen.getByText('write-or-throw'));
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0]).toEqual({ value: undefined, error: undefined });
    expect(screen.getByRole('alert').textContent).toContain('BANANASAURS_READONLY is set');
  });

  it('a 403 owner-protected refusal shows the server sentence, not the raw code', async () => {
    stubFetch([
      {
        method: 'POST',
        url: '/api/killswitch',
        status: 403,
        body: {
          error: 'owner-protected',
          title: "That can't be changed",
          message: "The owner account can't be changed.",
        },
      },
    ]);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    expect(screen.getByRole('alert').textContent).toContain("The owner account can't be changed.");
    expect(screen.getByText("The owner account can't be changed.").textContent).not.toContain(
      'owner-protected',
    );
  });

  it('logout posts with the CSRF header and calls onLoggedOut', async () => {
    const mock = stubFetch([{ method: 'POST', url: '/api/logout', body: {} }]);
    const onLoggedOut = vi.fn();
    renderWithSession(<Probe />, { onLoggedOut });
    await act(async () => {
      fireEvent.click(screen.getByText('logout'));
    });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-bananasaurs-csrf']).toBe(
      TEST_SESSION.csrfToken,
    );
    expect(onLoggedOut).toHaveBeenCalledTimes(1);
  });
});
