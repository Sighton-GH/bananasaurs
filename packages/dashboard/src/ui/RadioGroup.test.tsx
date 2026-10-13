// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RadioGroup } from './RadioGroup.js';
afterEach(cleanup);
const options = [
  { value: 'a', label: 'Alpha', hint: 'First team' },
  { value: 'b', label: 'Beta' },
];
it('fieldset has a legend and hints describe, not name, the radio', () => {
  render(<RadioGroup legend="Team" name="team" value="a" onChange={vi.fn()} options={options} />);
  expect(screen.getByRole('group', { name: 'Team' }).tagName).toBe('FIELDSET');
  for (const input of screen.getAllByRole<HTMLInputElement>('radio'))
    expect(input.name).toBe('team');
  const radio = screen.getByRole('radio', { name: 'Alpha' });
  expect(document.getElementById(radio.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
    'First team',
  );
  expect(screen.getByRole('radio', { name: 'Beta' }).getAttribute('aria-describedby')).toBeNull();
});
it('tab and native arrow keys change selection', async () => {
  const changed = vi.fn();
  const user = userEvent.setup();
  function Fixture() {
    const [value, setValue] = useState('a');
    return (
      <RadioGroup
        legend="Team"
        name="team"
        value={value}
        onChange={(v) => {
          setValue(v);
          changed(v);
        }}
        options={options}
        orientation="horizontal"
      />
    );
  }
  render(<Fixture />);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Alpha' }));
  await user.keyboard('{ArrowRight}');
  expect(changed).toHaveBeenLastCalledWith('b');
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Beta' }).checked).toBe(true);
  await user.keyboard('{ArrowLeft}');
  expect(changed).toHaveBeenLastCalledWith('a');
});
it('hint ids are unique across multiple groups', () => {
  render(
    <>
      <RadioGroup legend="One" name="one" value={undefined} onChange={vi.fn()} options={options} />
      <RadioGroup legend="Two" name="two" value={undefined} onChange={vi.fn()} options={options} />
    </>,
  );
  const ids = screen
    .getAllByRole('radio', { name: 'Alpha' })
    .map((r) => r.getAttribute('aria-describedby'));
  expect(new Set(ids).size).toBe(2);
});
