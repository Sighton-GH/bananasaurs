// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDelayedFlag } from './useDelayedFlag.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDelayedFlag', () => {
  it('clears its pending timer when unmounted before the delay', () => {
    const { unmount } = renderHook(() => useDelayedFlag(true, 1000));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => void vi.advanceTimersByTime(1000));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is false at 0 and 999 ms and true at 1,000 ms', () => {
    const { result } = renderHook(() => useDelayedFlag(true, 1000));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('resets when it goes inactive', () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 1000), {
      initialProps: { on: true },
    });
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
    rerender({ on: true });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe(true);
  });
});
