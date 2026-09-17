/**
 * `doctor`'s public-surface probe (ruling M6-D1).
 *
 * `https://bananasaurs.sighton.ca` publishes the dashboard behind a
 * Cloudflare Access policy, and the `cloudflared` ingress forwards the whole
 * origin — so Access is the entire security boundary for the dashboard paths.
 * This probe fetches the bot's own public hostname in both directions: the
 * dashboard paths must answer as Access (a redirect to
 * `*.cloudflareaccess.com`, or a 403), and the machine paths the connector
 * needs must answer as the app. Either direction wrong is a finding, and any
 * finding makes the whole report not-ok.
 *
 * The probe sends no credentials of any kind and never retains a response
 * body: `text()` is read so the well-known row can check for an `issuer`
 * field and the `/api/session` row can check for `"authenticated"`, tested,
 * and discarded. What crosses the boundary is status, content type and the
 * `Location` host only.
 *
 * Sequential, not parallel — five requests to the bot's own hostname do not
 * need to race, and sequential makes the timeout bound obvious.
 */

export type FetchLike = (
  url: string,
  init: {
    method: 'GET';
    redirect: 'manual';
    signal: AbortSignal;
    headers: Record<string, string>;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type PublicSurfaceOutcome =
  | 'ok'
  | 'exposed' // a dashboard path answered as the app
  | 'blocked-by-access' // a machine path answered as Access
  | 'not-published' // edge 404
  | 'origin-unreachable' // 502/503/504
  | 'unreachable' // network error / timeout
  | 'unexpected';

export interface PublicSurfaceRow {
  readonly path: string;
  readonly expects: 'access' | 'app';
  readonly outcome: PublicSurfaceOutcome;
  /** Status and content type only — never a body. */
  readonly observed: {
    status: number | undefined;
    contentType: string | undefined;
    locationHost: string | undefined;
  };
}

export interface PublicSurfaceReport {
  /** False when nothing was probed; `ok` is then true and `skipped` says why. */
  readonly probed: boolean;
  /**
   * `unset` — no `MCP_PUBLIC_URL`. `loopback` — it names `127.0.0.1`,
   * `localhost` or `::1`, which is a dev setting: there is no tunnel and no
   * Access in front of a loopback address, so every dashboard row would read
   * `exposed` forever (review M-3). A permanently red `doctor` teaches the
   * operator to ignore red, which is worse than not probing.
   */
  readonly skipped?: 'unset' | 'loopback' | undefined;
  readonly ok: boolean;
  readonly rows: readonly PublicSurfaceRow[];
}

export const PUBLIC_SURFACE_ROWS: readonly { path: string; expects: 'access' | 'app' }[] = [
  { path: '/', expects: 'access' },
  { path: '/api/session', expects: 'access' },
  { path: '/oauth/authorize', expects: 'access' },
  { path: '/.well-known/oauth-authorization-server', expects: 'app' },
  { path: '/mcp', expects: 'app' },
];

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/**
 * One budget across all five rows (review I-2). Five rows at five seconds
 * each is twenty-five, which is inside the CLI's thirty-second socket timeout
 * before `doctor`'s own Discord and archive reads are counted — so a hanging
 * edge turned `doctor` into a CLI timeout with no report at all, instead of
 * five `unreachable` rows. Each row gets the smaller of its own timeout and
 * what is left of the budget; a row the budget cannot reach is `unreachable`
 * without a fetch.
 */
export const DEFAULT_PROBE_BUDGET_MS = 10_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const ACCESS_REDIRECT_STATUSES = new Set([302, 303, 307]);
const ORIGIN_UNREACHABLE_STATUSES = new Set([502, 503, 504]);

export async function probePublicSurface(input: {
  publicUrl: string | undefined;
  fetch: FetchLike;
  timeoutMs?: number;
  budgetMs?: number;
  now?: () => number;
}): Promise<PublicSurfaceReport> {
  const base = input.publicUrl ?? '';
  if (base === '') return { probed: false, skipped: 'unset', ok: true, rows: [] };
  if (isLoopback(base)) return { probed: false, skipped: 'loopback', ok: true, rows: [] };
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const budgetMs = input.budgetMs ?? DEFAULT_PROBE_BUDGET_MS;
  const now = input.now ?? Date.now;
  const deadline = now() + budgetMs;

  const rows: PublicSurfaceRow[] = [];
  for (const row of PUBLIC_SURFACE_ROWS) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      rows.push({
        path: row.path,
        expects: row.expects,
        outcome: 'unreachable',
        observed: NOTHING,
      });
      continue;
    }
    rows.push(
      await probeRow(base, row.path, row.expects, input.fetch, Math.min(timeoutMs, remaining)),
    );
  }
  return { probed: true, ok: rows.every((row) => row.outcome === 'ok'), rows };
}

const NOTHING = { status: undefined, contentType: undefined, locationHost: undefined } as const;

const isLoopback = (base: string): boolean => {
  try {
    return LOOPBACK_HOSTS.has(new URL(base).hostname);
  } catch {
    return false;
  }
};

