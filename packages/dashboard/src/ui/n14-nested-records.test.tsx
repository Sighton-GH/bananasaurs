// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { KeyValueTable } from './KeyValueTable.js';
afterEach(cleanup);

it('renders the three-level redacted config as one table with stacked nested groups', () => {
  const { container } = render(
    <KeyValueTable
      data={{ guildId: '111111111111111111', providers: { gemini: { apiKey: '<redacted>' } } }}
    />,
  );
  expect(container.querySelectorAll('table')).toHaveLength(1);
  expect(container.querySelectorAll('table table')).toHaveLength(0);
  expect(screen.getByText('Providers')).toBeTruthy();
  expect(screen.getByText('Gemini')).toBeTruthy();
  expect(screen.getByText('Api key')).toBeTruthy();
  expect(screen.getByText('<redacted>')).toBeTruthy();
  // label association: the value is described by its term
  const term = screen.getByText('Api key');
  expect(term.tagName).toBe('DT');
  expect(term.nextElementSibling?.tagName).toBe('DD');
  expect(term.nextElementSibling?.textContent).toBe('<redacted>');
});

it('lets long keys and unbroken values wrap instead of widening the record', () => {
  const longKey = 'k'.repeat(80);
  const longValue = 'v'.repeat(200);
  const { container } = render(<KeyValueTable data={{ outer: { [longKey]: longValue } }} />);
  const dd = screen.getByText(longValue);
  expect(dd.className).toContain('[overflow-wrap:anywhere]');
  expect(screen.getByText(new RegExp(`^K{0,1}k{70}`)).className).toContain(
    '[overflow-wrap:anywhere]',
  );
  expect(container.innerHTML).not.toContain('overflow-hidden');
  expect(container.querySelector('table')?.className).toContain('min-w-0');
});

it('keeps explicit table roles so stacked small-screen rows stay accessible', () => {
  render(<KeyValueTable caption="C" data={{ a: 1 }} />);
  expect(screen.getByRole('table', { name: 'C' })).toBeTruthy();
  expect(screen.getByRole('row')).toBeTruthy();
  expect(screen.getByRole('rowheader', { name: 'A' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: '1' })).toBeTruthy();
});

it('keeps mixed arrays, empty records, nulls, booleans and numbers, none lost', () => {
  render(
    <KeyValueTable
      labels={{ custom: 'Shown as' }}
      data={{
        custom: { inner: { deepFlag: false, none: null, count: 1234567 } },
        empty: {},
        list: [{ name: 'Car', tags: ['a', 'b'] }, { name: 'Boat' }],
      }}
    />,
  );
  expect(screen.getByRole('rowheader', { name: 'Shown as' })).toBeTruthy();
  expect(screen.getByText('No')).toBeTruthy();
  expect(screen.getAllByText('—')).toHaveLength(2);
  expect(screen.getByText((1234567).toLocaleString())).toBeTruthy();
  expect(screen.getByText('a, b')).toBeTruthy();
  expect(screen.getByText('Boat')).toBeTruthy();
  expect(screen.getByText('Empty')).toBeTruthy();
});

it('falls back to a labelled code block past depth four without losing data', () => {
  const { container } = render(
    <KeyValueTable data={{ a: { b: { c: { d: { e: { apiKey: '<redacted>' } } } } } }} />,
  );
  const region = screen.getByRole('region', { name: 'E' });
  expect(within(region).getByRole('button', { name: 'Copy' })).toBeTruthy();
  expect(region.querySelector('code')?.textContent).toContain('<redacted>');
  expect(container.querySelectorAll('table table')).toHaveLength(0);
});
