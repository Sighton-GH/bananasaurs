// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_BUILT, StubPage } from './stub.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('StubPage', () => {
  it('renders the title, the purpose and NOT_BUILT', () => {
    render(
      <StubPage
        title="Archive"
        purpose="Every message from the channels the owner enabled, kept under the retention policy."
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Archive' })).toBeTruthy();
    expect(
      screen.getByText(
        'Every message from the channels the owner enabled, kept under the retention policy.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(NOT_BUILT)).toBeTruthy();
    expect(NOT_BUILT).toBe('Not built. Planned for Release 3.');
  });

  it('renders availableToday when set', () => {
    const note =
      'The archive and search exist in Release 2 as operator CLI commands (`archive`, `mcp`) and through the MCP connector; the page arrives with Release 3.';
    render(<StubPage title="Search" purpose="Full-text search over the archive, with citations." availableToday={note} />);
    expect(screen.getByText(note)).toBeTruthy();
    expect(screen.getByText(NOT_BUILT)).toBeTruthy();
  });

  it('omits the availableToday line when unset', () => {
    render(<StubPage title="Memory" purpose="What the assistant remembers." />);
    expect(screen.getByText(NOT_BUILT)).toBeTruthy();
    expect(screen.queryByText(/Release 2/)).toBeNull();
  });

  it('makes no fetch', () => {
    const mock = vi.fn(
      () =>
        Promise.resolve(
          new Response('{}', { headers: { 'content-type': 'application/json' } }),
        ) as Promise<Response>,
    );
    vi.stubGlobal('fetch', mock);
    render(<StubPage title="Archive" purpose="A purpose." />);
    expect(screen.getByText(NOT_BUILT)).toBeTruthy();
    expect(mock).not.toHaveBeenCalled();
  });
});