const probeRow = async (
  base: string,
  path: string,
  expects: 'access' | 'app',
  fetch: FetchLike,
  timeoutMs: number,
): Promise<PublicSurfaceRow> => {
  // `accept: text/html` for the dashboard rows so Access answers with its
  // browser redirect rather than a bare 403 — either is fine, but the
  // redirect is the more specific signal.
  const accept = expects === 'access' ? 'text/html' : 'application/json';
  const url = `${base}${path}`;

  let status: number | undefined;
  let contentType: string | undefined;
  let locationHost: string | undefined;
  let wwwAuthenticate: string | null = null;
  let body = '';
  try {
    const response = await fetch(url, {
      method: 'GET',
      // Manual so an Access 302 is observable rather than followed: following
      // it would turn "blocked" into whatever the Access login page returns.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept },
    });
    status = response.status;
    contentType = response.headers.get('content-type') ?? undefined;
    const location = response.headers.get('location');
    if (location !== null) locationHost = hostOf(location);
    wwwAuthenticate = response.headers.get('www-authenticate');
    // Read, tested below, discarded: it never reaches the report.
    body = await response.text();
  } catch {
    return { path, expects, outcome: 'unreachable', observed: observed() };
  }

  if (status === 404) {
    // The ingress is not publishing this path — its own finding.
    return { path, expects, outcome: 'not-published', observed: observed() };
  }
  if (ORIGIN_UNREACHABLE_STATUSES.has(status)) {
    // The tunnel is up and the origin is not — its own finding.
    return { path, expects, outcome: 'origin-unreachable', observed: observed() };
  }

  const outcome = expects === 'access' ? classifyDashboardPath(path) : classifyMachinePath(path);
  return { path, expects, outcome, observed: observed() };

  function observed(): PublicSurfaceRow['observed'] {
    return { status, contentType, locationHost };
  }

  function accessRedirect(): boolean {
    return (
      status !== undefined &&
      ACCESS_REDIRECT_STATUSES.has(status) &&
      locationHost !== undefined &&
      locationHost.endsWith('.cloudflareaccess.com')
    );
  }

  /** A 403 that Cloudflare Access itself signed, not any 403. */
  function accessForbidden(): boolean {
    return status === 403 && (wwwAuthenticate?.includes('Cloudflare-Access') ?? false);
  }

  function mime(): string {
    return contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  }

  function classifyDashboardPath(path: string): PublicSurfaceOutcome {
    // Blocked is the safe direction for these rows — but only when it is
    // Access doing the blocking. A bare 403 used to count (review I-1), and a
    // WAF or bot-challenge 403 from anything at all would then have read as
    // "protected" with no Access policy in front. Access identifies itself:
    // live, its answers carry `www-authenticate: Cloudflare-Access …`, and it
    // never sends a bare 403 to this probe, so requiring the header costs
    // nothing and closes the hole.
    if (accessRedirect() || accessForbidden()) return 'ok';
    // The "must NOT return" column, per row: each is unambiguous proof that
    // Access is not in front of this path. `/api/session` answers
    // `200 {"authenticated":false,…}` to anyone
    // (`packages/http/src/server.ts`), so seeing that JSON from the public
    // hostname is the proof; probing `/` alone would miss a policy that
    // covers the SPA and bypasses `/api/*`.
    if (path === '/' && status === 200 && mime().includes('text/html')) return 'exposed';
    if (
      path === '/api/session' &&
      status === 200 &&
      mime().includes('json') &&
      body.includes('"authenticated"')
    ) {
      return 'exposed';
    }
    if (
      path === '/oauth/authorize' &&
      ((status === 200 && mime().includes('text/html')) || status === 400)
    ) {
      return 'exposed';
    }
    return 'unexpected';
  }

  function classifyMachinePath(path: string): PublicSurfaceOutcome {
    // An Access answer on these rows is the too-wide policy: the connector's
    // client has no browser and no Access cookie, so it silently breaks.
    if (accessRedirect() || accessForbidden()) return 'blocked-by-access';
    if (path === '/.well-known/oauth-authorization-server') {
      if (status === 200 && mime().includes('json') && hasIssuer(body)) return 'ok';
      return 'unexpected';
    }
    if (
      status === 401 &&
      wwwAuthenticate !== null &&
      wwwAuthenticate.includes('Bearer') &&
      wwwAuthenticate.includes('resource_metadata')
    ) {
      return 'ok';
    }
    return 'unexpected';
  }
};

/** The `Location` host, or `undefined` for a relative or unparseable value. */
const hostOf = (location: string): string | undefined => {
  try {
    // No base URL on purpose: a relative `Location` is not a redirect to
    // Access, and resolving it against a placeholder rendered the placeholder
    // as if it were a host (review M-1).
    return new URL(location).host || undefined;
  } catch {
    return undefined;
  }
};

/** Whether the document names its issuer — read, tested, discarded. */
const hasIssuer = (body: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['issuer'] === 'string'
    );
  } catch {
    return false;
  }
};

/** The operator-facing rendering. Plain text, and never a body. */
export function formatPublicSurface(report: PublicSurfaceReport): string {
  if (!report.probed) {
    return report.skipped === 'loopback'
      ? 'public surface    not probed (MCP_PUBLIC_URL is a loopback address — no tunnel to check)'
      : 'public surface    not probed (MCP_PUBLIC_URL unset)';
  }
  const lines = report.rows.map(
    (row) =>
      `public surface    ${row.path}: ` +
      `expected ${row.expects === 'access' ? 'Access' : 'the app'}, ` +
      `observed ${describeObserved(row)} — ${row.outcome}`,
  );
  const problems = report.rows.filter((row) => row.outcome !== 'ok').length;
  lines.push(
    problems === 0 ? 'public surface    ok' : `public surface    ${String(problems)} problem(s)`,
  );
  return lines.join('\n');
}

/** Status, content type and `Location` host — the only three facts a row keeps. */
const describeObserved = (row: PublicSurfaceRow): string => {
  const { status, contentType, locationHost } = row.observed;
  if (status === undefined) return 'no response (unreachable)';
  const parts = [`status ${String(status)}`];
  if (contentType !== undefined) parts.push(contentType);
  if (locationHost !== undefined) parts.push(`location ${locationHost}`);
  return parts.join(', ');
};
