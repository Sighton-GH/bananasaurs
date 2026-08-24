# WP3 boundary report — role panels

**Branch:** `worktree-wp3-role-panels` · **HEAD:** `e8d239e` · **Base:** `bd430a3`
**Date:** 2026-08-23 · **Nothing pushed.**

Eight commits, slices 7a–11 of `docs/19` §7. 696 tests green; typecheck and lint
exit 0. Two new ADRs: 0016 (job dedupe) and 0017 (provenance names candidates).

---

## 1. What was built

**Slice 7a — a job dedupe key collapses pending work, not history (ADR 0016).**
Not a panel slice. Before writing anything that enqueues a job, I checked that
enqueuing worked twice, and it did not. `jobs_dedupe` was `UNIQUE (guild_id,
dedupe_key)` across every state, and job rows are never deleted, so a dedupe key
was single-use for the life of the database. Measured: first enqueue returns
`{"enqueued":true,"jobId":1}`; after the job completes, the identical enqueue
returns `{"enqueued":false}`. Because `createConnectionSubscriber` always uses
the key `reconcile_guild:gateway-gap`, the consequence was that **the second
gateway gap ever would have enqueued nothing** — the guild would never be
reconciled again, silently, for the life of the deployment. The timer pass could
run once and adoption once per panel. The index is now partial, over
`state IN ('queued','running')`, so it collapses pending work and forgets
history.

**Slice 7b — what a panel is, and where it lives.** `panelDefinitionSchema` (Zod,
with `superRefine` for the cross-field rules) and a guild-scoped panel
repository. The validator refuses the combinations that cannot work rather than
letting them fail at runtime: `single_choice` on an adopted panel is rejected
with a message naming Manage Messages and pointing at button panels (collision 1
in §6.4), an adopted panel must be a reaction panel and must name a message,
reaction options need an emoji and component options need a label, and duplicate
option ids, role ids or emoji are refused. `createPanel` is a single `write()`,
because a panel visible with two of its three options would converge to "revoke
the third".

**Slice 7c — a reaction becomes a role.** `planConvergence`, the pure function at
the centre of the package, and the reaction subscriber that drives it.
Convergence reads the member's **live Discord roles** and diffs against them
(amendment 4). The gate order is status → required role → blocked roles →
direction filter → `max_roles` clamp → diff, and a panel-level refusal returns
no changes at all rather than an empty desired set — the difference between "the
panel is not for you" and "the panel says you should have nothing".

**Slice 8 — the adoption pass, and a fake that was lying.** A panel with existing
reactions needs one grant per reactor, which any sane standing rate cap refuses
(collision 2). The pass computes its **entire** change list first, stores it in
the job cursor, and does nothing unless an owner-sized allowance covers it. This
slice is also where the harness was caught modelling Discord wrongly: the fake's
`fetchReactionUsers` filtered out the bot's own user id, and a WP1 test asserted
it should. Discord does no such thing — `GET /reactions` returns every user who
reacted, bot accounts included. The fake and its test were corrected, and only
then did the mutation that removes our bot-filter actually fail.

**Slice 9a — what a managed panel looks like on Discord.** Component building
(`buildCustomId`, `buildComponents`, `renderPanelMessage`), posting, and editing.
Custom ids are parsed by a Zod schema requiring exactly three parts, so an
appended segment is a refusal rather than a silently ignored suffix. Editing an
adopted panel is refused with a stated reason rather than being attempted and
coming back as Discord's 50013.

**Slice 9b — a click becomes a role, and the member is told the truth.** The
interaction handler defers ephemerally **before** doing any work, because the
acknowledgement deadline is three seconds and a missed acknowledgement discards
the token entirely. The reply is built from what was actually applied, never
from the plan, so a dry run or a gateway refusal produces an honest message
rather than a confident lie. The message is the authority for which panel a
click belongs to: `findPanelByMessage` first, then a check that the custom id's
panel id agrees.

**Slice 10 — every behaviour, including its refusal path.** Almost no new
implementation; this is where the design was checked rather than assumed.
`add_only` makes **no REST call** for an un-react rather than calling and being
refused. `max_roles` on an adopted panel — amendment 6's one expensive path —
has an end-to-end test asserting `fetchReactionUsers` **is** called, the mirror
of slice 7c's test asserting it is **not** called for a plain toggle.
Required and blocked roles are exercised across transitions, not just in one
state: losing the required role stops the panel responding *without stripping*
what it already granted.

