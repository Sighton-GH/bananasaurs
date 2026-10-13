// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Spinner } from './Spinner.js';
afterEach(cleanup);
it('label provides a named status with a decorative glyph', () => {
  render(<Spinner label="Loading" size="md" />);
  const glyph = screen.getByRole('status', { name: 'Loading' }).querySelector('svg');
  expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  expect(glyph?.getAttribute('width')).toBe('20');
  expect(glyph?.classList.contains('motion-reduce:animate-none')).toBe(true);
  expect(glyph?.classList.contains('animate-spin')).toBe(true);
});
it('unlabelled is decorative and defaults to small', () => {
  const { container } = render(<Spinner />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(container.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);
  expect(container.querySelector('svg')?.getAttribute('width')).toBe('16');
  expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
});
