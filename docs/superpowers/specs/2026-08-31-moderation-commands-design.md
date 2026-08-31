# Moderation commands, warnings, bounded purge, and confirmations — design

Status: approved by Bryan, 2026-08-31, ready for an implementation plan.
Decision record: `docs/decisions/0037-moderation-commands-warnings-purge-and-confirmations.md`.
Roadmap scope: `docs/08_ROADMAP.md` Release 2 (moderation-commands slice only).
Amends in practice: ADR 0036's case-event vocabulary (additively).

## 1. Problem and scope

The automod slice gave Bananasaurs a rule engine, per-member cases, an
escalation ladder, and a `ModerationActionGateway` that can timeout and kick.
A moderator still cannot moderate: no ban, no unban, no purge, no warning
that feeds the ladder, no case notes or evidence, no history search. This
slice adds the human half of Release 2 moderation and nothing else.

In scope: `/mod timeout` (clamped to 28 days), `untimeout`, `kick`, `ban`,
`unban`, `warn`, bounded `purge` as a durable background job, `note`,
`evidence`, permission-scoped `history`; second-confirmation taps for `ban`
and `purge`; mod warnings feeding the same escalation counter automod
strikes feed; purged messages appearing truthfully in the ADR 0023
deletion-attribution record; doctor checks for the new permissions.

Out of scope: additional automod predicate kinds, counters, false-positive
review tooling, cutover tracking, protected users/roles configuration beyond
ADR 0015 and the existing hierarchy checks, reconciliation of actions taken
directly in Discord, per-action capability grants beyond `moderation.act`,
reason templates, anything Release 3+. No AI anywhere in the path
(CLAUDE.md rule 1); no new runtime dependency.

## 2. Data model

All tables guild-scoped (CLAUDE.md rule 2); every repository function takes
`GuildScope` first and uses `scope.only`.

```
mod_case_events (existing — widened, not redesigned)
  + actor_id        TEXT NULL, snowflake-checked when present; null for
                    automod/system events, the moderator's id for manual ones
  action_taken      CHECK widened by six values:
                      'warned', 'note', 'evidence_added',
                      'purged', 'purge_refused', 'purge_failed'
  escalation_action CHECK widened to ('timeout','kick','ban','unban')

mod_pending_actions (new)
  guild_id, intent_id          (pk)
  payload                      JSON — Zod-validated on read; one of
                               ban-intent | unban-intent | purge-intent
  created_by                   snowflake — only this principal may confirm
  created_at, expires_at       expires_at = created_at + 15 min, the
                               interaction-token window (ADR 0018)
```

Migration `0007` via `npm run db:generate`. Existing rows keep their
meaning; nothing is rewritten.

Sentinels for manual events: `rule_id = 'manual'` (no FK exists to
`mod_rules`); `matched_category` is `'manual'` for warnings/notes and
`'evidence'` for evidence links; `matched_snippet` carries the reason, note
text, or URL (full text, matching the existing column contract).

## 3. DiscordPort surface

Four new methods on the one existing port (ADR 0037):

```typescript
banMember(guildId, userId, reason): Promise<void>
unbanMember(guildId, userId, reason): Promise<void>
bulkDeleteMessages(guildId, channelId, messageIds, reason): Promise<void>
fetchRecentMessages(guildId, channelId, { before?, limit }):
  Promise<{ messages: {messageId, authorId, createdAtMs, content?}[], nextBefore?: Snowflake }>
```