**Slice 11 — reconciliation.** Drift repair on the timer and after a gateway gap,
the `reconcile_guild` job, and amendment 5's `GUILD_MEMBER_UPDATE` handler. The
budget is checked against the whole change list before anything happens, and an
over-budget pass applies **none** of it and deliberately leaves the gateway gap
outstanding. Two tests failed on their first run for reasons that were defects
rather than wrong expectations — see §5, and ADR 0017.

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
 Test Files  35 passed (35)
      Tests  696 passed (696)
   Duration  7.06s
```

WP2 finished at 451 tests. WP3 adds 245. New test files:

| File | Tests |
|---|---|
| `packages/core/src/panels/model.test.ts` | 30 |
| `packages/core/src/panels/convergence.test.ts` | 35 |
| `packages/core/src/panels/components.test.ts` | 19 |
| `packages/storage/src/repos/panels.test.ts` | 26 |
| `packages/storage/src/repos/effects.test.ts` | 11 |
| `apps/daemon/src/panels.integration.test.ts` | 18 |
| `apps/daemon/src/adoption.integration.test.ts` | 19 |
| `apps/daemon/src/managed-panels.integration.test.ts` | 18 |
| `apps/daemon/src/behaviours.integration.test.ts` | 18 |
| `apps/daemon/src/reconcile.integration.test.ts` | 30 |
| `packages/testkit/src/panel-publish.integration.test.ts` | 10 |

Plus additions to `jobs.test.ts` (5) and `fake-discord.test.ts` (6).

### Mutation checks

Every slice broke the implementation deliberately and recorded what failed.
Mutations 29–45 are WP3's; each was restored and verified by md5 against a
pre-mutation copy, and the full suite re-run green.

| # | What I broke | Result |
|---|---|---|
| 29 | The pre-fix `jobs_dedupe` index itself | 3 of 5 failed; the 2 asserting the collapse passed throughout — the tests distinguish the property kept from the one fixed |
| 30 | Removed `scope.only(...)` from `findPanel`'s WHERE | 2 failed (cross-guild lookup, same panel id in two guilds) |
| 31 | Disabled the collision-1 refinement | 2 failed, including the owner-facing message |
| 32 | Made `inScope` return true unconditionally | 3 failed, including "leaves a role from another option alone" |
| 33 | Removed the bot-user filter from the reaction subscriber | 1 failed — the bot granting itself a role as it seeds a panel |
| 34 | Replaced live roles with an empty set (amendment 4 undone) | 3 failed |
| 35 | Removed the adoption allowance gate | 5 failed, including the ADR 0016 cycle test |
| 36 | Made `pageReactors` return after the first page | 1 failed — a real panel would adopt only its first 100 reactors |
| 37 | Removed the bot filter from `selectionsByMember` | **passed twice**; see §6 |
| 38 | Loosened custom id parsing to `parts.length < 3` | 1 failed — the crafted-payload test |
| 39 | Removed the 3-second check from the fake's `deferInteraction` | 1 failed |
| 40 | Moved the defer *after* convergence | 2 failed |
| 41 | Built the reply from `plan.grants` not `appliedChanges` | 2 failed — the dry-run and refusal honesty tests |
| 42 | Dropped `held` from the `add_only` union, so it revoked | 3 failed |
| 43 | Disabled the blocked-role gate | 5 failed, across unit and integration suites |
| 44 | Removed the direction predicate from `wasRecentlyApplied` | 3 failed |
| 45 | Dropped the provenance candidates from the visit set | 2 failed, including the slice-11 demonstrable |

**Mutation 37 is the one worth reading.** It passed twice. The first pass was the
fake's fault: `FakeDiscord.fetchReactionUsers` filtered out `BOT_USER_ID`, so
removing our own filter changed nothing because the fake had already done it.
The second pass, after fixing the fake, was the *test's* fault: it asserted only
`memberRoles(BOT_USER_ID) === []`, which passed because the extra change pushed
the count to 13 against an allowance of 12 and the pass therefore refused — the
test was watching the allowance gate and reading it as the filter working. The
third attempt failed correctly, once the test granted a generous allowance and
asserted `memberCount` and `changeCount` directly. A green mutation is
information; twice in a row on the same mutation means the harness is wrong.

**A process note.** Restoring mutation 44 with `git checkout <file>` also
discarded that slice's own edits to the file, which had to be rewritten. Mutation
restore takes a file copy, not a VCS command.

---

## 3. The four questions, with evidence

### Q1 — does every new query take a guild ID, structurally rather than by convention?

Yes, in three layers, none of which is caller discipline.

**Signature.** Every new repository function takes `GuildScope` as its first
parameter and there is no overload without it:
`packages/storage/src/repos/panels.ts:133` (`createPanel`), `:177` (`findPanel`),
`:221` (`listAdoptedPanels`); `packages/storage/src/repos/roles.ts:22`
(`allowlistRole`), `:27` (`isAllowlisted`), `:44` (`findManagedRole`), `:64`
(`setRoleAssignability`); `packages/storage/src/repos/effects.ts:218`
(`wasRecentlyApplied`), `:299` (`listAssignedUsers`).

**Predicate.** Every WHERE goes through `scope.only(table, ...)`, declared at
`packages/storage/src/scope.ts:39` as accepting only a `GuildPartitionedTable` —
a table carrying a `guildId` column. Passing an instance-level table is a
compile error, not an unscoped query. There is no call site in WP3 that builds
a WHERE without it.

**Reach.** `core` cannot hold a database handle at all: the internals live in a
`WeakMap` keyed by the scope (`packages/storage/src/scope.ts:52`), deliberately
not a property, because a property named `db` would be reachable by anything
holding a scope. Panel code in `core` never receives a `GuildScope` either — the
composition root binds one into the port objects at
`apps/daemon/src/panels/wiring.ts:41` (`panelStoreFor`) and `:55`
(`panelEffectsFor`), so `packages/core/src/panels/*` has no way to name another
guild's panels even in principle. The lint rules that enforce this are asserted
to actually fire by `packages/core/src/boundaries.test.ts`.

Guild scope is also a **physical** constraint below all of that: `panel_options`
has a composite foreign key into `panels` on `(guild_id, panel_id)` and into
`managed_roles` on `(guild_id, role_id)`, so a cross-guild row cannot be
inserted even by hand-written SQL.

### Q2 — does every new Discord side effect have a durable idempotency key and a unique constraint making double execution impossible?

Yes. WP3 adds **no new mutation path** — every role change in the package goes
through `EffectGateway.applyRoleEffect`, and the type system is what guarantees
it rather than a convention.

**The key.** `dedupeKeyFor` at `packages/core/src/effects/gateway.ts:158` is a
SHA-256 over `(guildId, panelId, userId, roleId, action, triggerRef)`, joined
with NUL so no component can impersonate a boundary. It is a pure function, not
a port, because a port would let each caller get it wrong differently.

**The constraint.** `uniqueIndex('role_effects_dedupe').on(t.guildId,
t.dedupeKey)` at `packages/storage/src/schema.ts:290`. The claim at
`gateway.ts:288-289` is an insert against that index: a second attempt with the
same key cannot produce a second row, so double execution is impossible at the
database rather than in a check somebody remembers to write.

**Why panel code cannot bypass it.** `PanelDiscordReader`
(`packages/core/src/panels/ports.ts:28`) is deliberately narrower than
`DiscordPort`: `fetchMember`, `fetchMessage`, `createReaction`,
`fetchReactionUsers`. **There is no `addRole` and no `removeRole` on it.**
`DiscordPort` structurally satisfies it, so the daemon hands over the same
object it hands the gateway, but the type panel code sees cannot mutate a role.
The only mutation door is `PanelEffects.apply` (`ports.ts:64`), which is the
gateway with its authorization witness already bound — panel code never holds a
witness and cannot forge one.

**Triggers, per source.** Reactions use a fresh pass id (`newPassId()`), which is
correct rather than sloppy: reaction events are level-triggered and carry no
fingerprint, so a replay must be free rather than deduplicated, and the
gateway's **no-op check runs before the rate cap and before the claim**
(`packages/core/src/effects/gateway.ts:268`, ahead of the claim at `:289`), so a second pass over unchanged state costs no
budget and writes no row. Interactions use `event.interactionId`
(`packages/core/src/panels/interactions.ts`), which is unique per click.
Reconciliation and adoption use one batch id per pass, so an incorrect repair is
one `undo` away.

**Jobs.** The other durable key WP3 touches is `jobs_dedupe`, now partial over
pending states (`packages/storage/src/schema.ts:448`, ADR 0016).

### Q3 — does any untrusted input reach an execution path without a Zod validator?

No. Five boundaries, each with a schema:

1. **Panel configuration** — `panelDefinitionSchema`
   (`packages/core/src/panels/model.ts:136`). The repository takes the Zod
   *output* type, so a `PanelDefinition` cannot be constructed without having
   been parsed.
2. **Component custom ids**, which arrive from the client and are the classic
   crafted-payload surface — `customIdSchema`
   (`packages/core/src/panels/components.ts:40`), parsed non-throwing at `:67`
   and requiring exactly three parts. Mutation 38 loosening this to `< 3` failed
   a test.
3. **Select menu values**, likewise from the client —
   `packages/core/src/panels/interactions.ts:115`, filtered against the panel's
   own options, so a value naming a role the panel does not offer is discarded
   before it can become an intent.
4. **Job payloads**, which may have been written by an older version of this
   process — `handler.payload.parse(JSON.parse(job.payload))` at
   `packages/core/src/jobs/worker.ts:139`, against the schemas in
   `packages/core/src/jobs/kinds.ts`. A malformed payload fails the job; there is
   a test.
5. **The adoption cursor**, which is our own writing but survives a restart —
   `adoptionCursorSchema` (`packages/core/src/panels/adoption.ts:35`).

Two things worth stating because they are easy to get wrong. Discord's own API
responses are treated as evidence, not instruction — a reaction is "a hint that
this message's reaction state may have changed", and the code re-reads state
rather than acting on the payload. And **no AI is anywhere in this package**;
there is no provider call in any WP3 path, so rule 1 is satisfied by absence.

### Q4 — would each new test fail if the implementation were broken?

Seventeen mutations say yes, with one instructive exception. Mutations 29–45 are
tabulated in §2; each names the specific tests that failed. The mutations were
chosen to hit the *controls* rather than the plumbing: guild scope (30), the
amendment 4 live-roles diff (34), the allowance gate (35), the bot filter (33,
37), the option-scope limit (32), the three-second defer (40), reply honesty
(41), the blocked-role gate (43), the self-mutation direction (44), and the
reconciliation candidate list (45).

The exception is mutation 37, which passed twice before failing — documented in
full in §2 and in §6, because "the mutation passed" was twice a true statement
about a broken harness rather than about a redundant control.

What I would not claim: mutation testing samples, it does not prove. I broke
seventeen things and every test that should have failed did. There are certainly
lines in WP3 that no mutation touched.

---

## 4. Amendment tracking

| # | What it requires | Status | Where |
|---|---|---|---|
| **4** | Convergence diffs against **live Discord roles**, never `managed_role_assignments` | **Done, and refined by ADR 0017** | `packages/core/src/panels/convergence.ts` takes `currentRoleIds` and has no access to the table; every caller fills it from `fetchMember`. Pinned by mutation 34 (empty set → 3 failed) and by `reconcile.integration.test.ts` "does not believe its own provenance over Discord". **Refinement:** the table now supplies reconciliation's *candidate list* — who to look at — because a reaction withdrawn during an outage leaves the member in no reaction set at all. Both sides of the diff are still read live. ADR 0017 argues why this is not the failure amendment 4 names: a stale row makes the pass look at the wrong person, which the no-op check absorbs for free; it cannot make the pass do the wrong thing. |
| **5** | `GUILD_MEMBER_UPDATE` handler with a self-mutation filter; "untested against a real loop — test that" | **Done, and the filter needed fixing** | `createMemberUpdateSubscriber` in `packages/core/src/panels/reconcile.ts`. Testing it against a real loop is what found the defect: `wasRecentlyApplied(userId, roleId, sinceMs)` answers for *either* direction, so our own grant of a role made a **removal** of that same role inside the window look like ours too — a moderator undoing the bot five seconds later was silently ignored until the timer pass. The lookup now takes the direction (`packages/storage/src/repos/effects.ts:218`) and the handler carries it per role in the delta. Same index, one more predicate. The loop stays suppressed for the same reason as before. Mutation 44 removes the predicate → 3 failed. **The fake was extended to model the echo**: Discord fires the event for our own mutations too, and a fake that only echoed human changes would have agreed with a broken implementation. |
| **6** | Fetch full reaction state only when the behaviour needs it; memoise per convergence pass | **Done, with a documented divergence** | `needsFullReactionState` (`packages/core/src/panels/convergence.ts`) returns true only for `maxRoles !== undefined` — `toggle`/`add_only`/`remove_only` are decidable from the single emoji the event carried, and `single_choice` is managed-only by CHECK. Pinned in **both directions**: `behaviours.integration.test.ts` asserts `fetchReactionUsers` **is** called for an adopted `max_roles` panel, and slice 7c's test asserts it is **not** called for a plain toggle. Memoisation is asserted by counting REST calls, not by trusting the cache. **Divergence:** §6.4 says memoise "so a burst on the same panel does not refetch". The cache is per *pass* and deliberately not shared across live events — see §5. |

---

## 5. Decisions I made that you did not specify

**Memoisation is per pass, never across live events.** `docs/19` §6.4 describes
memoising so a burst on the same panel does not refetch, and for the pass that
matters — adoption or reconciliation walking many members against one snapshot —
that is exactly what `ReactionStateCache` does. Carrying a cache across separate
live events would be a *correctness* bug rather than an optimisation: the next
event is usually the very member whose reaction is missing from the cached set,
and they would be denied the role they just asked for. A stale read that
silently withholds a role is worse than an extra REST call on a 30-member
server. This is a deliberate narrowing of one sentence in the plan.

**Reconciliation covers adopted panels only.** `docs/19` §6.3 has a table cell
implying drift repair applies to panels generally. An adopted panel has an
independent, member-owned record of intent — the reactions on the message — so
"the role does not match the reactions" is unambiguous drift and repairing it
restores what the member asked for. A managed panel has no such record: the only
durable trace of a member's last choice **is** the role they hold. If a
moderator removes it by hand, re-adding it would be the bot overruling a human on
the strength of nothing. `managed_role_assignments` is not consulted for this,
because that would be the exact bug amendment 4 forbids. It has its own test
asserting the behaviour rather than being left implicit.

> **Approved by Bryan, 2026-08-23**, at this boundary: the §6.3 table cell is
> amended to match. Settled — a later package that wants drift repair for
> managed panels needs a new decision and a new ADR, not an extension of this
> pass.

**Provenance names reconciliation's candidates (ADR 0017).** Described in §4 and
in the ADR. I found it by a failing test, not by design, and wrote the ADR after
implementing rather than before — which inverts the working-style rule. I am
flagging that rather than backdating it.

**The panel is the authorization, not the member.** A member holds no
`roles.mutate` grant and must not need one: requiring it would mean granting
every member the capability to change roles, which is the opposite of what a
panel is for. The authorization for a panel-driven change is *the panel* — an
owner holding `panels.manage` created it, enabled it, and chose its roles. So
`PANEL_ACTOR` is `{type: 'system'}` (`apps/daemon/src/panels/wiring.ts:39`) and
`authorize()` returns a witness unconditionally for system actors. Nothing about
who acted is lost: the member is the audit **subject**, and all twelve gateway
layers still run. The alternative — making the member the actor — would have
required a grant every member holds, which is a far worse blast radius.

**The adoption change list lives in the job cursor.** There is no
`adoption_allowance` table, and adding one for a list that is meaningful for
minutes seemed worse than using the resumability mechanism that already exists.
The cursor is Zod-validated on read.

**Panel-level refusals return the held set, not an empty set.** Losing a required
role or acquiring a blocked role stops the panel *responding*; it does not strip
what was already granted. The alternative reading would turn a timeout role into
a silent mass revocation the moment it is applied. Tested across the transition,
not just in one state.

**Revokes are emitted before grants.** Ordering matters under a rate cap: if the
cap bites mid-batch, having revoked first leaves a member with fewer roles than
they asked for rather than more.

**Editing an adopted panel is refused with a stated reason** rather than
attempted and surfaced as Discord's 50013, which is indistinguishable from a
plain permission failure and would send an owner looking in the wrong place.

**I deleted `listManagedRoles` after writing it.** It had no caller — the doctor
that would read it is WP5. Shipping an unused export with no test is a
speculative abstraction.

---

## 6. What I am least confident about

**The fake cannot prove we are fast enough.** Its clock is manual, so mutation 40
(moving the defer after convergence) was caught by an explicit ordering
assertion, not by a deadline firing. The harness can prove *that we defer first*;
it cannot prove *we are fast enough*, because it does not model latency. "The
panel responds within three seconds" remains a live smoke test, not a covered
one. This is the right division — real latency is not measurable here — but it
is a gap and it belongs in WP5's smoke checklist.

**The harness is my only oracle, and it was wrong twice.** Mutation 37 found the
bot-filter lie; slice 11 found that the fake did not echo `GUILD_MEMBER_UPDATE`
for our own mutations, which is the single fact amendment 5 exists to handle. I
fixed both, but the base rate is what concerns me: two modelling errors found by
accident in one package suggests others remain. Every WP3 conclusion is
conditional on the fake being right about Discord.

The remedy is not a smoke test — there is nothing to run. There is no discord.js
dependency, no adapter, and no `npm run smoke` script (CLAUDE.md lists one
aspirationally; `package.json` has no such target). The real remedy is a
**scheduling** decision that belongs to Bryan: **pull WP5 slice 6 — the real
discord.js adapter — forward, ahead of WP4**, so the harness is validated
against real Discord in the test guild before another package is built on top of
it. Step 1 of `docs/18`'s rollout sequence ("test guild, dry-run off; break
things deliberately") is exactly that exercise. The cost of doing it after WP4
instead is that a harness error would then have two packages of work resting on
it rather than one.

**Rate-cap interaction under concurrent load is untested.** All tests are
single-threaded with a manual clock. Reconciliation opening one batch while an
interaction is mid-flight, both drawing on the same token bucket, is a code path
I have reasoned about and not exercised. The breaker's behaviour when a
reconciliation pass and a burst of clicks collide is likewise unmeasured.

**`selectionAfterClick` derives a managed panel's selection from roles held.**
That is the only record there is, and it is correct as long as the member's roles
were not changed by something else between the click and the fetch. Under a
moderator editing roles at the same moment as a click, the member's click could
be computed against a state they did not see. The window is milliseconds and the
outcome is one role wrong on one click, but it is a real race and I did not
close it.

**The 30-minute outage test is a simulation of an outage, not an outage.** It
disconnects the fake, advances a counter, and reconnects. It does not test
partial delivery, out-of-order dispatches, or a reconnect that fails halfway.

---

## 7. Deferred

| Item | Why | Belongs to |
|---|---|---|
| The real discord.js adapter | Explicit instruction: WP3 and WP4 build against the fake harness only. No client construction pulled forward. | **WP5 slice 6** |
| `partials` configuration for Message, Channel, Reaction, User | It is a discord.js client option and there is no client yet. Listed in `docs/REVIEWING_AGENT_OUTPUT.md` as the trap that makes reactions on uncached messages produce **no event at all** — so it must be the first thing verified when the adapter lands. | **WP5 slice 6** |
| The CLI that previews and grants an adoption allowance | Settled at the WP2 boundary: the pass refusing without an allowance is the finished WP3 behaviour. Tests grant it directly. **No Discord-side confirmation was built**, per instruction. | **WP5 slice 13** |
| `reconcile_guild` on a periodic timer | The job, its handler, and its dedupe key all exist and are tested. Nothing schedules it, because the scheduler is the daemon's run loop. | **WP5** |
| The doctor's rendering of `unassignable_reason` | `setRoleAssignability` writes the diagnosis and it is tested; nothing displays it yet. | **WP5** |
| Member-remove cleanup of `managed_role_assignments` rows | A member who leaves is skipped by reconciliation rather than failing it, so this is tidiness, not correctness. | **WP4 or WP5** |
| Coverage numbers | No coverage tool is configured and adding one was not in scope. Test counts are reported instead. | — |

---

## 8. Handoff prompt for WP4

```
Begin WP4 of the Bananasaurs project — the LOGGING MODULE. You are picking up
from a completed WP3.

FIRST, BEFORE ANYTHING ELSE: if you have a dev database from before WP3, delete
it. `rm -rf data/ && npm install && npm run build && npm run db:migrate`.
WP3 added migration 0001 (a partial index on jobs_dedupe, ADR 0016).

READ, IN THIS ORDER
  1. CLAUDE.md — nine hard rules. Rule 2 (guild scope is structural), rule 4
     (no secrets in logs; Pino redaction is an ALLOWLIST) and rule 6 (durable
     idempotency key per side effect) are the ones WP4 lives inside.
  2. docs/reports/WP3.md — the boundary report you are continuing from. §5 is
     the decisions invisible in the diff; §6 is what I do not trust; §7 is what
     was deliberately left and where it belongs.
  3. docs/19_RELEASE_0_1_PLAN.md §6.7 (the logging module), the `log_routes`
     and `log_excluded_channels` schema under "Log routing" in §2, §7 slice 12,
     and the content-logging reversal in "Amendments from owner review".
  4. docs/20_AUTONOMOUS_EXECUTION.md — the protocol, the four questions, and
     the package-boundary report format.
  5. docs/REVIEWING_AGENT_OUTPUT.md §"Things specific to this project that are
     easy to get wrong" — three of its rows are WP4's whole job.
  6. ADRs 0014 (package boundaries), 0015 (protected describes a target),
     0016 (job dedupe collapses pending work), 0017 (provenance names
     candidates, never decides).

WHERE THE REPO IS
  Branch `worktree-wp3-role-panels`, HEAD `e8d239e`, nothing pushed.
  696 tests green; `npm run typecheck` and `npm run lint` exit 0.
  Packages: packages/core, packages/storage, packages/testkit, apps/daemon.

WHAT WP4 IS
  Slice 12 of docs/19 §7: message edits and deletions, joins and leaves, role
  and channel changes, routed per event kind to configured channels; deletion
  actor inferred from the guild audit log and labelled inferred EVERYWHERE it
  surfaces; and gap markers.

  Done when events route correctly and a missing actor degrades to "unknown",
  never to a guess presented as fact.

THE THREE THINGS THAT MAKE THIS HARDER THAN IT LOOKS

  1. MESSAGE_DELETE CARRIES NO ACTOR. The actor comes from the guild audit log,
     fuzzy-matched on target and timestamp. That correlation is inferred,
     delayed, and ABSENT ENTIRELY for self-deletions. Every such record must
     carry `audit_events.inferred = 1` and render as "deleted by X (inferred)".
     A self-deletion renders as "actor unknown" — never as a guess. This is the
     single requirement most likely to be quietly softened while making a test
     pass; write the test that fails if the label is dropped, first.

  2. THE RELEASE 1 GATE IS UNACHIEVABLE AS WRITTEN, and docs/19 §6.7 says so.
     docs/08 asks that a 30-minute outage "miss no log events". Role state is
     recoverable because reactions are durable state on a message. Log events
     are not: a message edited or deleted while disconnected produces no event,
     is never replayed after a fresh IDENTIFY, and there is no API that
     enumerates "messages deleted while I was away". The accepted restatement
     is: every gap is DETECTED and posted to the log channel as an explicit gap
     marker —
       "⚠ Bananasaurs was disconnected 14:02–14:31. Edits and deletions in that
        window were not captured."
     Silently missing log lines are worse than a visible gap marker. WP2's
     `gateway_gaps` table and `createConnectionSubscriber` already record the
     gaps; WP4 renders them.

  3. CONTENT IS INCLUDED, and that was a reversal. `include_content` defaults
     ON for message_delete and message_edit (decision 3, reversed on owner
     review — read the reasoning, do not re-litigate it). Any route can turn it
     off. `log_excluded_channels` exists so a channel can be excluded whole.
     Rule 4 still applies without exception: no secrets in logs, and Pino
     redaction stays an allowlist. Logged message content goes to a DISCORD
     channel, not to Pino — do not conflate the two paths.

WHAT WP3 LEAVES YOU — DO NOT REBUILD ANY OF IT

  The pipeline. `Pipeline` in packages/core/src/pipeline/ with subscribers,
  guild allowlist, and persistent event dedupe. Add a subscriber; do not build
  a second dispatch path. Note which event kinds are LEVEL-TRIGGERED and carry
  no fingerprint (reactions, memberUpdate) and which are deduplicated — a
  logging subscriber must not assume it sees each event exactly once for the
  level-triggered kinds.

  Gaps. `pipelineRepo.recordGap` / `unreconciledGaps` / `markGapReconciled`,
  and `createConnectionSubscriber`, which distinguishes a RESUME (dispatches
  replayed, nothing missed) from a fresh IDENTIFY (the window is gone). Gap
  markers are a rendering of records that already exist.

  Jobs. jobRepo, jobStoreFor, JobWorker; kinds and payload schemas in
  packages/core/src/jobs/kinds.ts; handlers in apps/daemon/src/jobs/. Dedupe
  keys collapse PENDING work only (ADR 0016). If audit-log correlation needs to
  be delayed — and it does, the entry may not exist yet when the delete event
  arrives — a job with a `runAfter` is the mechanism, not a timer.

  Audit rows. `effectRepo.recordAudit` with before/after and batch ids, and the
  `inferred` column, already in the schema.

  Guild scope. Every repository function takes a `GuildScope` first and every
  WHERE goes through `scope.only(table, ...)`. `core` cannot hold a database
  handle: the composition root binds a scope into port objects (see
  apps/daemon/src/panels/wiring.ts for the shape to copy). ESLint enforces the
  boundary and packages/core/src/boundaries.test.ts asserts the rules fire.

  The fake harness. packages/testkit/src/fake-discord.ts. It has messages,
  message deletion, an audit log (`defineAuditLogEntry`, `fetchAuditLog`),
  member add/remove/update, connection gaps with `resumed` true and false, REST
  call recording, and on-demand failures. It models interaction deadlines and
  returns bot accounts from fetchReactionUsers the way Discord actually does.
  If you find yourself making a test pass by weakening the fake, STOP: that has
  already produced one false green in this project (WP3 report §2, mutation 37).
  If the fake is genuinely wrong about Discord, fix the fake AND the WP1 test
  that asserted the wrong behaviour, and say so in the session log.

SETTLED — DO NOT RE-LITIGATE
  1. The real discord.js adapter stays in WP5 (slice 6). WP4 builds entirely
     against the fake harness. Do not pull client construction forward, and do
     not add `partials` configuration — there is no client to configure.
  2. Content logging is ON by default for delete and edit. The reversal is on
     the record with its reasoning.
  3. Inferred attribution is never rendered as plain attribution, anywhere,
     including in the operator CLI and the dashboard later. Build the label
     into the record, not into one renderer.
  4. `protected` means the bot will not mutate that member or role. It does NOT
     deny capability to an actor (ADR 0015).
  5. AI is nowhere in this package. A log line is deterministic rendering.

PROTOCOL
  Work slice by slice. Identify the thinnest end-to-end slice and its tests
  before writing feature code. Write the test first for anything touching
  permissions, retention, guild scope, or the inferred label. Then implement.
  Then run `npm run typecheck && npm run lint && npm run test` and paste the
  real output — do not report completion on the basis of code you have not run.

  Then BREAK the implementation deliberately to prove the tests catch it,
  record what you broke and what failed, and restore it. Restore with a FILE
  COPY, not `git checkout <file>`, which will also discard the slice's own
  edits — that happened in WP3. WP3's mutations are numbered up to 45; continue
  from 46.

  Append an entry to docs/SESSION_LOG.md: package, slice, what changed, what you
  broke to verify the tests, anything deferred and why. Commit. DO NOT PUSH.

  Record consequential choices as short ADRs in docs/decisions/ BEFORE
  implementing them, numbered sequentially — the next free number is 0018.

  If a slice needs more than roughly 400 lines of new implementation, split it
  rather than writing a large unreviewable change.

  Stop at the WP4 boundary and produce the seven-part report from docs/20
  §"At every package boundary", plus a self-contained WP5 handoff prompt in a
  fenced code block. Answer the four questions with real file:line evidence,
  not "not applicable" — question 3 (untrusted input, Zod) is especially live,
  because message content and audit-log responses are both untrusted input that
  reaches a rendering path.
```
