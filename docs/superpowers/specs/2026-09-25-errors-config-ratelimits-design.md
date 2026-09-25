# DRAFT — Explained errors, bot-wide configuration, per-model rate limits

Date: 2026-09-25 · Status: **DRAFT, awaiting owner review** · Branch: `worktree-errors-config-ratelimits`

## Why

On 2026-09-25 the assistant stopped answering, and the only thing anyone could see was
`Every assistant model is busy (busy)`. The real cause was a ProtonVPN exit in Singapore:
IPv4 connects took ~255 ms, just over Node's 250 ms Happy Eyeballs per-address wait. Node
fell back to a blackholed IPv6 route, and every `fetch` died with `UND_ERR_CONNECT_TIMEOUT`.
Finding that took a hand-written probe. Nothing in the journal, the History page or the
dashboard pointed at it. Website resources failed the same day with an unexplained `error`;
the site was actually answering with a Cloudflare managed challenge (`cf-mitigated: challenge`).

What the owner asked for (2026-09-25):

1. Much better logging, error codes, and explanations everywhere on the dashboard.
2. A new configuration tab for retry cycles "and whatnot", holding related settings too.
3. An RPM and an RPD limit on each model, so Bananasaurs does not try a provider that is at its limit.
4. The connect-wait fix: make the daemon wait longer before abandoning IPv4.

## Owner decisions (2026-09-25)

| Question | Decision |
|---|---|
| What an RPM/RPD limit attaches to | **Each chain entry** (one key + one model) |
| Provider detail on the dashboard | **Stable codes + our own fixed text.** The provider's free-text message stays in the journal only |
| Who sees the new settings | **Owner only.** Instance-wide (every guild) |
| Every model at its limit | **Answer at once** with when the next model frees up. No provider call, no retry cycle |
| Connect-wait fix | **In scope**, default 1000 ms, editable |
| Website-fetch header for a Cloudflare allow rule | Proposed. In scope unless the owner drops it |

## Out of scope

- Anything that solves or evades a bot challenge (headless browser, spoofed fingerprints).
- Moving the existing per-guild settings (role rate, reconcile budget, breaker threshold, dry run).
- Generic background-job backoff (`backoffMs`, 1 s→5 min). It governs Discord side effects too,
  and changing it is a moderation-path risk. The new retry settings are the assistant's own.
- Changing member-facing wording beyond the new "every model is at its limit" reply.

---

## 1. Error codes and explanations

### 1a. One catalog, on the server

New module `packages/http/src/errors/catalog.ts`: a typed record from every error code the API
can return to `{ status, title, explanation, hint? }`.

- **Codes keep today's kebab-case slugs** (`invalid-body`, `owner-only`, `provider-refused`, …).
  The dashboard and the CLI already branch on them, so nothing renames.
- `explanation` says what happened in plain words. `hint` says what the owner can do next,
  naming the dashboard page or command.
- **A test enforces completeness.** It scans `packages/http/src/**/*.ts` for every
  `error: '<slug>'` literal and fails if a slug has no catalog entry. A new route cannot ship a
  bare slug.

### 1b. The error body

Every non-2xx JSON response keeps `error` and gains fields:

```jsonc
{
  "error": "invalid-body",               // unchanged, stable
  "title": "The request was not valid",
  "message": "Retry delays must be between 1 second and 10 minutes.",  // specific when the route knows more, else the catalog explanation
  "hint": "Fix the highlighted field and save again.",
  "fields": [{ "path": "assistantRetryDelaysMs.2", "problem": "too_big" }],  // Zod issue paths + codes only, never values
  "requestId": "req-3f9c"                 // Fastify request id; the same id is on every log line for this request
}
```

- A single Fastify `onSend` hook fills `title`/`message`/`hint` from the catalog for any error
  body that lacks them. Routes that already send a specific `message` keep it.
- The central error handler adds `requestId` to every error, and to the `request failed` log
  line, so a 500 on the page can be found in `journalctl -u bananasaurs | grep <id>`.
- `internal` (500) reads: "Something went wrong inside Bananasaurs. Nothing was changed. Quote
  request `<id>` when checking the daemon log."
- Zod failures return `fields` (issue path + issue code). Values are never echoed, because a
  value can be a secret the owner just pasted.

