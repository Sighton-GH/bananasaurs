// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { KeyValueTable } from './KeyValueTable.js';
afterEach(cleanup);
it('renders labelled keys and locale-formatted scalar values', () => {
  render(
    <KeyValueTable
      caption="Settings"
      labels={{ enabled: 'Turned on' }}
      data={{ requestTimeoutMs: 12000, enabled: true, paused: false, missing: null }}
    />,
  );
  expect(screen.getByRole('table', { name: 'Settings' })).toBeTruthy();
  expect(screen.getAllByRole('row')).toHaveLength(4);
  expect(screen.getByRole('rowheader', { name: 'Request timeout ms' })).toBeTruthy();
  expect(screen.getByRole('rowheader', { name: 'Turned on' })).toBeTruthy();
  for (const value of ['Yes', 'No', '—', (12000).toLocaleString()])
    expect(screen.getByRole('cell', { name: value })).toBeTruthy();
});
it('renders nested objects, scalar arrays and object arrays without losing values', () => {
  render(
    <KeyValueTable
      data={{
        nested: { teamName: 'Car' },
        scalars: ['text', 1000, true, false, null],
        teams: [{ name: 'Car' }, { name: 'Boat' }],
      }}
    />,
  );
  expect(screen.getAllByRole('table')).toHaveLength(1);
  expect(
    screen.getByRole('cell', { name: `text, ${(1000).toLocaleString()}, Yes, No, —` }),
  ).toBeTruthy();
  expect(screen.getByText('Boat')).toBeTruthy();
  expect(screen.getByText('Team name')).toBeTruthy();
});
it('keeps four nested levels as stacked groups and renders deeper subtrees as copyable code', () => {
  const subtree = { secret: 'deep' };
  render(<KeyValueTable data={{ one: { two: { three: { four: { five: subtree } } } } }} />);
  expect(screen.getAllByRole('table')).toHaveLength(1);
  expect(screen.getByText('Four')).toBeTruthy();
  const region = screen.getByRole('region', { name: 'Five' });
  expect(region.querySelector('code')?.textContent).toBe(JSON.stringify(subtree, null, 2));
  expect(within(region).getByRole('button', { name: 'Copy' })).toBeTruthy();
});

it('counts nested arrays toward the depth limit too', () => {
  render(<KeyValueTable data={{ nested: [[[[[{ value: 'deep array' }]]]]] }} />);
  expect(screen.getAllByRole('table')).toHaveLength(1);
  expect(screen.getByRole('region').querySelector('code')?.textContent).toContain('deep array');
});
