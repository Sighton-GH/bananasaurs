# Tavily web search, several search keys, per-key limits — implementation plan

**Status: APPROVED by owner 2026-09-30 ("go ahead with tavily, keep brave as an option").**

**Goal:** the assistant can search the web through Brave or Tavily (owner's
choice), each with several labelled keys tried in order, and each key with a
monthly and daily limit set in the dashboard so the bot never goes over a
free allowance.

**Design:** `docs/decisions/0120-tavily-search-and-search-key-limits.md`
(read it first). The research behind it is in
`docs/24_OPENROUTER_WEB_SEARCH_PLAN.md`.

**Branch:** `oc/tavily-web-search`

**Verification command** (run in the main checkout on a branch at the same
commit; the oc worktree's typecheck is invalid):
`npm run typecheck && npm run lint && npm run test`

## Global constraints

These go verbatim into every brief.

- **Stack and style.** TypeScript strict, ESM `.js` import suffixes,
  Zod at every boundary, Vitest, and no network in tests. Match the
  surrounding code's comment density and naming. No new npm
  dependencies.
- **Numbering.**
  - Migration **0090** (journal `idx: 90`, tag `0090_search_keys`,
    snapshot `0090_snapshot.json`). Numbers 0053–0089 are reserved for
    other branches.
  - ADR **0120**, already written. Do not create ADRs.
- **Secrets.**
  - A search API key (plaintext or sealed) never appears in any HTTP
    response, audit row, log line, error message, trace or test snapshot.
  - Keys are sealed with the same `sealWithKey`/`openWithKey` and the
    same derived key as provider keys (`apps/daemon/src/crypto/seal.ts`,
    `providerKeyFrom`).
- **Search source.** Values are exactly `'brave' | 'tavily'`.
- **Limits.**
  - `monthlyLimit` is the maximum number of calls in any **sliding 31-day
    window**; `dailyLimit` is the maximum in any **sliding 24-hour window**.
  - Both are `number | null`, where null means no limit. Integers are
    1–1,000,000.
  - A new key's `monthlyLimit` defaults to **1000** when omitted. Its
    `dailyLimit` defaults to null.
- **The reservation.** The limit check and the ledger insert run in one
  synchronous `writeInstance` transaction, with no `await` inside, as in
  `packages/storage/src/repos/model-calls.ts`. A call counts even if it
  then fails.
- **Refused statuses.** A key is skipped for the next key only on HTTP
  401, 402, 403, 429, 432 or 433. A timeout or any other failure ends the
  search.
- **Provider response bodies on errors are never read into messages.**
  Errors carry only the HTTP status (`SearchHttpError`).
- **Owner-only.** Every search-key route and every change of
  `searchEnabled`/`searchSource` is instance-owner only, and every change
  is audited, with key ids, labels and limits only.
- **Instance-level tables** (ADR 0012/0081): `assistant_search_keys` and
  `assistant_search_calls`. The calls ledger records `guild_id` (hard
  rule 2), exactly like `assistant_model_calls`.

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/storage/src/schema.ts` | new tables, `search_source` column | 1 |
| `drizzle/0090_search_keys.sql`, `drizzle/meta/0090_snapshot.json`, `drizzle/meta/_journal.json` | migration + Brave key copy | 1 |
| `packages/storage/src/repos/search-keys.ts` (+ `.test.ts`) | keys CRUD, reserve, usage | 1 |
| `packages/storage/src/repos/assistant-provider.ts` (+ test) | `searchSource` on the config row | 1 |
| `packages/storage/src/index.ts` | export `searchKeysRepo` | 1 |
| `packages/storage/src/schema-invariants.test.ts` | INSTANCE_LEVEL += 2 tables | 1 |
| `apps/daemon/src/assistant/tavily-search.ts` (+ test) | Tavily client | 2 |
| `apps/daemon/src/assistant/brave-search.ts` (+ test) | throw `SearchHttpError` | 2 |
| `apps/daemon/src/assistant/web-search.ts` (+ test) | key order + limits runner | 2 |
| `apps/daemon/src/assistant/provider-config.ts` (+ test) | store: search keys, `webSearch(guildId)`, status/save | 2 |
| `apps/daemon/src/assistant/tools.ts` (+ test) | port shape, `webSource`, limit refusal | 3 |
| `apps/daemon/src/assistant/tool-loop.ts` (+ test) | `webSources` on loop result | 3 |
| `apps/daemon/src/assistant/service.ts` (+ test) | `webSearch` param, Brave-only attribution | 3 |
| `apps/daemon/src/runtime/guild.ts`, `apps/daemon/src/runtime/daemon.ts` | plumbing | 3 |
| `packages/http/src/server.ts` | store type additions | 4 |
| `packages/http/src/routes/assistant-search-keys.ts` (+ test) | search-key routes | 4 |
| `packages/http/src/routes/assistant.ts` (+ test) | `searchSource` on PUT provider | 4 |
| `packages/http/src/index.ts` or the route registrar | register the new routes | 4 |
| `packages/dashboard/src/api/assistant.ts` | types | 5 |
| `packages/dashboard/src/pages/providers.tsx` | web search card | 5 |
| `packages/dashboard/src/pages/assistant-skills.tsx` | tool text per source | 5 |
| `PRIVACY.md`, `docs/decisions/0066-web-search-through-brave.md` | disclosure, amended-by line | 5 |

## Tasks

### Task 1: Storage — tables, migration, repo

**Schema** (`packages/storage/src/schema.ts`, next to
`assistantProviderKeys` and `assistantModelCalls`, with comments citing
ADR 0120):

- `assistantProviderConfig`:
  - add `searchSource: text('search_source').notNull().default('brave')`
  - add the check `assistant_provider_config_search_source`:
    `IN ('brave','tavily')`
- `assistantSearchKeys = sqliteTable('assistant_search_keys', …)`:
  - `keyId` text PK
  - `source` text notNull, check `IN ('brave','tavily')`
  - `label` text notNull, check length 1–60
  - `apiKeyEnc` text notNull
  - `enabled` integer notNull default 1 (`boolCheck`)
  - `position` integer notNull default 0
  - `monthlyLimit` integer (nullable), check `IS NULL OR BETWEEN 1 AND 1000000`
  - `dailyLimit` integer (nullable), same check
  - `createdAt` and `updatedAt` integer notNull
- `assistantSearchCalls = sqliteTable('assistant_search_calls', …)`:
  - `callId` integer PK autoIncrement
  - `keyId` text notNull, FK → `assistantSearchKeys.keyId` onDelete cascade
  - `at` integer notNull
  - `guildId: snowflake('guild_id').notNull()` with `snowflakeCheck`
  - index `assistant_search_calls_key_at` on (keyId, at)

**Migration.**

1. Run `npm run db:generate`. It runs drizzle-kit and then strictify.
2. Rename the generated `0053_*.sql` to `drizzle/0090_search_keys.sql`,
   and its snapshot to `drizzle/meta/0090_snapshot.json`.
3. In `_journal.json`, set the new entry to `"idx": 90` and
   `"tag": "0090_search_keys"`. This follows the task-tracking branch's
   convention.
4. Append the hand-written data copy, marked like the 0039 comment:

   ```sql
   --> statement-breakpoint
   -- ADR 0120 data copy (hand edit): the saved Brave key becomes the first Brave search key.
   INSERT INTO `assistant_search_keys` (`key_id`, `source`, `label`, `api_key_enc`, `enabled`, `position`, `monthly_limit`, `daily_limit`, `created_at`, `updated_at`)
     SELECT 'skey_brave', 'brave', 'Brave key', `search_api_key_enc`, 1, 0, 1000, NULL, `updated_at`, `updated_at`
     FROM `assistant_provider_config`
     WHERE `search_api_key_enc` IS NOT NULL;
   ```

**Repo** `packages/storage/src/repos/search-keys.ts`, following the
`assistant-providers.ts` and `model-calls.ts` patterns:

```ts
export type SearchSource = 'brave' | 'tavily';
export interface StoredSearchKey {
  readonly keyId: string; readonly source: SearchSource; readonly label: string;
  readonly apiKeyEnc: string; readonly enabled: boolean; readonly position: number;
  readonly monthlyLimit: number | null; readonly dailyLimit: number | null;
  readonly createdAt: number; readonly updatedAt: number;
}
export const DEFAULT_MONTHLY_LIMIT = 1000;
export const DAY_MS = 86_400_000;
export const MONTH_WINDOW_MS = 31 * DAY_MS;
/** Ordered by source, then position, then key id. */
export const listSearchKeys: (scope: InstanceScope) => StoredSearchKey[];
/** `skey_` + 16 hex. Position = 1 + the highest position for that source (0 when none). monthlyLimit undefined → 1000; null → no limit. */
export const addSearchKey: (scope: InstanceScope, input: {
  source: SearchSource; label: string; apiKeyEnc: string; enabled?: boolean;
  monthlyLimit?: number | null; dailyLimit?: number | null; now: number;
}) => string;
/** Returns false when the key does not exist. Omitted fields are unchanged; null clears a limit. */
export const updateSearchKey: (scope: InstanceScope, keyId: string, input: {
  label?: string; apiKeyEnc?: string; enabled?: boolean;
  monthlyLimit?: number | null; dailyLimit?: number | null; now: number;
}) => boolean;
/** Swaps position with the neighbour in the same source; no-op at the ends. Returns false when the key does not exist. */
export const moveSearchKey: (scope: InstanceScope, keyId: string, direction: 'up' | 'down', now: number) => boolean;
/** Cascades its ledger rows. Returns false when the key does not exist. */
export const removeSearchKey: (scope: InstanceScope, keyId: string) => boolean;
export type SearchReserveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly limit: 'daily' | 'monthly'; readonly availableAt: number };
/** One synchronous transaction: prune rows older than 32 days, check daily then monthly, insert. */
export const reserveSearchCall: (scope: InstanceScope, input: {
  keyId: string; guildId: string; now: number;
  monthlyLimit: number | null; dailyLimit: number | null;
}) => SearchReserveResult;
export interface SearchKeyUsage { readonly last24h: number; readonly last31d: number; readonly availableAt?: number }
/** availableAt is present only while a limit is reached (the later of the two when both are). */
export const searchKeyUsage: (scope: InstanceScope, input: {
  keyId: string; now: number; monthlyLimit: number | null; dailyLimit: number | null;
}) => SearchKeyUsage;
```

`availableAt` for a window with `count >= limit`: sort that window's `at`
values ascending, then take `ats[count - limit] + windowMs`.
The window is `at > now - windowMs`.

Also:

- `assistant-provider.ts`: `AssistantProviderConfigRow.searchSource:
  'brave' | 'tavily'`, which get/put read and write. A missing value on
  put writes `'brave'`.
- `packages/storage/src/index.ts`: export `searchKeysRepo`, like the
  other repos.
- `schema-invariants.test.ts`: add both tables to `INSTANCE_LEVEL`, with
  a comment citing ADR 0120, and update the exact-names test.

**Tests, written first**, in `search-keys.test.ts`, using the storage
test-support helpers the sibling repo tests use:

- add, then list, orders by source and position
- the default monthly limit is 1000, and null is stored as no limit
- update changes only the given fields; an unknown id returns false
- move up and down swaps neighbours in the same source only; a no-op at
  the ends
- remove cascades the calls
- reserve with no limits always succeeds and records `guild_id`
- the daily limit refuses the next call, with `availableAt` = oldest in
  24 h + 24 h
- the monthly limit refuses within 31 days and allows it again after the
  oldest ages out
- a call made 31 days + 1 ms ago no longer counts
- rows older than 32 days are pruned on reserve
- `searchKeyUsage` counts both windows and gives `availableAt` only at a
  limit
- the migration copies a saved Brave key to `skey_brave` with limit 1000,
  and copies nothing when none was saved. Check this through the
  migrated test database and a row inserted before the copy; if that
  cannot be expressed, test the SQL statement directly against a fresh
  database.

Extend `assistant-provider.test.ts` so that `searchSource` round-trips
and defaults to `'brave'`.

**Verify:** `npx vitest run packages/storage`

### Task 2: Daemon — clients, runner, store

**`web-search.ts`** (new):

```ts
import type { InstanceScope } from '@bananasaurs/storage';
import { searchKeysRepo } from '@bananasaurs/storage';
import type { WebResult } from './tools.js';
export type WebSearchSource = 'brave' | 'tavily';
/** `keyId: null` is the `.env` Brave seed: never limited, never recorded. */
export interface WebSearchKey { readonly keyId: string | null; readonly apiKey: string; readonly monthlyLimit: number | null; readonly dailyLimit: number | null }
export interface WebSearchOutcome { readonly results: readonly WebResult[]; readonly source: WebSearchSource }
export type WebSearchRun = (query: string) => Promise<WebSearchOutcome>;
/** Only the HTTP status: a provider's error body is never read into a message (ADR 0120 §6). */
export class SearchHttpError extends Error { constructor(readonly status: number) { super(`HTTP ${String(status)}`); this.name = 'SearchHttpError'; } }
export class WebSearchLimitError extends Error { constructor(readonly availableAt: number) { super('every web search key is at its limit'); this.name = 'WebSearchLimitError'; } }
export const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 429, 432, 433]);
export type SearchClient = (apiKey: string, query: string) => Promise<readonly WebResult[]>;
export const createWebSearchRun: (deps: {
  readonly instance: InstanceScope; readonly guildId: string; readonly source: WebSearchSource;
  readonly keys: readonly WebSearchKey[]; readonly now: () => number;
  readonly client: SearchClient;
}) => WebSearchRun;
```

How a run works:

1. Take the keys in the order given.
2. For each key:
   1. If `keyId !== null`, call `reserveSearchCall`. On a refusal,
      remember the `availableAt` and continue to the next key.
   2. Call `client`. On a `SearchHttpError` whose status is in
      `REFUSED_STATUSES`, continue to the next key. On any other error,
      rethrow.
   3. On success, return `{ results, source }`.
3. When no key succeeded:
   - If every key was skipped for a limit, throw
     `WebSearchLimitError(min availableAt)`.
   - Otherwise throw `new Error('every web search key was refused')`.

**`tavily-search.ts`** (new): `export const tavilyWebSearch = (options:
{ apiKey: string; fetch?: typeof fetch; timeoutMs?: number }, query:
string): Promise<readonly WebResult[]>`.

- It sends `POST https://api.tavily.com/search` with the headers
  `authorization: Bearer <key>`, `content-type: application/json` and
  `accept: application/json`, and the JSON body exactly:

  ```json
  { "query": "…", "search_depth": "basic", "max_results": 5,
    "chunks_per_source": 2, "safe_search": true, "include_answer": false,
    "include_raw_content": false, "include_images": false }
  ```

