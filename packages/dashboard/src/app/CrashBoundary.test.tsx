// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrashBoundary, crashDetails, crashRef } from './CrashBoundary.js';

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BOOM = new TypeError("Cannot read properties of undefined (reading 'map')");

function Boom(): never {
  throw BOOM;
}

/** Renders a crashing child and silences React's own caught-error logging. */
function renderCrash(scope: 'app' | 'page' = 'page', resetKey = '/members') {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <CrashBoundary scope={scope} resetKey={resetKey}>
      <Boom />
    </CrashBoundary>,
  );
  return { log };
}

describe('CrashBoundary', () => {
  it('a throwing child shows the crash panel: title, copy, error name, Ref and both buttons', () => {
    renderCrash();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This page hit a problem');
    expect(alert.textContent).toContain(
      "Something in Bananasaurs' dashboard failed while showing this page. Nothing was saved or changed.",
    );
    expect(alert.textContent).toContain(
      'The rest of the dashboard still works — pick another page from the menu.',
    );
    expect(alert.textContent).toContain('TypeError');
    expect(alert.textContent).toMatch(/Ref [0-9A-Z]+/);
    expect(within(alert).getByRole('button', { name: 'Reload page' })).toBeDefined();
    expect(within(alert).getByRole('button', { name: 'Copy details' })).toBeDefined();
    const ref = within(alert).getByText(/Ref [0-9A-Z]+ · TypeError/);
    expect(ref.className).toContain('font-mono');
  });

  it("scope 'app' swaps the menu guidance for a reload instruction", () => {
    renderCrash('app');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Reload the page to continue.');
    expect(alert.textContent).not.toContain('pick another page from the menu');
  });

  it('Copy details writes the route, error and component stack to the clipboard', () => {
    let written = '';
    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: (text: string) => {
          written = text;
          return Promise.resolve();
        },
      },
      configurable: true,
    });
    renderCrash();
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    expect(written).toContain('Route: /members');
    expect(written).toContain('TypeError');
    expect(written).toContain("Cannot read properties of undefined (reading 'map')");
    expect(written).toContain('Component stack:');
    expect(written).toContain('at Boom');
  });

  it('Reload page calls window.location.reload', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    renderCrash();
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('changing resetKey clears the crash and renders the children again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <CrashBoundary scope="page" resetKey="/members">
        <Boom />
      </CrashBoundary>,
    );
    expect(screen.getByRole('alert')).toBeDefined();
    rerender(
      <CrashBoundary scope="page" resetKey="/">
        <p>Overview again</p>
      </CrashBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Overview again')).toBeDefined();
  });

  it('logs the crash exactly once through console.error with the Ref', () => {
    const { log } = renderCrash();
    const shown = screen.getByText(/Ref [0-9A-Z]+ · TypeError/).textContent ?? '';
    const ref = /Ref ([0-9A-Z]+)/.exec(shown)?.[1];
    expect(ref).toBeDefined();
    const crashCalls = log.mock.calls.filter((args) => args[0] === '[crash]');
    expect(crashCalls).toHaveLength(1);
    expect(crashCalls[0]?.[1]).toBe(ref);
  });

  it('Reload page and Copy details work from the keyboard: Tab order, Enter and Space', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderCrash();
    const reloadButton = screen.getByRole('button', { name: 'Reload page' });
    const copyButton = screen.getByRole('button', { name: 'Copy details' });
    await user.tab();
    expect(document.activeElement).toBe(reloadButton);
    await user.keyboard('{Enter}');
    expect(reload).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(document.activeElement).toBe(copyButton);
    await user.keyboard('{Enter}');
    expect(writeText).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('a rejected clipboard write is handled: the boundary attaches a catch to the promise', async () => {
    const rejected = Promise.reject(new Error('denied'));
    const caught = vi.spyOn(rejected, 'catch');
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: () => rejected },
      configurable: true,
    });
    renderCrash();
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(caught).toHaveBeenCalledTimes(1);
    await expect(caught.mock.results[0]?.value).resolves.toBeUndefined();
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('Copy details with no clipboard available does nothing and does not throw', () => {
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
    renderCrash();
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('Copy details omits extra API payload properties carried on the error (message is copied as thrown)', () => {
    let written = '';
    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: (text: string) => {
          written = text;
          return Promise.resolve();
        },
      },
      configurable: true,
    });
    const apiError = Object.assign(new Error('Request failed'), {
      status: 500,
      response: { secretField: 'response-payload-xyz' },
      body: '{"token":"body-payload-xyz"}',
      headers: { authorization: 'header-payload-xyz' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function ThrowApi(): never {
      throw apiError;
    }
    render(
      <CrashBoundary scope="page" resetKey="/members">
        <ThrowApi />
      </CrashBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    expect(written).toContain('Error: Request failed');
    expect(written).not.toContain('payload-xyz');
    expect(written).not.toContain('secretField');
    expect(written).not.toContain('authorization');
    expect(written).not.toContain('500');
  });

  it('crashRef is the upper-case base-36 of the timestamp modulo 1,000,000 (1 to 4 characters)', () => {
    expect(crashRef(1760220456789)).toBe('9SGL');
    expect(crashRef(999_999)).toBe('LFLR');
  });

  it('crashDetails carries the Ref, route, error name and message, and the stack', () => {
    const text = crashDetails({
      error: new TypeError('nope'),
      componentStack: '\n    at Boom',
      route: '/members',
      at: 1760220456789,
    });
    expect(text).toContain('Ref 9SGL');
    expect(text).toContain('Route: /members');
    expect(text).toContain('TypeError: nope');
    expect(text).toContain('at Boom');
  });
});
