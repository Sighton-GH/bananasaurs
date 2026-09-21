// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DataTable } from './DataTable.js';

// No global afterEach in this repo (vitest `globals` is off), so the
// library's auto-cleanup never registers — unmount between tests explicitly.
afterEach(cleanup);

describe('DataTable', () => {
  it('renders one header per column, one row per item, and a caption', () => {
    render(
      <DataTable
        caption="Two people"
        columns={[
          {
            key: 'name',
            header: 'Name',
            cell: (r: { id: string; name: string; n: number }) => r.name,
          },
          { key: 'n', header: 'Count', cell: (r) => r.n, numeric: true },
        ]}
        rows={[
          { id: 'a', name: 'Ada', n: 1 },
          { id: 'b', name: 'Bob', n: 2 },
        ]}
        rowKey={(r) => r.id}
      />,
    );
    expect(screen.getByRole('table', { name: 'Two people' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Name',
      'Count',
    ]);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('labels stacked cells with their column header for the mobile card layout', () => {
    render(
      <DataTable
        caption="One person"
        columns={[
          { key: 'name', header: 'Name', cell: (r: { id: string; name: string }) => r.name },
          { key: 'actions', header: '', cell: () => 'buttons' },
        ]}
        rows={[{ id: 'a', name: 'Ada' }]}
        rowKey={(r) => r.id}
      />,
    );
    expect(screen.getByText('Ada').closest('td')?.getAttribute('data-label')).toBe('Name');
    // An empty header (an actions column) gets no label.
    expect(screen.getByText('buttons').closest('td')?.hasAttribute('data-label')).toBe(false);
  });
});
