// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { RolePicker } from './RolePicker.js';

const roles = [
  { roleId: '123456789012345678', name: 'Engineering', managed: false },
  { roleId: '223456789012345678', name: 'Service bot', managed: true },
] as const;
function Harness() {
  const [value, setValue] = useState('');
  return (
    <RolePicker
      label="Role"
      hint="Exempt this role"
      error="Check this ID"
      value={value}
      onChange={setValue}
    />
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('preserves role name/ID filtering, pasted IDs, managed notice and field descriptions', async () => {
  stubFetch([{ url: '/api/guild/roles', body: { roles } }]);
  const user = userEvent.setup();
  renderWithSession(<Harness />);
  await screen.findByRole('button', { name: /@Engineering/ });
  const input = screen.getByRole('textbox', { name: 'Role' });
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const descriptions = input
    .getAttribute('aria-describedby')
    ?.split(' ')
    .map((id) => document.getElementById(id)?.textContent);
  expect(descriptions).toEqual(['Exempt this role', 'Check this ID']);
  await user.type(input, 'service');
  expect(screen.queryByRole('button', { name: /@Engineering/ })).toBeNull();
  expect(screen.getByRole('button', { name: /@Service bot.*Discord-managed/ })).toBeTruthy();
  await user.clear(input);
  await user.type(input, '223456');
  expect(screen.queryByRole('button', { name: /@Engineering/ })).toBeNull();
  expect(screen.getByRole('button', { name: /@Service bot/ })).toBeTruthy();
  await user.clear(input);
  await user.paste(roles[1].roleId);
  expect(input).toHaveProperty('value', roles[1].roleId);
  expect(screen.getByText('Selected: @Service bot (Discord-managed)')).toBeTruthy();
});
