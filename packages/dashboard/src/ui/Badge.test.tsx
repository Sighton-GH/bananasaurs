// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Badge } from './Badge.js';
import { IconCheck } from './icons.js';
afterEach(cleanup);
it.each(['neutral', 'progress', 'hold', 'ok', 'danger'] as const)(
  'uses tinted %s tokens',
  (tone) => {
    render(<Badge tone={tone}>Status</Badge>);
    const badge = screen.getByText('Status');
    for (const token of [`border-tone-${tone}`, `bg-tone-${tone}-bg`, `text-tone-${tone}-ink`]) {
      expect(badge.classList.contains(token)).toBe(true);
    }
  },
);
it('supports accent tone', () => {
  render(<Badge tone="accent">Selected</Badge>);
  for (const token of ['bg-accent-bg', 'border-accent', 'text-accent']) {
    expect(screen.getByText('Selected').classList.contains(token)).toBe(true);
  }
});
it('renders an icon decoratively before the text', () => {
  render(<Badge icon={IconCheck}>Done</Badge>);
  const badge = screen.getByText('Done');
  expect(badge.firstElementChild?.tagName.toLowerCase()).toBe('svg');
  expect(badge.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
});
