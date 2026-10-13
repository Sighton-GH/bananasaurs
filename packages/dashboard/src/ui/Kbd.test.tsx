// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Kbd } from './Kbd.js';
afterEach(cleanup);
it('uses a semantic keyboard element and caption mono type', () => {
  render(<Kbd>Enter</Kbd>);
  const key = screen.getByText('Enter');
  expect(key.tagName).toBe('KBD');
  expect(key.classList.contains('font-mono')).toBe(true);
  expect(key.classList.contains('text-caption')).toBe(true);
});
