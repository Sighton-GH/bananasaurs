// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(screen.getByRole('status').textContent).toContain('BANANASAURS_READONLY is set');
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
        return new Response(JSON.stringify({ error: 'wrong-password' }), { status: 401 });
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
    expect(screen.getByRole('status').textContent).toContain('Password not accepted');
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
