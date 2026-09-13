// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataState } from './DataState.js';

describe('DataState', () => {
  it('announces loading through a status region', () => {
    render(<DataState resource={{ state: 'loading' }}>{() => <p>never</p>}</DataState>);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByText('never')).toBeNull();
  });

  it('names the failed request and offers a retry that calls back', () => {
    const retry = vi.fn();
    render(
      <DataState resource={{ state: 'error', request: 'the audit log', message: 'boom', retry }}>
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Could not load the audit log: boom');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
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
