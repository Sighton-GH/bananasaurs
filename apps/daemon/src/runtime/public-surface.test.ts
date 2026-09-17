import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  formatPublicSurface,
  probePublicSurface,
  type FetchLike,
  type PublicSurfaceReport,
} from './public-surface.js';

/**
 * `doctor`'s public-surface probe (ruling M6-D1, brief Task 2).
 *
 * Every test drives a fake fetch with no network: the probe's only input is
 * the response the edge would give, so the whole table — both directions of
 * every row, plus every failure class — is asserted without contacting
 * anything.
 */

const BASE = 'https://bananasaurs.sighton.ca';

interface FakeResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

const toFetchResponse = (res: FakeResponse): Awaited<ReturnType<FetchLike>> => ({
  status: res.status,
  headers: {
    get: (name: string): string | null => {
      const found = Object.entries(res.headers ?? {}).find(
        ([key]) => key.toLowerCase() === name.toLowerCase(),
      );
      return found?.[1] ?? null;
    },
  },
  text: () => Promise.resolve(res.body ?? ''),
});

/** A fake fetch that records every URL and answers from a per-path table. */
const fakeFetch = (
  seen: string[],
  table: Record<string, FakeResponse | Error>,
  onRequest?: (url: string, init: Parameters<FetchLike>[1]) => void,
): FetchLike => {
  const fetch: FetchLike = (url, init) => {
    seen.push(url);
    onRequest?.(url, init);
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const answer = table[path];
    if (answer === undefined) throw new Error(`no fake response for ${path}`);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(toFetchResponse(answer));
  };
  return fetch;
};

const ACCESS_REDIRECT: FakeResponse = {
  status: 302,
  headers: { location: 'https://login.example.cloudflareaccess.com/cdn-cgi/access/login' },
};

const responseFor = (report: PublicSurfaceReport, path: string) =>
  report.rows.find((row) => row.path === path);

/** The all-clear edge: Access in front of the dashboard, the app behind the machine paths. */
const cleanTable = (): Record<string, FakeResponse> => ({
  '/': ACCESS_REDIRECT,
  '/api/session': { status: 403 },
  '/oauth/authorize': ACCESS_REDIRECT,
  '/.well-known/oauth-authorization-server': {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"issuer":"https://bananasaurs.sighton.ca"}',
  },
  '/mcp': {
    status: 401,
    headers: {
      'WWW-Authenticate':
        'Bearer resource_metadata="https://bananasaurs.sighton.ca/.well-known/oauth-protected-resource", error="invalid_token"',
    },
  },
});