- It uses `AbortSignal.timeout(timeoutMs ?? 10_000)`.
- When the response is not ok, it throws `new SearchHttpError(status)`
  **without reading the body**.
- It validates with Zod
  `{ results: z.array(z.object({ title: z.string().optional(), url:
  z.string().optional(), content: z.string().optional() })).default([]) }`.
  A schema failure throws `Error('Tavily returned an invalid response')`.
- It keeps only `^https?://` URLs and maps each result to `{ title: title
  ?? url, url, description: content ?? '' }`.
- Put a header comment in the style of `brave-search.ts`, citing ADR 0120.

**`brave-search.ts`:** replace `throw new Error(\`HTTP …\`)` with `throw
new SearchHttpError(response.status)`, imported from `./web-search.js`.
Change the signature to take the same options shape. It keeps working
standalone.

**`provider-config.ts`**, the store. Add:

```ts
searchKeys(): readonly searchKeysRepo.StoredSearchKey[];               // sealed values never opened
addSearchKey(input: { source: 'brave'|'tavily'; label: string; apiKey: string; monthlyLimit?: number|null; dailyLimit?: number|null }, now: number): string;
updateSearchKey(keyId: string, input: { label?: string; apiKey?: string; enabled?: boolean; monthlyLimit?: number|null; dailyLimit?: number|null }, now: number): boolean;
moveSearchKey(keyId: string, direction: 'up'|'down', now: number): boolean;
removeSearchKey(keyId: string): boolean;
isSearchKeyReadable(keyId: string): boolean;
searchKeyUsage(keyId: string): searchKeysRepo.SearchKeyUsage | undefined;  // undefined for an unknown key
/** The run for one request, or undefined while search is off or no key is usable. */
webSearch(guildId: string, clients?: { brave?: SearchClient; tavily?: SearchClient }): WebSearchRun | undefined;
```

