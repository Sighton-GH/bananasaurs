# DRAFT — Explained errors, AI tuning, per-entry RPM/RPD — Implementation Plan

> **For agentic workers:** executed with `opencode-delegate:opencode-driven-development`
> (owner's choice). Each task below is pasted whole into one implementer brief. Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** Make every dashboard, API, journal and trace error say what happened and what to do.
Add an owner-only **Assistant → AI tuning** page for retry, timeout, tool-loop, network and
resource settings. Enforce owner-set RPM/RPD limits on each model-chain entry.

**Architecture:** Four layers:

- **Server-side error catalog.** It enriches every JSON error body. The dashboard only renders.
- **Provider-failure classifier in core.** It turns any provider error into a stable code, and
  traces and History carry that code.
- **Instance-scoped settings.** A typed registry, a SQLite table and a cached daemon store feed
  their consumers live.
- **SQLite call ledger.** It reserves each provider call against the entry's RPM/RPD before the
  call is sent.

**Tech Stack:** TypeScript (Node 22, strict), Fastify, Zod, better-sqlite3 + Drizzle (drizzle-kit
migrations), React + Vite, Vitest, Pino.

**Spec:** `docs/superpowers/specs/2026-09-25-errors-config-ratelimits-design.md`
**ADRs:** `docs/decisions/0078`–`0081` (already written; read the one your task names).

## Global Constraints

- Project rules in `CLAUDE.md` apply in full. The ones this plan touches most:
  - **Hard rule 4:** no secret, key, token or sealed value in any response, log line, audit row,
    trace or error body.
  - **Hard rule 2:** guild scope on every guild-owned query.
  - **Hard rule 8:** no new outbound network destinations.
  - **Hard rule 7:** no copied code.
- **No new dependencies.** Everything needed is already installed.
- **Error codes are kebab-case slugs. Never rename an existing code.** The dashboard and the CLI
  branch on them.
- **The provider's own error text appears in the journal only** (Pino field `providerMessage`).
  Never in a trace, API response, dashboard, audit row or Discord message.
- **Error bodies never echo a submitted value.** Validation detail is a field path plus a Zod
  issue code.
- Copy is plain Canadian English: short sentences, no jargon in titles, and a hint that names the
  page or the action.
- **Setting defaults equal today's constants**, except the connect fallback wait, which defaults
  to 1000 ms.
- **Retry delays:** at most 4 delays, each 1 s–3 min (1000–180000 ms), total ≤ 180000 ms.
- **AI tuning is instance owner only.** Its API answers 403 `owner-only` to anyone else, and the
  nav hides the entry from anyone else.
- **Tests never touch the network or live Discord.**
- **Commands.** Always give `rg`/`grep` an explicit path (never a bare `.`). Never pipe a gate
  command through `tail`/`head`. Use literal line numbers only. `jq` is not installed.
- **Per-task verification:** `npx vitest run <the task's test files>` must pass. The whole-branch
  gate is `npm run typecheck && npm run lint && npm run test`.

## Review Focus

1. **A pasted secret comes back in a validation error.** A 400 on
   `POST /api/assistant/keys` or `PUT /api/assistant/tuning/resources.fetchHeaderValue` must not
   contain the submitted value anywhere in the body (Task 2, Task 6 tests).
2. **A stored setting no longer validates** (hand-edited DB, bounds tightened later). The store
   uses the default, logs one `warn` naming the key, and never throws on read (Task 6 test).
3. **Two jobs race for the last RPM slot.** Exactly one reservation succeeds (Task 5 test).
4. **Gemini RPD across the daylight-saving change** (2026-11-01, America/Los_Angeles). The day
   start and the next day start are the true local midnights (Task 9 test).
5. **A non-JSON error page** (e.g. a Cloudflare tunnel 502 HTML page) reaches the dashboard. It
   shows `unreadable-response` with the HTTP status and does not crash (Task 3 test).

---

### Task 1: Provider failure classification (core)

ADR 0079. Package `packages/core`.

**Files:**
- Modify: `packages/core/src/providers/errors.ts`
- Create: `packages/core/src/providers/failure.ts`
- Create: `packages/core/src/providers/failure.test.ts`
- Modify: `packages/core/src/providers/openai-compatible.ts` (the `generateText` catch block and the `!response.ok` block)
- Modify: `packages/core/src/providers/gemini.ts` (the `generateContent` catch block around line 171 and the non-ok block around line 182; the model-list function around lines 303–316)
- Modify: `packages/core/src/assistant/trace.ts` (attempt object)
- Modify: `packages/core/src/index.ts` (exports)
- Test: `packages/core/src/providers/openai-compatible.test.ts`, `packages/core/src/providers/gemini.test.ts` (add cases; the files exist)

**Interfaces — Produces:**

```ts
// errors.ts — ProviderError gains three optional readonly fields, set from constructor options
export class ProviderError extends Error {
  public readonly resetAt?: number;
  public readonly quotaScope?: 'daily-free';
  public readonly status?: number;    // HTTP status when a response arrived
  public readonly netCode?: string;   // allowlisted network error code (see failure.ts)
  public readonly host?: string;      // from OUR base URL, e.g. 'openrouter.ai'
  constructor(kind: ProviderErrorKind, message: string, retryable: boolean,
    options?: ErrorOptions & { resetAt?: number; quotaScope?: 'daily-free';
      status?: number; netCode?: string; host?: string });
}

// failure.ts
export const NET_ERROR_CODES = [
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID',
] as const;
export type NetErrorCode = (typeof NET_ERROR_CODES)[number];
/** Walks err, err.cause, err.cause.cause … (max depth 5); first `code` in the allowlist, else undefined. */
export const netCodeOf: (err: unknown) => NetErrorCode | undefined;

export type ProviderFailureCode =
  | 'provider-connect-timeout' | 'provider-dns' | 'provider-connection-refused'
  | 'provider-network-unreachable' | 'provider-tls' | 'provider-network-error'
  | 'provider-timeout' | 'provider-auth' | 'provider-bad-model' | 'provider-rate-limit'
  | 'provider-daily-quota' | 'provider-credits' | 'provider-outage'
  | 'provider-invalid-response' | 'provider-safety-refusal' | 'provider-error'
  | 'local-rpm-limit' | 'local-rpd-limit';

export interface FailureText { readonly title: string; readonly explanation: string; readonly hint: string }
export const PROVIDER_FAILURE_TEXT: Readonly<Record<ProviderFailureCode, FailureText>>;

export interface ProviderFailure {
  readonly code: ProviderFailureCode;
  readonly provider: string;
  readonly model: string;
  readonly host?: string;
  readonly httpStatus?: number;
  readonly netCode?: NetErrorCode;
  readonly retryable: boolean;
  readonly resetAt?: number;
}
export const classifyProviderFailure: (err: unknown, ctx: { provider: string; model: string }) => ProviderFailure;
```

Trace attempt (`trace.ts`) gains **optional** fields, and nothing else changes:
`code: z.string().optional()`, `httpStatus: z.number().int().optional()`,
`netCode: z.string().optional()`, `host: z.string().optional()`,
`availableAt: z.number().int().optional()`.

**Classification rules** (first match wins):

1. `ProviderError` with `quotaScope === 'daily-free'` → `provider-daily-quota` (carry `resetAt`).
2. `netCode = err.netCode ?? netCodeOf(err)`:
   - `UND_ERR_CONNECT_TIMEOUT` | `ETIMEDOUT` → `provider-connect-timeout`
   - `ENOTFOUND` | `EAI_AGAIN` → `provider-dns`
   - `ECONNREFUSED` | `ECONNRESET` | `EPIPE` | `UND_ERR_SOCKET` → `provider-connection-refused`
   - `EHOSTUNREACH` | `ENETUNREACH` → `provider-network-unreachable`
   - any `CERT_*` / `ERR_TLS_*` / `*_CERT*` code in the list → `provider-tls`
   - `UND_ERR_HEADERS_TIMEOUT` | `UND_ERR_BODY_TIMEOUT` → `provider-timeout`
3. `kind === 'timeout'` → `provider-timeout`.
4. By `status` (or kind when status is absent):
   - 401/403 or `authentication` → `provider-auth`
   - 402 → `provider-credits`
   - 429 or `rate-limit` → `provider-rate-limit`
   - 400/404, `invalid-request` or `capability-mismatch` → `provider-bad-model`
   - status ≥ 500 → `provider-outage`
5. `kind === 'quota'` → `provider-credits`.
6. `invalid-response` → `provider-invalid-response`; `safety-refusal` → `provider-safety-refusal`.
7. `kind === 'outage'` with no status and no netCode → `provider-network-error`.
8. Otherwise `provider-error`.

`retryable` = `err instanceof ProviderError ? err.retryable : false`. `host`, `httpStatus` and
`netCode` are copied when present.

**Text, verbatim** (`title` / `explanation` / `hint`):

| code | title | explanation | hint |
|---|---|---|---|
| provider-connect-timeout | Could not connect to the AI provider | The connection to the provider's server timed out before it was established. This is almost always the network on the Bananasaurs host: a VPN, a firewall, or broken IPv6. | Check the host's VPN and network. If a VPN is on, raise AI tuning → Network → Connect fallback wait, or turn the VPN off. |
| provider-dns | The provider's address could not be looked up | DNS did not return an address for the provider's host. | Check the host's DNS and internet connection. |
| provider-connection-refused | The provider refused or dropped the connection | The connection was refused or reset before a response arrived. | Usually brief. If it persists, check any proxy or firewall on the host. |
| provider-network-unreachable | The provider's network is unreachable | The host has no route to the provider. | Check the host's network connection and any VPN. |
| provider-tls | The secure connection to the provider failed | The provider's certificate could not be verified. | Check the host's clock, and whether a proxy is intercepting HTTPS. |
| provider-network-error | The request to the provider failed | The request failed before any response arrived. | Check the host's network. The daemon log has the detail. |
| provider-timeout | The provider did not answer in time | The request was sent but no answer came back within the provider request timeout. | Raise AI tuning → Provider request timeout, or choose a faster model. |
| provider-auth | The provider rejected the API key | The provider answered 401 or 403 for this key. | Re-paste the key in AI setup, and check that it is active in the provider's console. |
| provider-bad-model | This model is not available on this key | The provider did not accept this model name for this key. | Check the model name in AI setup against the provider's model list. |
| provider-rate-limit | The provider's rate limit was reached | The provider answered 429: too many requests in a short time. | Set an RPM limit on this chain entry in AI setup, so Bananasaurs stops before the provider does. |
| provider-daily-quota | The provider's daily allowance is used up | The provider refused because this key's daily free allowance is spent. | It resets on its own. Set an RPD limit on this chain entry, or add a fallback model. |
| provider-credits | The provider account has no credit | The provider answered that the account is out of credit or quota. | Add credit in the provider's console, or move this entry down the chain. |
| provider-outage | The provider had a server problem | The provider answered with a 5xx error. | Usually brief; the next chain entry is tried. Check the provider's status page if it persists. |
| provider-invalid-response | The provider's answer was unusable | The provider answered, but with nothing Bananasaurs could use. | Try again, or choose a different model. |
| provider-safety-refusal | The provider refused on safety grounds | The provider's safety filter blocked the request or the answer. | Rephrase the question, or choose a different model. |
| provider-error | The provider request failed | The request failed for a reason Bananasaurs does not recognise. | The daemon log has the detail. Search for this model's name. |
| local-rpm-limit | This model reached its per-minute limit | Bananasaurs did not call it, because this chain entry's RPM limit is used up. | It frees up within a minute. Raise the RPM limit in AI setup if the provider allows more. |
| local-rpd-limit | This model reached its daily limit | Bananasaurs did not call it, because this chain entry's RPD limit is used up for the provider's day. | It frees up at the provider's next day start. Raise the RPD limit in AI setup if the provider allows more. |

**Adapter changes:**

- `openai-compatible.ts` `generateText`:
  - The catch block adds `netCode: netCodeOf(error)` (only when defined) and `host: this.host`.
  - The non-ok block adds `status: response.status, host: this.host`, and so does the daily-quota
    throw.
  - `this.host = new URL(this.baseUrl).host`, computed in the constructor.
- `gemini.ts`: the same, in `generateText` and in the model-list function.

- [ ] **Step 1:** Write `failure.test.ts`, table-driven:
  - **Connect timeout.**
    `new ProviderError('outage','openrouter request failed',true,{cause: new TypeError('fetch failed',{cause: Object.assign(new Error('Connect Timeout Error'),{code:'UND_ERR_CONNECT_TIMEOUT'})}), host:'openrouter.ai'})`
    → `provider-connect-timeout`, `netCode: 'UND_ERR_CONNECT_TIMEOUT'`, `host: 'openrouter.ai'`,
    `retryable: true`.
  - **One case per rule.** Each rule 2–8 gets a case: `ENOTFOUND`; `ECONNREFUSED`;
    `EHOSTUNREACH`; `CERT_HAS_EXPIRED`; `UND_ERR_HEADERS_TIMEOUT`; `kind:'timeout'`; statuses
    401, 402, 429, 404 and 503; `kind:'quota'` without scope; `kind:'quota'` with
    `quotaScope:'daily-free'` and `resetAt`; `invalid-response`; `safety-refusal`; bare `outage`;
    a plain `Error`.
  - **`netCodeOf`.** It ignores codes outside the allowlist (`{code:'EWHATEVER'}` → undefined) and
    stops at depth 5.
  - **Text table.** Every `ProviderFailureCode` has non-empty title, explanation and hint (iterate
    a literal array of all 18 codes).
- [ ] **Step 2:** Run `npx vitest run packages/core/src/providers/failure.test.ts`. Expect FAIL
  (module missing).
- [ ] **Step 3:** Implement `errors.ts` and `failure.ts`, and export both from `packages/core/src/index.ts`.
- [ ] **Step 4:** Add adapter tests, using the existing fake-`fetch` pattern in those files:
  - a fetch that throws the TypeError above → the thrown `ProviderError` has
    `netCode === 'UND_ERR_CONNECT_TIMEOUT'` and `host === 'openrouter.ai'` (Gemini:
    `'generativelanguage.googleapis.com'`);
  - a 429 response → `status === 429`;
  - a 401 response → `status === 401`.

  Implement the adapter changes.
- [ ] **Step 5:** Extend the trace attempt schema. Add a test in the existing trace test file, or
  create `packages/core/src/assistant/trace.test.ts`:
  - an attempt with the five new fields parses;
  - an attempt without them still parses.
- [ ] **Step 6:** Run `npx vitest run packages/core/src/providers packages/core/src/assistant`. Expect PASS.
- [ ] **Step 7:** Commit: `feat(core): classify provider failures into stable codes (ADR 0079)`.

---

### Task 2: Explained API error bodies (http)

ADR 0078. Package `packages/http`, plus one core edit (logger allowlist).

**Files:**
- Create: `packages/http/src/errors/catalog.ts`
- Create: `packages/http/src/errors/reply.ts`
- Create: `packages/http/src/errors/catalog.test.ts`
- Create: `packages/http/src/errors/enrich.test.ts`
- Create: `packages/http/src/owner.ts`
- Modify: `packages/http/src/server.ts`:
  - `Fastify({...})` at line 391: add `genReqId`;
  - the error handler at lines 415–435;
  - add an `onSend` hook;
  - the `/api/session` route at lines 490–510.
- Modify: `packages/http/src/routes/assistant.ts`: move `isInstanceOwner` (line 111) into
  `owner.ts` and re-export it from `assistant.ts` so existing imports keep working.
- Modify: every route file in `packages/http/src/routes/*.ts` where a Zod `safeParse` failure
  answers 400 (see Step 5).
- Modify: `packages/http/src/index.ts` (export `ERROR_CATALOG`, `explainError`).
- Modify: `packages/core/src/obs/logger.ts`: add to `LOGGABLE_FIELDS` exactly:
  `requestId`, `route`, `method`, `httpStatus`, `netCode`, `host`, `provider`, `model`,
  `keyLabel`, `providerMessage`, `ms`, `settingKey`, `availableAt`, `resourceId`. Update the
  allowlist test if one enumerates the set.

**Interfaces — Produces:**

```ts
// catalog.ts
export interface ErrorExplanation { readonly title: string; readonly explanation: string; readonly hint?: string }
export const ERROR_CATALOG: Readonly<Record<string, ErrorExplanation>>;
/** The catalog entry, or a generic one: title 'The request failed', explanation `Bananasaurs refused the request (${code}).` */
export const explainError: (code: string) => ErrorExplanation;

// reply.ts
export interface FieldProblem { readonly path: string; readonly problem: string }
/** issue.path.join('.') and issue.code only — NEVER issue.message for non-custom issues, never a value. First 20 issues. */
export const fieldsOf: (error: import('zod').ZodError) => FieldProblem[];
export const badRequest: (reply: FastifyReply, error?: import('zod').ZodError, code?: string) => FastifyReply;
// → reply.status(400).send({ error: code ?? 'bad-request', ...(error ? { fields: fieldsOf(error) } : {}) })

// owner.ts
export const isInstanceOwner: (deps: HttpDeps, session: SessionContext) => boolean;
```

**Error body contract** (every non-2xx JSON response):
`{ error, title, message, hint?, fields?, requestId }`.

- **`onSend` hook.** It applies when `reply.statusCode >= 400`, the `content-type` starts with
  `application/json`, and the payload is a string that parses to an object with a string
  `error`. It then adds `title` and `hint` from `explainError(error)` when absent, `message`
  (= the catalog `explanation`) only when absent, and `requestId: request.id` when absent. It
  never overwrites a field the route set. Anything else passes through untouched.
- **`genReqId`.** `() => \`req-${randomBytes(4).toString('hex')}\`` (`node:crypto`).
- **Error handler, 5xx path.** Log
  `safeLogFields({ component: 'http', requestId: request.id, method: request.method, route: request.routeOptions.url ?? 'unmatched', httpStatus: 500, err: message })`
  with message `request failed`. Send
  `{ error: 'internal', requestId: request.id }` (the hook adds the rest).
- **Error handler, 4xx Fastify errors.** Also log at `warn` with the same fields plus
  `code: <the fastify code>`.
- **`/api/session`.** Adds `instanceOwner: isInstanceOwner(deps, result.session)`.

**Catalog contents.** One entry for every slug `rg -o "error: '[a-z0-9-]+'" packages/http/src --no-filename`
prints. Also include every code a route sends through a variable: read
`packages/http/src/routes/*.ts` for `send({ error:` with a non-literal, and include the values
those variables can hold, e.g. codes from ops ports in `packages/core/src/ops`. Also include
these, with this exact text:

| code | title | explanation | hint |
|---|---|---|---|
| internal | Something went wrong inside Bananasaurs | Nothing was changed. The daemon log has the detail under this request id. | Search the journal for the request id shown below. |
| bad-request | The request was not valid | One or more fields were missing or had the wrong format. | Fix the highlighted fields and try again. |
| owner-only | Only the owner can do that | This setting belongs to the bot's owner account. | Sign in as the owner. |
| owner-protected | That can't be changed | The owner account can't be changed. | — (omit hint) |
| weak-password | That password is too short | Use at least 12 characters. | — |
| username-taken | That username is taken | That username is already in use. | Choose another. |
| not-revealable | That password can't be shown | This password can't be shown. Set a new one instead. | — |
| read-only | Bananasaurs is read-only | This instance was started with BANANASAURS_READONLY, so nothing can be changed. | Restart without BANANASAURS_READONLY to make changes. |
| csrf | Your page is out of date | The page's security token did not match. | Reload the page and try again. |
| unauthenticated | You are signed out | Your session ended. | Sign in again. |
| reauth-required | Confirm your password | This action needs your password again. | — |
| provider-secret-store-not-configured | Provider keys can't be stored | The daemon has no provider secret, so keys and sealed settings can't be saved. | Set ASSISTANT_PROVIDER_SECRET_KEY or let the daemon create its key file, then restart. |
| unknown-setting | No such setting | That setting does not exist. | Reload the page. |
| invalid-setting | That value is not allowed | The value is outside what this setting accepts. | Check the limits shown under the setting. |
| settings-unavailable | AI tuning is not available | The settings store is not wired in this process. | Restart the daemon. If it persists, check the daemon log. |
| unreadable-response | The server's answer could not be read | Something between the browser and Bananasaurs answered with a page that is not JSON. | Check that the daemon is running and the tunnel is up. |
| dashboard-offline | Bananasaurs could not be reached | The browser could not reach the dashboard API. The daemon may be restarting. | Wait a moment and try again. |

(`unreadable-response` and `dashboard-offline` are produced by the dashboard, not the server.
They live here so the text has one home, and Task 3 copies them verbatim.)

- [ ] **Step 1:** Write `catalog.test.ts`:
  - It reads every `.ts` file under `packages/http/src` except `*.test.ts` (use `node:fs`
    `readdirSync` recursively), collects every match of `/error: '([a-z0-9-]+)'/g`, and asserts
    each has an `ERROR_CATALOG` entry with non-empty title and explanation.
  - It asserts the five former `REFUSAL_SENTENCES` codes have the exact explanations above.
- [ ] **Step 2:** Write `enrich.test.ts`, using `packages/http/src/test-support.ts`'s server
  builder as the existing `server.test.ts` does:
  - (a) An unauthenticated owner route returns `error`, `title`, `message`, `requestId`
    matching `/^req-[0-9a-f]{8}$/`.
  - (b) A route that sends its own `message` (the read-only 503) keeps it unchanged.
  - (c) `POST /api/assistant/keys` as the owner with
    `{ provider: 'bogus', label: 'x', apiKey: 'sk-SECRET-VALUE-123' }` → 400. The body has
    `fields` including path `provider`. **`JSON.stringify(body)` does not contain
    `sk-SECRET-VALUE-123`.**
  - (d) A registered test route that throws `new Error('boom')` → 500 with `error: 'internal'`
    and a `requestId`. The fake logger received `request failed` with that `requestId`.
  - (e) `GET /api/session` reports `instanceOwner: true` for the owner and `false` for a
    non-owner account.
- [ ] **Step 3:** Run `npx vitest run packages/http/src/errors`. Expect FAIL.
- [ ] **Step 4:** Implement `catalog.ts`, `reply.ts`, `owner.ts`, and the server changes. Add the
  logger allowlist fields.
- [ ] **Step 5:** In every `packages/http/src/routes/*.ts`, replace each
  `if (!parsed.success) return reply.status(400).send({ error: 'bad-request' })` (or `'invalid-body'`,
  or another code) with `return badRequest(reply, parsed.error)` (passing the same code when it
  is not `bad-request`). Find them with
  `rg -n "success\)" packages/http/src/routes`. Keep status codes and codes exactly as they
  were.
- [ ] **Step 6:** Run `npx vitest run packages/http packages/core/src/obs`. Expect PASS. Update
  existing tests only where they deep-equal a whole error body; switch those to
  `toMatchObject({ error: ... })`.
- [ ] **Step 7:** Commit: `feat(http): explained error bodies with request ids (ADR 0078)`.

---

### Task 3: Dashboard error rendering core

ADR 0078. Package `packages/dashboard`. **The dashboard must not import `@bananasaurs/core`,
`@bananasaurs/http` or `node:*`** (ESLint boundary). Copy any text you need.

**Files:**
- Modify: `packages/dashboard/src/api.ts` (`ApiError`, `apiFetch`, `SessionInfo`)
- Create: `packages/dashboard/src/api/describe-error.ts`
- Create: `packages/dashboard/src/api/describe-error.test.ts`
- Create: `packages/dashboard/src/ui/ErrorNotice.tsx`
- Create: `packages/dashboard/src/ui/ErrorNotice.test.tsx`
- Modify: `packages/dashboard/src/ui/Toast.tsx` (add optional `detail`)
- Modify: `packages/dashboard/src/app/session.tsx` (`handleWriteError`, `write`)
- Modify: `packages/dashboard/src/api/ops.ts`: delete `REFUSAL_SENTENCES`. Reimplement
  `accountErrorText` and `accountWriteErrorText` on top of `describeError`, keeping their
  exported signatures.
- Test: `packages/dashboard/src/app/session.test.tsx` (update the `owner-protected` case's mock
  body to include `message: "The owner account can't be changed."`, as the server now sends)

**Interfaces — Produces:**

```ts
// api.ts
export interface ApiErrorBody {
  readonly error: string; readonly title?: string; readonly message?: string; readonly hint?: string;
  readonly fields?: readonly { readonly path: string; readonly problem: string }[];
  readonly requestId?: string;
}
export class ApiError extends Error { constructor(readonly status: number, readonly body: ApiErrorBody) }
export class ReadonlyError extends ApiError {}
export class OfflineError extends Error {}           // fetch itself threw
// SessionInfo gains: readonly instanceOwner?: boolean | undefined;

// describe-error.ts
export interface DescribedError {
  readonly title: string; readonly message: string; readonly hint?: string;
  readonly code: string; readonly status?: number; readonly requestId?: string;
  readonly fields: readonly { readonly path: string; readonly problem: string }[];
}
export const describeError: (err: unknown) => DescribedError;
/** The human text for the first field problem at `path` (exact match or `path.` prefix), else undefined. */
export const fieldError: (err: unknown, path: string) => string | undefined;

// ErrorNotice.tsx
export function ErrorNotice(props: { readonly error: unknown; readonly compact?: boolean }): ReactElement;
```

**Rules:**

- **`apiFetch`.**
  - Wrap the `fetch` call in try/catch and rethrow as `new OfflineError(String(err))`.
  - For a non-ok response whose body is not JSON, throw
    `new ApiError(status, { error: 'unreadable-response' })`. Today's `'unknown'` fallback goes.
  - The 401 and 503 branches parse with the same fallback.
- **`describeError`.**
  - For an `ApiError`: `title` = `body.title` ?? `'The request failed'`; `message` =
    `body.message` ?? the local text for `unreadable-response` (copy from Task 2's table) ??
    `` `Bananasaurs refused the request (${body.error}).` ``. Then `hint`, `code = body.error`,
    `status`, `requestId`, and `fields ?? []`.
  - For an `OfflineError`: `code: 'dashboard-offline'`, with Task 2's table text.
  - For any other `Error`: `code: 'dashboard-bug'`, title `'Something went wrong in this page'`,
    `message: err.message`.
  - Anything else: the same, with `String(err)`.
- **`fieldError` problem text.** `too_small` → "Too small."; `too_big` → "Too large.";
  `invalid_type` → "Missing or the wrong kind of value."; `invalid_string` → "Not in the right
  format."; `invalid_enum_value` → "Not one of the allowed choices."; `unrecognized_keys` →
  "Not a field this form accepts."; `custom` → "Not allowed."; anything else → "Not valid."
- **`ErrorNotice`.** A `role="alert"` block:
  - the title in bold, then the message, then the hint (muted, prefixed "What to do: ");
  - then a muted small line `code · HTTP <status> · request <requestId>`, omitting absent parts;
  - a "Copy request id" button (`navigator.clipboard?.writeText(requestId)`), only when
    `requestId` is present.
  - `compact` shows the title and message only, with the meta line.
  - Use the existing Tailwind tokens seen in `Field.tsx` (`text-danger`, `text-ink-muted`).
- **Toast.** `ToastInput` gains `readonly detail?: string`, rendered as a small muted line.
- **`session.tsx`.** Every `toast({ tone: 'danger', title: 'The request failed', message: accountErrorText(...) ?? err.message })`
  becomes: `const d = describeError(err); toast({ tone: 'danger', title: d.title, message: [d.message, d.hint].filter(Boolean).join(' '), detail: [d.code, d.status && \`HTTP ${d.status}\`, d.requestId && \`request ${d.requestId}\`].filter(Boolean).join(' · ') })`.
  The special cases above it (read-only, reauth cancelled, invalid credentials, signed out) stay
  as they are.

- [ ] **Step 1:** Write `describe-error.test.ts`:
  - an `ApiError` with a full body;
  - an `ApiError` with only `{ error: 'x' }` → message `Bananasaurs refused the request (x).`;
  - `unreadable-response`;
  - `OfflineError`;
  - a plain `Error`;
  - a string;
  - `fieldError` with an exact match, a prefix match, and no match.
- [ ] **Step 2:** Write `ErrorNotice.test.tsx`:
  - it renders title, message, hint, and the meta line `bad-request · HTTP 400 · request req-0a1b2c3d`;
  - the copy button calls a stubbed `navigator.clipboard.writeText` with the id;
  - `compact` hides the hint.
- [ ] **Step 3:** Add a test in `packages/dashboard/src/api.test.ts` (create it if absent, using
  `vi.stubGlobal('fetch', ...)`):
  - a 502 with an HTML body throws `ApiError` with `status 502` and `body.error === 'unreadable-response'`;
  - a fetch that rejects throws `OfflineError`.
- [ ] **Step 4:** Run `npx vitest run packages/dashboard/src/api packages/dashboard/src/ui/ErrorNotice.test.tsx packages/dashboard/src/api.test.ts`.
  Expect FAIL.
- [ ] **Step 5:** Implement. Update `session.tsx` and `ops.ts`.
- [ ] **Step 6:** Run `npx vitest run packages/dashboard`. Expect PASS. Fix every existing test
  that asserted the old toast text, updating its mock bodies to include the server-sent
  `title`/`message`.
- [ ] **Step 7:** Commit: `feat(dashboard): describeError and ErrorNotice (ADR 0078)`.

---

### Task 4: Dashboard error call-site sweep

ADR 0078. Consumes Task 3's `describeError`, `fieldError` and `ErrorNotice`.

**Files:**
- Modify: every page under `packages/dashboard/src/pages/*.tsx`, and
  `packages/dashboard/src/app/*.tsx`, that renders error text. Find them with:
  `rg -n "err\.body\.error|err\.message|String\(err\)|'The request failed'|Request failed|error instanceof Error \? error\.message" packages/dashboard/src/pages packages/dashboard/src/app`
- Test: the matching `*.test.tsx` files. New tests in
  `packages/dashboard/src/pages/assistant-resources.test.tsx`,
  `packages/dashboard/src/pages/providers.test.tsx` and
  `packages/dashboard/src/pages/config.test.tsx`.

**Rules:**

- **Branching stays; rendering changes.** Code that *branches* on `err.status` or `err.body.error`
  (e.g. `if (err.status === 409)`) stays.
- **Every place that renders an error changes:**
  - an inline `<p role="alert">` becomes `<ErrorNotice error={err} />` (store the thrown value in
    state, not a string);
  - a toast uses `describeError`, exactly as Task 3's `session.tsx` pattern does;
  - a `<Field error=...>` gets `fieldError(err, '<fieldPath>')` when the form's submit failed
    with 400, with the path equal to the request body key the field edits.
- **Nothing may render a raw slug.** A page-specific friendly sentence that exists today for a
  specific code may stay, but only where it is more specific than the server text.

- [ ] **Step 1:** Add three failing tests (one per named test file). Each mocks a 400 response
  `{ error: 'bad-request', title: 'The request was not valid', message: 'One or more fields were missing or had the wrong format.', hint: 'Fix the highlighted fields and try again.', fields: [{ path: '<a real field on that page>', problem: 'too_big' }], requestId: 'req-0a1b2c3d' }`
  for the page's main save, and asserts:
  - the title and the hint render;
  - `req-0a1b2c3d` renders;
  - the matching field shows "Too large.";
  - the text `bad-request` does not appear outside the meta line.
- [ ] **Step 2:** Run those three files. Expect FAIL.
- [ ] **Step 3:** Sweep every file the `rg` above lists.
- [ ] **Step 4:** Run `npx vitest run packages/dashboard`. Expect PASS. Update old assertions of
  raw codes or generic strings to the new texts.
- [ ] **Step 5:** Re-run the `rg` from **Files**. Every remaining hit must be a branch, not a
  render. List any you kept, and why, in your RESULT.
- [ ] **Step 6:** Commit: `feat(dashboard): every error shows its explanation and request id`.

---

### Task 5: Storage — migration 0047 and repos

ADRs 0080, 0081. Package `packages/storage`.

**Files:**
- Modify: `packages/storage/src/schema.ts`:
  - add `instanceSettings` and `assistantModelCalls` after `assistantModelChain` (line ~1856);
  - add two columns to `assistantModelChain` (lines 1841–1856);
  - add one column to `resourceDocuments` (lines 2165–2195).
- Generate: `npm run db:generate` → `drizzle/0047_*.sql` plus meta. Then **read the SQL**.
- Create: `packages/storage/src/repos/instance-settings.ts` (+ `.test.ts`)
- Create: `packages/storage/src/repos/model-calls.ts` (+ `.test.ts`)
- Modify: `packages/storage/src/repos/assistant-providers.ts` (`ChainRow`, `getModelChain`, `setModelChain`)
- Modify: the resource-cache repo that owns `upsertDocument`, found with
  `rg -n "export const upsertDocument" packages/storage/src`. Add `errorCode` to its input and
  read rows.
- Modify: `packages/storage/src/index.ts` (exports `instanceSettingsRepo`, `modelCallsRepo`)

**Schema** (no CHECK constraints on the new chain and document columns, so drizzle emits a plain
`ALTER TABLE … ADD COLUMN` and never rebuilds a table):

```ts
// on assistantModelChain
rpmLimit: integer('rpm_limit'),   // null = no limit
rpdLimit: integer('rpd_limit'),
// on resourceDocuments
errorCode: text('error_code'),

export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
}, (t) => [check('instance_settings_key_length', sql`length(${t.key}) BETWEEN 1 AND 64`)]);

export const assistantModelCalls = sqliteTable('assistant_model_calls', {
  callId: integer('call_id').primaryKey({ autoIncrement: true }),
  keyId: text('key_id').notNull(),
  model: text('model').notNull(),
  at: integer('at').notNull(),
  guildId: snowflake('guild_id').notNull(),
}, (t) => [
  foreignKey({ columns: [t.keyId], foreignColumns: [assistantProviderKeys.keyId] }).onDelete('cascade'),
  index('assistant_model_calls_key_model_at').on(t.keyId, t.model, t.at),
  check('assistant_model_calls_guild_id_snowflake', snowflakeCheck(t.guildId)),
]);
```

**Interfaces — Produces:**

```ts
// instance-settings.ts
export interface StoredSetting { readonly key: string; readonly valueJson: string; readonly updatedAt: number; readonly updatedBy: string }
export const listSettings: (scope: InstanceScope) => StoredSetting[];
export const upsertSetting: (scope: InstanceScope, row: StoredSetting) => void;
export const deleteSetting: (scope: InstanceScope, key: string) => void;

// model-calls.ts
export type ReserveResult = { readonly ok: true } | { readonly ok: false; readonly limit: 'rpm' | 'rpd'; readonly availableAt: number };
export const reserveModelCall: (scope: InstanceScope, input: {
  readonly keyId: string; readonly model: string; readonly guildId: string; readonly now: number;
  readonly rpmLimit: number | null; readonly rpdLimit: number | null;
  readonly dayStart: number; readonly nextDayStart: number;
}) => ReserveResult;
export interface ModelUsage { readonly lastMinute: number; readonly today: number }
export const modelUsage: (scope: InstanceScope, input: { keyId: string; model: string; now: number; dayStart: number }) => ModelUsage;

// assistant-providers.ts
export interface ChainRow { readonly position: number; readonly keyId: string; readonly provider: ProviderId; readonly model: string; readonly rpmLimit: number | null; readonly rpdLimit: number | null }
export const setModelChain: (scope: InstanceScope,
  rows: readonly { keyId: string; model: string; rpmLimit?: number | null; rpdLimit?: number | null }[], now: number) => void;
```

**`reserveModelCall` algorithm.** One `writeInstance` transaction, synchronous, with no `await`:

1. `DELETE FROM assistant_model_calls WHERE at < now - 172800000` (prune rows older than 48 h).
2. If `rpmLimit !== null`: count rows for (keyId, model) with `at > now - 60000`. If
   `count >= rpmLimit`, return `{ ok: false, limit: 'rpm', availableAt: <min at in that window> + 60000 }`.
3. If `rpdLimit !== null`: count rows with `at >= dayStart`. If `count >= rpdLimit`, return
   `{ ok: false, limit: 'rpd', availableAt: nextDayStart }`.
4. Insert `{ keyId, model, at: now, guildId }`, then return `{ ok: true }`.

`guildId` is written through the existing snowflake column type, so it must be a valid snowflake.
Tests use `'123456789012345678'`.

- [ ] **Step 1:** Write `model-calls.test.ts`, using the repo test-support database helper the
  sibling repo tests use:
  - **rpm 2.** Calls at t=0 and t=1000 are ok. A call at t=2000 is refused with `limit:'rpm'`,
    `availableAt: 60000`. A call at t=60001 is ok.
  - **rpd 3 with dayStart=0, nextDayStart=86400000.** The fourth call at t=4000 is refused with
    `availableAt 86400000`.
  - **Both null.** Unlimited: 50 calls are ok.
  - **Separate counters.** A different model and a different key have their own counters.
  - **Last-slot race** (Review Focus 3). With rpm 1, two `reserveModelCall` calls at the same
    `now` → exactly one ok.
  - **Prune.** Rows older than 48 h are gone after the next reserve.
  - **`modelUsage`.** It counts correctly.
  - **Cascade.** Deleting the key cascades its rows.
- [ ] **Step 2:** Write `instance-settings.test.ts`: upsert then list, upsert overwrites, delete.
  Extend the chain repo test: limits round-trip; omitted limits store null.
- [ ] **Step 3:** Run `npx vitest run packages/storage/src/repos/model-calls.test.ts packages/storage/src/repos/instance-settings.test.ts`.
  Expect FAIL.
- [ ] **Step 4:** Edit `schema.ts` and run `npm run db:generate`. **Read the generated
  `drizzle/0047_*.sql`.** It must contain only `CREATE TABLE … STRICT` for the two new tables,
  their index, and three `ALTER TABLE … ADD COLUMN` statements, with no `__new_` table copy. If
  drizzle generated a table rebuild, stop and report `BLOCKED` with the SQL.
- [ ] **Step 5:** Implement the repos and exports.
- [ ] **Step 6:** Run `npx vitest run packages/storage`. Expect PASS, including the schema
  invariant test that asserts every table is STRICT.
- [ ] **Step 7:** Commit: `feat(storage): migration 0047 — instance settings, model-call ledger, chain limits`.

---

### Task 6: Instance settings — registry, daemon store, HTTP routes

ADR 0080. Consumes Task 5's `instanceSettingsRepo` and Task 2's `badRequest`/`fieldsOf`.

**Files:**
- Create: `packages/core/src/settings/instance-settings.ts` (+ `.test.ts`); export from `packages/core/src/index.ts`
- Create: `apps/daemon/src/settings/instance-settings-store.ts` (+ `.test.ts`)
- Modify: `apps/daemon/src/assistant/provider-config.ts`: export `keyFrom` (line 24) as
  `providerKeyFrom`, so the store seals with the same key.
- Create: `packages/http/src/routes/assistant-tuning.ts` (+ `.test.ts`); export
  `registerAssistantTuningRoutes` from `packages/http/src/index.ts`
- Modify: `packages/http/src/server.ts` (`HttpDeps` gains `instanceSettings?: InstanceSettingsPort`)
- Modify: `apps/daemon/src/runtime/daemon.ts` (create the store; expose it on the returned daemon object)
- Modify: `apps/daemon/src/index.ts` and `apps/daemon/src/http/wiring.ts` (pass the store
  through, as `assistantProviderConfig` is passed; register the tuning routes next to
  `registerAssistantProviderRoutes`)

**Registry** (`instance-settings.ts`). All values stored in base units (ms, counts):

```ts
export type SettingDisplay = 'seconds' | 'milliseconds' | 'minutes' | 'count' | 'text' | 'secret' | 'seconds-list' | 'host-list';
export interface SettingDefinition<T> {
  readonly key: string; readonly group: 'Assistant retries' | 'Assistant tool loop' | 'Network' | 'Resources';
  readonly label: string; readonly help: string; readonly display: SettingDisplay;
  readonly schema: z.ZodType<T>; readonly defaultValue: T;
  readonly bounds?: { readonly min?: number; readonly max?: number; readonly maxItems?: number };
  readonly secret?: true;
}
```

| key | group | label | display | default | schema |
|---|---|---|---|---|---|
| `assistant.retryDelaysMs` | Assistant retries | Retry delays | seconds-list | `[10000, 30000, 90000]` | `z.array(z.number().int().min(1000).max(180000)).max(4).refine(a => a.reduce((s, x) => s + x, 0) <= 180000, { message: 'Retry delays must add up to 3 minutes or less.' })` |
| `assistant.providerTimeoutMs` | Assistant retries | Provider request timeout | seconds | `30000` | `z.number().int().min(5000).max(120000)` |
| `assistant.maxToolRounds` | Assistant tool loop | Max tool rounds | count | `4` | `z.number().int().min(1).max(8)` |
| `assistant.maxToolCalls` | Assistant tool loop | Max tool calls per question | count | `12` | `z.number().int().min(1).max(30)` |
| `assistant.maxOutputTokens` | Assistant tool loop | Max answer length (tokens) | count | `2048` | `z.number().int().min(256).max(8192)` |
| `network.connectFallbackMs` | Network | Connect fallback wait (IPv4/IPv6) | milliseconds | `1000` | `z.number().int().min(100).max(5000)` |
| `resources.fetchTimeoutMs` | Resources | Fetch timeout | seconds | `5000` | `z.number().int().min(1000).max(60000)` |
| `resources.refreshIntervalMin` | Resources | Refresh interval | minutes | `60` | `z.number().int().min(15).max(1440)` |
| `resources.fetchHeaderName` | Resources | Fetch header name | text | `null` | `z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_\`\|~-]{1,64}$/).refine(n => !RESERVED.has(n.toLowerCase()), { message: 'That header is managed by Bananasaurs.' }).nullable()` with `RESERVED = new Set(['host','authorization','cookie','content-length','content-type','connection','transfer-encoding','if-none-match','if-modified-since','user-agent','accept','accept-encoding'])` |
| `resources.fetchHeaderValue` | Resources | Fetch header value | secret | `null` | `z.string().min(1).max(500).nullable()`, `secret: true` |
| `resources.fetchHeaderHosts` | Resources | Send the header only to | host-list | `[]` | `z.array(z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)).max(10)` |

Help texts (verbatim, in the same order):

1. "How long to wait before retrying when every AI model was busy or timed out. Up to 4 retries,
   3 minutes in total. Leave empty to answer at once without retrying."
2. "How long one request to an AI provider may take before it is abandoned."
3. "How many rounds of tool use (searching resources, reading pages) one question may take."
4. "How many tool calls one question may make in total."
5. "The longest answer a model may write, in tokens (about 4 characters each)."
6. "How long to try IPv6 before falling back to IPv4 (or the other way round) when connecting.
   Node's default is 250 ms, which fails behind a slow VPN. Applies to new connections at once."
7. "How long a website or document fetch may take."
8. "How often cached resources are refreshed."
9. "Optional. A header sent with website fetches, so a site's Cloudflare rule can let Bananasaurs
   through without a challenge."
10. "The header's secret value. Stored encrypted; never shown again."
11. "The header is sent only to these hosts, and never anywhere else."

Exports: `INSTANCE_SETTINGS` (readonly array of definitions, in the table's order),
`InstanceSettingKey` (union of the keys), `InstanceSettingValues` (key → value type), and
`settingDefinition(key)`.

**Daemon store** (`instance-settings-store.ts`):

```ts
export interface InstanceSettingView {
  readonly key: InstanceSettingKey; readonly group: string; readonly label: string; readonly help: string;
  readonly display: SettingDisplay; readonly bounds?: SettingDefinition<unknown>['bounds'];
  readonly value: unknown;            // secret settings: { configured: boolean } — never the value
  readonly defaultValue: unknown;     // secret: { configured: false }
  readonly isDefault: boolean; readonly updatedAt?: number; readonly updatedBy?: string;
}
export type SetResult =
  | { readonly ok: true; readonly before: unknown; readonly after: unknown; readonly view: InstanceSettingView }
  | { readonly ok: false; readonly code: 'unknown-setting' | 'invalid-setting' | 'provider-secret-store-not-configured'; readonly error?: z.ZodError };
export interface InstanceSettingsStore {
  get<K extends InstanceSettingKey>(key: K): InstanceSettingValues[K];   // secret: the opened plaintext (daemon-internal only)
  list(): readonly InstanceSettingView[];
  set(key: string, value: unknown, by: string, now: number): SetResult;
  reset(key: string, by: string, now: number): SetResult;
  onChange(listener: (key: InstanceSettingKey) => void): () => void;
}
export const createInstanceSettingsStore: (deps: {
  readonly instance: InstanceScope;
  readonly seal?: (plain: string) => string;           // absent when there is no provider secret
  readonly open?: (sealed: string) => string | undefined;
  readonly logger: Logger;
}) => InstanceSettingsStore;
```

Store rules:

- **Cache.** `listSettings` is read once into a `Map`; `set`/`reset` update the row and the
  cache, then call the listeners.
- **Invalid stored value** (Review Focus 2): a stored row whose JSON does not parse or does not
  pass the schema → `get` returns the default and logs once per key per process:
  `logger.warn(safeLogFields({ component: 'config', settingKey: key }), 'stored setting is invalid; using the default')`.
  It never throws.
- **Secret setting.** `set` with a string seals it and stores `JSON.stringify(sealed)`; with
  `null` it deletes the row. No `seal` → `{ ok:false, code:'provider-secret-store-not-configured' }`.
  `get` opens it; if opening fails it returns `null`.
- **Audit values.** `before`/`after` in `SetResult` are the view values, so a secret shows as
  `{ configured }`.

**HTTP port and routes** (`assistant-tuning.ts`). Define
`InstanceSettingsPort = Pick<InstanceSettingsStore, 'list' | 'set' | 'reset'>` with `list`
returning `readonly unknown[]` views. Keep the http package free of daemon imports: define the
view type structurally in `assistant-tuning.ts`.

- **`GET /api/assistant/tuning`.** Guard, then owner (403 `owner-only`), then port present (503
  `settings-unavailable`). Returns `200 { settings: views }`.
- **`PUT /api/assistant/tuning/:key`.**
  - The body is `z.object({ value: z.unknown() }).strict()`; a bad body gets
    `badRequest(reply, err)`.
  - `set(key, value, session.accountId, deps.now())`.
  - `unknown-setting` → 404. `invalid-setting` → `400 { error: 'invalid-setting', fields: fieldsOf(error), message: <first issue's message if the issue code is 'custom', else omitted> }`.
    Secret-store missing → 503.
  - On ok: audit `{ ...dashboardAuditBase(session, deps.now()), action: 'instance_setting.changed', subjectType: 'instance_setting', subjectId: key, before, after }`,
    then `200 { setting: view }`.
- **`DELETE /api/assistant/tuning/:key`.** Reset, with the same audit and responses.

- [ ] **Step 1:** Write `packages/core/src/settings/instance-settings.test.ts`:
  - every default parses under its own schema;
  - retry delays: `[60000, 60000, 60000]` ok; `[60000, 60000, 60001]` refused with the custom
    message; 5 items refused; `[500]` refused; `[]` ok;
  - header name `Authorization` refused; `X-Bananasaurs-Fetch` ok;
  - host `sfuracerbot.ca` ok; `https://x.ca` refused.
- [ ] **Step 2:** Write `instance-settings-store.test.ts`, using a real test database from
  `@bananasaurs/storage/test-support`:
  - `get` returns the default when there is no row;
  - `set` then `get` returns the value;
  - `set` of an invalid value returns `invalid-setting` and leaves the old value;
  - a row hand-written with `valueJson: '"oops"'` for `assistant.maxToolRounds` → `get` returns
    4 and the logger got exactly one warn, even after two reads;
  - a secret with a fake seal/open (`s => 'sealed:' + s`) stores the sealed text, `list()` shows
    `{ configured: true }`, and `JSON.stringify(list())` does not contain the plaintext;
  - `reset` returns to the default;
  - `onChange` fires with the key.
- [ ] **Step 3:** Write `assistant-tuning.test.ts`, following `assistant-providers.test.ts`'s
  setup:
  - a non-owner gets 403 `owner-only` on all three routes;
  - the owner gets the list;
  - PUT a valid value → 200 and one audit record `instance_setting.changed`;
  - PUT retry delays summing over 180000 → 400 `invalid-setting`, `message` equal to the custom
    text;
  - PUT `resources.fetchHeaderValue` with `'tok-SECRET-999'` → 200, and neither the response nor
    the recorded audit contains `tok-SECRET-999`;
  - an unknown key → 404;
  - DELETE → the default, audited.
- [ ] **Step 4:** Run the three test files. Expect FAIL.
- [ ] **Step 5:** Implement the registry, store, routes and wiring. In `daemon.ts`, build the
  store after `providerStore`. Use `seal`/`open` = `sealWithKey`/`openWithKey` (from
  `apps/daemon/src/crypto/seal.ts`) with `providerKeyFrom(providerSecret.secret)` when the
  secret is present.
- [ ] **Step 6:** Run `npx vitest run packages/core/src/settings apps/daemon/src/settings packages/http/src/routes/assistant-tuning.test.ts apps/daemon/src/http`.
  Expect PASS.
- [ ] **Step 7:** Commit: `feat: instance settings store and AI tuning API (ADR 0080)`.

---

### Task 7: Settings consumers — assistant retries, timeout, loop limits, connect wait

ADR 0080. Consumes Task 6's `InstanceSettingsStore.get` / `onChange`.

**Files:**
- Modify: `apps/daemon/src/jobs/assistant.ts`:
  - `PROVIDER_RETRY_DELAYS_MS` / `PROVIDER_RETRY_CEILING` (lines 244–245) and their use (~line
    570–590);
  - add a dep `retryDelaysMs?: () => readonly number[]`, defaulting to the constant.
- Modify: `apps/daemon/src/assistant/model-chain.ts`: `makeProvider` (line 57) gains
  `options?: { timeoutMs?: number }`, passed to `GeminiProvider` /
  `createOpenRouterProvider` / `createNvidiaNimProvider` as `timeoutMs`. `resolveModelChain`
  deps gain `providerTimeoutMs?: () => number`.
- Modify: `apps/daemon/src/assistant/provider-config.ts` (`createProviderConfigStore` gains
  `options.providerTimeoutMs?: () => number`, forwarded in `chain()`) and its caller in
  `apps/daemon/src/runtime/daemon.ts`.
- Modify: `apps/daemon/src/assistant/service.ts`: where `runToolLoop` is called, pass
  `limits: { rounds, totalCalls, maxOutputTokens }` from a new service dep
  `loopLimits?: () => { rounds: number; totalCalls: number; maxOutputTokens: number }`.
- Create: `apps/daemon/src/runtime/network.ts` (+ `.test.ts`)
- Modify: `apps/daemon/src/runtime/daemon.ts` / `apps/daemon/src/runtime/guild.ts`: wire the
  deps from the store. Apply the connect wait at startup, and on `onChange('network.connectFallbackMs')`.
- Modify: `apps/daemon/src/index.ts`: after the store exists, log every setting where
  `isDefault === false`, as
  `log.info(safeLogFields({ component: 'config', settingKey: key }), \`setting ${key} = ${JSON.stringify(value)}\`)`.
  Secret settings log `configured` only.

**`network.ts`:**

```ts
import net from 'node:net';
/** Verified 2026-09-25 on Node v22.23.2: global fetch honours a runtime change for new connections. */
export const applyConnectFallback = (ms: number, logger: Logger): void => {
  net.setDefaultAutoSelectFamilyAttemptTimeout(ms);
  logger.info(safeLogFields({ component: 'config', settingKey: 'network.connectFallbackMs' }),
    `connect fallback wait set to ${ms} ms`);
};
```

**Retry rule** (`jobs/assistant.ts`):

- `const delays = deps.retryDelaysMs?.() ?? PROVIDER_RETRY_DELAYS_MS; const ceiling = delays.length + 1;`
- Retry only when `context.attempts < ceiling`. The delay is `delays[context.attempts - 1] ?? delays.at(-1)`.
- With `delays.length === 0`, the first retryable failure answers at once.
- Update the doc comment above the constant to match.

- [ ] **Step 1:** Write failing tests:
  - (a) In the existing assistant job test file (find it with
    `rg -ln "assistantInvokeHandler" apps/daemon/src`): with `retryDelaysMs: () => [5000]`, a
    retryable provider failure throws `RetryAfterError` with 5000 on attempt 1 and answers busy
    on attempt 2; with `() => []`, attempt 1 answers busy.
  - (b) `network.test.ts`: `applyConnectFallback(1234, logger)` makes
    `net.getDefaultAutoSelectFamilyAttemptTimeout()` return 1234 and logs once. Restore the
    original value in `afterEach`.
  - (c) The model-chain test: `makeProvider('openrouter', 'k', 'free', { timeoutMs: 7000 })`
    uses 7000. Assert it through a fake `fetch` whose signal is checked, or by exposing the
    timeout on the provider in a test-only way that already exists; read the provider tests
    first.
  - (d) A service test: `loopLimits: () => ({ rounds: 1, totalCalls: 2, maxOutputTokens: 300 })`
    reaches the provider request (`maxOutputTokens: 300`).
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Run `npx vitest run apps/daemon/src/jobs apps/daemon/src/assistant apps/daemon/src/runtime`.
  Expect PASS.
- [ ] **Step 5:** Commit: `feat(daemon): assistant retries, timeout, loop limits and connect wait read AI tuning`.

---

### Task 8: AI tuning page (dashboard)

ADR 0080. Consumes Task 6's API and Task 3's `ErrorNotice` / `fieldError`.

**Files:**
- Modify: `packages/dashboard/src/app/routes.ts`: `NavEntry` gains `readonly ownerOnly?: true`.
  Add, after the `/assistant/setup` entry:
  `{ path: '/assistant/tuning', label: 'AI tuning', status: 'built', group: 'Assistant', ownerOnly: true }`
- Modify: `packages/dashboard/src/app/Shell.tsx`: filter out `ownerOnly` entries when
  `session.info.instanceOwner !== true` (both the rail at line ~104 and the jump sheet); add the
  route.
- Modify: `packages/dashboard/src/app/JumpNav.tsx` if it reads `NAV` separately.
- Create: `packages/dashboard/src/api/tuning.ts`: typed `getTuning`, `putTuning(key, value)`,
  `resetTuning(key)`, using the session's `read`/`writeOrThrow`, like `api/assistant.ts` does.
- Create: `packages/dashboard/src/pages/assistant-tuning.tsx` (+ `.test.tsx`)

**Page:**

- **Header.** `PageHeader` title "AI tuning", with the subtitle "These settings apply to every
  server this bot is in. Changes take effect at once."
- **One `Card` per group**, in the registry's order.
- **Each setting row** shows the label, the help text (as `Field` hint), the control, "Default:
  <formatted default>", and a "Reset" button (disabled when `isDefault`). Controls by display:
  - `seconds`: a number input in seconds, step 1. Sends `value × 1000`.
  - `milliseconds`: a number input in ms.
  - `minutes` / `count`: a number input.
  - `seconds-list`: a text input of comma-separated seconds (`10, 30, 90`); an empty input sends
    `[]`.
  - `text`: a text input; an empty input sends `null`.
  - `secret`: a password input with placeholder "Configured — type to replace" when configured,
    else "Not set", plus a "Remove" button that sends `null`. The value is never prefilled.
  - `host-list`: comma-separated hosts.
- **Save** is one button per row. On 400, show `fieldError(err, '')`, or the `ErrorNotice`
  compact form under the row. On success, toast "Saved" and replace the row from the response.
- **Load failure** shows `<ErrorNotice error={err} />`.
- **A non-owner** who opens the URL directly sees the `owner-only` `ErrorNotice` from the 403.

- [ ] **Step 1:** Write `assistant-tuning.test.tsx`, mocking `fetch` as sibling page tests do:
  - it renders the groups and labels from a fixture list;
  - editing "Provider request timeout" to 45 and saving sends
    `PUT /api/assistant/tuning/assistant.providerTimeoutMs` with `{ value: 45000 }`;
  - retry delays "60, 60, 61" → the 400 `invalid-setting` custom message renders under the row;
  - the secret row never renders a value;
  - Reset sends `DELETE`;
  - a 403 renders "Only the owner can do that".
- [ ] **Step 2:** Add a Shell test: with `instanceOwner: false`, the rail has no "AI tuning";
  with `true`, it does.
- [ ] **Step 3:** Run them. Expect FAIL. Implement. Run `npx vitest run packages/dashboard`.
  Expect PASS.
- [ ] **Step 4:** Commit: `feat(dashboard): Assistant → AI tuning page (owner only)`.

---

### Task 9: RPM/RPD enforcement in the model chain

ADR 0081. Consumes Task 5's `reserveModelCall`, Task 1's text for `local-rpm-limit` /
`local-rpd-limit`, and Task 1's trace attempt fields.

**Files:**
- Create: `packages/core/src/providers/provider-day.ts` (+ `.test.ts`); export from core index
- Modify: `apps/daemon/src/assistant/model-chain.ts`: `ChainEntry` gains
  `rpmLimit: number | null; rpdLimit: number | null`, filled from `ChainRow` (null for env-seed
  candidates)
- Modify: `apps/daemon/src/assistant/tool-loop.ts`
- Create: `apps/daemon/src/assistant/local-limit.ts` (+ `.test.ts`)
- Modify: `apps/daemon/src/assistant/service.ts` (build `reserveCall`; `mapLoopFailure`; the Try-it catch near line 1074)
- Modify: `apps/daemon/src/jobs/assistant.ts` (catch `LocalLimitError` before the retryable branch)
- Test: `apps/daemon/src/assistant/tool-loop.test.ts`, `apps/daemon/src/assistant/service*.test.ts`,
  and the assistant job test file

**`provider-day.ts`** (exact code):

```ts
const zoneOffsetMs = (timeZone: string, ms: number): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
};
const zonedDayStart = (timeZone: string, ms: number): number => {
  const offset = zoneOffsetMs(timeZone, ms);
  const local = new Date(ms + offset);
  const midnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const guess = midnightAsUtc - offset;
  return midnightAsUtc - zoneOffsetMs(timeZone, guess);   // DST correction
};
/** Gemini's day follows Pacific time; OpenRouter and NVIDIA NIM use UTC. */
export const providerDayZone = (provider: string): string =>
  provider === 'gemini' ? 'America/Los_Angeles' : 'UTC';
export const providerDayStart = (provider: string, ms: number): number =>
  zonedDayStart(providerDayZone(provider), ms);
export const nextProviderDayStart = (provider: string, ms: number): number =>
  zonedDayStart(providerDayZone(provider), providerDayStart(provider, ms) + 36 * 3_600_000);
```

**Tool loop:**

- **Input.** `runToolLoop` gains
  `readonly reserveCall?: (entry: ChainEntry) => { readonly ok: true } | { readonly ok: false; readonly code: 'local-rpm-limit' | 'local-rpd-limit'; readonly availableAt: number }`.
- **In `runEntry`.** Pass `reserveCall` through deps. In `callProvider`, **before**
  `provider.generateText`, call `deps.reserveCall?.(entry)`. On refusal, push
  `{ provider: entry.providerId, model: entry.model, keyLabel: entry.keyLabel, outcome: 'skipped', reason: code, code, availableAt, ms: deps.entryMs() }`
  and return `undefined`, so the entry ends. A refusal in round 2+ also ends the entry, and the
  next entry restarts from round 1.
- **`LoopResult`** gains `readonly localLimit?: { readonly availableAt: number; readonly code: 'local-rpm-limit' | 'local-rpd-limit' }`.
  It is set on the final failed return when **every** attempt has `outcome === 'skipped'` and at
  least one has a `local-*` code. `availableAt` is the minimum over the local-limit attempts, and
  `code` comes from that attempt.

**`local-limit.ts`:**

```ts
export class LocalLimitError extends Error {
  constructor(readonly availableAt: number, readonly code: 'local-rpm-limit' | 'local-rpd-limit') {
    super('every assistant model is at its configured limit'); this.name = 'LocalLimitError';
  }
}
/** Member-facing text. ≤ 90 minutes away: minutes; otherwise a clock time in `timeZone`. */
export const localLimitReply = (availableAt: number, now: number, timeZone: string): string
// ≤ 90 min: `All AI models have reached the limits set for them. The next one frees up in about ${n} minute(s).`
//   n = Math.max(1, Math.ceil((availableAt - now) / 60000)); "1 minute" singular.
// else:     `All AI models have reached the limits set for them. The next one frees up at ${time}.`
//   time = new Intl.DateTimeFormat('en-CA', { timeZone, hour: 'numeric', minute: '2-digit' }).format(availableAt)
```

**Service wiring:**

- `reserveCall = (entry) => { const now = deps.now(); const r = modelCallsRepo.reserveModelCall(instanceScope, { keyId: entry.keyId, model: entry.model, guildId: scope.guildId, now, rpmLimit: entry.rpmLimit, rpdLimit: entry.rpdLimit, dayStart: providerDayStart(entry.providerId, now), nextDayStart: nextProviderDayStart(entry.providerId, now) }); return r.ok ? r : { ok: false, code: r.limit === 'rpm' ? 'local-rpm-limit' : 'local-rpd-limit', availableAt: r.availableAt }; }`.
  Use the instance scope the service already has access to (search `scopes.instance()` or the
  `InstanceScope` the service receives; add a dep if there is none).
- **`mapLoopFailure`.** The **first** check, before `dailyQuota`: if `failed.localLimit` is set,
  `throw new LocalLimitError(failed.localLimit.availableAt, failed.localLimit.code)`.
- **Job** (`jobs/assistant.ts`). In the catch, before the retryable branch:
  `if (err instanceof LocalLimitError) { const text = localLimitReply(err.availableAt, deps.now(), <the guild time zone the service already uses: BANANASAURS_TIME_ZONE via a dep>); deps.logger.warn(safeLogFields({ component: 'assistant-job', guildId: deps.guildId, code: err.code, availableAt: err.availableAt }), 'every assistant model is at its configured limit; answering at once'); await answerSingle(text); await logFailure(text, PROVIDER_FAILURE_LOG_REASON); return; }`.
  No `RetryAfterError`.
- **Try-it** (service.ts ~line 1076). Add the same branch, producing the same text.

- [ ] **Step 1:** Write `provider-day.test.ts`:
  - openrouter at `2026-09-25T15:00:00Z` → start `2026-09-25T00:00:00Z`, next `2026-09-26T00:00:00Z`;
  - gemini at `2026-09-25T06:00:00Z` → start `2026-09-24T07:00:00Z`, next `2026-09-25T07:00:00Z`;
  - gemini at `2026-11-01T12:00:00Z` → start `2026-11-01T07:00:00Z`, next `2026-11-02T08:00:00Z`;
  - gemini at `2026-03-08T12:00:00Z` → start `2026-03-08T08:00:00Z`, next `2026-03-09T07:00:00Z`.
- [ ] **Step 2:** Write `local-limit.test.ts`:
  - 30 s away → "about 1 minute";
  - 14 min 10 s away → "about 15 minutes";
  - 5 h away in `America/Vancouver` → contains "at " and a time.
- [ ] **Step 3:** Add tool-loop tests, using the existing fake-provider helpers in `tool-loop.test.ts`:
  - (a) Entry 1 refused `local-rpm-limit` and entry 2 answers → answered. Entry 1's attempt is
    skipped with `code` and `availableAt`, and entry 1's provider was **never called**.
  - (b) Both refused with availableAt 5000 and 3000 → failed, and
    `localLimit = { availableAt: 3000, code: <entry 2's code> }`. Neither provider was called.
  - (c) Entry 1 refused and entry 2 fails with a retryable outage → no `localLimit`.
  - (d) A refusal on round 2 of entry 1 ends entry 1, and entry 2 is tried.
  - (e) `reserveCall` is called once per provider call, including tool rounds.
- [ ] **Step 4:** Add service and job tests:
  - `mapLoopFailure` with `localLimit` throws `LocalLimitError`;
  - the job answers `localLimitReply` text and does **not** throw `RetryAfterError`;
  - a real `reserveModelCall` against a test DB with `rpmLimit: 1` → the second question in the
    same minute gets the limit reply without calling the fake provider.
- [ ] **Step 5:** Run them. Expect FAIL. Implement. Run
  `npx vitest run packages/core/src/providers apps/daemon/src/assistant apps/daemon/src/jobs`.
  Expect PASS.
- [ ] **Step 6:** Commit: `feat: enforce per-entry RPM/RPD before calling a provider (ADR 0081)`.

---

### Task 10: Provider failures in logs, traces, History and the chain test

ADR 0079. Consumes Task 1 (`classifyProviderFailure`, `PROVIDER_FAILURE_TEXT`, trace fields)
and Task 9 (tool-loop shape).

**Files:**
- Modify: `apps/daemon/src/assistant/tool-loop.ts`: `failAttempt`, around line 346. `runToolLoop`
  input gains `logger?: Logger` and `guildId?: string`.
- Create: `apps/daemon/src/assistant/chain-failed-error.ts`
- Modify: `apps/daemon/src/assistant/service.ts`: `mapLoopFailure`'s busy branch (lines
  ~696–712), plus passing `logger`/`guildId` into `runToolLoop`.
- Modify: `apps/daemon/src/jobs/assistant.ts`: write a trace on the retry path and the final
  failure path.
- Modify: `packages/http/src/routes/assistant-traces.ts`: the detail response adds `explain` per
  attempt.
- Modify: `packages/http/src/routes/assistant-providers.ts`: the chain test route (lines 316–356)
  returns the classified failure. It reserves the call through a new optional
  `assistantProviderConfig.reserveTestCall?(position, guildId)` (see Task 11, which adds the
  implementation; here, call it only when present).
- Modify: `packages/dashboard/src/pages/assistant-history-detail.tsx` (attempts table ~lines 130–160)
- Modify: `packages/dashboard/src/pages/providers.tsx` (the chain Test result display) and
  `packages/dashboard/src/api/traces.ts` / `api/assistant.ts` types
- Modify: `packages/core/src/jobs/worker.ts`: the `job failed` log (lines ~216–227) adds
  `code` when the thrown error has a string `code` property. `ChainFailedError` declares
  `readonly code = 'chain-failed'`. Add a worker test that asserts the logged `code`.

**Interfaces:**

```ts
// chain-failed-error.ts
export class ChainFailedError extends ProviderError {
  constructor(kind: ProviderErrorKind, readonly summary: string, retryable: boolean,
    readonly attempts: AssistantTrace['attempts']) { super(kind, summary, retryable); this.name = 'ChainFailedError'; }
}
/** "openrouter/stealth/space-bunny-alpha: provider-connect-timeout; gemini/gemini-3.5-flash-lite: provider-connect-timeout" */
export const summarizeAttempts: (attempts: AssistantTrace['attempts']) => string;
// for each attempt with outcome !== 'ok': `${provider}/${model}: ${code ?? reason ?? outcome}`, joined by '; '
```

**Rules:**

- **`failAttempt`.** Compute `const f = classifyProviderFailure(err, { provider: entry.providerId, model: entry.model })`,
  and push the attempt with `code: f.code` plus `httpStatus`/`netCode`/`host` when present. Keep
  `reason` and `outcome` exactly as computed today. Then, when `deps.logger` is present:
  `logger.warn(safeLogFields({ component: 'assistant', guildId, provider: entry.providerId, model: entry.model, keyLabel: entry.keyLabel, code: f.code, httpStatus: f.httpStatus, netCode: f.netCode, host: f.host, ms, providerMessage: err instanceof Error ? err.message : undefined }), 'provider attempt failed')`.
  This is the **only** place `providerMessage` is logged.
- **Busy branch in `mapLoopFailure`.** It throws
  `new ChainFailedError(kind, \`Every assistant model failed — ${summarizeAttempts(failed.attempts)}\`, true, failed.attempts)`
  instead of the plain `ProviderError`. The final non-retryable re-throw (`failed.lastError`)
  stays.
- **Job.** In both the retry branch and the final "failed before a response" branch, when
  `err instanceof ChainFailedError` and `deps.conversations` is set, insert a trace:
  - `traceId: \`trace_${key}_a${context.attempts}\`` (the same `key` the success path uses; skip
    the insert if the id exists);
  - `outcome: 'failed'`, `attempts: err.attempts`, `error: { kind: err.kind, message: err.summary }`;
  - `flags: [context.attempts < ceiling ? \`retry:${context.attempts}\` : 'gave-up']`;
  - the other fields as in the success insert (question, userId, behaviourId, …; `answer`
    omitted; `sections: []`, `toolCalls: []`, `usage: {}`, `guard: { removed: [] }`,
    `timeline: [{ label: 'received', atMs: 0 }, { label: 'failed', atMs: <elapsed> }]`,
    `discordMessageIds: []`, `sources: []`).

  Also replace the log `err` field there with `code: 'chain-failed'` plus the summary as the
  message.
- **Traces route.** Each attempt in the detail response gains
  `explain: PROVIDER_FAILURE_TEXT[a.code]` when `a.code` is a known code.
- **Chain test route.** On failure, return
  `{ ok: false, latencyMs, error: text.title, failure: { code, title, explanation, hint, host?, httpStatus?, netCode? } }`
  (`error` stays, for older clients). The terms refusal and no-usable-key answers stay as they
  are. Delete `chainTestFailure`.
- **History detail page.** The attempts table adds a "Why" column: `explain.title` in bold, the
  explanation, "What to do: " plus the hint, and a muted `host · HTTP status · netCode` line. An
  attempt with no `explain` shows its `reason`, as today.
- **AI setup Test result.** When `failure` is present, render it with the same layout (map it to
  a `DescribedError`-shaped object and use `ErrorNotice`).

- [ ] **Step 1:** Failing tests:
  - (a) Tool-loop: a fake provider throwing the connect-timeout `ProviderError` (from Task 1's
    test) → the attempt has `code: 'provider-connect-timeout'` and `netCode`, and a fake logger
    got `provider attempt failed` with `providerMessage`.
  - (b) Service: the busy path throws `ChainFailedError`, whose summary names both entries' codes.
  - (c) Job: a retryable `ChainFailedError` on attempt 1 inserts trace `trace_<key>_a1` with flag
    `retry:1` and the attempts, then throws `RetryAfterError`; on the last attempt it inserts
    `…_a<n>` with `gave-up`.
  - (d) Traces route: an attempt with `code: 'provider-auth'` returns `explain.title` "The
    provider rejected the API key".
  - (e) Chain test route: a provider throwing the connect-timeout error → `failure.code`
    `provider-connect-timeout`, and `JSON.stringify(body)` does not contain the provider's
    message text (use a distinctive message like `'UPSTREAM-SAID-xyz'`).
  - (f) History detail page renders the "Why" title and hint.
  - (g) The AI setup Test result renders the failure title and hint.
- [ ] **Step 2:** Run them. Expect FAIL. Implement.
- [ ] **Step 3:** Run `npx vitest run apps/daemon/src/assistant apps/daemon/src/jobs packages/http/src/routes packages/dashboard/src/pages`.
  Expect PASS.
- [ ] **Step 4:** Commit: `feat: explained provider failures in logs, traces, History and the chain test (ADR 0079)`.

---

### Task 11: Chain editor — RPM/RPD inputs and live usage

ADR 0081. Consumes Task 5 (`ChainRow` limits, `modelUsage`, `reserveModelCall`) and Task 9
(`providerDayStart`, `nextProviderDayStart`).

**Files:**
- Modify: `packages/http/src/routes/assistant-providers.ts`:
  - `chainBody` entries gain `rpmLimit: z.number().int().min(1).max(1_000_000).nullable().optional()`
    and the same for `rpdLimit`;
  - pass them to `saveChain`;
  - the GET `chain` rows add `rpmLimit`, `rpdLimit` and `usage`;
  - the audit `after.entries` includes the limits.
- Modify: `packages/http/src/server.ts`, `HttpDeps.assistantProviderConfig`:
  - the `chain()` element type gains `rpmLimit: number | null; rpdLimit: number | null`;
  - `saveChain` rows gain optional limits;
  - add `modelUsage?(entry: { keyId: string; model: string; providerId: string }): { lastMinute: number; today: number; availableAt?: number }`;
  - add `reserveTestCall?(position: number, guildId: string): { ok: true } | { ok: false; code: 'local-rpm-limit' | 'local-rpd-limit'; availableAt: number }`.
- Modify: `apps/daemon/src/assistant/provider-config.ts`: implement `saveChain` with limits,
  `modelUsage`, and `reserveTestCall` (using `modelCallsRepo` and the provider-day helpers).
  `availableAt` is set when usage is at a limit: for RPM, the oldest call in the window + 60 s;
  for RPD, the next day start.
- Modify: `packages/dashboard/src/pages/providers.tsx` (the chain editor, from ~line 176) and
  `packages/dashboard/src/api/assistant.ts` types.

**Rules:**

- **GET `usage`.** `{ lastMinute, today, availableAt? }` from `modelUsage`.
- **Chain test.** It calls `reserveTestCall(position, session.guildId)` before the provider. A
  refusal returns `{ ok: false, latencyMs, error: title, failure: { code, title, explanation, hint } }`
  from `PROVIDER_FAILURE_TEXT`, and the provider is not called.
- **Editor.** Each chain row adds two small number inputs, "RPM" and "RPD" (blank = no limit,
  placeholder "no limit"), sent with the chain save. Under each row, a muted usage line:
  `RPM 12 / 15 · today 180 / 1000`. Omit the `/ limit` part when there is no limit. Add
  ` · frees up 14:02` when `availableAt` is present, formatted `hour:'2-digit', minute:'2-digit'`
  local.
- **Validation.** A 400 on save shows `fieldError(err, 'entries.<i>.rpmLimit')` under the input.

- [ ] **Step 1:** Failing tests:
  - (a) Route: a PUT chain with `rpmLimit: 15, rpdLimit: 1000` round-trips through GET;
    `rpmLimit: 0` → 400 with a field path `entries.0.rpmLimit`.
  - (b) Route: GET includes `usage` from a fake `modelUsage`.
  - (c) Route: the chain test with `reserveTestCall` refusing → `failure.code` `local-rpm-limit`,
    and the provider was not called.
  - (d) The provider-config store (daemon) against a real test DB: `saveChain` with limits, then
    `chain()` carries them; `modelUsage` counts reserved calls.
  - (e) Dashboard: the editor renders the inputs and the usage line, and saving sends the limits.
- [ ] **Step 2:** Run them. Expect FAIL. Implement.
- [ ] **Step 3:** Run `npx vitest run packages/http/src/routes/assistant-providers.test.ts apps/daemon/src/assistant packages/dashboard/src/pages/providers.test.tsx`.
  Expect PASS.
- [ ] **Step 4:** Commit: `feat: RPM/RPD inputs and live usage in the model chain editor`.

---

### Task 12: Resource fetch — explained failures, header, timeout, refresh interval

ADRs 0079 (§1e of the spec) and 0080. Consumes Task 5 (`errorCode` column) and Task 6 (store).

**Files:**
- Modify: `apps/daemon/src/assistant/resource-fetcher.ts`:
  - `ResourceFetchFailureCode` adds `'challenge'`;
  - `ResourceFetchFailure` gains `readonly httpStatus?: number; readonly host?: string`;
  - `fail()` accepts them;
  - the options gain a live `limits` getter and a `headersFor` hook.
- Modify: `apps/daemon/src/assistant/resource-refresh.ts` (the `!result.ok` branch at ~line 174:
  persist `errorCode: result.code`; return a detail object for logging)
- Modify: `apps/daemon/src/jobs/resource-refresh.ts` (the log line at line ~88)
- Modify: `apps/daemon/src/runtime/guild.ts` (lines 844 and 861: construct the fetchers with
  settings)
- Modify: `apps/daemon/src/runtime/resource-refresh-timer.ts` (the interval from settings)
- Create: `packages/http/src/errors/resource-failures.ts` (text per resource code)
- Modify: the resource routes that return documents (`packages/http/src/routes/assistant-resources-cache.ts`
  and/or `assistant.ts`, found with `rg -n "status: 'error'|\.error\b" packages/http/src/routes/assistant-resources-cache.ts packages/http/src/routes/assistant.ts`):
  add `errorCode` and `errorExplain` per document.
- Modify: `packages/dashboard/src/pages/assistant-resources.tsx` (show the explanation per
  resource row)

**Fetcher rules:**

- **Challenge detection.** In the non-2xx branch (`status < 200 || status >= 300`): if
  `(status === 403 || status === 503)` and
  `(response.headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge'`, return
  `fail('challenge', 'The site\'s Cloudflare bot protection challenged Bananasaurs.', { httpStatus: status, host: url.hostname })`.
  Otherwise, `http-status` with `httpStatus` and `host`.
- **Every other `fail`** carries `host: url.hostname` where a URL is known.
- **Options.**
  - `limits` may be a `Partial<ResourceFetchLimits>` **or** `() => Partial<ResourceFetchLimits>`.
    It is read on every `fetch()` call; the in-memory cache TTL reads it too.
  - `headersFor?: (host: string) => Readonly<Record<string, string>> | undefined` is merged into
    `extraHeaders` for each request (including each redirect hop, with the host re-evaluated per
    hop).
- **`guild.ts`.** Construct the **website** fetcher (the one at line 844 serving website
  resources; confirm by reading) with:
  - `limits: () => ({ timeoutMs: store.get('resources.fetchTimeoutMs') })`;
  - `headersFor: (host) => { const name = store.get('resources.fetchHeaderName'); const value = store.get('resources.fetchHeaderValue'); const hosts = store.get('resources.fetchHeaderHosts'); return name && value && hosts.some(h => h === host.toLowerCase()) ? { [name.toLowerCase()]: value } : undefined; }`.

  The GitHub raw fetcher (the one with `allowedHosts`) gets the live timeout only, **never the
  header**.
- **Refresh timer.** Read the file first. Replace the constant `RESOURCE_REFRESH_INTERVAL_MS`
  with a dep `intervalMs: () => number` (from `resources.refreshIntervalMin × 60000`). The
  bucket used for the dedupe key becomes `Math.floor(now / intervalMs())`, keeping the `hourly`
  reason name so existing dedupe keys and tests keep their meaning. Keep the export of the
  constant as the default.
- **Log line** (jobs/resource-refresh.ts). For one resource:
  `safeLogFields({ component: 'jobs', jobKind, resourceId: resource.id, outcome, code, httpStatus, host })`,
  message `resource cache: refreshed ${id} -> ${outcome}` + (code ? ` (${code})` : '') +
  ` (reason=…)`.

**Resource failure text** (`resource-failures.ts`: `RESOURCE_FAILURE_TEXT: Record<string, { title; explanation; hint }>`):

| code | title | explanation | hint |
|---|---|---|---|
| challenge | The site's bot protection blocked Bananasaurs | The site answered with a Cloudflare challenge page ("Just a moment…"), which only a browser can pass. | Ask the site's owner to add a Cloudflare WAF Skip rule for the header set in AI tuning → Resources, or import the content from GitHub instead. |
| http-status | The site answered with an error | The site returned an HTTP error instead of the page. | Check the URL in a browser. |
| timeout | The site did not answer in time | The fetch took longer than the resource fetch timeout. | Raise AI tuning → Resources → Fetch timeout, or try again later. |
| dns-failed | The site's address could not be looked up | DNS returned no address for this host. | Check the URL's spelling. |
| network | The site could not be reached | The connection failed before the page arrived. | Check the host's network, and try again. |
| private-address | That address is not allowed | The host resolves to a private network address, which Bananasaurs never fetches. | Use the site's public address. |
| redirect | The site redirected somewhere not allowed | The page redirected too many times, or to a place Bananasaurs does not fetch. | Use the final URL directly. |
| content-type | The page is not text | The site returned a file type Bananasaurs does not read. | Link to an HTML, Markdown or plain-text page. |
| too-large | The page is too large | The page is bigger than the fetch size limit. | Link to a smaller page or section. |
| invalid-url | The URL is not allowed | Only public HTTPS URLs can be resources. | Use an https:// address. |

- [ ] **Step 1:** Failing tests:
  - (a) Fetcher, with the injectable `request` fake: a 403 with `cf-mitigated: challenge` →
    `code: 'challenge'`, `httpStatus: 403`, `host`; a plain 403 → `http-status` with 403.
  - (b) Fetcher: `headersFor` returning `{ 'x-bananasaurs-fetch': 'tok' }` for `example.com` →
    the fake request received that header; for `other.com`, no header.
  - (c) Fetcher: a `limits` getter changing between two calls → the second request uses the new
    timeout.
  - (d) Refresh: a failed fetch persists `errorCode: 'challenge'`.
  - (e) Job: the log line includes `code` and `httpStatus`.
  - (f) Route: a document with `errorCode: 'challenge'` returns `errorExplain.title`.
  - (g) Dashboard: a Resources row shows "The site's bot protection blocked Bananasaurs" and the
    hint.
  - (h) guild.ts wiring (unit-level if a test exists for it, else via a small exported builder
    `websiteFetchHeaders(store)` tested directly): the header is sent only to the listed hosts,
    and never when the value is null.
- [ ] **Step 2:** Run them. Expect FAIL. Implement.
- [ ] **Step 3:** Run `npx vitest run apps/daemon/src/assistant apps/daemon/src/jobs apps/daemon/src/runtime packages/http/src packages/dashboard/src/pages/assistant-resources.test.tsx`.
  Expect PASS.
- [ ] **Step 4:** Commit: `feat: explained resource failures, Cloudflare challenge detection, fetch header and live fetch settings`.

---

## Final gate (controller)

In the opencode worktree, after `npm install` (so `@bananasaurs/*` resolve to the branch's own
packages): `npm run typecheck && npm run lint && npm run test`. Then the final whole-branch
review.

## Deploy note (owner)

Migration 0047 adds two tables and three nullable columns. On this box:
`sudo systemctl stop bananasaurs` → `npm run db:migrate` → `npm run build` →
`sudo systemctl start bananasaurs`.