describe('probePublicSurface', () => {
  it('probes nothing and is ok when MCP_PUBLIC_URL is unset', async () => {
    const seen: string[] = [];
    const fetch: FetchLike = () => {
      throw new Error('must not fetch when there is no public URL');
    };
    const report = await probePublicSurface({ publicUrl: undefined, fetch });
    expect(report).toEqual({ probed: false, ok: true, rows: [] });
    expect(seen).toEqual([]);
  });

  it('probes nothing and is ok when MCP_PUBLIC_URL is the empty string', async () => {
    let called = false;
    const fetch: FetchLike = () => {
      called = true;
      throw new Error('must not fetch when there is no public URL');
    };
    const report = await probePublicSurface({ publicUrl: '', fetch });
    expect(report.probed).toBe(false);
    expect(report.ok).toBe(true);
    expect(called).toBe(false);
  });

  it('reports ok when every row answers as specified', async () => {
    const seen: string[] = [];
    const report = await probePublicSurface({
      publicUrl: BASE,
      fetch: fakeFetch(seen, cleanTable()),
    });
    expect(report.probed).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.rows.map((row) => row.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('fetches every URL from the configured base and nothing else (hard rule 8)', async () => {
    const seen: string[] = [];
    await probePublicSurface({ publicUrl: BASE, fetch: fakeFetch(seen, cleanTable()) });
    expect(seen).toHaveLength(5);
    for (const url of seen) {
      expect(url.startsWith(BASE)).toBe(true);
    }
    expect(seen).toEqual([
      `${BASE}/`,
      `${BASE}/api/session`,
      `${BASE}/oauth/authorize`,
      `${BASE}/.well-known/oauth-authorization-server`,
      `${BASE}/mcp`,
    ]);
  });

  it('sends no Authorization, cookie or credentials of any kind', async () => {
    const inits: Parameters<FetchLike>[1][] = [];
    await probePublicSurface({
      publicUrl: BASE,
      fetch: fakeFetch([], cleanTable(), (_url, init) => {
        inits.push(init);
      }),
    });
    expect(inits).toHaveLength(5);
    for (const init of inits) {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('manual');
      expect(Object.keys(init.headers)).not.toContain('authorization');
      expect(Object.keys(init.headers)).not.toContain('cookie');
    }
  });

  it('uses manual redirects so an Access 302 is observable rather than followed', async () => {
    const inits: Parameters<FetchLike>[1][] = [];
    await probePublicSurface({
      publicUrl: BASE,
      fetch: fakeFetch([], cleanTable(), (_url, init) => {
        inits.push(init);
      }),
    });
    for (const init of inits) {
      expect(init.redirect).toBe('manual');
    }
  });

  describe('/ (expects Access)', () => {
    it('is ok on an Access redirect', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/': ACCESS_REDIRECT }),
      });
      expect(responseFor(report, '/')?.outcome).toBe('ok');
    });

    it('is ok on a 403, which is the safe direction for a dashboard path', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/': { status: 403 } }),
      });
      expect(responseFor(report, '/')?.outcome).toBe('ok');
    });

    it('is exposed on a 200 text/html: the dashboard is reachable without Access', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], {
          ...cleanTable(),
          '/': {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: '<html>login</html>',
          },
        }),
      });
      const row = responseFor(report, '/');
      expect(row?.outcome).toBe('exposed');
      expect(report.ok).toBe(false);
    });
  });

  describe('/api/session (expects Access)', () => {
    it('is ok on an Access redirect or 403', async () => {
      const redirected = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/api/session': ACCESS_REDIRECT }),
      });
      expect(responseFor(redirected, '/api/session')?.outcome).toBe('ok');

      const forbidden = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/api/session': { status: 403 } }),
      });
      expect(responseFor(forbidden, '/api/session')?.outcome).toBe('ok');
    });

    it('is exposed on the 200 {"authenticated":false} the app answers to anyone', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], {
          ...cleanTable(),
          '/api/session': {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"authenticated":false}',
          },
        }),
      });
      const row = responseFor(report, '/api/session');
      expect(row?.outcome).toBe('exposed');
      expect(report.ok).toBe(false);
    });

    it('is unexpected, not exposed, on a 200 JSON without the authenticated marker', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], {
          ...cleanTable(),
          '/api/session': {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"status":"up"}',
          },
        }),
      });
      expect(responseFor(report, '/api/session')?.outcome).toBe('unexpected');
      expect(report.ok).toBe(false);
    });
  });

  describe('/oauth/authorize (expects Access)', () => {
    it('is ok on an Access redirect or 403', async () => {
      const redirected = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/oauth/authorize': ACCESS_REDIRECT }),
      });
      expect(responseFor(redirected, '/oauth/authorize')?.outcome).toBe('ok');

      const forbidden = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/oauth/authorize': { status: 403 } }),
      });
      expect(responseFor(forbidden, '/oauth/authorize')?.outcome).toBe('ok');
    });

    it('is exposed on the 200 consent page', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], {
          ...cleanTable(),
          '/oauth/authorize': {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: '<html>consent</html>',
          },
        }),
      });
      expect(responseFor(report, '/oauth/authorize')?.outcome).toBe('exposed');
      expect(report.ok).toBe(false);
    });

    it('is exposed on a 400 from the app, which is still the app answering', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], {
          ...cleanTable(),
          '/oauth/authorize': {
            status: 400,
            headers: { 'content-type': 'application/json' },
            body: '{"error":"invalid_request"}',
          },
        }),
      });
      expect(responseFor(report, '/oauth/authorize')?.outcome).toBe('exposed');
      expect(report.ok).toBe(false);
    });
  });

  describe('/.well-known/oauth-authorization-server (expects the app)', () => {
    it('is ok on the 200 JSON document with an issuer', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], cleanTable()),
      });
      expect(responseFor(report, '/.well-known/oauth-authorization-server')?.outcome).toBe('ok');
    });

    it('is blocked-by-access on an Access redirect: the connector cannot work', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], {
          ...cleanTable(),
          '/.well-known/oauth-authorization-server': ACCESS_REDIRECT,
        }),
      });
      const row = responseFor(report, '/.well-known/oauth-authorization-server');
      expect(row?.outcome).toBe('blocked-by-access');
      expect(report.ok).toBe(false);
    });

    it('is blocked-by-access on a 403', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], {
          ...cleanTable(),
          '/.well-known/oauth-authorization-server': { status: 403 },
        }),
      });
      expect(responseFor(report, '/.well-known/oauth-authorization-server')?.outcome).toBe(
        'blocked-by-access',
      );
      expect(report.ok).toBe(false);
    });

    it('is unexpected on a 200 JSON document without an issuer', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], {
          ...cleanTable(),
          '/.well-known/oauth-authorization-server': {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"authorization_endpoint":"https://x.test/auth"}',
          },
        }),
      });
      expect(responseFor(report, '/.well-known/oauth-authorization-server')?.outcome).toBe(
        'unexpected',
      );
      expect(report.ok).toBe(false);
    });
  });

  describe('/mcp (expects the app)', () => {
    it('is ok on the 401 with the RFC 9728 challenge', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], cleanTable()),
      });
      expect(responseFor(report, '/mcp')?.outcome).toBe('ok');
    });

    it('is blocked-by-access on an Access redirect: the connector cannot work', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/mcp': ACCESS_REDIRECT }),
      });
      const row = responseFor(report, '/mcp');
      expect(row?.outcome).toBe('blocked-by-access');
      expect(report.ok).toBe(false);
    });

    it('is blocked-by-access on a 403', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/mcp': { status: 403 } }),
      });
      expect(responseFor(report, '/mcp')?.outcome).toBe('blocked-by-access');
      expect(report.ok).toBe(false);
    });

    it('is unexpected on a 401 without the resource_metadata challenge', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], {
          ...cleanTable(),
          '/mcp': { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
        }),
      });
      expect(responseFor(report, '/mcp')?.outcome).toBe('unexpected');
      expect(report.ok).toBe(false);
    });
  });

  describe('edge findings', () => {
    it('reports not-published on an edge 404', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/': { status: 404 } }),
      });
      expect(responseFor(report, '/')?.outcome).toBe('not-published');
      expect(report.ok).toBe(false);
    });

    it.each([502, 503, 504])(
      'reports origin-unreachable on a %i: the tunnel is up and the origin is not',
      async (status) => {
        const report = await probePublicSurface({
          publicUrl: BASE,
          fetch: fakeFetch([], { ...cleanTable(), '/': { status } }),
        });
        expect(responseFor(report, '/')?.outcome).toBe('origin-unreachable');
        expect(report.ok).toBe(false);
      },
    );

    it('reports unreachable on a rejecting fetch', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/': new Error('connect ECONNREFUSED') }),
      });
      const row = responseFor(report, '/');
      expect(row?.outcome).toBe('unreachable');
      expect(row?.observed).toEqual({
        status: undefined,
        contentType: undefined,
        locationHost: undefined,
      });
      expect(report.ok).toBe(false);
    });

    it('times out a hung fetch instead of hanging doctor', async () => {
      const hanging: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: hanging,
        timeoutMs: 20,
      });
      expect(report.probed).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.rows.map((row) => row.outcome)).toEqual([
        'unreachable',
        'unreachable',
        'unreachable',
        'unreachable',
        'unreachable',
      ]);
    }, 10_000);

    it('reports unexpected with status and content type on anything else', async () => {
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch([], { ...cleanTable(), '/': { status: 500 } }),
      });
      const row = responseFor(report, '/');
      expect(row?.outcome).toBe('unexpected');
      expect(row?.observed).toMatchObject({ status: 500 });
      expect(report.ok).toBe(false);
    });
  });

  describe('no secrets anywhere', () => {
    it('never renders a response body in the formatted text or the report', async () => {
      const seen: string[] = [];
      const report = await probePublicSurface({
        publicUrl: BASE,
        fetch: fakeFetch(seen, {
          '/': {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: '<html>BODY-SENTINEL-9f3k</html>',
          },
          '/api/session': {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"authenticated":false,"token":"BODY-SENTINEL-9f3k"}',
          },
          '/oauth/authorize': ACCESS_REDIRECT,
          '/.well-known/oauth-authorization-server': {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"issuer":"https://x.test","secret":"BODY-SENTINEL-9f3k"}',
          },
          '/mcp': {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://x.test/"' },
          },
        }),
      });
      expect(report.ok).toBe(false);
      expect(formatPublicSurface(report)).not.toContain('BODY-SENTINEL-9f3k');
      expect(JSON.stringify(report)).not.toContain('BODY-SENTINEL-9f3k');
    });
  });
});

