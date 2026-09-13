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
