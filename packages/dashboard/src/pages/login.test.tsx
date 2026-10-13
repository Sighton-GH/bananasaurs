// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, stubFetch } from '../test-support.js';
import { ThemeProvider } from '../app/theme.js';
import { BootstrapForm, LoginForm } from './login.js';

// jsdom lacks these DOM APIs called by Radix Select (same shim as ui/Select.test.tsx).
const dom = globalThis as unknown as { Element: { prototype: Record<string, unknown> } };
dom.Element.prototype.hasPointerCapture ??= () => false;
dom.Element.prototype.releasePointerCapture ??= () => undefined;
dom.Element.prototype.scrollIntoView ??= () => undefined;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const renderForm = (node: React.ReactElement) => render(<ThemeProvider>{node}</ThemeProvider>);

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('LoginForm', () => {
  it('posts { username, password } to /api/login and calls onSignedIn on 200', async () => {
    const mock = stubFetch([{ method: 'POST', url: '/api/login', body: {} }]);
    const onSignedIn = vi.fn();
    renderForm(<LoginForm onSignedIn={onSignedIn} />);
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
    renderForm(<LoginForm onSignedIn={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('temporarily locked');
  });

  it('shows no guild choice before the server asks for one', async () => {
    stubFetch([{ method: 'POST', url: '/api/login', body: {} }]);
    renderForm(<LoginForm onSignedIn={() => undefined} />);
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
    renderForm(<LoginForm onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    const select = screen.getByRole('combobox', { name: 'Server' });
    expect(document.querySelector('select:not([aria-hidden="true"])')).toBeNull();
    const user = userEvent.setup();
    await user.click(select);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Dev', 'Club']);
    await user.click(screen.getByRole('option', { name: 'Club' }));
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

describe('login chrome (7c)', () => {
  it('keeps brand, theme toggle and attribution; the heading uses title tokens, no legacy classes', () => {
    renderForm(<LoginForm onSignedIn={vi.fn()} />);
    const h1 = screen.getByRole('heading', { level: 1, name: 'Bananasaurs' });
    expect(h1.className).toContain('text-title');
    expect(document.querySelector('.login-backdrop')).toBeTruthy();
    expect(
      h1.parentElement?.querySelector('.text-xl, .text-xs, .rounded-md, .rounded-sm'),
    ).toBeNull();
    expect(document.querySelector('input[type="password"]')?.getAttribute('autocomplete')).toBe(
      'current-password',
    );
  });
});

describe('BootstrapForm', () => {
  it('posts { token, username, password } to /api/bootstrap on success', async () => {
    const mock = stubFetch([{ method: 'POST', url: '/api/bootstrap', body: { ok: true } }]);
    const onSignedIn = vi.fn();
    renderForm(<BootstrapForm token="tok" onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a long enough password' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create owner account' }));
    });
    expect(bodyOf(mock.mock.calls[0]!)).toEqual({
      token: 'tok',
      username: 'owner',
      password: 'a long enough password',
    });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('renders a 400 bootstrap refusal with the server title, hint, request id and field problem', async () => {
    stubFetch([
      {
        method: 'POST',
        url: '/api/bootstrap',
        status: 400,
        body: {
          error: 'bad-request',
          title: 'The request was not valid',
          message: 'One or more fields were missing or had the wrong format.',
          hint: 'Fix the highlighted fields and try again.',
          fields: [{ path: 'username', problem: 'too_small' }],
          requestId: 'req-0a1b2c3d',
        },
      },
    ]);
    renderForm(<BootstrapForm token="tok" onSignedIn={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ab' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a long enough password' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create owner account' }));
    });
    expect(await screen.findByText('The request was not valid')).toBeTruthy();
    const notice = (await screen.findAllByRole('alert')).find((a) =>
      a.textContent?.includes('The request was not valid'),
    )!;
    expect(notice.textContent).toContain('Fix the highlighted fields and try again.');
    expect(notice.textContent).toContain('req-0a1b2c3d');
    expect(notice.textContent).toContain('bad-request · HTTP 400 · request req-0a1b2c3d');
    expect(screen.getByText('Too small.')).toBeTruthy();
    // The code survives only inside the `code · HTTP n · request id` meta line.
    expect(screen.getAllByText(/bad-request/)).toHaveLength(1);
  });
});