### 1c. Dashboard rendering

- `ApiError` carries the whole body. New `describeError(err)` returns `{ title, message, hint,
  code, status, requestId }` for any thrown value:
  - `ApiError` → from the body.
  - `TypeError` from `fetch` → code `dashboard-offline`: "The dashboard could not reach
    Bananasaurs. The daemon may be restarting."
  - Anything else → `dashboard-bug`, with its message.
- New `<ErrorNotice>` component shows the title, message and hint, plus a muted line
  `code · HTTP status · request id`, with a copy button for the request id. Toasts use a
  compact variant; forms map `fields` onto the matching `<Field error>`.
- **Every call site that renders `err.body.error`, `err.message` or a generic string switches to
  these** (33 sites today).

### 1d. Provider failures: codes, traces, logs

New `packages/core/src/providers/failure.ts` classifies any provider error into a
**`ProviderFailure`**:

```ts
{
  code: ProviderFailureCode;     // stable, e.g. 'provider-connect-timeout'
  provider: ProviderId;
  model: string;
  host: string;                  // from our base URL, not from the provider
  httpStatus?: number;
  netCode?: NetErrorCode;        // allowlisted: UND_ERR_CONNECT_TIMEOUT, ENOTFOUND, ECONNREFUSED,
                                 // ECONNRESET, EAI_AGAIN, CERT_*, UND_ERR_SOCKET, …
  retryable: boolean;
  resetAt?: number;
}
```

Codes, each with fixed explanation and hint text in a catalog next to it:

| Code | When | Hint (abridged) |
|---|---|---|
| `provider-connect-timeout` | `UND_ERR_CONNECT_TIMEOUT` | Check VPN/network; raise *Network → connect fallback wait* |
| `provider-dns` | `ENOTFOUND`/`EAI_AGAIN` | DNS cannot resolve the host |
| `provider-connection-refused` | `ECONNREFUSED`/`ECONNRESET` | Host refused or dropped the connection |
| `provider-tls` | `CERT_*`, TLS errors | Clock skew or an intercepting proxy |
| `provider-timeout` | our request timeout fired | Raise *Provider request timeout* or pick a faster model |
| `provider-auth` | 401/403 | Key rejected: re-paste it in AI setup |
| `provider-bad-model` | 400/404 | Model id not available to this key |
| `provider-rate-limit` | 429 (not daily) | Provider per-minute limit; set this entry's RPM |
| `provider-daily-quota` | ADR 0077 daily cap | Resets at `<time>`; set this entry's RPD |
| `provider-credits` | 402 | Account out of credits |
| `provider-outage` | 5xx | Provider-side problem |
| `provider-invalid-response` | unparsable / empty | Model returned nothing usable |
| `local-rpm-limit` / `local-rpd-limit` | our own limit (§3) | Frees up at `<time>` |

Where it shows up:

- **Journal.** One `warn` line per failed attempt, `provider attempt failed`, with `code`,
  `provider`, `model`, `keyLabel`, `host`, `httpStatus`, `netCode`, `ms`, `attempt`, `guildId`.
  The sanitized provider reason (≤160 chars, already produced by the adapters) goes in
  `providerMessage`, **journal only**. New field names join the Pino allowlist.
- **Traces.** Each attempt stores `code`, `httpStatus`, `netCode`, `host`, `availableAt?`. No
  provider text. The trace schema gains optional fields, so old rows still parse.
- **Busy failures get a trace.** Today a retryable failure throws before any trace is written.
  Every assistant attempt now writes one: outcome `retrying` with its job attempt number, and
  the final give-up as `failed`.
