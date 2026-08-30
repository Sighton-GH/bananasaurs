# WP4 boundary report — the logging module

Branch `wp4-logging` (worktree branch `worktree-wp4-logging`), six commits from `a6eb1d2`:

| Commit | Slice |
|---|---|
| `5e97a48` | ADR 0023 — scope, correlation algorithm, idempotency design, gap markers — written before any implementation |
| `2c3b823` | 12a — read-side plumbing: `log_routes`/`log_excluded_channels` repo, `pipelineRepo.forgetFirstSight`, `RoleEvent.name` |
| `0a8cdd4` | 12b — the plain log subscriber: message edits, member joins/leaves, role create/update/delete |
| `b90694e` | 12c — inferred message-delete attribution (the hard part) |
| `26586fa` | 12d — gap markers on a non-resumed reconnect |
| `c9c3ca8` | 12e — wired into the composition root |

**Nothing is pushed.** Nothing connected to Discord.

---

## 1. What was built

**ADR 0023** settles four things before any code: scope is message/member/role logging only — `REVIEW.md`'s Release 1 list ("Message, member, and role logging") wins over `docs/20`'s broader "role and channel changes" summary, per `CLAUDE.md`'s rule that `REVIEW.md` wins on contradiction, and the codebase already agreed (no `ChannelEvent`, no channel verb in `FakeDiscord`). No kick/ban attribution either — that is `REVIEW.md` Release 2's "mod log," and `FakeDiscord` was extended for `deleteMessageAs` specifically and nothing analogous for a kick or a ban, which is itself evidence of where the line was meant to fall. The ADR also fixes the message-delete correlation algorithm, the log-post idempotency design (a deliberate inversion of the role-effects "claim before REST, never release" pattern), and the gap-marker design, all before slices 12b–12d implemented them.

**12a — read-side plumbing.** `packages/storage/src/repos/logging.ts`: `findRoute` and `isChannelExcluded`, read-only — neither `log_routes` nor `log_excluded_channels` has a writer yet; nothing in Release 1 configures them except a future operator CLI. `pipelineRepo.forgetFirstSight` — the release half of the existing `recordFirstSight` claim. `RoleEvent` gains `name: string`, free from discord.js's own listener argument, needed so role logging can say "Role deleted: **old-name**" instead of a bare, unrecoverable id.