How `webSearch` decides:

1. `row = assistantProviderRepo.get(instance)`.
2. If there is **no row**: when `envBase?.BRAVE_SEARCH_API_KEY` is set,
   return a Brave run with `[{ keyId: null, apiKey, monthlyLimit: null,
   dailyLimit: null }]`; otherwise `undefined`.
3. If `row.searchEnabled !== true`, return `undefined`.
4. Otherwise take the keys where `source === row.searchSource` and
   `enabled` is true, in list order, opened with `open(key, …)`. Drop any
   that do not open. If none are left, return `undefined`.
5. The client is `clients?.[source]` when given, else
   `(apiKey, q) => braveWebSearch({ apiKey }, q)` or `tavilyWebSearch`.
   The clock is the store's `clock`.

Change `status().webSearch` to `{ keyConfigured: boolean; enabled:
boolean; source: 'brave' | 'tavily' }`, where `keyConfigured` means at
least one enabled key of the current source is stored. It is present when
any search key is stored or search is enabled.

`save()` accepts `searchSource?: 'brave' | 'tavily'`, where omitted keeps
the current value. Remove `searchApiKey` from `save`'s input, because keys
now go through `addSearchKey`. `effective()` no longer opens
`searchApiKeyEnc` or injects `BRAVE_SEARCH_API_KEY`, but it still deletes
it from `rest` when a saved row exists, as it does today.

