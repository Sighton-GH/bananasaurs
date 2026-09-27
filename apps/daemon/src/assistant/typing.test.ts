import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTyping } from './typing.js';

describe('startTyping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends once immediately', () => {
    const send = vi.fn(async () => undefined);
    const onError = vi.fn();
    const stop = startTyping(send, { onError });
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });

  it('sends again at 8s and 16s', () => {
    const send = vi.fn(async () => undefined);
    const stop = startTyping(send, { onError: () => undefined });
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(8_000);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(8_000);
    expect(send).toHaveBeenCalledTimes(3);
    stop();
  });

  it('stops sending after stop()', () => {
    const send = vi.fn(async () => undefined);
    const stop = startTyping(send, { onError: () => undefined });
    stop();
    vi.advanceTimersByTime(32_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops by itself after maxMs', () => {
    const send = vi.fn(async () => undefined);
    const stop = startTyping(send, { onError: () => undefined });
    vi.advanceTimersByTime(179_000);
    const count = send.mock.calls.length;
    expect(count).toBeGreaterThan(1);
    vi.advanceTimersByTime(30_000);
    expect(send.mock.calls.length).toBe(count);
    stop();
  });

  it('a rejecting send calls onError once and does not throw', async () => {
    const send = vi.fn(async () => {
      throw new Error('typing failed');
    });
    const onError = vi.fn();
    const stop = startTyping(send, { onError });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a synchronously throwing send does not throw out of startTyping', () => {
    const send = vi.fn(() => {
      throw new Error('sync boom');
    });
    const onError = vi.fn();
    expect(() => startTyping(send, { onError })).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stop() twice is safe', () => {
    const send = vi.fn(async () => undefined);
    const stop = startTyping(send, { onError: () => undefined });
    stop();
    expect(() => stop()).not.toThrow();
    vi.advanceTimersByTime(16_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
