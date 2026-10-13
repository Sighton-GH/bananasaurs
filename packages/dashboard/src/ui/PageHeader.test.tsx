// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { PageHeader } from './PageHeader.js';

afterEach(cleanup);
const wrap = (ui: React.ReactNode) => {
  const { hook } = memoryLocation({ path: '/' });
  return render(<Router hook={hook}>{ui}</Router>);
};

it('renders heading classes, purpose and actions without crumbs', () => {
  wrap(<PageHeader title="Tasks" purpose="All tasks." actions={<button>Go</button>} />);
  const h1 = screen.getByRole('heading', { level: 1, name: 'Tasks' });
  expect(h1.className).toContain('text-title');
  expect(h1.className).toContain('font-semibold');
  expect(screen.getByText('All tasks.').className).toContain('text-small');
  expect(screen.getByText('All tasks.').className).toContain('text-ink-muted');
  expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy();
  expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
});

it('renders ordered linked ancestors then the current title as plain text', () => {
  wrap(
    <PageHeader
      title="Fix the sink"
      purpose="p"
      crumbs={[
        { label: 'Tasks', href: '/tasks' },
        { label: 'Teams', href: '/tasks/teams' },
      ]}
    />,
  );
  const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
  const links = within(nav).getAllByRole('link');
  expect(links.map((l) => l.textContent)).toEqual(['Tasks', 'Teams']);
  expect(links.map((l) => l.getAttribute('href'))).toEqual(['/tasks', '/tasks/teams']);
  const current = nav.querySelector('[aria-current="page"]')!;
  expect(current.textContent).toBe('Fix the sink');
  expect(within(current as HTMLElement).queryByRole('link')).toBeNull();
  expect(nav.querySelectorAll('[aria-current]').length).toBe(1);
});

it('places status after the header row, with no role added', () => {
  const { container } = wrap(
    <PageHeader title="T" purpose="p" status={<span data-testid="st">ok</span>} />,
  );
  const st = screen.getByTestId('st');
  expect(st.closest('[role]')).toBeNull();
  const h1 = container.querySelector('h1')!;
  expect(h1.compareDocumentPosition(st) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('wraps long titles, crumbs and actions rather than clipping', () => {
  wrap(
    <PageHeader
      title={'x'.repeat(200)}
      purpose="p"
      crumbs={[{ label: 'y'.repeat(100), href: '/a' }]}
      actions={<button>A</button>}
    />,
  );
  expect(screen.getByRole('heading', { level: 1 }).className).toContain('break-words');
  expect(screen.getByRole('link').className).toContain('break-words');
  expect(screen.getByRole('button').parentElement!.className).toContain('flex-wrap');
});

it('bounds the title column to the available width so an unbroken title wraps in place', () => {
  const { container } = wrap(
    <PageHeader
      title={'x'.repeat(200)}
      purpose="p"
      crumbs={[{ label: 'Tasks', href: '/tasks' }]}
      actions={<button>A</button>}
    />,
  );
  const h1 = container.querySelector('h1')!;
  const column = h1.parentElement!;
  const row = column.parentElement!;
  const nav = container.querySelector('nav')!;
  const current = nav.querySelector('[aria-current="page"]')!;
  const classes = (el: Element) => el.className.split(/\s+/);
  // A flex-column items-start row sizes children to their intrinsic width, so
  // the row must stretch its items and the title column must be shrinkable
  // and capped at the row width.
  expect(classes(row)).not.toContain('items-start');
  expect(classes(row)).toContain('items-stretch');
  expect(classes(row)).toContain('min-w-0');
  expect(classes(row)).toContain('sm:items-start');
  expect(classes(column)).toContain('min-w-0');
  expect(classes(column)).toContain('max-w-full');
  expect(classes(h1)).toContain('min-w-0');
  expect(classes(h1)).toContain('max-w-full');
  expect(classes(current)).toContain('min-w-0');
  expect(classes(current)).toContain('max-w-full');
  expect(classes(current)).toContain('break-words');
  expect(classes(container.querySelector('ol')!)).toContain('min-w-0');
  expect(classes(container.querySelector('ol')!)).toContain('max-w-full');
});