- **Chain summary.** "Every assistant model is busy" is replaced by a summary naming each
  entry's code, e.g. `openrouter/space-bunny: provider-connect-timeout; gemini/flash-lite:
  provider-connect-timeout`. Journal and History only; member replies are unchanged.
- **History page.** Each attempt row shows the code's title, explanation and hint, the host,
  and the status or network code.
- **AI setup → "Test" button per chain entry.** Sends the fixed prompt "Reply with the single
  word OK." (no server content; hard rule 5 unaffected), and shows OK with latency or the
  `ProviderFailure` card. Owner only; counts toward that entry's RPM/RPD.

### 1e. Resource fetch failures

`resource_documents` gains `error_code`. The fetcher classifies failures:

- `resource-challenge`: 403/503 with `cf-mitigated: challenge`, or a Cloudflare challenge page.
  Explanation: "The site's Cloudflare bot protection challenged Bananasaurs". Hint: "Ask the site
  owner to add a WAF Skip rule for the Bananasaurs fetch header (Configuration → Resources), or
  import the content from GitHub instead."
- Also `resource-http-<class>`, `resource-timeout`, `resource-dns`, `resource-connect`,
  `resource-too-large`, `resource-redirects`, `resource-unsafe-url`, `resource-not-text`.

The log line `resource cache: refreshed <id> -> error` gains `code`, `httpStatus` and `host`.
The Resources page shows the explained error on each resource row.

### 1f. Other log improvements

- Every HTTP request log line carries `requestId`; the error handler logs route and status.
- On startup the daemon logs every effective bot-wide setting that differs from its default
  (`component: 'config'`).
- `job failed` lines gain `code` whenever the thrown error carries one.

---

## 2. Bot-wide configuration tab

### 2a. Where

The existing **Advanced → Configuration** page gets two tabs:

- **This server**: today's per-guild settings, unchanged.
- **Bot-wide**: new, **owner only**. Admins do not see the tab; its API returns `owner-only`.

(Ruling: a second tab on the existing page rather than a new nav entry. Two nav items both
called "Configuration" would confuse. Cheap to move later if wrong.)

### 2b. Storage

- New table `instance_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at
  INTEGER NOT NULL, updated_by TEXT NOT NULL)`. Instance-scoped, like the provider keys and
  model chain (ADR 0075). These settings govern the one process, not a guild.
- New registry `packages/core/src/settings/instance-settings.ts`. Each setting has key, group,
  label, help text, unit, a Zod schema with bounds, and a default equal to **today's hard-coded
  value** (except the connect wait, see below). A setting with no row uses its default, so
  nothing changes on deploy until the owner edits it.
- `InstanceSettingsStore`: reads through an in-memory cache and writes invalidate it. Every use
  reads the effective value, so **changes apply without a restart**. Every change writes an
  audit event carrying the key, old value and new value. The header token is recorded as
  "changed", never its value.

### 2c. The settings

| Group | Setting | Default | Bounds |
|---|---|---|---|
| Assistant retries | Retry delays after a busy/timeout failure | 10 s, 30 s, 90 s | 0–4 delays, each 1 s–10 min |
| Assistant retries | Provider request timeout | 30 s | 5–120 s |
| Assistant tool loop | Max tool rounds | 4 | 1–8 |
| Assistant tool loop | Max tool calls per question | 12 | 1–30 |
| Assistant tool loop | Max answer length (output tokens) | 2048 | 256–8192 |
| Network | Connect fallback wait (IPv4/IPv6) | **1000 ms** | 100–5000 ms |
| Resources | Fetch timeout | 5 s | 1–60 s |
| Resources | Refresh interval | 60 min | 15 min–24 h |
| Resources | Fetch header name | *(off)* | RFC 7230 token |
| Resources | Fetch header value | *(off)* | write-only, sealed like provider keys |
| Resources | Send the header only to hosts | *(empty)* | host list; the header is sent to no other host |

Notes:

- **Retry-delay invariant.** The assistant job's `maxAttempts` becomes `delays.length + 1`, set
  when the job is enqueued. That removes today's hidden coupling to the job store's default of 5.
- **Connect wait** applies via `net.setDefaultAutoSelectFamilyAttemptTimeout()` at startup and on
  every change. Before relying on it, the implementation must show in a test against the
  installed Node that `fetch` honours a value set at runtime, not only the CLI flag. The
  2026-09-25 probe proved only the flag.
- **Header value** is sealed with the provider secret. It is only sent to the listed hosts, and
  only by the website resource fetcher: never to providers, never on GitHub imports.

### 2d. UI

Each setting row has the label, help text, current value with unit, "default: X", a **Reset to
default** action, and inline validation errors from §1. Save is per group. The tab header says
"These settings apply to every server this bot is in".

---

## 3. RPM / RPD per chain entry

### 3a. Data

- `assistant_model_chain` gains `rpm_limit INTEGER NULL` and `rpd_limit INTEGER NULL`. Null means
  no limit. The chain `PUT` carries them per row, and the editor shows two number inputs per
  entry.
- New table `assistant_model_calls (key_id TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT
  NULL, guild_id TEXT NOT NULL)`, indexed on `(key_id, model, at)`. One row per provider HTTP call.
  Rows older than 48 h are pruned by the daily expiry run. `guild_id` records which guild
  spent the call, for accounting and logs. The limit itself is instance-wide, because the key is
  shared.

### 3b. Counting rules

- **Every provider HTTP call counts**, including each tool round and each Test button press,
  because that is what providers meter.
- **Reserve before sending.** The row is inserted in the same synchronous step as the limit
  check (single writer, `better-sqlite3`, no `await` between them), so two jobs cannot both take
  the last slot. A call that then fails still counts, as it does at the provider.
- **RPM** is a sliding 60 s window: count calls with `at > now − 60 000`. `availableAt` is the
  oldest counted call + 60 s.
- **RPD** counts calls since the start of the provider's day: **UTC midnight** for OpenRouter
  and NVIDIA NIM, **midnight America/Los_Angeles** for Gemini (their documented reset).
  `availableAt` is the next such midnight.

### 3c. Chain behaviour

- Before each call (the first round and every later round), the loop checks the entry's limits.
  At a limit, the attempt is recorded as `skipped` with code `local-rpm-limit`/`local-rpd-limit`
  and `availableAt`, and the loop moves to the next entry. This is exactly the path for a
  failure today (a later entry restarts from round 1).
- If **every** tried entry was skipped for a local limit, no provider is called. The job answers
  at once: *"All AI models have reached the limits set for them. The next one frees up in about
  N minutes."* A daily limit gives the time instead: *"…at 5:00 PM."* It completes without
  retrying. A mix of local-limit skips and provider failures follows the normal retry rules.
- The existing provider-reported daily cap (ADR 0077, `QuotaLedger`) keeps working alongside.

### 3d. UI

Each chain entry row shows its inputs and live usage, e.g. `RPM 12 / 15 · today 180 / 1000 ·
frees up 14:02`, read from a new `GET /api/assistant/model-chain/usage`.

---

## 4. ADRs (written before the code)

- **0078** — Explained error bodies and the error catalog (§1a–c, §1f).
- **0079** — Provider failure classification and per-attempt traces (§1d–e).
- **0080** — Bot-wide settings: the table, registry and Configuration tab (§2), including the
  connect wait and the website fetch header.
- **0081** — Per-chain-entry RPM/RPD limits (§3).

## 5. Testing

- The catalog completeness test (§1a).
- The error body: `requestId` present, `fields` never contains values, `onSend` fills blanks and
  never overwrites a route's own `message`.
- Classification: table-driven tests from real error shapes (undici `cause.code`, HTTP statuses,
  ADR 0077 bodies) to codes.
- Settings: bounds, defaults equal the old constants, audit event on change, header value never
  in any API response or log, owner-only enforced (admin gets `owner-only`).
- Retry delays drive the job's `maxAttempts` and delay sequence; setting 0 delays answers on the
  first failure.
- Rate limits, written test-first: the sliding window at the boundary; RPD rollover at UTC and at
  LA midnight; the last slot reserved without an overshoot; every-entry-capped answers with the
  right time and makes no provider call; mixed failures still retry.
- Connect wait: a runtime change reaches `fetch` (§2c); a startup log line appears.
- Dashboard: `describeError` on each thrown shape; `<ErrorNotice>` renders code, request id and
  hint; the Configuration tab hides Bot-wide from a non-owner.
- Live check after deploy (owner, optional): VPN on a far server, Test button shows
  `provider-connect-timeout` with the connect-wait hint; raise the wait; Test shows OK.

## 6. Migration and deploy

One drizzle migration (0047): `instance_settings`, `assistant_model_calls`, two chain columns,
`resource_documents.error_code`. Deploy on this box: stop → `npm run db:migrate` → build → start
(see the build-is-a-deploy note).
