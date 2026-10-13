// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOnline } from './useOnline.js';

function Probe() {
  return <p>online:{String(useOnline())}</p>;
}

function setNavigatorOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
}

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

describe('useOnline', () => {
  it('starts from navigator.onLine=false', () => {
    setNavigatorOnline(false);
    render(<Probe />);
    expect(screen.getByText('online:false')).toBeTruthy();
  });

  it('follows online and offline window events', () => {
    setNavigatorOnline(true);
    render(<Probe />);
    expect(screen.getByText('online:true')).toBeTruthy();
    act(() => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('online:false')).toBeTruthy();
    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByText('online:true')).toBeTruthy();
  });

  it('subscribes once per mount and unsubscribes on unmount, also under StrictMode', () => {
    setNavigatorOnline(true);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const count = (spy: typeof add, type: string) =>
      spy.mock.calls.filter((c) => c[0] === type).length;
    const { unmount } = render(<Probe />);
    expect(count(add, 'online')).toBe(1);
    expect(count(add, 'offline')).toBe(1);
    unmount();
    expect(count(remove, 'online')).toBe(1);
    expect(count(remove, 'offline')).toBe(1);

    add.mockClear();
    remove.mockClear();
    const strict = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    strict.unmount();
    expect(count(add, 'online')).toBe(count(remove, 'online'));
    expect(count(add, 'offline')).toBe(count(remove, 'offline'));
    // After unmount an event no longer reaches a stale listener.
    expect(() => window.dispatchEvent(new Event('offline'))).not.toThrow();
  });

  it('uses the server snapshot (online) when rendered to a string', () => {
    setNavigatorOnline(false);
    expect(renderToString(<Probe />)).toContain('online:<!-- -->true');
  });
});