REST routes: `PUT /guilds/{g}/bans/{u}` (no `delete_message_*` parameter —
message removal is purge's explicit job), `DELETE /guilds/{g}/bans/{u}`,
`POST /channels/{c}/messages/bulk-delete` (2..100 ids, all < 14 days, else
Discord rejects the whole call), `GET /channels/{c}/messages?before=&limit=`.
FakeDiscord gains the four verbs: ban/unban toggle a `bans` set (with
`memberBanAdd`/`memberBanRemove` audit entries after `AUDIT_LOG_LAG_MS`),
bulk-delete validates the 14-day ceiling and 100-id cap and marks messages
deleted, fetch-recent walks stored messages newest-first.

## 4. ModerationActionGateway: the new actions

`ModerationIntent.action` becomes
`'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban'`.
The layer ordering is unchanged (auth → kill switch → breaker → hierarchy →
idempotency claim → dry run → execute). Differences per action:

- `ban`: the full hierarchy path applies — owner refused
  (`discord-owner`), member at/above the bot refused (`role-above-bot`),
  exactly like kick.
- `unban`, `untimeout`: no member fetch, no hierarchy — the target is not
  an ordinary member (banned, or Discord refuses the member fetch); the
  layers that survive are auth, kill switch, breaker, idempotency, dry run.
  A ban that does not exist still executes — Discord treats deleting a
  non-existent ban as success, and the outcome is honest either way.
- `timeout`: unchanged, clamped by the boundary validator to 28 days
  (`MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000`, clamped in the boundary
  validator, never silently rounded mid-gateway).

The dedupe key is supplied by the caller as today; for `/mod` commands it is
minted at preview time and bound to the confirmed intent (§7).

## 5. Warnings feed the ladder

`/mod warn` is not a new subsystem; it is the existing calls in sequence:

1. `authorize('moderation.act')` for the invoking moderator (role ids via
   `fetchMember` — same as every member-actor capability check);
2. `openOrResolveCase(memberId, { countsAsViolation: true })` — the same
   counter, the same open-case index, the same semantics as an automod
   strike (ADR 0036 decision 3);
3. `recordCaseEvent` with `action_taken = 'warned'`, `actor_id` set,
   `rule_id = 'manual'`;
4. `nextEscalationTier(violationCount)`; if a tier is crossed, attempt it
   through `ModerationActionGateway` with dedupe key
   `mod:<guildId>:warn-escalation:<caseId>:<count>`, and record the outcome
   as its own case event (the same five-value outcome mapping).

So yes: a moderator's third warning triggers the same automatic timeout an
automod strike would. Violation expiry does not exist for automod counts and
is not invented for manual ones (ADR 0037); the tests pin the equality.

## 6. Bounded purge as a durable background job

`JOB_KINDS.modPurge = 'mod_purge'`; payload schema
`{ intentId: uuid, channelId, initiatorUserId, reason }` in
`packages/core/src/jobs/kinds.ts`, Zod-validated on read. Cursor
`{ phase: 'fresh' | 'old', lastMessageId }` in `jobs.cursor` via the
worker's `saveCursor`.

Flow:

1. `/mod purge` (confirm flow, §7) counts and ages the channel's recent
   messages via `fetchRecentMessages` pagination; the ephemeral preview
   shows counts and age distribution; a count over `PURGE_MAX_MESSAGES`
   (500, constant in `packages/core/src/mod/purge.ts`) is refused with
   "narrow the scope".
2. Confirm enqueues one job, dedupe key `mod:<guildId>:purge:<intentId>` —
   the jobs table's partial unique index makes a double-tap enqueue
   nothing.
3. Worker tick (per attempt): check the guild safety state
   (`readSafetyState`) — killswitch/breaker/dry-run/unknown means the job
   records `purge_refused` (reason in `refusal_reason`) and completes
   without deleting. Budget check (`checkPurgeBudget`,
   `packages/core/src/effects/budget.ts`). `phase: 'fresh'`: page up to 100
   un-deleted messages < 14 days via the cursor, call
   `bulkDeleteMessages`, save cursor; `phase: 'old'`: delete one at a time
   via `deleteMessage`, requeue with `runAfter = now +
   PURGE_TICK_SPACING_MS` (2_500 — the single-message-delete cadence under
   rate limits) until done.
4. For every message deleted, the job writes the honest `audit_events` row
   (actor = the confirming moderator, `inferred = 0`) and enqueues the
   normal delayed `log_message_delete` job — the ordinary ADR 0023 path
   attributes and posts it; `findMessageDeleteAttribution` finds the true
   actor. The `event_dedupe` claim on the messageId keeps this idempotent
   even if Discord also dispatches a `MESSAGE_DELETE` event for the same
   message.
5. On completion the job records one `purged` case event on the case
   (`matched_category = 'purge'`, snippet summarising counts and the
   initiator), `actor_id` = the moderator.

Discord API failure mid-job: the tick throws; the worker's existing
retry/backoff (attempts counted at claim) re-runs from the saved cursor.
A permanent failure exhausts attempts and is recorded as `purge_failed` on
the case by the handler (best-effort — the job row's `last_error` is the
durable truth).

## 7. Confirmation taps

`/mod ban` and `/mod purge` do not execute on invocation:

1. Handler authorizes the invoker, fetches the target member (ban) or the
   channel page (purge), builds the preview.
2. Mints `intentId = randomUUID()` and the dedupe key; writes a
   `mod_pending_actions` row (payload Zod-shaped, `created_by` = invoker,
   `expires_at` = now + 15 min); expired rows are ignored (and lazily
   skipped by the same query that reads them).
3. Defers ephemeral, then `respondToInteraction` with the preview text and
   two buttons: custom ids `modconfirm:<intentId>` / `modcancel:<intentId>`
   (custom ids carry only the intent id — they are attacker-controlled
   input).
4. The component arrives as an `InteractionEvent`; the mod interaction
   handler re-authorizes the *clicker*, requires
   `clicker === created_by`, reads the pending intent (expired → "expired,
   run the command again"), then:
   - cancel: deletes the pending row, answers "cancelled";
   - confirm: deletes the pending row first (one confirmation, ever),
     then executes — member actions through `ModerationActionGateway` with
     the intent's dedupe key; purge through one `mod_purge` job enqueue.
     A replayed dispatch or a second tap finds the row gone (or the claim
     taken) and answers "already executed" — duplicate execution is
     impossible, per the acceptance gate.

Preview → daemon restart → confirm: the pending row survives; the
interaction token does not, so the confirm reports expired. Accepted
(ADR 0037).

## 8. `/mod` surface

One command, subcommands; all responses ephemeral; every invocation and
confirmation re-checks `moderation.act` (`authorize()` with the caller's
member record; unauthorized callers get an ephemeral refusal — and nothing
else happens).

| subcommand | arguments | behaviour |
| --- | --- | --- |
| `timeout` | user, duration, reason | clamp to 28 days; gateway; case event |
| `untimeout` | user, reason | gateway, no hierarchy |
| `kick` | user, reason | gateway; hierarchy applies |
| `ban` | user, reason | preview + confirm (§7); gateway |
| `unban` | user, reason | gateway, no hierarchy |
| `warn` | user, reason | §5 |
| `purge` | channel, reason | preview + confirm (§7) |
| `note` | user, text | case event `note` |
| `evidence` | user, url | case event `evidence_added` |
| `history` | user | permission-scoped case-history read (§9) |

Every member-action case event carries `actor_id` = the moderator, the
reason in `matched_snippet`, and the outcome value from the same
`ModerationOutcome` → vocabulary mapping automod uses. Registration per
ADR 0032 with a moderator `default_member_permissions` first filter.

## 9. Permission-scoped case history

`/mod history user` requires `moderation.act`; the response lists the
member's cases (open first) and their events — each with `at`,
`rule_id`/`manual`, `action_taken`, `escalation_action`, `refusal_reason`,
`actor_id`, and the snippet. A new guild-scoped repo read
(`listCasesForMember`) joins the case to its events. The
"permission-scoped" requirement is satisfied by the capability gate itself:
no `moderation.act`, no history — not a redacted view (ADR 0037).

## 10. Doctor

`RELEASE_1_PERMISSIONS` gains `BanMembers | ManageMessages` as a Release 2
requirement (a constant of its own, unioned in): missing either is a
finding; `Administrator` stays forbidden. Doctor tests updated.

## 11. Testing plan

- Port tests (`packages/discord/src/rest/port.test.ts`): the four new verbs,
  error mapping, the 14-day/100-id ceilings enforced by the fake.
- Gateway tests (extend `moderation-gateway.test.ts`): ban owner refused,
  ban above-bot refused, unban/untimeout skip hierarchy, dry run records
  without calling, idempotency claim → `skipped` on replay — for each new
  action.
- Repo tests (`mod-cases.test.ts`): mixed-source counting equality (automod
  strike + manual warn interleavings produce identical counts), expiry
  equality, new vocabulary values accepted by the CHECK, `actor_id`
  round-trip.
- Pending-action repo tests: guild scoping, expiry, claim-once semantics.
- Purge job tests: 14-day ceiling honoured, one-at-a-time for older,
  budget refusal, honest-attribution audit rows + enqueued
  `log_message_delete`, cursor resume across a simulated restart, safety
  state refused → `purge_refused`.
- `apps/daemon/src/mod.integration.test.ts` (FakeDiscord, end to end):
  confirm-then-execute for ban and purge; double-tap on Confirm executes
  once; owner-target, hierarchy, and unauthorized-caller refusals recorded
  as case events; a warn visibly advancing the same ladder (warn → count 3
  → automatic timeout, deduped on replay); purged messages present in the
  deletion record with the moderator as actor; all with no AI configured.
- Doctor tests: missing Ban Members / Manage Messages flagged.
