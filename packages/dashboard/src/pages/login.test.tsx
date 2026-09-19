// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, stubFetch } from '../test-support.js';
import { BootstrapForm, LoginForm } from './login.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('LoginForm', () => {
  it('posts { username, password } to /api/login and calls onSignedIn on 200', async () => {
    const mock = stubFetch([{ method: 'POST', url: '/api/login', body: {} }]);
    const onSignedIn = vi.fn();
    render(<LoginForm onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(bodyOf(mock.mock.calls[0]!)).toEqual({
      username: 'owner',
      password: 'correct horse battery',
    });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('shows the lock-out message on locked-out', async () => {
    stubFetch([{ method: 'POST', url: '/api/login', status: 429, body: { error: 'locked-out' } }]);
    render(<LoginForm onSignedIn={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('temporarily locked');
  });

  it('shows no guild choice before the server asks for one', async () => {
    stubFetch([{ method: 'POST', url: '/api/login', body: {} }]);
    render(<LoginForm onSignedIn={() => undefined} />);
    expect(screen.queryByLabelText('Server')).toBeNull();
  });

  it('offers the server’s guild choices after guild-required and re-posts with guildId', async () => {
    const bodies: unknown[] = [];
    const mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body !== undefined ? JSON.parse(init.body as string) : undefined);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: 'guild-required',
            choices: [
              { guildId: '111111111111111111', name: 'Dev' },
              { guildId: '222222222222222222', name: 'Club' },
            ],
          }),
          { status: 401 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', mock);
    const onSignedIn = vi.fn();
    render(<LoginForm onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    const select = screen.getByLabelText('Server');
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Dev',
      'Club',
    ]);
    fireEvent.change(select, { target: { value: '222222222222222222' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(bodies[0]).toEqual({ username: 'owner', password: 'correct horse battery' });
    expect(bodies[1]).toEqual({
      username: 'owner',
      password: 'correct horse battery',
      guildId: '222222222222222222',
    });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });
});

describe('BootstrapForm', () => {
  it('posts { token, username, password } to /api/bootstrap and joins issues on failure', async () => {
    const mock = stubFetch([
      {
        method: 'POST',
        url: '/api/bootstrap',
        status: 400,
        body: { error: 'bad-request', issues: ['too short', 'too common'] },
      },
    ]);
    render(<BootstrapForm token="tok" onSignedIn={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create owner account' }));
    });
    expect(bodyOf(mock.mock.calls[0]!)).toEqual({
      token: 'tok',
      username: 'owner',
      password: 'short',
    });
    expect(screen.getByRole('alert').textContent).toBe('too short; too common');
  });
});
