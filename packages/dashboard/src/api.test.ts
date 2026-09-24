import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, CSRF_HEADER } from './api.js';

afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('apiFetch write headers', () => {
  it('a DELETE with no body sends no content-type header but does send the CSRF header', async () => {
    const mock = vi.fn(() => Promise.resolve(ok({ ok: true })));
    vi.stubGlobal('fetch', mock);
    await apiFetch('/api/accounts/nobody', 'csrf-test', () => Promise.resolve(undefined), {
      method: 'DELETE',
    });
    expect(mock).toHaveBeenCalledTimes(1);
    const init = mock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe('csrf-test');
    expect(headers).not.toHaveProperty('content-type');
    expect(init.body).toBeUndefined();
  });

  it('a POST with a body sends both the CSRF and content-type headers', async () => {
    const mock = vi.fn(() => Promise.resolve(ok({ ok: true })));
    vi.stubGlobal('fetch', mock);
    await apiFetch<{ ok: boolean }>(
      '/api/accounts/nobody/disabled',
      'csrf-test',
      () => Promise.resolve(undefined),
      { method: 'POST', body: JSON.stringify({ disabled: true }) },
    );
    expect(mock).toHaveBeenCalledTimes(1);
    const init = mock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe('csrf-test');
    expect(headers['content-type']).toBe('application/json');
  });
});
