// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination.js';
afterEach(cleanup);
it('names its nav, shows the current page and changes page by keyboard', async () => {
  const change = vi.fn();
  render(<Pagination page={2} pageCount={5} onPageChange={change} />);
  expect(screen.getByRole('navigation', { name: 'Pages' })).toBeTruthy();
  expect(screen.getByText('Page 2 of 5')).toBeTruthy();
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{Enter}');
  expect(change).toHaveBeenLastCalledWith(1);
  await user.tab();
  await user.keyboard('{Enter}');
  expect(change).toHaveBeenLastCalledWith(3);
});
it('disables endpoint actions and allows a custom nav label', async () => {
  const change = vi.fn();
  const { rerender } = render(
    <Pagination page={1} pageCount={5} label="Task pages" onPageChange={change} />,
  );
  expect(screen.getByRole('navigation', { name: 'Task pages' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(true);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Previous' }));
  expect(change).not.toHaveBeenCalled();
  rerender(<Pagination page={5} pageCount={5} onPageChange={change} />);
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(false);
});
it('renders nothing for a single page or an empty result', () => {
  const { container, rerender } = render(
    <Pagination page={1} pageCount={1} onPageChange={vi.fn()} />,
  );
  expect(container.childElementCount).toBe(0);
  rerender(<Pagination page={1} pageCount={0} onPageChange={vi.fn()} />);
  expect(container.childElementCount).toBe(0);
});