**Tests, written first:**

- `web-search.test.ts`, with an in-memory storage scope and a fake client:
  - the first key is used
  - a key at its daily limit is skipped without calling the client
  - 429, 432 and 401 skip to the next key, and the refused call still
    counts
  - 500 and a timeout rethrow and do not try the next key
  - all keys at their limits give a `WebSearchLimitError` with the
    earliest `availableAt`
  - the env seed (`keyId: null`) is never recorded
  - `source` is returned
- `tavily-search.test.ts`, with a fake fetch:
  - the exact request body, headers and URL
  - results are mapped and non-http URLs dropped
  - a non-ok response throws `SearchHttpError` with the status, and the
    body is never read: assert that the response's `json`/`text` spies
    were not called
  - an invalid body throws
- `brave-search.test.ts`: update it for `SearchHttpError`.
- `provider-config.test.ts`:
  - search keys are sealed, and the plaintext never appears in
    `searchKeys()`
  - `webSearch` is undefined while off, with no keys, or with only
    another source's keys
  - it uses only the enabled keys of the current source, in order
  - the env seed applies only with no saved row
  - `status().webSearch.source` is reported
  - `save` keeps `searchSource` when it is omitted

**Verify:** `npx vitest run apps/daemon/src/assistant/web-search.test.ts
apps/daemon/src/assistant/tavily-search.test.ts
apps/daemon/src/assistant/brave-search.test.ts
apps/daemon/src/assistant/provider-config.test.ts`

