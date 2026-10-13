// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { useResource } from '../hooks/useResource.js';
import { ApiError } from '../api.js';
import { DataState } from './DataState.js';

// No global afterEach in this repo (vitest `globals` is off), so the
// library's auto-cleanup never registers — unmount between tests explicitly.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DataState', () => {
  it('retries a real pending load with Tab and Enter after 10 seconds', async () => {
    const load = vi.fn<() => Promise<string>>().mockImplementation(() => new Promise(() => {}));
    function Probe() {
      const { resource } = useResource('the audit log', load);
      return <DataState resource={resource}>{(data) => <p>{data}</p>}</DataState>;
    }
    render(<Probe />);
    expect(load).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByText('Still loading. This is taking longer than usual.')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Try again' });
    vi.useRealTimers();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(retry);
    await user.keyboard('{Enter}');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('announces loading through a status region', () => {
    render(<DataState resource={{ state: 'loading' }}>{() => <p>never</p>}</DataState>);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByRole('status').getAttribute('aria-label')).toContain('Loading');
    expect(screen.queryByText('never')).toBeNull();
  });

  it('names the failed request and offers a retry that calls back', () => {
    const retry = vi.fn();
    render(
      <DataState
        resource={{
          state: 'error',
          request: 'the audit log',
          message: 'boom',
          error: new Error('boom'),
          retry,
        }}
      >
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load the audit log");
    expect(screen.getByRole('alert').textContent).toContain('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders a server answer with its title, hint and request id', () => {
    const retry = vi.fn();
    render(
      <DataState
        resource={{
          state: 'error',
          request: 'the assistant',
          message: 'internal',
          error: new ApiError(500, {
            error: 'internal',
            title: 'Something went wrong inside Bananasaurs',
            message: 'Nothing was changed. The daemon log has the detail under this request id.',
            hint: 'Search the journal for the request id shown below.',
            requestId: 'req-0a1b2c3d',
          }),
          retry,
        }}
      >
        {() => <p>never</p>}
      </DataState>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Something went wrong inside Bananasaurs');
    expect(alert.textContent).toContain('Search the journal for the request id shown below.');
    expect(alert.textContent).toContain('req-0a1b2c3d');
    expect(alert.textContent).toContain("Couldn't load the assistant");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('never')).toBeNull();
  });

  it('renders the empty node instead of children when isEmpty says so', () => {
    render(
      <DataState
        resource={{ state: 'ready', data: [] as string[] }}
        isEmpty={(d) => d.length === 0}
        empty={<p>Add one.</p>}
      >
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByText('Add one.')).toBeTruthy();
    expect(screen.queryByText('never')).toBeNull();
  });

  it('renders children with the data, and a degraded reason when given', () => {
    render(
      <DataState resource={{ state: 'ready', data: 'x', degraded: 'Gateway is reconnecting' }}>
        {(d) => <p>got {d}</p>}
      </DataState>,
    );
    expect(screen.getByText('got x')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Gateway is reconnecting');
  });

  it('shows Forbidden for a 403 with the server title and no Try again', () => {
    render(
      <DataState
        resource={{
          state: 'error',
          request: 'accounts',
          message: 'owner-only',
          error: new ApiError(403, {
            error: 'owner-only',
            title: 'Only the owner can do this',
            message: 'Owner accounts only.',
          }),
          retry: vi.fn(),
        }}
      >
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Only the owner can do this');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows NotFound for a 404', () => {
    render(
      <DataState
        resource={{
          state: 'error',
          request: 'This task',
          message: 'nf',
          error: new ApiError(404, { error: 'not-found' }),
          retry: vi.fn(),
        }}
      >
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByText("This task doesn't exist or was deleted")).toBeTruthy();
  });

  it('renders the notFound node for a 404 when given', () => {
    render(
      <DataState
        resource={{
          state: 'error',
          request: 'x',
          message: 'nf',
          error: new ApiError(404, { error: 'not-found' }),
          retry: vi.fn(),
        }}
        notFound={<p>Custom gone.</p>}
      >
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByText('Custom gone.')).toBeTruthy();
  });

  it('treats a stray 401 as Unavailable', () => {
    render(
      <DataState
        resource={{
          state: 'error',
          request: 'x',
          message: 'u',
          error: new ApiError(401, { error: 'unauthorized' }),
          retry: vi.fn(),
        }}
      >
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load x");
  });

  it('uses emptyTitle and emptyAction in the default empty state', () => {
    render(
      <DataState
        resource={{ state: 'ready', data: [] as string[] }}
        isEmpty={(d) => d.length === 0}
        emptyTitle="No tasks"
        emptyAction={<button>Add task</button>}
      >
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByRole('region', { name: 'No tasks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add task' })).toBeTruthy();
  });
});
