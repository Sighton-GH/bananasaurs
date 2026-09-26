// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.js';
import { DataState } from './DataState.js';

// No global afterEach in this repo (vitest `globals` is off), so the
// library's auto-cleanup never registers — unmount between tests explicitly.
afterEach(cleanup);

describe('DataState', () => {
  it('announces loading through a status region', () => {
    render(<DataState resource={{ state: 'loading' }}>{() => <p>never</p>}</DataState>);
    expect(screen.getByRole('status').textContent).toContain('Loading');
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
    expect(screen.getByText('Could not load the audit log.')).toBeTruthy();
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
    expect(screen.getByText('Could not load the assistant.')).toBeTruthy();
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
    expect(screen.getByRole('status').textContent).toContain('Gateway is reconnecting');
  });
});
