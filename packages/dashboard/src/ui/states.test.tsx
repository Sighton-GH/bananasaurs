// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../api.js';
import { Empty, Forbidden, Loading, NotFound, Stale, Unavailable } from './states.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = (ms: number): void => {
  act(() => void vi.advanceTimersByTime(ms));
};

describe('Loading', () => {
  it('operates Try again with Tab and Enter', async () => {
    const retry = vi.fn();
    render(<Loading label="x" onRetry={retry} />);
    advance(10_000);
    const button = screen.getByRole('button', { name: 'Try again' });
    vi.useRealTimers();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders nothing before 1 s, then a status region named Loading <label>', () => {
    const { container } = render(<Loading label="the audit log" />);
    expect(container.innerHTML).toBe('');
    advance(999);
    expect(screen.queryByRole('status')).toBeNull();
    advance(1);
    expect(screen.getByRole('status', { name: 'Loading the audit log' })).toBeTruthy();
  });

  it('after 10 s says it is taking longer and offers Try again when a retry is given', () => {
    const retry = vi.fn();
    render(<Loading label="x" onRetry={retry} />);
    advance(9_999);
    expect(screen.queryByText(/Still loading/)).toBeNull();
    advance(1);
    expect(screen.getByText('Still loading. This is taking longer than usual.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows no Try again after 10 s without a retry', () => {
    render(<Loading />);
    advance(10_000);
    expect(screen.getByText(/Still loading/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('can use a spinner variant', () => {
    render(<Loading label="rows" variant="spinner" />);
    advance(1000);
    expect(screen.getByRole('status', { name: 'Loading rows' })).toBeTruthy();
  });
});

describe('Empty', () => {
  it('shows the mark at 64 px with empty alt by default, plus title, detail and action', () => {
    const { container } = render(
      <Empty title="Nothing here" detail="Add one." action={<button>Add</button>} />,
    );
    expect(screen.getByRole('region', { name: 'Nothing here' })).toBeTruthy();
    expect(screen.getByText('Add one.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/brand/bananasaur.png');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('width')).toBe('64');
  });

  it('drops the mark with art={false}', () => {
    const { container } = render(<Empty title="Nothing" art={false} />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('Unavailable', () => {
  it('operates Try again with Tab and Enter', async () => {
    const retry = vi.fn();
    render(<Unavailable what="x" error={new Error('boom')} onRetry={retry} />);

    const button = screen.getByRole('button', { name: 'Try again' });
    vi.useRealTimers();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('titles the failure, describes the error, offers Try again and announces it', () => {
    const retry = vi.fn();
    render(<Unavailable what="the audit log" error={new Error('boom')} onRetry={retry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("Couldn't load the audit log");
    expect(alert.textContent).toContain('boom');
    expect(alert.textContent).not.toContain('The rest of this page is working.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('adds the rest-is-safe line when restIsSafe', () => {
    render(<Unavailable what="x" error={new Error('b')} restIsSafe />);
    expect(screen.getByText('The rest of this page is working.')).toBeTruthy();
  });

  it('omits Try again without onRetry', () => {
    render(<Unavailable what="x" error={new Error('b')} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows Ref <requestId> for an ApiError that has one', () => {
    render(
      <Unavailable
        what="x"
        error={new ApiError(500, { error: 'internal', requestId: 'abc123' })}
      />,
    );
    expect(screen.getByText('Ref abc123')).toBeTruthy();
  });
});

describe('Forbidden', () => {
  it('uses the server title and message and the Accounts line, never Try again', () => {
    render(
      <Forbidden
        error={
          new ApiError(403, {
            error: 'owner-only',
            title: 'Only the owner can do this',
            message: 'Owner accounts only.',
          })
        }
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Only the owner can do this');
    expect(alert.textContent).toContain('Owner accounts only.');
    expect(alert.textContent).toContain('Ask the owner to change your account in Accounts.');
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('falls back to the default title and body', () => {
    render(<Forbidden />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("You don't have access to this");
    expect(alert.textContent).toContain("Your account doesn't include this.");
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('NotFound', () => {
  it('says what is missing and links back, with Go back by default', () => {
    render(<NotFound what="This task" backHref="/tasks" />);
    expect(screen.getByText("This task doesn't exist or was deleted")).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Go back' });
    expect(link.getAttribute('href')).toBe('/tasks');
  });

  it('uses a custom backLabel', () => {
    render(<NotFound what="This task" backHref="/tasks" backLabel="All tasks" />);
    expect(screen.getByRole('link', { name: 'All tasks' })).toBeTruthy();
  });
});

describe('Stale', () => {
  it('operates Refresh with Tab and Enter', async () => {
    const retry = vi.fn();
    render(<Stale updatedAt={0} now={600_000} onRefresh={retry} />);

    const button = screen.getByRole('button', { name: 'Refresh' });
    vi.useRealTimers();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows the relative time and a Refresh button', () => {
    const onRefresh = vi.fn();
    const now = 10 * 60_000;
    render(<Stale updatedAt={0} now={now} onRefresh={onRefresh} />);
    expect(screen.getByText('Updated 10 minutes ago')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

it('Empty can put the artwork above a full-width text and keyboard action row', async () => {
  vi.useRealTimers();
  const action = vi.fn();
  render(
    <Empty
      title="No tasks yet"
      detail="Create a task to start."
      action={<button onClick={action}>Create task</button>}
    />,
  );
  const section = screen.getByRole('region', { name: 'No tasks yet' });
  expect(section.firstElementChild?.classList.contains('flex-wrap')).toBe(true);
  const text = screen.getByRole('heading', { name: 'No tasks yet' }).parentElement;
  for (const token of ['min-w-0', 'flex-1', 'basis-48', '[overflow-wrap:anywhere]'])
    expect(text?.classList.contains(token)).toBe(true);
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create task' }));
  await user.keyboard('{Enter}');
  expect(action).toHaveBeenCalledTimes(1);
});

it('Stale puts its refresh icon in the leading Button slot, not in a second label line', () => {
  render(<Stale updatedAt={0} now={600_000} onRefresh={() => undefined} />);
  const button = screen.getByRole('button', { name: 'Refresh' });
  expect(button.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  expect(button.firstElementChild?.classList.contains('size-4')).toBe(true);
  expect(button.firstElementChild?.nextElementSibling?.textContent).toBe('Refresh');
  expect(button.firstElementChild?.nextElementSibling?.querySelector('svg')).toBeNull();
});