### Task 3: Daemon — tool, loop, service, runtime wiring

**`tools.ts`:**

- `AssistantToolPorts.webSearch` becomes `WebSearchRun | undefined`,
  imported from `./web-search.js`.
- `AssistantToolResult`: replace `web?: boolean` with `webSource?:
  'brave' | 'tavily'`, and update the doc comment ("the answer must say
  'Powered by Brave Search' when brave").
- In the `web_search` case:
  - Keep the scan.
  - `const outcome = await ports.webSearch(q)`, then use
    `outcome.results`, and set `webSource: outcome.source` on both the
    empty and the non-empty result.
  - Catch `WebSearchLimitError` there and `return refused(name, 'Web
    search has reached its limit for now. Answer without it.')`.
  - Other errors keep flowing to the existing failure path.

**`tool-loop.ts`:**

- `recordWeb: (source: 'brave' | 'tavily') => void`.
- The loop result keeps `web: boolean`, which is true when any web
  result was used, and adds `webSources: readonly ('brave' | 'tavily')[]`
  (unique, in first-seen order).
- The call site becomes `if (result.webSource !== undefined)
  deps.recordWeb(result.webSource)`.

**`service.ts`:**

- Add a final positional parameter after `channelContextMessages`:

  ```ts
  /** ADR 0120: the web search run for one request, from the provider store; undefined while search is off. */
  webSearch: (guildId: string) => WebSearchRun | undefined = () => undefined,
  ```

- The port becomes `webSearch: testPorts.webSearch ??
  webSearch(scope.guildId)`. Delete the `braveWebSearch` import and the
  `currentConfig.BRAVE_SEARCH_API_KEY` branch.
- The type of `AssistantServiceTestPorts.webSearch` becomes
  `WebSearchRun`.
- Attribution: `const braveUsed = loop.webSources.includes('brave')`.
  Append `BRAVE_ATTRIBUTION` only when `braveUsed`, and update the
  comment. The trace and detail `web` fields keep using `loop.web`.

**Runtime:**

- `runtime/guild.ts`: accept and pass a `webSearch` dependency exactly as
  `chain` is passed.
- `runtime/daemon.ts`: build `const assistantWebSearch = (guildId:
  string) => providerStore !== undefined ? providerStore.webSearch(guildId)
  : config.BRAVE_SEARCH_API_KEY === undefined ? undefined :
  createWebSearchRun({ instance: scopes.instance(), guildId, source:
  'brave', keys: [{ keyId: null, apiKey: config.BRAVE_SEARCH_API_KEY,
  monthlyLimit: null, dailyLimit: null }], now: Date.now, client: (k, q) =>
  braveWebSearch({ apiKey: k }, q) })`, and pass it alongside
  `assistantChain`.

**Tests:** update `tools.test.ts`, `tool-loop.test.ts`, `service.test.ts`
and `e2e.test.ts` for the port shape. Add:

- a Tavily result gives `webSource: 'tavily'`
- `WebSearchLimitError` gives a refused result with the limit text and no
  throw
- a Tavily-only answer has **no** "Powered by Brave Search" line
- a Brave answer still has it
- `loop.webSources` is deduplicated

**Verify:** `npx vitest run apps/daemon`

### Task 4: HTTP routes

**`packages/http/src/server.ts`:**

- Extend `AssistantProviderStatus.webSearch` with `source: 'brave' |
  'tavily'`.
- Add optional methods to the `assistantProviderConfig` dep type,
  mirroring Task 2's store signatures. Restate the types locally, because
  `packages/http` must not import `apps/daemon` (ADR 0014):
  `searchKeys?`, `addSearchKey?`, `updateSearchKey?`, `moveSearchKey?`,
  `removeSearchKey?`, `isSearchKeyReadable?` and `searchKeyUsage?`.
- Remove `searchApiKey` from `save`'s input type and add `searchSource?`.

**New file `packages/http/src/routes/assistant-search-keys.ts`:**
`registerAssistantSearchKeyRoutes(app, guard, deps)`. Every route is
owner-only, using the same `requireOwner` pattern as
`assistant-providers.ts`, and returns 503
`provider-secret-store-not-configured` when a method is missing.

- `GET /api/assistant/search-keys` →
  `{ enabled, source, keys: [{ keyId, source, label, enabled, position,
  monthlyLimit, dailyLimit, readable, usage: { last24h, last31d,
  availableAt? } }] }`.
- `POST /api/assistant/search-keys` with the strict Zod body
  `{ source: enum, label: 1–60, apiKey: 1–1000, monthlyLimit?:
  int 1–1e6 | null, dailyLimit?: same }` → `{ keyId }`. Audit
  `assistant_search.key_added` with `after: { source, label,
  monthlyLimit, dailyLimit }`.
- `PATCH /api/assistant/search-keys/:keyId` with the strict body
  `{ label?, apiKey?, enabled?, monthlyLimit?, dailyLimit? }`. An empty
  body is a 400, and an unknown id a 404. Audit
  `assistant_search.key_updated` with before/after labels, limits and
  enabled, plus `keyReplaced`.
- `POST /api/assistant/search-keys/:keyId/move` with the strict body
  `{ direction: 'up' | 'down' }`. A 404 for an unknown id. Audit
  `assistant_search.key_moved`.
- `DELETE /api/assistant/search-keys/:keyId`. A 404 for an unknown id.
  Audit `assistant_search.key_removed` with `before: { source, label }`.

Register it wherever `registerAssistantProviderRoutes` is registered.

**`routes/assistant.ts`:** in the `providerConfig` schema, remove
`searchApiKey` and add `searchSource: z.enum(['brave', 'tavily'])
.optional()`. A change of `searchSource` by a non-owner gets 403
`{ error: 'owner-only', field: 'searchSource' }`. The audit before/after
gains `searchSource`, and `searchKeyReplaced` is dropped.

**Tests, written first:** `assistant-search-keys.test.ts`, modelled on
`assistant-providers.test.ts`:

- non-owner gets 403 on each route
- missing store methods give 503
- add, then GET shows the key with **no `apiKey` or `apiKeyEnc` field
  anywhere in the JSON**. Assert on the serialised body string that the
  pasted key does not appear.
- the audit rows never contain the key
- PATCH validation, 404 and empty-body 400
- move and delete

In `assistant.test.ts`, the `searchSource` owner gate and the removal of
`searchApiKey` (the non-strict schema then ignores it; assert that it is
not saved).

**Verify:** `npx vitest run packages/http`

### Task 5: Dashboard, PRIVACY.md, ADR 0066 note

**`packages/dashboard/src/api/assistant.ts`:** types for the GET shape,
and `AiStatus.webSearch.source`.

**`providers.tsx` `WebSearchCard`**, rewritten. It stays owner-editable
only; non-owners see it read-only, as today.

1. **Source radio:** "Brave Search" or "Tavily", with one line of help
   text each:
   - Brave: "About 1,000 free searches a month. Answers that use it end
     with "Powered by Brave Search". Brave's terms forbid using results
     to train AI."
   - Tavily: "1,000 free searches a month, no card needed. Tavily may
     keep search queries and use them to improve its services, including
     AI training." Link the terms (`https://tavily.com/terms`) and the
     place to get a key (`https://app.tavily.com`).
2. **On/off checkbox:** "Let the assistant search the web". A Save
   button sends `PUT /api/assistant/provider` with `searchEnabled` and
   `searchSource`, keeping the provider/enabled fields as today.
3. **Key list for the selected source**, from `GET
   /api/assistant/search-keys`. One row per key shows:
   - the label
   - an On/Off badge
   - `Unreadable` when it is not readable
   - usage "N / LIMIT in the last 31 days" (or "N in the last 31 days"
     with no limit) and "N / LIMIT today" when a daily limit is set
   - "Paused until <local time>" when `availableAt` is set
   - ↑/↓ buttons, an Edit button (label, replace key, monthly limit,
     daily limit, enabled) and Remove, with a confirm step
4. **"Add key" form:** label, key (password input, write-only), monthly
   limit (number, prefilled 1000; blank means no limit) and daily limit
   (number, blank means none). Under it, the note: "Several keys are for
   a spare or a paid key. Using several free accounts to get more
   searches breaks Brave's and Tavily's terms."

Reuse the components the existing card and the provider-key section
already use (`Card`, `Field`, `Input`, `Checkbox`, `Button`, `Badge`, the
`session.write`/toast pattern). Follow how the provider keys section
lists and edits keys.

**`assistant-skills.tsx`:** the `web_search` tool detail depends on
`data.aiStatus?.webSearch?.source`:

- Brave: "Sends a short query to the Brave Search API."
- Tavily: "Sends a short query to the Tavily search API."

Both keep " Queries that look like they carry personal data are
refused."

**`PRIVACY.md`:** rewrite the "Web search" paragraph for both sources.
Keep the Brave sentences and add: "If the owner chooses Tavily instead,
queries go to the Tavily search API. Tavily's terms let it keep queries
and use them to improve its services, including training AI models." The
refused-query sentence stays.

**`docs/decisions/0066-web-search-through-brave.md`:** add under
`Status:` the line `Amended by ADR 0120 (Tavily as a second source,
several keys, per-key limits).`

**Tests:** if the dashboard has tests for the providers page, update them.
Otherwise add a light `providers-web-search.test.tsx`, following the
pattern of `account-new.test.tsx`: the add-key form posts the expected
body, and the pasted key is cleared after saving.

**Verify:** `npx vitest run packages/dashboard`

## Out of scope

- OpenRouter server-side search
- DuckDuckGo
- keyless Tavily
- Tavily extract, crawl or research
- the doctor command
- the MCP connector
- every file not in the file map
