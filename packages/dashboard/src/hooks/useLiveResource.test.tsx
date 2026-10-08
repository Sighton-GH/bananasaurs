// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useCallback } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLiveResource } from './useLiveResource.js';

// No global afterEach in this repo (vitest `globals` is off), so the
// library's auto-cleanup never registers — unmount between tests explicitly.
afterEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
  // jsdom starts `visibilityState` as `prerender`; tests below redefine it,
  // so put it back to keep later files from seeing a stale `hidden`.
  Object.defineProperty(document, 'visibilityState', { value: 'prerender', configurable: true });
});

interface Count {
  readonly n: number;
}

function Probe({
  load,
  isFast,
}: {
  readonly load: () => Promise<Count>;
  readonly isFast: (data: Count) => boolean;
}) {
  const stableLoad = useCallback(load, [load]);
  const { resource, stale, reload } = useLiveResource<Count>('the thing', stableLoad, {
    fastMs: 2000,
    slowMs: 15000,
    isFast,
  });
  return (
    <div>
      {resource.state === 'loading' && <p>loading</p>}
      {resource.state === 'error' && <p>error: {resource.message}</p>}
      {resource.state === 'ready' && <p>value: {resource.data.n}</p>}
      {stale && <p>stale</p>}
      <button type="button" onClick={reload}>
        reload
      </button>
    </div>
  );
}

const setVisibility = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useLiveResource', () => {
  it('polls every fastMs while isFast, then every slowMs once it slows', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<() => Promise<Count>>()
      .mockResolvedValueOnce({ n: 1 })
      .mockResolvedValueOnce({ n: 2 })
      .mockResolvedValue({ n: 2 });
    render(<Probe load={load} isFast={(d) => d.n < 2} />);
    expect(screen.getByText('loading')).toBeTruthy();
    await act(async () => {});
    expect(screen.getByText('value: 1')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);

    // Still fast: a 2 s wait polls again.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('value: 2')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);

    // Now slow: 2 s more polls nothing, 15 s polls once.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(13000);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('keeps the old data with stale on a failed poll, and clears stale on success', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<() => Promise<Count>>()
      .mockResolvedValueOnce({ n: 1 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ n: 2 });
    render(<Probe load={load} isFast={() => true} />);
    await act(async () => {});
    expect(screen.getByText('value: 1')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    // The failed poll keeps the old data rendered and marks it stale.
    expect(screen.getByText('value: 1')).toBeTruthy();
    expect(screen.getByText('stale')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('value: 2')).toBeTruthy();
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('reports the error state when the first load fails', async () => {
    vi.useFakeTimers();
    const load = vi.fn<() => Promise<Count>>().mockRejectedValue(new Error('nope'));
    render(<Probe load={load} isFast={() => true} />);
    await act(async () => {});
    expect(screen.getByText('error: nope')).toBeTruthy();
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('keeps a slow poll going after a first-load error until a load succeeds', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<() => Promise<Count>>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ n: 1 })
      .mockResolvedValue({ n: 2 });
    render(<Probe load={load} isFast={() => true} />);
    await act(async () => {});
    expect(screen.getByText('error: nope')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);

    // The retry waits the slow cadence, not the fast one.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('error: nope')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(13000);
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText('value: 1')).toBeTruthy();

    // Then polling continues as normal at the fast cadence.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.getByText('value: 2')).toBeTruthy();
  });

  it('pauses while the tab is hidden and polls once on return', async () => {
    vi.useFakeTimers();
    const load = vi.fn<() => Promise<Count>>().mockResolvedValue({ n: 1 });
    render(<Probe load={load} isFast={() => true} />);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(load).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stops polling after unmount', async () => {
    vi.useFakeTimers();
    const load = vi.fn<() => Promise<Count>>().mockResolvedValue({ n: 1 });
    const { unmount } = render(<Probe load={load} isFast={() => true} />);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
