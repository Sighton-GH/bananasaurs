// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable } from './DataTable.js';

describe('DataTable', () => {
  it('renders one header per column, one row per item, and a caption', () => {
    render(
      <DataTable
        caption="Two people"
        columns={[
          { key: 'name', header: 'Name', cell: (r: { id: string; name: string; n: number }) => r.name },
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
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Count']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('Bob')).toBeTruthy();
  });
});
