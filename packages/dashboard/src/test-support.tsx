import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { SessionInfo } from './api.js';
import { SessionProvider } from './app/session.js';

export interface StubRoute {
  readonly method?: string;
  readonly url: string;
  readonly status?: number;
  readonly body: unknown;
}

/**
 * Installs a `fetch` that answers from `routes` by method + exact URL and
 * returns the mock so a test can assert what was called and with what body.
 * An unmatched request resolves 404 with `{ error: 'unstubbed' }` rather than
 * throwing, so the failure shows up as the page's error state.
 */
export function stubFetch(routes: readonly StubRoute[]) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => r.url === url && (r.method ?? 'GET').toUpperCase() === method);
    const status = route?.status ?? (route === undefined ? 404 : 200);
    const body = route?.body ?? { error: 'unstubbed', message: `${method} ${url}` };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

export function bodyOf(call: unknown[]): unknown {
  const init = call[1] as RequestInit | undefined;
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

export const TEST_SESSION: SessionInfo = {
  authenticated: true,
  accountId: 'acct-1',
  guildId: '1540816150026518620',
  csrfToken: 'csrf-test',
  expiresAt: 4102444800000,
  reauthFresh: true,
  readonly: false,
};

export function renderWithSession(
  ui: ReactNode,
  options: { readonly session?: SessionInfo; readonly onLoggedOut?: () => void } = {},
) {
  return render(
    <SessionProvider
      session={options.session ?? TEST_SESSION}
      onLoggedOut={options.onLoggedOut ?? (() => undefined)}
    >
      {ui}
    </SessionProvider>,
  );
}