**12b — the plain log subscriber.** `createLoggingSubscriber` handles `messageUpdate`, `memberAdd`, `memberRemove`, `roleCreate`, `roleUpdate`, `roleDelete`: route lookup, source-channel exclusion for message events, a namespaced claim/release pair around the send (namespaced so it cannot collide with the pipeline's own gate-2 dedupe row for the bare gateway kind), and a locally-computed content-based fingerprint for `roleUpdate`, which has no pipeline-level one.

**12c — inferred message-delete attribution.** The hard part `docs/19` and ADR 0019 both flagged. `messageDelete` enqueues a delayed job (`log_message_delete`, 3 seconds — past the fake's 2-second audit-log lag) instead of formatting and sending inline, because ADR 0019 fact 3 says a synchronous fetch finds nothing. `correlateDeletion` (pure, unit-tested) decides an actor from a durable "already claimed" cursor (`message_delete_runs`, new table) compared against the audit log's live count — the only way to answer "did a new deletion join this run" when the port reports a running total, never a delta. Exactly one active candidate wins; zero or two-or-more both mean unknown, never a guess. A single claim guards both resolution and the send; a retry after a failed send reads back the already-recorded audit row (`findExistingAttribution`) instead of re-resolving, which would see its own prior cursor increment and wrongly downgrade a correct attribution to "unknown" — proven by deliberately breaking it (mutation 96).

**12d — gap markers.** On a non-resumed `connection` event, the logging subscriber posts one marker per distinct enabled `log_routes` channel, using Discord's own `<t:unix:t>` timestamp markup so it renders in each reader's local time. One detail of ADR 0023 decision 5 was corrected during implementation, in the ADR text itself: the idempotency key is `(disconnectedAtMs, channelId)`, not `(gapId, channelId)` — `gapId` is minted by a *different* subscriber (`connection-subscriber.ts`), and subscribers share no state.

**12e — wiring.** `apps/daemon/src/runtime/guild.ts`: `createLoggingSubscriber` added to `subscribers`, `logMessageDeleteHandler` added to the job worker's handlers, both wired to the real repositories exactly as every other subscriber in that function already is. Proved with two new tests in `daemon.integration.test.ts` — the file that drives the composition root with raw gateway packets through a real discord.js client — written before the wiring existed and failing for exactly the "forgot to register it" reason first, which is the same class of bug WP5-slice-6's own handoff flagged as a finding ("No daemon trigger for X").

---

## 2. Verification evidence

```
$ npm run typecheck
> tsc --build --force && tsc -p tsconfig.all.json
(no output; exit 0)

$ npm run lint
> eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
(exit 0)

$ npm run test
 Test Files  45 passed (45)
      Tests  954 passed (954)
   Duration  ~9.3s
```

Baseline at the start of the package was **853**. The count rose one slice at a time: 853 → 870 (12a) → 895 (12b) → 935 (12c) → 952 (12d) → 954 (12e).

**Mutation checks, 85–107. Every one killed; every one restored by file copy, never `git checkout`.**

| # | What was broken | Result |
|---|---|---|
| 85 | `forgetFirstSight` filtered only on `eventKind`, dropping `fingerprint` | killed |
| 86–88 | `findRoute`'s `enabled`/`eventKind` filters, `isChannelExcluded` always true | killed |
| 89 | Adapter stopped reading `role.name` on create/update/delete | killed |
| 90–94 | Subscriber: excluded-channel check, `route.enabled` check, claim gate, release-on-failure, `roleUpdate`'s name-based fingerprint | killed |
| 95 | `correlateDeletion` picked the first active candidate instead of refusing when ambiguous | killed |
| 96 | Removed the `findExistingAttribution` idempotency guard, forcing re-resolution on retry | killed — reproduced the exact bug the guard exists to prevent |
| 97 | Removed release-on-failure in `attributeAndLogDeletion` | killed |
| 98 | Made `incrementClaimedCount` a no-op | **survived against the original test suite** — see §5 |
| 99–101 | messageDelete's excluded-channel/`enabled` checks, dropped `(inferred)` from the formatted line | killed |
| 102–105 | Gap markers: `resumed` early return, per-channel claim, per-channel try/catch, `channelId` dropped from the claim fingerprint | killed |
| 106–107 | Composition root: `createLoggingSubscriber` removed from `subscribers`, `logMessageDeleteHandler` removed from the worker | killed |

**Mutation 98 surviving is the most useful row in this table**, for the same reason mutation 50 was in WP5 slice 6: it exposed that the original test suite did not actually exercise the cursor's role, because both existing tests only ever involved one actor — with or without the cursor working, a lone actor's second deletion still resolves correctly, since there is never a competing candidate to disambiguate against. A new test (`does not let a fully-claimed run keep attributing a later, unrelated self-deletion`) reproduces the actual failure mode: two real deletions correctly attributed and claimed, then a same-author, same-channel self-deletion, which a broken cursor would wrongly attribute to the moderator who deleted the first two. Confirmed green against correct code, then confirmed mutation 98 fails it, before moving on.

---

## 3. The four questions, with evidence

### Does every new query take a guild ID, structurally rather than by convention?

Yes.

- `packages/storage/src/repos/logging.ts:24,47,58,82,98,137` — every one of the six new functions (`findRoute`, `listEnabledLogChannels`, `isChannelExcluded`, `claimedCountFor`, `incrementClaimedCount`, `findMessageDeleteAttribution`) takes `scope: GuildScope` as its first parameter and calls `scope.only(...)` for its `WHERE` clause; there is no route to a row that skips it.
- `packages/storage/src/schema.ts:579-596` — `message_delete_runs`' primary key is `(guild_id, actor_user_id, author_id, channel_id)` and its foreign key cascades from `guilds.guild_id`. A row cannot exist without a guild, and the composite key makes the same (actor, author, channel) triple in two different guilds two different rows structurally, not by caller discipline.
- `packages/core/src/logging/subscriber.ts` and `attribute-deletion.ts` — every port function (`findRoute`, `claim`, `release`, `sendMessage`, `claimedCountFor`, `incrementClaimedCount`, `findExistingAttribution`, `recordAudit`) is a closure over one `scope` in `apps/daemon/src/runtime/guild.ts:215-260`, bound once per guild at `buildGuildRuntime` call time — there is no parameter through which a caller could pass a different guild's id even if it tried.

### Does every new Discord side effect have a durable idempotency key and a unique constraint making double execution impossible?

Yes, by two different mechanisms depending on whether the effect can be retried safely.

- **The six plain log events + gap markers**: `packages/core/src/logging/subscriber.ts:158-159,94` — `ports.claim({eventKind, fingerprint})` before every `sendMessage`, backed by `pipelineRepo.recordFirstSight`'s `INSERT OR IGNORE` on `event_dedupe`'s primary key `(guild_id, event_kind, fingerprint)`. Namespaced (`log:<kind>`) so it cannot collide with the pipeline's own gate-2 row for the bare gateway kind.
- **Message deletion**: `packages/core/src/logging/attribute-deletion.ts:63` — the same claim mechanism, keyed on `messageId` (a message is deleted at most once). The job itself also carries `jobs_dedupe`'s unique index (`packages/storage/src/schema.ts:457`, keyed via `logMessageDeleteDedupeKey` at `packages/core/src/jobs/kinds.ts:85`), so the *enqueue* is idempotent independently of the claim that guards the *send*.
- **The deliberate deviation, stated plainly**: unlike `role_effects` (claim before the REST call, never released — "a crash records the effect as attempted and a replay skips it"), every claim in this module is *released on failure* (`subscriber.ts:100,185`; `attribute-deletion.ts:80`). ADR 0023 decision 4 records why: the logging module has no reconciliation to fall back on, so a permanent claim on a transient failure would mean silent, permanent loss — worse than the visible-gap-marker problem this same package exists to solve. This is a considered choice, not an oversight, and it is why mutation 97 (removing the release) was tested as its own case rather than assumed identical to the panel-effects pattern.

### Does any untrusted input reach an execution path without a Zod validator?

- **The job payload**: `packages/core/src/jobs/kinds.ts:75-83` — `logMessageDeletePayload` (channel/message/author ids through `snowflakeIdSchema`, so a malformed id cannot reach the correlation algorithm at all). Validated on every read, not just enqueue, by the existing generic mechanism at `packages/core/src/jobs/worker.ts:139` (`handler.payload.parse(JSON.parse(job.payload))`) — unchanged by this package, reused as-is.
- **Audit log entries from Discord** are not Zod-validated, and that is a continuation of the position WP5 slice 6 already took and stated plainly for gateway payloads generally: `AuditLogEntry` has already been parsed by discord.js/the REST adapter into a typed structure, and every id inside it that this module actually branches on (`targetId`, `actorUserId`, `channelId`) is compared for equality against an already-validated snowflake, never used to construct a query string or reach a mutating call directly. If that reasoning is wrong, WP5 slice 6's report is the place it was first argued, and this package did not re-litigate it.
- No AI provider is involved anywhere in WP4, so rule 3's "model output is untrusted input" has nothing to bite on here, same as WP5 slice 6.

### Would each new test fail if the implementation were broken?

Twenty-three mutations across the package, twenty-two killed on first attempt, one survived and was turned into the reason a new test exists (§2, mutation 98). That is the second time in two work packages a survived mutation has been the most informative single result (WP5 slice 6's mutation 50 was the first) — recorded here because a pattern worth naming is a `docs/20`-style honest signal, not a coincidence: mutation testing that never finds anything is decoration, and mutation testing that occasionally does is doing its job.

---

## 4. Decisions I made that were not specified

**Scope stops at message/member/role, contradicting `docs/20`'s own summary line.** `docs/20`'s WP4 bullet says "role and channel changes"; `REVIEW.md`'s Release 1 list says "Message, member, and role logging" with no channel mention anywhere. `CLAUDE.md` names `REVIEW.md` as the tiebreaker, and the codebase's own shape (`DomainEvent` has no channel variant) agreed before I had to decide anything. Recorded in ADR 0023 decision 1 rather than assumed silently, because a scope narrower than a package's own summary line is exactly the kind of thing a fresh reader would otherwise flag as a gap.

**No kick/ban attribution, even though the port's `AuditLogEntry.actionType` already lists `member_kick` and `member_ban`.** Those values exist because ADR 0019 needed to describe the audit log's general shape, not because WP4 is meant to consume them. `REVIEW.md` Release 2 owns "kick, ban/unban... mod log" explicitly, and `FakeDiscord` was never given a `kickMemberAs`/`banMemberAs` verb the way it was given `deleteMessageAs` — an absence I read as evidence, not merely convenient.

**The message-delete cursor is a new table, not a reuse of `audit_events`.** Considered folding "how much of this run have I claimed" into a `COUNT(*)` query over `audit_events` filtered by JSON fields inside `before`, to avoid a schema change. Rejected: it would make a correctness-load-bearing query depend on an unenforced shape convention in a column four other features already write JSON into for their own reasons, versus one small table with typed, indexed columns and its own primary key. `message_delete_runs` (`packages/storage/src/schema.ts:579`) is the answer.

**Claim exactly one unit per successful attribution, not the whole visible delta.** ADR 0023 decision 3 explains the reasoning (a burst of N deletions by one actor must let each of N independent jobs see an unclaimed unit regardless of execution order), but the choice to increment by exactly one rather than "catch up to the live count" was mine to make within that constraint, and it is the detail that makes 12c's burst test pass regardless of which job runs first.

**Idempotency claims release on failure here, and do not in `role_effects`.** Covered in §3 Q2. Worth repeating in this section because it is the single most reversible-looking choice in the package that is not actually reversible without reintroducing the silent-loss problem ADR 0023 exists to avoid.

**Gap markers swallow per-channel failures instead of propagating the first one.** Every other failure path in this module rethrows so the job or pipeline sees it. Gap markers are the one exception (`subscriber.ts:99-111`): there is nothing above a connection event to retry a marker, so one bad channel must not cost every other configured channel its warning too.

---

## 5. What I am least confident about

**The operator CLI (WP5 slice 13, next) has no named surface for configuring `log_routes` or `log_excluded_channels`, and the whole module is inert without one.** Every test in this package seeds those tables by inserting into the schema directly, because — as every repo test's own comment says — nothing in Release 1 writes them except a future CLI. Slice 13's stated demonstrable in `docs/19` §7 is `bananasaurs status`, `audit tail`, `panel sync`, `killswitch` — it does not mention a log-route command anywhere. If slice 13 ships without adding one, WP4 is a complete, fully-tested, fully-wired feature that a fresh install cannot ever turn on. This is not a design gap in WP4 — the ADR is explicit that a writer is out of scope here — but it is a real gap in what comes next, and I would rather name it now than have it discovered the way WP5 slice 6's live test discovered its own gaps.

**The message-delete attribution's one named, un-fixed ambiguity (ADR 0023 decision 3) is real and will eventually happen live.** If a member self-deletes one message at nearly the same moment a moderator deletes a *different* message by that same member in the same channel, both jobs see the identical single active candidate and race to claim it — whichever runs first claims it, correctly if it was the moderator's deletion, **wrongly, naming a real moderator for a self-deletion, if it wasn't.** No algorithm can do better with `(actor, target, channel, count)` and no message id, which is exactly what ADR 0019 already said the available key is. It is narrow (both deletions have to land inside the same ~3-second attribution window) but it is not hypothetical, and nothing in this package makes it rarer than the math says it is.

**The 3-second attribution delay is a guess, same as the fake's 2-second lag is a guess.** ADR 0023 says so plainly rather than dressing it up: Discord documents no figure for how long a `MESSAGE_DELETE` audit entry actually takes to become queryable after the dispatch. If the real number is larger under load, this package's single fixed-delay check (no retry, by design — see ADR 0019's "must tolerate no entry yet") will report more deletions as "unknown" than necessary. That is the safe direction to be wrong in, and it is untested against real Discord, because it cannot be — the same caveat WP5 slice 6 recorded for the fake's coalescing window.

**`message_delete_runs` has no sweep job**, unlike `event_dedupe`. Bounded by realistic single-guild usage (one row per unique actor/author/channel triple this guild has ever seen a moderator delete from) rather than by event volume, so I believe this is fine for Release 1 — but I have not measured it, the same honest gap `event_dedupe` had before its own sweep slice existed.

---

## 6. Deferred items

| Item | Why | Where it belongs |
|---|---|---|
| A CLI surface for configuring `log_routes` / `log_excluded_channels` | Out of WP4's stated scope (ADR 0023); genuinely needed before this package does anything on a live guild | WP5 slice 13 — flagged above as possibly missing from its current stated scope |
| Kick/ban attribution for `memberRemove` | `REVIEW.md` Release 2's "mod log"; needs the same audit-log correlation machinery this package built, applied to different action types | Release 2 |
| Channel-change logging | Absent from `REVIEW.md`'s Release 1 list and from the current `DomainEvent`/port shape; would need a port and gateway-subscription widening this package must not do | a future ADR + slice, if the owner wants it |
| A sweep for `message_delete_runs` | Bounded but unmeasured, same caveat `event_dedupe` had before slice 4's sweep | WP6 hardening, or wherever `event_dedupe`'s own sweep lands if it needs a second pass |
| The same-window self-deletion/moderator-deletion race (§5) | No algorithm can resolve it with the available key; documenting it is the fix available now | live smoke test, if it is ever observed, per the same "record what happened" discipline as WP5 slice 6's findings 4–16 |

---

## 7. Handoff prompt for a fresh session

```
Model: Opus, high effort — for the socket/auth/idempotency core (undo,
killswitch, the capability check over the new socket channel). Per
docs/decisions/0022-claude-model-strategy.md, this is Tier A: a new
authorization surface plus idempotent state-mutating commands, not
"follow an established pattern" work. Switch to Sonnet/medium effort once
that plumbing is built and reviewed — e.g. for the third or fourth
similar read-only command (status/doctor output formatting, --json
plumbing). If you'd rather not juggle models mid-session, stay on Opus for
the whole slice; it is a small package and the safety-critical parts
dominate it.

Begin WP5 of the Bananasaurs project — the operator CLI, dashboard, and
/privacy. Slice 6 (the real Discord adapter) already shipped out of order;
this session starts at slice 13, the operator CLI.

START HERE — BRANCH

Call the EnterWorktree tool with the name `wp5-operator-cli` (or similar —
pick a fresh name that does not collide with any existing worktree). Do NOT
work on `wp4-logging`, `worktree-wp3-role-panels`,
`worktree-wp5-live-test-fixes`, `worktree-wp5-live-test-report`, or
`worktree-clarify-doc21` — all stale, already merged into main. Commit on
your new branch only. Never push.

STATE OF THE REPO

`main` (once this branch merges) carries everything through WP4: the
logging module, message/member/role events routed to configured Discord
channels, inferred deletion attribution from the guild audit log labelled
"(inferred)" everywhere it surfaces, and gap markers on a lossy reconnect.
954 tests pass; `npm run typecheck && npm run lint && npm run test` is
green.

SETUP

  npm install && npm run build && npm run db:migrate

Confirm 954 tests before you change anything. If the count differs, stop
and find out why.

READ FIRST, IN THIS ORDER

1. docs/reports/WP4.md (this report) — especially §5's flag that the
   operator CLI has no stated command for configuring `log_routes` /
   `log_excluded_channels`, and WP4 is inert without one. Decide whether
   slice 13 needs to add that command, and if so, size it in before you
   start rather than discovering it at the end.
2. docs/decisions/0013-operator-cli-and-claude-code-access.md — the whole
   reason this CLI's shape is unusual: a Unix socket, not a subprocess, and
   the absolute rule about the `claude` binary.
3. docs/decisions/0023-logging-module-scope-and-deletion-attribution.md —
   for the log-route schema shape (`log_routes`, `log_excluded_channels`)
   the CLI will be writing to, and the honesty conventions (inferred,
   claimed) it must not weaken.
4. docs/19 §6.9 (operator CLI) and §9's "socket bind + O_EXCL PID lockfile"
   single-writer correction — Amendment 1 in that document.
5. docs/21 exercise 5's note that "the CLI that sizes and grants an
   allowance is slice 13" — the adoption-pass allowance grant is part of
   this slice's job, not a follow-up.
6. docs/SESSION_LOG.md, the WP4 entries (5 slices, this session) — for the
   claim/release idempotency convention and the guild-scope-as-closure
   pattern the CLI's own command handlers should match.

WHAT THIS PACKAGE COVERS

Per docs/20: `bananasaurs status`, `doctor`, `audit tail`, `undo`,
`killswitch` all work over the socket; one dashboard page with
owner-provisioned local accounts (ADR 0012) including first-account
bootstrap; `/privacy` rendering `PRIVACY.md` with live settings.

SETTLED — DO NOT RE-LITIGATE

  - The socket, not a subprocess: `bananasaurs:bananasaurs-ops` group,
    mode 0660. The identity a caller claims is an assertion, never
    kernel-verified (amendment 2) — `actor_unix_user_claimed`, not
    `actor_unix_user`.
  - Discord Administrator grants no capability (ADR 0012). Capability comes
    only from a `capability_grants` row.
  - Never spawn the `claude` binary from application code, directly or
    through a queue, even with a human approving each step (ADR 0013). The
    ESLint tripwire enforcing this is absolute; do not add an exception.
  - One process. No new services.

PROTOCOL

  - Write the test first for anything touching permissions, hierarchy,
    idempotency, retention, or guild scope.
  - Run `npm run typecheck && npm run lint && npm run test` and PASTE THE
    REAL OUTPUT. Do not report completion on code you have not run.
  - After each slice, BREAK the implementation deliberately to prove the
    tests catch it. Number the mutations continuing from 108. Restore with
    a FILE COPY, never `git checkout <file>`.
  - Append to docs/SESSION_LOG.md after each slice.
  - Record consequential choices as ADRs in docs/decisions/ BEFORE
    implementing them. The next free number is 0023 — verify against
    docs/decisions/ before assuming.
  - Commit after each slice, on your branch. NEVER `git push`.

SECURITY

You cannot connect to Discord and must not attempt to. Never read, print or
copy `.env`. Never spawn the `claude` binary from application code.

FINISH BY

Stopping at the end of the package and producing the seven-part report
docs/20 specifies, in that order, including the four questions answered
with real file:line evidence.
```