describe('formatPublicSurface', () => {
  it('says not probed when MCP_PUBLIC_URL is unset', () => {
    expect(formatPublicSurface({ probed: false, ok: true, rows: [] })).toBe(
      'public surface    not probed (MCP_PUBLIC_URL unset)',
    );
  });

  it('says ok when every row is ok', async () => {
    const report = await probePublicSurface({
      publicUrl: BASE,
      fetch: fakeFetch([], cleanTable()),
    });
    const text = formatPublicSurface(report);
    expect(text).toContain('public surface    ok');
    expect(text).toContain('/');
  });

  it('names the path, what it expected and what came back on a problem row', async () => {
    const report = await probePublicSurface({
      publicUrl: BASE,
      fetch: fakeFetch([], {
        ...cleanTable(),
        '/': {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html>login</html>',
        },
      }),
    });
    const text = formatPublicSurface(report);
    expect(text).toContain('/');
    expect(text).toContain('Access');
    expect(text).toContain('200');
    expect(text).toContain('text/html');
    expect(text).toContain('exposed');
    expect(text).toContain('public surface    1 problem(s)');
  });

  it('counts every non-ok row in the summary', async () => {
    const report = await probePublicSurface({
      publicUrl: BASE,
      fetch: fakeFetch([], {
        ...cleanTable(),
        '/': {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html>login</html>',
        },
        '/mcp': ACCESS_REDIRECT,
      }),
    });
    expect(formatPublicSurface(report)).toContain('public surface    2 problem(s)');
  });

  it('shows the Location host on a redirect row', async () => {
    const report = await probePublicSurface({
      publicUrl: BASE,
      fetch: fakeFetch([], {
        ...cleanTable(),
        '/.well-known/oauth-authorization-server': ACCESS_REDIRECT,
      }),
    });
    expect(formatPublicSurface(report)).toContain('login.example.cloudflareaccess.com');
  });
});

describe('DEFAULT_PROBE_TIMEOUT_MS', () => {
  it('is five seconds', () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(5_000);
  });
});
