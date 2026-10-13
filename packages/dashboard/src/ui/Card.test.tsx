// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Card } from './Card.js';
afterEach(cleanup);
it('supports children alone with medium padding and panel radius', () => {
  render(<Card>Body</Card>);
  const card = screen.getByText('Body');
  expect(card.classList.contains('rounded-panel')).toBe(true);
  expect(card.classList.contains('p-3')).toBe(true);
  expect(screen.queryByRole('heading')).toBeNull();
});
it('renders title, description and actions in the header', () => {
  render(
    <Card title="Tasks" description="Your team" actions={<button>Add</button>}>
      Body
    </Card>,
  );
  const header = screen.getByRole('heading', { name: 'Tasks' }).parentElement?.parentElement;
  expect(header?.contains(screen.getByText('Your team'))).toBe(true);
  expect(screen.getByText('Your team').classList.contains('text-small')).toBe(true);
  expect(screen.getByText('Your team').classList.contains('text-ink-muted')).toBe(true);
  expect(header?.contains(screen.getByRole('button', { name: 'Add' }))).toBe(true);
  expect(screen.getByRole('heading').classList.contains('text-section')).toBe(true);
});
it('keeps the legacy action alias and supports no padding', () => {
  render(
    <Card title="Tasks" padding="none" action={<button>Clean up</button>}>
      Body
    </Card>,
  );
  expect(screen.getByRole('button', { name: 'Clean up' })).toBeTruthy();
  expect(screen.getByText('Body').closest('section')?.classList.contains('p-3')).toBe(false);
});
it('actions takes precedence over the legacy action when both are provided', () => {
  render(
    <Card title="Tasks" actions={<button>Add</button>} action={<button>Legacy</button>}>
      Body
    </Card>,
  );
  expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Legacy' })).toBeNull();
});
