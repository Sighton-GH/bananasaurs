# AI Observability Implementation Plan

> **For agentic workers:** executed with `opencode-delegate:opencode-driven-development`, with Cline
> as the implementer seat (`cline-delegate`) and opencode Muse Spark as task reviewer. Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** every AI request is visible on the dashboard while it runs and after it ends: what it did,
what it used, and exactly why it failed.

**Architecture:**
- Slice 1 makes every terminal path of the assistant job write a trace and a conversation turn,
  carrying the classified failure, the provider's sanitized message and empty-answer evidence.
- Slice 2 adds a guild-partitioned run ledger (`assistant_runs` + `assistant_run_events`), written
  through a `RunRecorder` port threaded from the job into the service and tool loop.
- Slice 3 exposes the ledger through polling routes and live dashboard panels.
- Slice 4 derives per-model health, a persistent-failure banner and `doctor` warning, and records
  per-call cost.

**Tech stack:** TypeScript (Node 22, strict), Fastify, React + Vite, better-sqlite3 + Drizzle
(migration 0102), Zod, Vitest (jsdom for dashboard tests), Pino.

**Spec:** `docs/27_AI_OBSERVABILITY_PLAN.md` (FINAL) and `docs/decisions/0129-ai-run-observability.md`.

## Global Constraints

Copied into every brief.

**Gates and git**
- Gates, each run alone and each must exit 0: `npm run typecheck`, `npm run lint`, `npm run test`.
  Never pipe a gate through `tail`/`head`; check `$?`.
- Never run `npm run build`, `npm run start`, `npm run db:migrate`, `systemctl`, or anything
  touching `data/` or `backups/`.
- Never run `git stash`; commit work in progress instead (the stash stack is shared by every
  worktree). Never push, merge, rebase or reset.
- Commit after every numbered step that leaves the tests green, with a message naming the task.

**Project hard rules**
- **Guild scope** is mandatory: every new repository function takes `scope: GuildScope` first and
  filters with `scope.only(...)`. Every new table has `guild_id` in its primary key, with the
  snowflake CHECK and the guild foreign key (copy `assistantTraces` in
  `packages/storage/src/schema.ts`).
- **No secrets** in traces, events, logs, API responses or Discord. Provider text goes through
  `sanitizeProviderMessage` before storage. Log fields go through `safeLogFields`, and every new
  field name is added to the allowlist in `packages/core/src/obs/logger.ts`.
- **No message text** in `assistant_runs` or `assistant_run_events`. That means no question, no
  answer, no tool args, no tool result. Counts, ids, names of tools and models, codes, ms and tokens
  only.
- **Observability never changes behaviour:** a recorder or ledger write failure is caught, logged
  once at `warn`, and the run continues with the same outcome and reply.
- **Zod at every boundary:** event payloads, route queries, cursor fields.
- **Old rows still parse:** new trace and cursor fields are `.optional()`, with no migration for the
  trace body.

**Code style**
- Match the surrounding code: comment density, `...(x === undefined ? {} : { x })` spreads for
  optional fields, and ADR references in comments ("ADR 0129").
- Command shapes: always give `rg` an explicit path (`rg -n "x" packages/core/src`), never a bare
  `.`. Use absolute paths, no `cd` in compound commands, and no heredoc followed by other commands.

## Review Focus

Each item names its owning task.

1. **A job retry after a failure trace was written** must not write a second trace for the same
   attempt, and must not append a second failure turn. Task 3: a test drives two failing attempts,
   then a final one.
2. **A provider error message containing a key-shaped string** (`sk-or-v1-…`, `AIza…`,
   `Bearer …`, a 40-char hex token) must never reach a trace, event, API body or Discord. Task 1
   (sanitizer test) and Task 4 (route test).
3. **The dashboard polling while the daemon restarts:** a failed poll must keep the last data on
   screen with a quiet "reconnecting" note, never blank the page or throw. Task 8, `useLiveResource`
   test.
4. **A run stuck in `running` after a crash** (the process died mid-run) must not show as in
   progress forever. Runs not updated for 10 minutes display as "stalled". Task 7 route test; Task 8
   label.
5. **Old trace rows** (no `runId`, no `providerMessage`, no new attempt fields) must still render on
   History detail and Conversations. Task 4: a test with a pre-0129 trace body.

---

## Task 1: Core: provider error evidence, `provider-empty-answer`, message sanitizer, trace fields

**Files:**
- Modify: `packages/core/src/providers/errors.ts` (ProviderError options)
- Modify: `packages/core/src/providers/openai-compatible.ts` (response schema, empty-answer throw,
  error-body upstream)
- Modify: `packages/core/src/providers/gemini.ts` (empty-answer throw carries `finishReason`)
- Modify: `packages/core/src/providers/failure.ts` (new code + text + classification)
- Create: `packages/core/src/providers/provider-message.ts` (+ export from the providers index /
  core index, matching how `failure.ts` is exported)
- Modify: `packages/core/src/assistant/trace.ts` (attempt fields, `runId`)
- Modify: `packages/core/src/obs/logger.ts` (allowlist: `runId`, `finishReason`, `upstream`,
  `reasoningTokens`, `completionTokens`, `totalTokens`, `stage`)
- Tests: the existing `*.test.ts` beside each file (`failure.test.ts`, `openai-compatible.test.ts`,
  `gemini.test.ts`, `trace.test.ts`, `logger.test.ts`), plus `provider-message.test.ts`

**Interfaces produced:**

```ts
// errors.ts — new optional ProviderError fields, set via the options bag like status/netCode/host
public readonly finishReason?: string;      // provider finish/stop reason, verbatim, ≤40 chars
public readonly upstream?: string;          // OpenRouter `provider` / error.metadata.provider_name, ≤60 chars
public readonly emptyAnswer?: {             // set only on the "returned no text" path
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
  readonly reasoningOnly: boolean;          // reasoning text present, answer empty
};

// provider-message.ts
/** Scrubs key-shaped substrings and caps to 160 chars (`…` suffix when cut). */
export const sanitizeProviderMessage: (text: string) => string;

// failure.ts
// ProviderFailureCode gains 'provider-empty-answer' (insert after 'provider-invalid-response'
// in the union, PROVIDER_FAILURE_TEXT and PROVIDER_FAILURE_CODES; update the "All 18 codes"
// comment to 19).
// classifyProviderFailure: an invalid-response ProviderError whose `emptyAnswer` is set →
// 'provider-empty-answer' (checked inside Rule 6, before 'provider-invalid-response').
// ProviderFailure gains optional finishReason?: string; upstream?: string (copied from the error).

// trace.ts — attempt object gains (all optional):
providerMessage: z.string().max(200).optional(),
finishReason: z.string().max(40).optional(),
upstream: z.string().max(60).optional(),
completionTokens: z.number().int().nonnegative().optional(),
reasoningTokens: z.number().int().nonnegative().optional(),
costUsd: z.number().nonnegative().optional(),   // filled by Task 9; declared now
// trace gains:
runId: z.string().min(1).max(64).optional(),
// TraceSummary gains `errorCode?: string` = the last non-ok, non-skipped attempt's `code`
// (summaryOfTrace computes it).
```

