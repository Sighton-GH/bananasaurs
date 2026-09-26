import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyConnectFallback } from './network.js';

describe('applyConnectFallback', () => {
  const original = net.getDefaultAutoSelectFamilyAttemptTimeout();
  afterEach(() => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(original);
  });

  it('applies the wait to new connections and logs once', () => {
    const info = vi.fn();
    applyConnectFallback(1234, { info });
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(1234);
    expect(info).toHaveBeenCalledTimes(1);
  });
});
