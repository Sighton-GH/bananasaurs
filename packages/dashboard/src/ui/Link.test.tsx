// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Link } from './Link.js';
afterEach(cleanup);
it('internal links route with wouter and work with the keyboard', async () => {
  const location = memoryLocation({ path: '/', record: true });
  const user = userEvent.setup();
  render(
    <Router hook={location.hook}>
      <Link href="/tasks">Tasks</Link>
    </Router>,
  );
  const link = screen.getByRole('link', { name: 'Tasks' });
  expect(link.getAttribute('target')).toBeNull();
  await user.tab();
  expect(document.activeElement).toBe(link);
  await user.keyboard('{Enter}');
  expect(location.history.at(-1)).toBe('/tasks');
});
it('external links have a decorative icon and announce the new tab', () => {
  render(<Link href="https://discord.com/channels/1/2">Discord</Link>);
  const link = screen.getByRole('link', { name: 'Discord (opens in a new tab)' });
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noreferrer');
  expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByText('(opens in a new tab)').classList.contains('sr-only')).toBe(true);
});
it.each(['javascript:alert(1)', 'data:text/html,test', '//evil.invalid', '/\\evil.invalid'])(
  'unsafe href %s is plain text',
  (href) => {
    render(<Link href={href}>Unsafe</Link>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Unsafe').tagName).toBe('SPAN');
  },
);

it.each([
  '/\t/evil.invalid',
  '/\r/evil.invalid',
  '/\n/evil.invalid',
  ' /\t/evil.invalid',
  '/tasks\x00',
  '/tasks\x1f',
])('internal control-character bypass %j is plain text', (href) => {
  render(<Link href={href}>Unsafe</Link>);
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('Unsafe').tagName).toBe('SPAN');
});