`PROVIDER_FAILURE_TEXT['provider-empty-answer']`:
- **title:** "The model returned an empty answer"
- **explanation:** "The provider answered, but the answer had no text. Reasoning models often do
  this when their thinking uses up the whole output budget."
- **hint:** "Check the finish reason and reasoning tokens below. If the finish reason is `length`,
  raise AI tuning → Max output tokens, or move this model down the chain."

`sanitizeProviderMessage` replaces each match below with `[redacted]`, in this order, then caps the
result. Collapse whitespace runs to a single space first.

| Matches | Pattern |
|---|---|
| bearer tokens | `/Bearer\s+\S+/gi` |
| OpenAI-style keys, including `sk-or-v1-…` | `/sk-[A-Za-z0-9_-]{8,}/g` |
| Google keys | `/AIza[0-9A-Za-z_-]{20,}/g` |
| NVIDIA keys | `/nvapi-[A-Za-z0-9_-]{8,}/g` |
| Tavily keys | `/tvly-[A-Za-z0-9_-]{8,}/g` |
| GitHub tokens | `/gh[pousr]_[A-Za-z0-9]{20,}/g` and `/github_pat_[A-Za-z0-9_]{20,}/g` |
| any long token-like run | `/[A-Za-z0-9_\-]{32,}/g` |

**OpenAI-compatible adapter changes:**
- **Response schema:**
  - add `provider: z.string().optional()` at the top level;
  - add `reasoning: z.string().nullable().optional()` on `message`;
  - add to `usage`:
    `completion_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).partial().optional()`
    and `cost: z.number().nonnegative().optional()`.
- **The empty-text throw** (currently `throw new ProviderError('invalid-response', \`${this.id} returned no text\`, false)`)
  becomes the same kind, message and retryable flag, with options:
  `{ host: this.host, finishReason, upstream, emptyAnswer: { completionTokens, reasoningTokens, reasoningOnly } }`.
  Include only the fields that are present.
- **The HTTP-error path** reads `metadata.provider_name` (string) into `upstream` on the thrown
  error.
- **A successful response** returns `upstream` and `reasoningTokens`. Add both, optional, to
  `GenerateTextResponse` and `ProviderUsage` in `contracts.ts`: `upstream?: string` on the
  response, `reasoningTokens?: number` on usage.

