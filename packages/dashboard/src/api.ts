/**
 * The one place this page talks to the API.
 *
 * `packages/dashboard` may not import `@bananasaurs/http` (the boundary rule
 * in `eslint.config.js` and `packages/core/src/boundaries.test.ts` — the
 * dashboard builds to static assets and must not pull in server code), so the
 * CSRF header name is a literal here rather than the `CSRF_HEADER` export.
 * `server.test.ts`'s "the dashboard's CSRF header string" test asserts the two
 * agree; if `packages/http` ever renames its constant, that test — not a
 * runtime failure a year from now — is what catches it.
 */
export const CSRF_HEADER = 'x-bananasaurs-csrf';

export interface SessionInfo {
  readonly authenticated: true;
  readonly accountId: string;
  readonly guildId: string;
  /** The current guild's display name. Absent on older servers; the shell falls back to health. */
  readonly guildName?: string | undefined;
  /**
   * Every guild this account can reach on this instance (S13-D9). Optional so
   * a session established before the server learned to send it still renders —
   * the shell simply shows no switcher.
   */
  readonly reachableGuilds?: readonly ReachableGuild[] | undefined;
  readonly csrfToken: string;
  readonly expiresAt: number;
  readonly reauthFresh: boolean;
  readonly readonly: boolean;
  /** True when this account owns the instance. Absent on older servers. */
  readonly instanceOwner?: boolean | undefined;
}

/** One entry of the login refusal's `choices` and the session's `reachableGuilds`. */
export interface ReachableGuild {
  readonly guildId: string;
  readonly name?: string | undefined;
}

export interface NoSession {
  readonly authenticated: false;
  readonly reason: string;
}

/**
 * The JSON body every non-2xx API answer carries (0078): the stable
 * kebab-case `error` code plus the server catalog's title, message and hint,
 * the Zod issue paths for a validation failure, and the request id that ties
 * the answer to its journal line.
 */
export interface ApiErrorBody {
  readonly error: string;
  readonly title?: string | undefined;
  readonly message?: string | undefined;
  readonly hint?: string | undefined;
  readonly fields?: readonly { readonly path: string; readonly problem: string }[] | undefined;
  readonly requestId?: string | undefined;
}

/**
 * Thrown for every non-2xx response except the two the caller is expected to
 * handle itself: 401 `reauth-required` (retried transparently by `apiFetch`)
 * and 503 `read-only` (its `message` names `BANANASAURS_READONLY`, so callers
 * render it rather than a generic failure).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message ?? body.error);
  }
}

export class ReadonlyError extends ApiError {}

/** `fetch` itself threw: the browser could not reach the dashboard API. */
export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineError';
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The one fetch wrapper every call in this page goes through.
 *
 * `credentials: 'same-origin'` sends the session cookie; every write carries
 * the CSRF header. A 401 `reauth-required` is not a failure the caller should
 * see — the session is still live (ADR 0029), so this prompts for the
 * password via `onReauthRequired`, calls `POST /api/reauth`, and retries the
 * original request once, rather than bouncing the page to a login screen it
 * is not in.
 */
export const apiFetch = async <T>(
  url: string,
  csrfToken: string,
  onReauthRequired: () => Promise<string | undefined>,
  init: RequestInit = {},
): Promise<T> => {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (WRITE_METHODS.has(method)) {
    headers[CSRF_HEADER] = csrfToken;
    // A bodiless write (the dashboard's DELETEs carry no body) must not claim
    // `application/json`: Fastify rejects an empty labelled body before
    // routing. Only label the request when a body is actually sent.
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
  }

  /**
   * Reads an error body without ever crashing: a proxy page or a dead tunnel
   * answers with HTML (or nothing at all), which becomes the
   * `unreadable-response` code `describeError` knows how to explain.
   */
  const readErrorBody = async (response: Response): Promise<ApiErrorBody> => {
    const parsed = await response.json().catch(() => undefined);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { error?: unknown }).error === 'string'
    ) {
      return parsed as ApiErrorBody;
    }
    return { error: 'unreadable-response' };
  };

  let response: Response;
  try {
    response = await fetch(url, { ...init, method, headers, credentials: 'same-origin' });
  } catch (err) {
    throw new OfflineError(String(err));
  }

  if (response.status === 401) {
    const body = await readErrorBody(response);
    if (body.error === 'reauth-required') {
      const password = await onReauthRequired();
      if (password === undefined) throw new ApiError(401, body);
      let reauth: Response;
      try {
        reauth = await fetch('/api/reauth', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { [CSRF_HEADER]: csrfToken, 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        });
      } catch (err) {
        throw new OfflineError(String(err));
      }
      if (!reauth.ok) throw new ApiError(reauth.status, await readErrorBody(reauth));
      return apiFetch(url, csrfToken, onReauthRequired, init);
    }
    throw new ApiError(401, body);
  }

  if (response.status === 503) {
    throw new ReadonlyError(503, await readErrorBody(response));
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorBody(response));
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
};

export const getSession = async (): Promise<SessionInfo | NoSession> => {
  const response = await fetch('/api/session', { credentials: 'same-origin' });
  return (await response.json()) as SessionInfo | NoSession;
};
