import { describe, expect, it, vi } from 'vitest';
import { invokeStreamCallback } from './callbacks.js';

describe('invokeStreamCallback', () => {
  it('invokes the callback exactly once', () => {
    const fn = vi.fn();
    invokeStreamCallback(fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('swallows a synchronous throw', () => {
    expect(() =>
      invokeStreamCallback(() => {
        throw new Error('callback broke');
      }),
    ).not.toThrow();
  });

  it('observes a rejected promise so it never surfaces as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      invokeStreamCallback(() => Promise.reject(new Error('callback broke')));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('ignores a never-settling promise and returns immediately', () => {
    invokeStreamCallback(() => new Promise<void>(() => undefined));
  });

  it('swallows a hostile thenable whose then access throws', () => {
    const hostile = Object.defineProperty({}, 'then', {
      get() {
        throw new Error('callback broke');
      },
    });
    expect(() => invokeStreamCallback(() => hostile)).not.toThrow();
  });
});