**Gemini adapter:** where it throws for an empty answer, attach `finishReason` (from the
candidate's `finishReason`) and `emptyAnswer: { reasoningOnly: false }`, plus token counts if the
usage metadata has them.

- [ ] **Step 1: Write failing tests**
  - `provider-message.test.ts`: each key shape above is redacted. `"No endpoints found for stealth/space-bunny-alpha."`
    passes through unchanged. A 400-char input comes back ≤160 chars ending in `…`.
  - `openai-compatible.test.ts`, empty answer: a 200 response with
    `{ choices:[{ message:{ content:null, reasoning:'thinking…' }, finish_reason:'length' }], usage:{ completion_tokens:2048, completion_tokens_details:{ reasoning_tokens:2048 } }, provider:'Nebius' }`
    throws a `ProviderError` with `kind 'invalid-response'`, `finishReason 'length'`,
    `upstream 'Nebius'`, and
    `emptyAnswer { completionTokens:2048, reasoningTokens:2048, reasoningOnly:true }`.
  - `openai-compatible.test.ts`, upstream on error: a 404 whose body has
    `error.metadata.provider_name:'X'` throws with `upstream 'X'`.
  - `failure.test.ts`: that error classifies as `provider-empty-answer`, with `finishReason`
    and `upstream` copied. `PROVIDER_FAILURE_CODES.length === 19`, and every code has text.
  - `trace.test.ts`: a body without any new field still parses. A body with every new field
    parses. `summaryOfTrace` sets `errorCode` from the last failed attempt.
  - `logger.test.ts`: `runId` survives `safeLogFields`.
- [ ] **Step 2:** run `npx vitest run packages/core` and confirm the new tests fail.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `npx vitest run packages/core` passes, then the three gates.
- [ ] **Step 5:** commit `Task 1: provider error evidence, provider-empty-answer, message sanitizer (ADR 0129)`.

---

## Task 2: Daemon service and tool loop: failures carry detail, outcome on refusals, run id

**Files:**
- Modify: `apps/daemon/src/assistant/tool-loop.ts`
- Modify: `apps/daemon/src/assistant/chain-failed-error.ts`
- Modify: `apps/daemon/src/assistant/local-limit.ts` (`LocalLimitError`)
- Modify: `apps/daemon/src/assistant/service.ts` (`mapLoopFailure`, the `ok:false` returns,
  `invoke`, `tryIt`)
- Modify: `apps/daemon/src/assistant/commands.ts` (`AssistantInvocationResult` ok:false variant)
- Modify: `packages/core/src/jobs/kinds.ts` (cursor ok:false variant gains `outcome`)
- Tests: `tool-loop.test.ts`, `service.test.ts` (or the existing service test files; find them with
  `rg -l "mapLoopFailure|runToolLoop" apps/daemon/src`), `chain-failed-error.test.ts`

**Interfaces:**
- Consumes (Task 1): `sanitizeProviderMessage`, the `ProviderError.finishReason/upstream/emptyAnswer`
  fields, `classifyProviderFailure` returning `provider-empty-answer`, and the attempt fields.
- Produces:

```ts
// chain-failed-error.ts
export class ChainFailedError extends ProviderError {
  readonly code = 'chain-failed';
  constructor(
    kind: ProviderErrorKind,
    readonly summary: string,
    retryable: boolean,
    readonly attempts: AssistantTrace['attempts'],
    options?: {
      readonly detail?: AssistantTraceDetail;    // import type from './commands.js'
      readonly quotaScope?: 'daily-free';
      readonly resetAt?: number;
      readonly cause?: unknown;
    },
  );
  readonly detail?: AssistantTraceDetail;
}
// local-limit.ts: LocalLimitError gains optional `attempts?: AssistantTrace['attempts']`
// and `detail?: AssistantTraceDetail` (constructor options bag, existing args unchanged).

// commands.ts ok:false variant gains:
readonly outcome?: 'refused' | 'failed';   // absent means 'refused' (old cursors)
// kinds.ts cursor ok:false object gains: outcome: z.enum(['refused','failed']).optional()

// tool-loop.ts runToolLoop input gains:
readonly runId?: string | undefined;
// and `logger` widens to Pick<Logger, 'warn' | 'info'>.
```

**Behaviour:**

1. **`failAttempt` (tool-loop):** every failed attempt pushed onto `attempts` also carries:
   - `providerMessage: sanitizeProviderMessage(err.message)`, when `err instanceof Error`;
   - `finishReason`, `upstream`, `completionTokens` and `reasoningTokens` from
     `err.emptyAnswer` / `err.finishReason` / `err.upstream`, when present.

   The `provider attempt failed` warn line adds `runId`, `finishReason` and `upstream` when
   present. Remove the comment saying provider text never reaches the trace, and replace it with:
   "ADR 0129 §3: the sanitized provider message is stored; routes show it only to config.read."
2. **`finishEntry` empty-answer path:**
   - the final `outcome:'error', reason:'empty-answer'` attempt also records
     `code: 'provider-empty-answer'` and the first response's `finishReason`;
   - the bare `catch {}` on the retry becomes `catch (err)`, which logs `provider attempt failed`
     (same fields as `failAttempt`'s line, `code` from `classifyProviderFailure(err, …)`) and stays
     non-fatal.
3. **Skipped entries:** each skipped entry (`entry.skip`, daily allowance, local limit) logs one
   `info` line, `assistant model skipped`, with `{ component:'assistant', guildId, runId, provider,
   model, keyLabel, reason }`.
4. **`mapLoopFailure` (service):**
   - Local limit → `throw new LocalLimitError(availableAt, code, { attempts: failed.attempts, detail: loopDetail() })`.
   - Daily quota →
     `throw new ChainFailedError('quota', 'free-model daily allowance exhausted', false, failed.attempts, { quotaScope: 'daily-free', resetAt, detail: loopDetail() })`.
     This keeps `err.quotaScope === 'daily-free'` true for the job's existing check.
   - The busy/rate-limit/timeout branch passes `{ detail: loopDetail() }`.
   - The "last attempt is error" branch (currently `throw failed.lastError` or `new ProviderError('invalid-request', …)`)
     becomes `throw new ChainFailedError(kind, \`Every assistant model failed — ${summarizeAttempts(failed.attempts)}\`, retryable, failed.attempts, { detail: loopDetail(), cause: failed.lastError })`.
     Here `kind` and `retryable` come from `failed.lastError` when it is a `ProviderError`, else
     `'invalid-request'` and `false`.
   - The empty-answer return gets `outcome: 'failed'`.
   - The "not configured" return (both places: `mapLoopFailure` and `chainEntries.length === 0`
     near line 635) gets `outcome: 'failed'`.
   - The terms, caller-role, skill-scope and IT-routing returns get `outcome: 'refused'`.
5. **`invoke`** passes `runId: input.invocationId` to `runToolLoop`.
6. **`tryIt`:**
   - outcome becomes `result.ok ? 'answered' : (result.outcome ?? 'refused')`;
   - in the catch, use `err.attempts` and `err.detail` (for `ChainFailedError` / `LocalLimitError`)
     for the trace's attempts, sections, usage, toolCalls, guard and included, and set
     `error: { kind: err.kind ?? 'internal', message: err.summary ?? 'internal error' }`;
   - the trace gets `runId: userTurnId`.

- [ ] **Step 1: Write failing tests**
  - Tool loop with a chain `[empty-answer provider, 404 provider]`: the attempts carry
    `providerMessage`; the 404 attempt has `code 'provider-bad-model'` and
    `providerMessage` containing `No endpoints found`.
  - The service invoke with that chain throws a `ChainFailedError` with `attempts.length === 2`,
    `retryable false`, and `detail.sections.length > 0`.
  - The service invoke with a daily-cap chain throws a `ChainFailedError` with
    `quotaScope 'daily-free'` and `detail`.
  - An all-local-limited chain throws a `LocalLimitError` with `attempts` and `detail`.
  - Empty answer → `{ ok:false, outcome:'failed' }`; terms refusal → `outcome:'refused'`.
  - A `finishEntry` retry that throws is logged (a fake logger captures `provider attempt failed`).
  - `tryIt` with a 404-only chain stores a trace with `outcome 'failed'`, `attempts.length 1` and
    `sections.length > 0`.
  - An old cursor with an ok:false result and no `outcome` still parses.
- [ ] **Step 2:** run the daemon assistant tests and confirm the new ones fail.
- [ ] **Step 3:** implement. Keep every existing test green; update an existing assertion only when
  it pinned the old raw-`ProviderError` rethrow, and say which in the RESULT block.
- [ ] **Step 4:** the three gates.
- [ ] **Step 5:** commit `Task 2: failed chains carry attempts and detail; refusal outcome; run id in loop logs (ADR 0129)`.

---

## Task 3: Daemon job: one terminal path, failure turns, outcome, run logs, log-channel detail

**Files:**
- Modify: `apps/daemon/src/jobs/assistant.ts`
- Modify: `apps/daemon/src/assistant/log-message.ts` (the failure reason shows code and model)
- Tests: `apps/daemon/src/jobs/assistant.test.ts`, `apps/daemon/src/assistant/commands.test.ts`
  (uses the real handler), `log-message.test.ts`

**Interfaces:**
- Consumes (Task 2): `ChainFailedError.detail/attempts`, `LocalLimitError.attempts/detail`, and
  `result.outcome`.
- Produces:
  - Trace ids are unchanged. The success trace is `trace_<key>`; failure traces are
    `trace_<key>_a<n>` with flag `retry:<n>` or `gave-up`.
  - A terminal failure appends the assistant turn `turn_<key>_a`, with `traceId` = that failure
    trace's id. It is linked to the posted reply message id when Discord returned one.

**Behaviour:**

1. **Replace `insertChainFailureTrace`** with `insertFailureTrace(err: unknown, opts: { final: boolean })`.
   It writes a `failed` trace for **any** error and is skipped when that trace id already exists.

   | Error | `attempts` / detail | `error` |
   |---|---|---|
   | `ChainFailedError` | from the error, including `detail` (sections, usage, toolCalls, guard, included, finishReason) | `{ kind: err.kind, message: err.summary }` |
   | `LocalLimitError` | from the error | `{ kind: err.code, message: 'Every model is at its configured limit' }` |
   | anything else | `attempts: []` | `{ kind: 'internal', message: 'An internal error stopped the request; the daemon log has the detail.' }` (never `err.message`) |

   Every failure trace also carries:
   - `runId: payload.invocationId`;
   - `turnId: turn_<key>_a`, only when final;
   - flags: `retry:<n>` while retrying, `gave-up` when final;
   - timeline `[received 0, failed elapsed]`.
2. **The daily-quota and local-limit branches** now call `insertFailureTrace(err, { final: true })`
   and `appendFailureTurn(...)` before `answerSingle`/`logFailure`. So does the final branch.
   Their replies are unchanged.
3. **`answerSingle`** returns the posted message id (`string | undefined`), from
   `deps.respond(...)?.messageId` or `deps.send(...)?.messageId`.
4. **`appendFailureTurn(text, traceId, postedId)`** runs when `conversationId !== undefined &&
   deps.conversations !== undefined`. It appends `turn_<key>_a` with role `assistant`, author the
   bot's display name, the reply text and the trace id, unless that turn already exists. It links
   `turn_<key>_u` to `payload.messageId` and `turn_<key>_a` to `postedId`. The idempotency is the
   same as the success path's.
5. **Deleted or disabled behaviour:** write a `refused` trace `trace_<key>` with
   `error: { kind: 'behaviour-unavailable', message: 'The behaviour was deleted or turned off before the request ran.' }`
   and `runId`. No conversation exists yet at that point, so there is no turn.
6. **Channel not writable** (the fresh-run `writeAllowedNow()` false): write a `refused` trace
   `trace_<key>` with `error: { kind: 'channel-not-writable', message: 'Bananasaurs may not post in this channel (channel permissions).' }`
   and flags `['channel-not-writable']`. This needs a guild scope: write it only when
   `deps.conversations !== undefined`.
7. **Success path outcome:** `outcome: result.ok ? 'answered' : (result.outcome ?? 'refused')` in
   the trace and in the stage-4 log entry. The success trace also gets `runId`.
8. **Logs:**
   - Every `deps.logger.*` call in this file adds `runId: payload.invocationId` to its fields.
   - After stage 2 writes the trace, log one `info` line, `assistant run finished`:
     `{ component:'assistant-job', guildId, runId, outcome, model, ms: durationMs, totalTokens, attempt: context.attempts }`.
   - The final-failure branch logs the same line with `outcome:'failed'` and
     `code: <classified code of the last failed attempt>`.
9. **`log-message.ts`:** the failure entry's `reason` becomes `"<title> — <model>"`. It is built
   from the last failed attempt: `PROVIDER_FAILURE_TEXT[code].title` and the attempt's `model`,
   for example "This model is not available on this key — stealth/space-bunny-alpha". When there
   are no attempts it falls back to today's `PROVIDER_FAILURE_LOG_REASON`. Pass the attempts
   through `logFailure(text, reason)` by computing the reason in the job. **Never** the provider
   message (ADR 0129 §3).

- [ ] **Step 1: Write failing tests** in `assistant.test.ts`, with fake service failures.
  - A non-retryable `ChainFailedError` (404) → one `failed` trace `trace_<key>_a1` with flag
    `gave-up`, `attempts.length 1` and `runId`. The conversation has turn `turn_<key>_a` with that
    `traceId` and the reply text. The reply was sent once.
  - A retryable chain failure ×2, then success → traces `_a1` (`retry:1`), `_a2` (`retry:2`) and
    `trace_<key>` (`answered`). Exactly one assistant turn.
  - Retryable ×4 (ceiling): `_a4` with `gave-up` plus one failure turn. Re-running the same job
    attempt (simulated crash replay with the same `context.attempts`) writes no second trace and no
    second turn. **(Review Focus 1)**
  - Daily quota → a failed trace plus a failure turn, with the quota reply text.
  - `LocalLimitError` → the same, with the local-limit reply.
  - A plain `Error('boom')` thrown by the service → a failed trace whose `error.kind` is
    `'internal'` and whose message does not contain `boom`.
  - Deleted behaviour → a `refused` trace with `error.kind 'behaviour-unavailable'`.
  - Write denied → a `refused` trace with flag `channel-not-writable`, and no send.
  - `{ ok:false, outcome:'failed' }` → the trace outcome is `failed`.
  - A log line `assistant run finished` carries `runId`.
  - `log-message.test.ts`: the failure reason names the title and the model.
- [ ] **Step 2:** run and confirm they fail.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the three gates.
- [ ] **Step 5:** commit `Task 3: every terminal path writes a trace and a turn; run logs; log-channel failure detail (ADR 0129)`.

---

## Task 4: HTTP + dashboard: failures visible in History and Conversations

**Files:**
- Modify: `packages/http/src/routes/assistant-traces.ts`
- Modify: `packages/http/src/routes/assistant-conversations.ts`
- Modify: `packages/storage/src/repos/conversations.ts` and `packages/storage/src/repos/traces.ts`
  (failure counts and per-turn outcome)
- Modify: `packages/dashboard/src/api/traces.ts`, `packages/dashboard/src/api/conversations.ts`
- Modify: `packages/dashboard/src/pages/assistant-history.tsx`, `assistant-history-detail.tsx`,
  `assistant-conversations.tsx`, `assistant-conversation.tsx`, `what-the-ai-saw.tsx`
- Modify: `PRIVACY.md` (one paragraph: the provider error text is stored with the trace, shown
  only to config.read, deleted with the conversation)
- Tests: route tests beside each route file, repo tests, page tests (`// @vitest-environment jsdom`,
  follow `packages/dashboard/src/pages/tasks.test.tsx` for render and fetch mocking)

**Interfaces:**
- Consumes: the Task 1 attempt fields, `runId`, `TraceSummary.errorCode`, and the Task 3 failure
  turns.
- Produces:

```ts
// traces repo
export const outcomesForTraces: (scope: GuildScope, traceIds: readonly string[]) =>
  Map<string, { outcome: 'answered'|'refused'|'failed'; errorCode?: string; model?: string;
                providerMessage?: string }>;
export const failedCountsForConversations: (scope: GuildScope, conversationIds: readonly string[]) =>
  Map<string, number>;  // count of assistant turns whose trace outcome is 'failed'
```

**API changes:**
- `GET /api/assistant/traces/:traceId`:
  - each attempt's `providerMessage` is removed unless `canReadPromptText(session)` (config.read);
  - the response gains `journal: { since: string; until: string }`, ISO local times, from
    `trace.at - trace.durationMs - 5000` to `trace.at + 5000`.
- `GET /api/assistant/traces` rows gain `errorCode` (from `TraceSummary`).
- `GET /api/assistant/conversations` rows gain `failedTurns: number`.
- `GET /api/assistant/conversations/:id`: each assistant turn with a `traceId` gains
  `outcome` and, when failed, `failure: { code, title, model?, providerMessage? }`.
  - `title` comes from `PROVIDER_FAILURE_TEXT` for known codes; otherwise use the trace's
    `error.kind`, mapped through a fixed table: `internal` → "Internal error",
    `behaviour-unavailable` → "Behaviour unavailable", `channel-not-writable` → "Channel not
    writable".
  - `providerMessage` is included only for config.read.

**Dashboard:**
- **History list:** a new column "Error" shows `errorCode` as a `Badge` (danger tone), with "—"
  when absent.
- **History detail, Model card:**
  - each attempt row shows `providerMessage` (monospace, wrapped) under the explain text;
  - `finishReason`, `upstream`, and `completionTokens` / `reasoningTokens` show when present.
- **History detail, Summary card:** shows `runId`, and a copyable
  `journalctl -u bananasaurs --since "<since>" --until "<until>" --no-pager` line. Use the existing
  copy affordance if one exists (`rg -n "clipboard" packages/dashboard/src`), else a `Button` that
  calls `navigator.clipboard.writeText`.
- **Conversations list:** a "Failed" `Badge` (danger) with the count when `failedTurns > 0`.
- **Transcript:**
  - a failed assistant turn renders with danger styling: a `Badge` "Failed", the failure title, the
    model, and `providerMessage` when present, then the turn text (the member-facing reply), then
    the existing "View details" link and the `WhatTheAiSaw` panel;
  - a `refused` turn gets a neutral "Refused" badge.

- [ ] **Step 1: Write failing tests**
  - Route: the trace detail strips `providerMessage` for an `audit.read`-only session and keeps it
    for `config.read`. A key-shaped string stored in `providerMessage` never appears in any
    response body; seed the row raw through `insertTrace` with an unsanitized value to prove the
    route doesn't rely on it **(Review Focus 2)**. Note: the route need not re-sanitize; the test
    asserts that what is stored is what is gated. If you decide to also run
    `sanitizeProviderMessage` at the route, say so.
  - Route: the conversation list gives `failedTurns` 1 for a conversation with a failed turn.
  - Route: the transcript turn carries `failure.title` "This model is not available on this key".
  - Page: a transcript with a failed turn shows "Failed" and the title. The History detail of a
    **pre-0129 trace body** (no `runId`, no new attempt fields) renders without throwing
    **(Review Focus 5)**.
- [ ] **Step 2:** confirm the tests fail. **Step 3:** implement. **Step 4:** the three gates.
- [ ] **Step 5:** commit `Task 4: failures visible in History and Conversations (ADR 0129)`.

---

## Task 5: Storage: run ledger tables, event schema, repository, retention

**Files:**
- Create: `packages/core/src/assistant/run-events.ts` (+ export through the core index like
  `trace.ts`)
- Modify: `packages/storage/src/schema.ts` (two tables after `assistantTraces`)
- Create: `drizzle/0102_*.sql` via `npm run db:generate` (it must produce STRICT tables like 0101;
  if the generator does not add STRICT, follow whatever post-processing the repo uses, and find it
  with `rg -n "STRICT" scripts drizzle.config.ts`)
- Create: `packages/storage/src/repos/runs.ts` (+ export as `runRepo` wherever `traceRepo` is
  exported)
- Modify: `apps/daemon/src/jobs/conversation-prune.ts` (delete runs with their conversations, plus
  orphans after 30 days)
- Modify: `packages/storage/src/repos/assistant.ts` `forgetMember` (delete that member's runs)
- Modify: `PRIVACY.md` (the step log: metadata only, deleted with the conversation, orphans after
  30 days)
- Tests: `run-events.test.ts`, `runs.test.ts`, prune and forget tests

**Interfaces produced:**

```ts
// core run-events.ts
export const RUN_STATES = ['queued','running','retry-wait','answered','refused','failed'] as const;
export type RunState = (typeof RUN_STATES)[number];
export const RUN_STAGES = ['queued','starting','conversation','context','calling-model',
  'running-tool','retry-wait','delivering','done'] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export const runEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('queued'), via: z.enum(['mention','reply','slash','dashboard']) }),
  z.object({ kind: z.literal('started'), attempt: z.number().int().min(1), queueWaitMs: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('conversation'), continued: z.boolean(), historyTurns: z.number().int().nonnegative(),
             summaryVersion: z.number().int().nonnegative().optional() }),
  z.object({ kind: z.literal('context-built'),
             sections: z.array(z.object({ name: z.string().max(80), chars: z.number().int(), estTokens: z.number().int() })).max(40),
             snippetChunks: z.number().int().nonnegative(), memories: z.number().int().nonnegative(),
             channelMessages: z.number().int().nonnegative(), toolsOffered: z.array(z.string().max(60)).max(60) }),
  z.object({ kind: z.literal('model-call'), position: z.number().int().nonnegative(), of: z.number().int().positive(),
             provider: z.string().max(40), model: z.string().max(120), keyId: z.string().max(60), keyLabel: z.string().max(60).optional(),
             round: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('model-result'), provider: z.string().max(40), model: z.string().max(120), keyId: z.string().max(60),
             ok: z.boolean(), ms: z.number().int().nonnegative(),
             promptTokens: z.number().int().nonnegative().optional(), completionTokens: z.number().int().nonnegative().optional(),
             reasoningTokens: z.number().int().nonnegative().optional(), finishReason: z.string().max(40).optional(),
             upstream: z.string().max(60).optional(), costUsd: z.number().nonnegative().optional(),
             code: z.string().max(60).optional(), httpStatus: z.number().int().optional(), netCode: z.string().max(60).optional(),
             providerMessage: z.string().max(200).optional(), toolCalls: z.number().int().nonnegative().optional() }),
  z.object({ kind: z.literal('model-skipped'), provider: z.string().max(40), model: z.string().max(120), keyId: z.string().max(60),
             reason: z.string().max(60), availableAt: z.number().int().optional() }),
  z.object({ kind: z.literal('tool-call'), round: z.number().int().nonnegative(), tool: z.string().max(60) }),
  z.object({ kind: z.literal('tool-result'), round: z.number().int().nonnegative(), tool: z.string().max(60), ok: z.boolean(),
             refused: z.string().max(120).optional(), ms: z.number().int().nonnegative(), resultChars: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('guard'), removed: z.number().int().nonnegative(), blocked: z.string().max(40).optional() }),
  z.object({ kind: z.literal('retry-scheduled'), code: z.string().max(60), retryAt: z.number().int(), attempt: z.number().int().min(1) }),
  z.object({ kind: z.literal('delivering'), parts: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('delivered'), messageIds: z.array(z.string().max(25)).max(20) }),
  z.object({ kind: z.literal('finished'), outcome: z.enum(['answered','refused','failed']), durationMs: z.number().int().nonnegative(),
             totalTokens: z.number().int().nonnegative().optional(), code: z.string().max(60).optional(), traceId: z.string().max(80).optional() }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export interface RunEventRow { readonly seq: number; readonly at: number; readonly event: RunEvent }
export interface RunRow {
  readonly runId: string; readonly conversationId?: string; readonly traceId?: string;
  readonly userId: string; readonly channelId?: string; readonly behaviourId: string;
  readonly source: 'mention'|'slash-command'|'dashboard-test';
  readonly state: RunState; readonly stage: RunStage; readonly attempt: number;
  readonly queuedAt: number; readonly startedAt?: number; readonly updatedAt: number;
  readonly finishedAt?: number; readonly retryAt?: number;
  readonly model?: string; readonly keyLabel?: string; readonly errorCode?: string; readonly totalTokens?: number;
}
```

**Tables** (snake_case columns). The typed columns duplicate fields from `data_json` for indexing.

```text
assistant_runs:
  guild_id (snowflake) · run_id text · conversation_id text null · trace_id text null ·
  user_id (snowflake) · channel_id text null · behaviour_id text · source text ·
  state text CHECK IN RUN_STATES · stage text CHECK IN RUN_STAGES · attempt int default 1 ·
  queued_at int · started_at int null · updated_at int · finished_at int null · retry_at int null ·
  model text null · key_label text null · error_code text null · total_tokens int null
  PK (guild_id, run_id); FK guild cascade; snowflake CHECKs on guild_id, user_id;
  index assistant_runs_state (guild_id, state, updated_at);
  index assistant_runs_conversation (guild_id, conversation_id)

assistant_run_events:
  guild_id · run_id · seq int · at int · kind text · model text null · key_id text null ·
  ok int null CHECK IN (0,1) · code text null · ms int null · tokens int null ·
  cost_usd real null · data_json text
  PK (guild_id, run_id, seq); FK (guild_id, run_id) → assistant_runs ON DELETE cascade;
  index assistant_run_events_kind (guild_id, kind, at)
```

**Repository** (`runs.ts`). Every function takes `scope` first.

```ts
export const ensureRun: (scope, init: { runId; userId; channelId?; behaviourId; source; queuedAt: number }) => void;
  // insert-or-ignore, state 'queued', stage 'queued'
export const updateRun: (scope, runId: string, patch: Partial<Pick<RunRow,
  'state'|'stage'|'attempt'|'startedAt'|'finishedAt'|'retryAt'|'model'|'keyLabel'|'errorCode'|
  'totalTokens'|'conversationId'|'traceId'>> & { updatedAt: number }) => void;
export const appendRunEvent: (scope, runId: string, at: number, event: RunEvent) => number;
  // validates with runEventSchema.parse; seq = max(seq)+1 inside the same write transaction;
  // fills the typed columns from the event (model/keyId/ok/code/ms/tokens=completion+prompt or
  // totalTokens/costUsd); returns seq
export const getRun: (scope, runId: string) => RunRow | undefined;
export const listRuns: (scope, q: { active?: boolean; before?: number; limit: number }) => RunRow[];
  // active = state IN ('queued','running','retry-wait'); newest updated first
export const listRunEvents: (scope, runId: string, afterSeq: number, limit: number) => RunEventRow[];
  // a row whose data_json no longer parses is skipped
export const deleteRunsForConversations: (scope, conversationIds: readonly string[]) => number;
export const deleteRunsForUser: (scope, userId: string) => number;
export const pruneOrphanRuns: (scope, olderThan: number) => number;
  // conversation_id IS NULL AND updated_at < olderThan
```

- [ ] **Step 1: Write failing tests**
  - **Schema:** every event kind round-trips. An event with a `question` or `text` field is
    rejected; it uses `.strict()` on every member object. Make all members strict.
  - **Repo:**
    - `appendRunEvent` assigns seq 1, 2, 3;
    - a parallel-style double call within one transaction cannot produce duplicate seqs (the PK
      rejects it);
    - `listRunEvents(after=1)` returns seq ≥ 2;
    - a cross-guild read returns nothing;
    - a non-snowflake guild id is rejected by the CHECK;
    - `listRuns({active:true})` returns only queued, running and retry-wait runs;
    - deleting runs cascades their events.
  - **Prune:** a run whose conversation is pruned is deleted, and an orphan older than 30 days is
    deleted. **Forget:** the member's runs are deleted.
- [ ] **Step 2:** confirm the tests fail. **Step 3:** schema, `npm run db:generate`, repo, prune,
  forget. **Step 4:** `npm run db:generate` produces no further diff, and the three gates pass.
- [ ] **Step 5:** commit `Task 5: run ledger tables, events schema and repository (ADR 0129, migration 0102)`.

---

## Task 6: Daemon: `RunRecorder` wired through subscriber, job, service, tool loop, try-it

**Files:**
- Create: `apps/daemon/src/assistant/run-recorder.ts`
- Modify: `apps/daemon/src/assistant/commands.ts` (subscriber: `ensureRun` + `queued` after a
  newly queued job)
- Modify: `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/assistant/service.ts`,
  `apps/daemon/src/assistant/tool-loop.ts`
- Modify: `apps/daemon/src/runtime/guild.ts` (wiring)
- Tests: `run-recorder.test.ts`; extend `assistant.test.ts`, `tool-loop.test.ts`, `commands.test.ts`

**Interfaces produced:**

```ts
export interface RunRecorder {
  readonly runId: string;
  event(e: RunEvent): void;                       // appendRunEvent + updateRun(stage/model…) — never throws
  update(patch: Parameters<typeof runRepo.updateRun>[2]): void;  // never throws
}
export const createRunRecorder: (deps: { scope: GuildScope; runId: string; now: () => number;
  logger: Pick<Logger,'warn'>; guildId: string }) => RunRecorder;
export const NOOP_RUN_RECORDER: RunRecorder;   // runId '' ; used when no scope (tests, golden pair)
```

`event()` also updates the run row's `stage`, `state` and summary fields:

| Event | Run row update |
|---|---|
| `started` | state `running`, stage `starting`, `startedAt`, `attempt` |
| `conversation` | stage `conversation` |
| `context-built` | stage `context` |
| `model-call` | stage `calling-model`, plus `model` and `keyLabel` |
| `tool-call` | stage `running-tool` |
| `retry-scheduled` | state `retry-wait`, stage `retry-wait`, `retryAt`, `errorCode` |
| `delivering` | stage `delivering` |
| `finished` | state = outcome, stage `done`, `finishedAt`, `totalTokens`, `errorCode`, `traceId` |

A failure inside `event` or `update` logs a `warn` line, `assistant run ledger write failed`, at
most once per recorder, and returns.

**Wiring:**
- **Subscriber:** after `deps.enqueue(...)` reports a new job, call
  `ensureRun(scope, { runId: event.messageId, userId, channelId, behaviourId, source: 'mention', queuedAt: now })`
  and `event({ kind:'queued', via: event.referencedMessageId ? 'reply' : 'mention' })`. Give the
  subscriber an optional `runs?: { scope: GuildScope }` dep, wired in `guild.ts`.
- **Job:**
  - creates the recorder when `deps.conversations` is present: `ensureRun` (covers jobs queued
    before deploy) and `event({kind:'started', attempt: context.attempts, queueWaitMs: startedAt - run.queuedAt})`;
  - `conversation` after resolve;
  - passes `recorder` to `service.invoke` (new optional `recorder?: RunRecorder` on
    `AssistantInvocation`);
  - `retry-scheduled` before throwing `RetryAfterError` (`retryAt = now + delay`, `code` from the
    last failed attempt or `'internal'`);
  - `delivering` with the parts count, `delivered` with the message ids;
  - `finished` with outcome, duration, tokens, code and `traceId` on every terminal path
    (answered, refused, failed), plus `updateRun({ conversationId })` once it is known.
- **Service:** `context-built` after the context compiles (sections from `traceSections`, chunk,
  memory and channel-message counts, `toolsOffered` known after the loop: emit with the round-1
  declaration names). The recorder is passed into `runToolLoop`.
- **Tool loop:**
  - `model-call` before each `provider.generateText` (position = chain index, of = chain length,
    round);
  - `model-result` after it, ok or failed, with the same fields as the attempt plus `toolCalls`
    count, sanitized `providerMessage`, tokens from `response.usage`, and
    `upstream`/`finishReason`;
  - `model-skipped` for each skip;
  - `tool-call` / `tool-result` around `run(call)` (`resultChars = result.text.length`; refused
    calls emit only `tool-result` with `ok:false, refused`);
  - `guard` when anything was removed or blocked.
- **Try-it:** `ensureRun` with `runId = userTurnId`, `source 'dashboard-test'`, then
  `queued{via:'dashboard'}`, `started`, then pass the recorder and emit `finished` with the trace id.

- [ ] **Step 1: Write failing tests**
  - Recorder: a throwing repo never throws out, and the warn is logged once.
  - Job happy path: events in order
    `started, conversation, context-built, model-call, model-result, delivering, delivered, finished`;
    the run ends `answered`, stage `done`, with `traceId` set.
  - Failover (404, then ok): `model-call`, `model-result(ok:false, code provider-bad-model)`,
    `model-call`, `model-result(ok:true)`.
  - Retryable failure: `retry-scheduled` with `retryAt`, state `retry-wait`.
  - Tool call: `tool-call` and `tool-result` with `resultChars`.
  - Subscriber: a mention creates a `queued` run.
  - No event `data_json` contains the question text (assert by searching all rows for a unique
    marker word put in the question).
  - Behaviour unchanged: the existing job and service tests stay green.
- [ ] **Step 2:** confirm they fail. **Step 3:** implement. **Step 4:** the three gates.
- [ ] **Step 5:** commit `Task 6: RunRecorder records every step of a run (ADR 0129)`.

---

## Task 7: HTTP: run routes, stage labels, queue position, stalled runs

**Files:**
- Create: `packages/core/src/assistant/run-label.ts` (pure; exported)
- Create: `packages/http/src/routes/assistant-runs.ts` (register it where
  `registerAssistantTraceRoutes` is registered)
- Tests: `run-label.test.ts`, `assistant-runs.test.ts` (copy the harness of
  `assistant-traces.test.ts`)

**Interfaces produced:**

```ts
// run-label.ts
export const RUN_STALLED_MS = 10 * 60 * 1000;
export const describeRun: (run: RunRow, ctx: { now: number; queueAhead: number;
  lastEvent?: RunEvent; chainLength?: number }) => { label: string; stalled: boolean };
```

**Labels:**

| Run state | Label |
|---|---|
| queued, nothing ahead | "Queued" |
| queued, `queueAhead` > 0 | "Queued (N ahead)" |
| starting | "Starting" |
| conversation | "Reading the conversation" |
| context | "Gathering context" |
| calling-model | "Asking <model short name> (model <position+1> of <of>)" |
| running-tool | "Running tool: <tool>" |
| retry-wait | "Retrying at <HH:MM:SS UTC> after <code>" |
| delivering | "Posting the answer" |
| done | "Answered", "Refused" or "Failed" |

- The model short name is the part after the last `/`.
- The calling-model and running-tool labels take their details from `lastEvent` when it is a
  `model-call` or `tool-call`.
- `stalled` is true when the state is active and `now - updatedAt > RUN_STALLED_MS`. The label then
  becomes "Stalled (no progress for N min)".

**Routes.** All need `guard.require` and `audit.read`. Query schemas are Zod.
- `GET /api/assistant/runs?active=1|0&before=&limit=` (limit ≤ 100, default 20) returns
  `{ runs: Array<RunRow & { label, stalled, member }>, nextBefore? }`.
  - Member lookup is one bulk `fetchGuildMembers` call, as on the trace list.
  - `queueAhead` is the count of `queued` runs with an earlier `queuedAt`, from one
    `listRuns({active:true, limit:100})` call per request.
- `GET /api/assistant/runs/:runId` returns `{ run: RunRow & { label, stalled } }`, or 404
  `not-found`.
- `GET /api/assistant/runs/:runId/events?after=<seq>&limit=` (limit ≤ 500, default 200) returns
  `{ events: RunEventRow[] }`. A `model-result` event's `providerMessage` is removed unless
  `config.read` (the same `canReadPromptText` check as the trace route; reuse it, exporting it if
  needed).

- [ ] **Step 1: Write failing tests**
  - Label for each stage. A stalled running run older than 10 minutes gets `stalled:true`
    **(Review Focus 4)**.
  - `active=1` lists only active runs, and a finished run drops out.
  - `?after=2` returns seqs > 2.
  - `providerMessage` is stripped without `config.read`.
  - 403 without `audit.read`.
  - A run from another guild returns 404.
- [ ] **Step 2:** confirm they fail. **Step 3:** implement. **Step 4:** the three gates.
- [ ] **Step 5:** commit `Task 7: run routes with live labels (ADR 0129)`.

---

## Task 8: Dashboard: live panels and the step log

**Files:**
- Create: `packages/dashboard/src/hooks/useLiveResource.ts` (+ `useLiveResource.test.tsx`)
- Create: `packages/dashboard/src/api/runs.ts`
- Create: `packages/dashboard/src/pages/assistant-live.tsx` (`InProgressPanel`, `StepLog`
  components; tests in `assistant-live.test.tsx`)
- Modify: `assistant-history.tsx` (panel on top; reload the table when a run finishes)
- Modify: `assistant-conversations.tsx` (panel on top)
- Modify: `assistant-conversation.tsx` (pending bot turn for the conversation's active run)
- Modify: `assistant-history-detail.tsx` (a "Step log" card fed by `runId`, live while active)

**Interfaces produced:**

```ts
export interface UseLiveResource<T> extends UseResource<T> {
  /** True when the last poll failed; the last good data stays in `resource`. */
  readonly stale: boolean;
}
export function useLiveResource<T>(
  request: string,
  load: () => Promise<T>,
  opts: { fastMs: number; slowMs: number; isFast: (data: T) => boolean },
): UseLiveResource<T>;
```

**Hook behaviour:**
- The first load uses the `loading` state, like `useResource`.
- After that, polls replace the data **without** returning to `loading`.
- A failed poll keeps the data and sets `stale: true` **(Review Focus 3)**. The next successful
  poll clears it.
- The poll interval is `fastMs` (2000) when `isFast(data)`, else `slowMs` (15000).
- Polling pauses while `document.visibilityState === 'hidden'` and polls once immediately on
  becoming visible.
- Timers are cleared on unmount.

**Components:**
- **`InProgressPanel`** (polls `GET /api/assistant/runs?active=1`).
  - Rendered as a `Card` titled "In progress".
  - It shows nothing but a one-line "Nothing running" when the list is empty.
  - Each row shows the member (`MemberRef`), channel, label, a ticking stopwatch since `startedAt`
    (or `queuedAt`; a 1 s local `setInterval` re-render, no extra fetch), the attempt as
    "attempt N" when N > 1, and a link to the conversation when `conversationId` is set.
  - Stalled rows get a warning `Badge` "Stalled".
  - When the stale flag is set, it shows "Reconnecting…".
  - The `onFinished()` callback fires when a run id that was active disappears, so History reloads
    its table.
- **Transcript pending turn.** It polls `GET /api/assistant/runs?active=1` (fast while any run
  matches this `conversationId`). For a matching run it renders a placeholder bot turn: the label
  and the stopwatch. When the run leaves the active list, it reloads the transcript once.
- **`StepLog({ runId })`.**
  - It polls `GET /api/assistant/runs/:runId/events?after=<last seq>`, appending, fast while the
    run is active.
  - It renders one row per event: the offset from the first event (`+1.2 s`), an icon-free kind
    label, and a one-line plain-English description:
    - "Called nemotron-3-ultra… (model 1 of 2)";
    - "Failed: provider-bad-model · HTTP 404 · 291 ms · No endpoints found…";
    - "Tool search_messages ok, 1,240 chars, 85 ms";
    - "Retry at 13:05:10 after provider-connect-timeout".
  - A horizontal bar per `model-result` and `tool-result`, width proportional to `ms`, is
    optional; include it only if it stays under about 40 lines.
- **History detail.** When the trace has `runId`, render `<StepLog runId={trace.runId} />` in a
  "Step log" card under Summary.

- [ ] **Step 1: Write failing tests** (jsdom, fake timers)
  - The hook: polls at the fast rate while `isFast`, then the slow rate. A rejected poll keeps the
    data and sets `stale`. Hidden tab → no polls; visible → an immediate poll.
  - `InProgressPanel` renders the label and "Stalled". It calls `onFinished` when a run disappears.
  - `StepLog` appends only new events when `after` advances, and renders the failure line with the
    code and the HTTP status.
- [ ] **Step 2:** confirm they fail. **Step 3:** implement. **Step 4:** the three gates.
- [ ] **Step 5:** commit `Task 8: live In-progress panels and step log (ADR 0129)`.

---

## Task 9: Model health, persistent-failure detection, doctor warning, per-call cost

**Files:**
- Create: `packages/core/src/assistant/model-health.ts` (pure)
- Modify: `packages/storage/src/repos/runs.ts` (`modelResultsSince`)
- Create: `packages/http/src/routes/assistant-model-health.ts`
- Modify: `packages/http/src/routes/assistant-traces.ts` (`/api/assistant/usage` gains
  `failuresByCode` and `tokensByModel` per day, computed from run events; keep the existing fields)
- Modify: `apps/daemon/src/runtime/doctor.ts` (an "AI model health" section: one warning line per
  persistent failure, per allowlisted guild, read through storage the way `listBackups` is read)
- Modify: `packages/core/src/providers/openai-compatible.ts`
  - when `this.id === 'openrouter'`, the request body adds `usage: { include: true }`;
  - the response maps `usage.cost` to `GenerateTextResponse.usage.costUsd` (add the optional field
    to `ProviderUsage`).
- Modify: `apps/daemon/src/assistant/tool-loop.ts`: the `ok` attempt and the `model-result` event
  carry `costUsd` when present; the loop sums it into the trace usage as `usage.costUsd` (add the
  optional field to the trace `usage` schema).
- Tests beside each file

**Interfaces produced:**

```ts
// model-health.ts
export const PERSISTENT_CODES = ['provider-bad-model','provider-auth','provider-credits'] as const;
export interface ModelResult { readonly at: number; readonly model: string; readonly keyId: string;
  readonly ok: boolean; readonly ms: number; readonly code?: string; readonly providerMessage?: string;
  readonly tokens?: number; readonly costUsd?: number }
export interface ModelHealth { readonly model: string; readonly keyId: string;
  readonly calls: number; readonly ok: number; readonly successRate: number | null;
  readonly p50Ms: number | null; readonly p95Ms: number | null; readonly tokens: number; readonly costUsd: number;
  readonly failuresByCode: Readonly<Record<string, number>>;
  readonly lastError?: { at: number; code: string; providerMessage?: string };
  readonly lastOkAt?: number;
  /** Last 3 results all failed with one of PERSISTENT_CODES. */
  readonly persistent?: { code: string; since: number; count: number };
}
export const modelHealth: (results: readonly ModelResult[]) => ModelHealth[];
  // grouped by (keyId, model), results sorted by `at`
// runs.ts
export const modelResultsSince: (scope, since: number) => ModelResult[];  // from model-result events
```

`persistent.count` is the length of the trailing run of failures with a persistent code. `since`
is the first of that run.

**Route.** `GET /api/assistant/model-health?window=24h|7d` (`audit.read`) returns
`{ window, models: ModelHealth[] }`. Each model is matched to its chain entry label where the chain
knows the key: add `keyLabel`, and `inChain: boolean`. `providerMessage` is stripped without
`config.read`.

**Doctor.** For each persistent model, print:

`WARN AI model <model> (key <label>) failed <count> times in a row with <code> since <ISO>; remove or replace it in Providers → Model order.`

A persistent model makes `report.ok` false, the same way other warnings do. Check how the existing
warnings affect `ok` and match it.

- [ ] **Step 1: Write failing tests**
  - `modelHealth`: success rate, p50 and p95 on known inputs. 3 trailing `provider-bad-model`
    results → `persistent`. 2 bad-model then 1 ok → none. 3 `provider-connect-timeout` → none.
  - The route strips `providerMessage` without `config.read`.
  - The OpenRouter request body contains `"usage":{"include":true}`; NVIDIA NIM's does not.
    `usage.cost: 0.0012` maps to `costUsd`.
  - Doctor prints the warning line for a seeded run-event history.
- [ ] **Step 2:** confirm they fail. **Step 3:** implement. **Step 4:** the three gates.
- [ ] **Step 5:** commit `Task 9: model health, persistent-failure warning, per-call cost (ADR 0129)`.

---

## Task 10: Dashboard: health on Providers and History, banner, usage by code and model, cost

**Files:**
- Create: `packages/dashboard/src/api/model-health.ts`
- Create: `packages/dashboard/src/ui/ModelHealthBanner.tsx` (+ test). It is rendered in the app
  shell for sessions with `audit.read`: find the shell with `rg -n "PageHeader|<main" packages/dashboard/src/app`.
  It polls `model-health?window=24h` every 60 s with `useLiveResource`
  (`fastMs = slowMs = 60000`).
- Modify: `packages/dashboard/src/pages/providers.tsx` (Model order table: Success (24h), p50/p95,
  Last error, Cost (24h) columns; a "Persistent failure" danger badge in the row)
- Modify: `assistant-history.tsx`
  - adds a "Model health (24h)" card: one line per model with calls, success %, p95 and last error;
  - the usage strip tooltip or legend shows failures by code and tokens by model for the day.
- Modify: `assistant-history-detail.tsx` (show `usage.costUsd` and per-attempt `costUsd` when
  present, formatted `$0.0012`)

**Banner.** For each persistent model, a danger banner reads:

"**<model>** has failed <count> times in a row since <local time> — <PROVIDER_FAILURE_TEXT title>.
[Open Model order](/assistant/providers)"

It links to the providers route path; find it in `packages/dashboard/src/app/routes.ts`.

- [ ] **Step 1: Write failing tests**
  - The banner renders for a persistent model, and renders nothing otherwise.
  - Providers rows show the success rate and the badge.
  - Detail shows the cost.
- [ ] **Step 2:** confirm they fail. **Step 3:** implement. **Step 4:** the three gates.
- [ ] **Step 5:** commit `Task 10: model health on Providers and History, persistent-failure banner, cost (ADR 0129)`.

---

## Self-review notes (controller)

**docs/27 coverage**

| docs/27 section | Tasks |
|---|---|
| §4.3 no silent failures | Tasks 1–4 |
| §4.2 run ledger | Tasks 5–6 |
| §4.4 live dashboard | Tasks 7–8 |
| §4.5 model health | Tasks 9–10 |
| D1 provider message | Tasks 1–4, 7, 9 |
| D2 retention | Task 5 |
| D3 alerts | Task 3 (log channel), Task 9 (doctor), Task 10 (banner) |
| D4 cost | Tasks 9–10 |

**Gaps closed**

| Gap | Task |
|---|---|
| G1, G2, G4 | Task 3 |
| G3 | Tasks 3–4 |
| G5 | Task 2 |
| G6 | Tasks 1–2 |
| G7 | Tasks 1, 2, 4 |
| G8 | Tasks 5–8 |
| G9 | Task 8 |
| G10 | Tasks 2–3 |
| G11 | Task 3 |
| G12 | Task 6 (`queueWaitMs`), Task 7 (queue position) |

**Type names checked across tasks:** `RunRow`, `RunEvent`, `RunEventRow`, `RunRecorder`,
`runRepo.updateRun`, `ModelResult` and `ModelHealth`.

**Order:** each slice depends only on earlier ones. Tasks 1→2→3→4 are sequential (shared types).
Task 5 depends on Task 1 (attempt fields mirrored in events). Task 6 needs Tasks 2, 3 and 5. Task 7
needs Task 5. Task 8 needs Task 7. Task 9 needs Task 6. Task 10 needs Task 9.
