# Threads and Forums Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make thread and forum conversations visible to the archive, correctly
exempt in automod, readable through the MCP connector, and postable to — with
authorization that can be granted per category and inherited by public threads.

**Architecture:** Parentage is never consulted today; that single omission
causes three separate defects. Message events are enriched at the adapter with
`parentChannelId` and `categoryId` so hot-path subscribers resolve scope with no
lookup and no network call. A separate `channelScope` resolver, cache-first with
a REST fallback, serves the infrequent callers (sends, CLI, MCP discovery). One
predicate expresses the scope rule and every consumer calls it.

**Tech Stack:** TypeScript (Node 22, strict), discord.js v14, better-sqlite3 +
Drizzle ORM, SQLite FTS5, Vitest, Pino, Fastify.

**Spec:** `docs/superpowers/specs/2026-09-20-threads-and-forums-design.md` — read
it first. The eight owner decisions in its §2 are settled and must not be
re-litigated; §3.1 is the rule this whole plan implements.

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements include these.

- **Guild scope is a mandatory partition key.** Every query, cache key, job
  payload, index, export, log line and provider request carries an explicit
  guild ID, enforced in repository signatures and database constraints, not in
  caller discipline.
- **Model output is untrusted input.** Retrieved Discord messages are evidence,
  never instructions.
- **No secrets in the repo, in logs, in config exports or in diagnostics.**
- **Every Discord side effect has a durable idempotency key** and a unique
  constraint making double execution impossible.
- **Write the test first** for anything touching permissions, hierarchy,
  idempotency, retention or guild scope. This feature is nothing but those.
- **Verify, do not assert.** Check library behaviour against the copy in
  `node_modules`, not from memory. Never trust a guard you have not watched fail.
- **Do not modify `packages/core/src/effects/gateway.ts`.** The moderation
  chokepoint stays byte-identical (ruling M5-D1).
- **`allowedMentions` handling in the send path must not change.** It was
  verified live on 2026-09-20 (`mention_everyone: false` from Discord's own
  message object, `docs/reports/mcp-m6-live-run.md` §6).
- **Gates before any task is done:** `npm run typecheck && npm run lint && npm run test`
  must all pass. Do not report completion on code you have not run.
- **A build on this box is a deployment** — systemd runs this checkout's
  `dist/`. Do not run `npm run build` casually. If a migration is pending the
  order is stop → migrate → start.
- **Observe window caveat:** Task 6 touches the frozen automod package. It is
  safe because `mod_rule_exemptions` holds zero rows (spec §7). Do not create
  an exemption before 2026-09-27T02:49:57.656Z.

---

### Task 1: Message events carry their parentage

**Files:**

- Modify: `packages/core/src/discord/events.ts` (the `MessageEvent` and
  `MessageBulkDeleteEvent` interfaces)
- Modify: `packages/discord/src/events.ts` (`toMessageEvent`, ~line 377, and the
  bulk-delete branch ~line 150)
- Test: `packages/discord/src/events.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `MessageEvent.parentChannelId: Snowflake | undefined`,
  `MessageEvent.categoryId: Snowflake | undefined`,
  `MessageEvent.isPrivateThread: boolean`. Same three on
  `MessageBulkDeleteEvent`. Tasks 4 and 6 read them.

`parentChannelId` is the thread's parent when the message is in a thread, and
`undefined` otherwise. `categoryId` is the category of whichever channel is the
authorized unit — the parent for a thread message, the channel itself
otherwise. Both come from the cache only; this code must never make a network
call.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/discord/src/events.test.ts
it('carries the parent and category for a message in a public thread', () => {
  const event = toMessageEvent('messageCreate', fakeThreadMessage({
    channelId: '300', parentId: '200', categoryId: '100', type: ChannelType.PublicThread,
  }), 1_000);
  expect(event).toMatchObject({
    channelId: '300', parentChannelId: '200', categoryId: '100', isPrivateThread: false,
  });
});

it('marks a private thread so downstream vetoes can refuse it', () => {
  const event = toMessageEvent('messageCreate', fakeThreadMessage({
    channelId: '301', parentId: '200', categoryId: '100', type: ChannelType.PrivateThread,
  }), 1_000);
  expect(event).toMatchObject({ isPrivateThread: true });
});

it('leaves parentChannelId undefined for a message in a plain text channel', () => {
  const event = toMessageEvent('messageCreate', fakeTextMessage({
    channelId: '200', categoryId: '100',
  }), 1_000);
  expect(event).toMatchObject({
    channelId: '200', parentChannelId: undefined, categoryId: '100', isPrivateThread: false,
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/discord/src/events.test.ts -t 'parent and category'`
Expected: FAIL — the properties do not exist on the returned object.

- [ ] **Step 3: Add the fields to the domain interfaces**

```typescript
// packages/core/src/discord/events.ts, inside MessageEvent
  /**
   * The thread's parent channel when this message is in a thread, else
   * undefined. Read from cache only — never a network call, because this is
   * built inside message handling.
   */
  parentChannelId: Snowflake | undefined;
  /** Category of the authorized unit: the parent for a thread, else the channel. */
  categoryId: Snowflake | undefined;
  /** Spec §2 decision 2: a private thread is never archived and never inherits sends. */
  isPrivateThread: boolean;
```

Add the same three to `MessageBulkDeleteEvent`.

- [ ] **Step 4: Populate them in the adapter**

```typescript
// packages/discord/src/events.ts, inside toMessageEvent
const channel = message.channel;
const isThread = 'isThread' in channel && channel.isThread();
const parentChannelId = isThread ? (channel.parentId ?? undefined) : undefined;
const isPrivateThread = isThread && channel.type === ChannelType.PrivateThread;
// The category of the authorized unit, not of the thread.
const authorized = isThread ? channel.parent : channel;
const categoryId =
  authorized !== null && 'parentId' in authorized ? (authorized.parentId ?? undefined) : undefined;
```

Return them on the event object. Apply the same in the bulk-delete branch.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/discord/src/events.test.ts`
Expected: PASS.

- [ ] **Step 6: Update FakeDiscord so the rest of the suite can build threads**

`FakeDiscord` must be able to emit a thread message with a parent, a category
and a private flag, or no later task can test its behaviour. Find the fake's
message-emitting helper and add the three fields, defaulting to
`undefined/undefined/false` so every existing test compiles unchanged.

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/core/src/discord/events.ts packages/discord/src/events.ts packages/discord/src/events.test.ts
git commit -m "feat(events): message events carry parent channel, category and private-thread flag"
```

---

### Task 2: The scope predicate

**Files:**

- Create: `packages/core/src/channels/scope.ts`
- Create: `packages/core/src/channels/scope.test.ts`

**Interfaces:**

- Consumes: nothing (pure function over supplied facts).
- Produces:

```typescript
export type ScopePurpose = 'archive' | 'send';

export interface ScopeFacts {
  readonly channelId: Snowflake;
  readonly parentChannelId: Snowflake | undefined;
  readonly categoryId: Snowflake | undefined;
  readonly isPrivateThread: boolean;
  /** Does this exact id have a row for this purpose? */
  readonly hasOwnRow: (id: Snowflake) => boolean;
  /** Does this exact id have a CATEGORY-kind row for this purpose? */
  readonly hasCategoryRow: (id: Snowflake) => boolean;
  /** `log_excluded_channels`. Checked on thread, parent and category. */
  readonly isExcluded: (id: Snowflake) => boolean;
  /** Spec §2 decision 3: false means this parent's threads are not archived. */
  readonly parentIncludesThreads: (id: Snowflake) => boolean;
}

export const isInScope = (purpose: ScopePurpose, facts: ScopeFacts): boolean => { ... };
```

This is the centre of gravity for the whole feature. A mistake here is a privacy
incident, so it is a pure function over supplied facts — no database, no
discord.js, no I/O — and it is tested exhaustively.

- [ ] **Step 1: Write the failing table-driven test**

```typescript
// packages/core/src/channels/scope.test.ts
const facts = (over: Partial<ScopeFacts> = {}): ScopeFacts => ({
  channelId: 'C', parentChannelId: undefined, categoryId: undefined,
  isPrivateThread: false,
  hasOwnRow: () => false, hasCategoryRow: () => false,
  isExcluded: () => false, parentIncludesThreads: () => true,
  ...over,
});

it('a channel with its own row is in scope', () => {
  expect(isInScope('archive', facts({ hasOwnRow: (id) => id === 'C' }))).toBe(true);
});

it('a public thread inherits its parent', () => {
  expect(isInScope('archive', facts({
    channelId: 'T', parentChannelId: 'P', hasOwnRow: (id) => id === 'P',
  }))).toBe(true);
});

it('a channel inherits its category', () => {
  expect(isInScope('send', facts({
    channelId: 'C', categoryId: 'CAT', hasCategoryRow: (id) => id === 'CAT',
  }))).toBe(true);
});

it('a private thread NEVER inherits, for either purpose', () => {
  for (const purpose of ['archive', 'send'] as const) {
    expect(isInScope(purpose, facts({
      channelId: 'T', parentChannelId: 'P', categoryId: 'CAT', isPrivateThread: true,
      hasOwnRow: (id) => id === 'P', hasCategoryRow: (id) => id === 'CAT',
    }))).toBe(false);
  }
});

it('a private thread with its own explicit row IS in scope', () => {
  expect(isInScope('send', facts({
    channelId: 'T', parentChannelId: 'P', isPrivateThread: true,
    hasOwnRow: (id) => id === 'T',
  }))).toBe(true);
});

it('exclusion of the parent excludes its threads', () => {
  expect(isInScope('archive', facts({
    channelId: 'T', parentChannelId: 'P',
    hasOwnRow: (id) => id === 'P', isExcluded: (id) => id === 'P',
  }))).toBe(false);
});

it('exclusion of the category excludes a channel inside it', () => {
  expect(isInScope('archive', facts({
    channelId: 'C', categoryId: 'CAT',
    hasCategoryRow: (id) => id === 'CAT', isExcluded: (id) => id === 'CAT',
  }))).toBe(false);
});

it('a parent with threads disabled does not pass its scope to a thread', () => {
  expect(isInScope('archive', facts({
    channelId: 'T', parentChannelId: 'P',
    hasOwnRow: (id) => id === 'P', parentIncludesThreads: () => false,
  }))).toBe(false);
});

it('parentIncludesThreads does not affect SEND inheritance', () => {
  expect(isInScope('send', facts({
    channelId: 'T', parentChannelId: 'P',
    hasOwnRow: (id) => id === 'P', parentIncludesThreads: () => false,
  }))).toBe(true);
});
```

Note the last two: `include_threads` is an **archive** setting only (spec §4).
Send inheritance is governed by decision 2 alone.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/core/src/channels/scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
export const isInScope = (purpose: ScopePurpose, facts: ScopeFacts): boolean => {
  const { channelId, parentChannelId, categoryId, isPrivateThread } = facts;

  // Exclusion wins over everything, at every level.
  if (facts.isExcluded(channelId)) return false;
  if (parentChannelId !== undefined && facts.isExcluded(parentChannelId)) return false;
  if (categoryId !== undefined && facts.isExcluded(categoryId)) return false;

  // An explicit row for this exact id always counts, private thread or not.
  if (facts.hasOwnRow(channelId)) return true;

  // Decision 2: a private thread inherits nothing.
  if (isPrivateThread) return false;

  if (parentChannelId !== undefined) {
    const threadsAllowed = purpose === 'send' || facts.parentIncludesThreads(parentChannelId);
    if (threadsAllowed && facts.hasOwnRow(parentChannelId)) return true;
  }

  if (categoryId !== undefined && facts.hasCategoryRow(categoryId)) {
    if (parentChannelId === undefined) return true;
    return purpose === 'send' || facts.parentIncludesThreads(parentChannelId);
  }

  return false;
};
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run packages/core/src/channels/scope.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/core/src/channels/
git commit -m "feat(channels): the one scope predicate, with private threads excluded by construction"
```

---

### Task 3: Schema migration

**Files:**

- Modify: `packages/storage/src/schema.ts` (`archiveChannels` ~872,
  `archiveMessages` ~909, the MCP send-channel table, `modCaseEvents`)
- Create: `drizzle/00NN_threads_and_forums.sql` (generated, then corrected)
- Test: the existing schema-invariants proof test

**Interfaces:**

- Consumes: nothing.
- Produces: columns `archive_channels.scope_kind`,
  `archive_channels.include_threads`, `mcp_send_channels.scope_kind`,
  `archive_messages.thread_id`, `mod_case_events.channel_id`.

- [ ] **Step 1: Add the columns to the Drizzle schema**

```typescript
// archiveChannels
scopeKind: text('scope_kind').notNull().default('channel'),
includeThreads: integer('include_threads').notNull().default(1),
// and in the constraints array:
check('archive_channels_scope_kind', sql`${t.scopeKind} IN ('channel','category')`),

// archiveMessages — channel_id KEEPS meaning the authorized parent (spec §4)
threadId: text('thread_id'),
// and an index, because "everything in this thread" is a real query:
index('archive_messages_thread_created').on(t.guildId, t.threadId, t.createdAt),
```

Add `scopeKind` with the same check to the MCP send-channel table, and
`channelId: text('channel_id')` to `modCaseEvents`.

Do **not** add a foreign key on `thread_id`. There is no row to point at — that
is the entire reason `channel_id` stays the parent.

- [ ] **Step 2: Generate the migration**

```bash
npm run db:generate
```

- [ ] **Step 3: Inspect the generated SQL by hand — this is not optional**

**drizzle-kit 0.31.10 emits an invalid `CREATE INDEX` when it rebuilds a table
carrying a sort-ordered index** (ruling M5-D7). `archive_messages` carries
`archive_messages_channel_created` and `archive_messages_deleted`. Open the
generated file and confirm every `CREATE INDEX` is valid SQL and that both
existing indexes are recreated. Correct it by hand if not.

Also confirm the generated SQL preserves the `(guild_id, channel_id)` foreign
key to `archive_channels`. If the rebuild drops it, the whole design's
assumption about cascade is gone.

- [ ] **Step 4: Extend the schema-invariants proof**

Assert that after migration: `archive_messages` still has its FK to
`archive_channels`; both pre-existing indexes exist; the new
`archive_messages_thread_created` index exists; and rows written before the
migration still read back with `thread_id` NULL.

- [ ] **Step 5: Run the gates**

```bash
npm run typecheck && npm run lint && npm run test
```

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/schema.ts drizzle/
git commit -m "feat(schema): thread_id, scope_kind, include_threads, and channel_id on the match corpus"
```

**Do not run `db:migrate` against the live database as part of this task.**
Deployment is stop → migrate → start, performed deliberately by the owner.

---

### Task 4: The archive ingests threads

**Files:**

- Modify: `packages/core/src/archive/ports.ts` (`ArchivePorts`,
  `UpsertMessageInput`)
- Modify: `packages/core/src/archive/subscriber.ts:63-68` (the veto) and the
  `upsertMessage` calls
- Modify: `apps/daemon/src/runtime/guild.ts` (where the ports are bound)
- Test: `packages/core/src/archive/subscriber.test.ts`

**Interfaces:**

- Consumes: `isInScope` from Task 2; `parentChannelId`/`categoryId`/
  `isPrivateThread` from Task 1.
- Produces: `UpsertMessageInput.threadId: Snowflake | undefined`; ports gain
  `hasCategoryRow`, `parentIncludesThreads`.

- [ ] **Step 1: Write the failing tests**

```typescript
it('archives a message in a public thread whose parent is enabled', () => {
  const ports = fakePorts({ enabled: ['P'] });
  run(ports, threadMessageCreate({ channelId: 'T', parentChannelId: 'P', messageId: 'm1' }));
  expect(ports.upserted).toHaveLength(1);
  // channel_id is the AUTHORIZED PARENT, thread_id is the thread (spec §4).
  expect(ports.upserted[0]).toMatchObject({ channelId: 'P', threadId: 'T', messageId: 'm1' });
});

it('never archives a private thread, even under an enabled parent', () => {
  const ports = fakePorts({ enabled: ['P'] });
  run(ports, threadMessageCreate({
    channelId: 'T', parentChannelId: 'P', isPrivateThread: true, messageId: 'm2',
  }));
  expect(ports.upserted).toHaveLength(0);
});

it('archives a forum post when the forum is enabled', () => {
  const ports = fakePorts({ enabled: ['F'] });
  run(ports, threadMessageCreate({ channelId: 'POST', parentChannelId: 'F', messageId: 'm3' }));
  expect(ports.upserted[0]).toMatchObject({ channelId: 'F', threadId: 'POST' });
});

it('records threadId undefined for a message in the channel itself', () => {
  const ports = fakePorts({ enabled: ['P'] });
  run(ports, messageCreate({ channelId: 'P', messageId: 'm4' }));
  expect(ports.upserted[0]).toMatchObject({ channelId: 'P', threadId: undefined });
});

it('does not archive a thread when the parent has include_threads off', () => {
  const ports = fakePorts({ enabled: ['P'], includeThreads: { P: false } });
  run(ports, threadMessageCreate({ channelId: 'T', parentChannelId: 'P', messageId: 'm5' }));
  expect(ports.upserted).toHaveLength(0);
});

it('a thread in another guild resolves to no scope', () => {
  // Cannot occur naturally, which is exactly why it needs a test.
  const ports = fakePorts({ enabled: ['P'], guildId: 'G1' });
  run(ports, threadMessageCreate({
    guildId: 'G2', channelId: 'T', parentChannelId: 'P', messageId: 'm6',
  }));
  expect(ports.upserted).toHaveLength(0);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run packages/core/src/archive/subscriber.test.ts`
Expected: FAIL — thread messages are dropped by the exact-equality veto.

- [ ] **Step 3: Widen the ports**

```typescript
// packages/core/src/archive/ports.ts, in ArchivePorts
  /** A CATEGORY-kind row for this id (spec §4). */
  hasCategoryRow(channelId: Snowflake): boolean;
  /** `archive_channels.include_threads` for this parent. Default true. */
  parentIncludesThreads(channelId: Snowflake): boolean;

// in UpsertMessageInput
  /** The thread this was posted in, if any. `channelId` stays the parent. */
  readonly threadId?: Snowflake;
```

- [ ] **Step 4: Replace the veto with the predicate**

```typescript
// packages/core/src/archive/subscriber.ts, replacing lines 63-68
if (!ports.guildArchiveEnabled) return;

const inScope = isInScope('archive', {
  channelId: event.channelId,
  parentChannelId: event.parentChannelId,
  categoryId: event.categoryId,
  isPrivateThread: event.isPrivateThread,
  hasOwnRow: (id) => ports.isChannelEnabled(id),
  hasCategoryRow: (id) => ports.hasCategoryRow(id),
  isExcluded: (id) => ports.isChannelExcluded(id),
  parentIncludesThreads: (id) => ports.parentIncludesThreads(id),
});
if (!inScope) return;

// The authorized unit owns the row; the thread is recorded beside it.
const archiveChannelId = event.parentChannelId ?? event.channelId;
const threadId = event.parentChannelId === undefined ? undefined : event.channelId;
```

Pass `channelId: archiveChannelId, threadId` into every `upsertMessage`,
`recordEdit` and delete call in the switch below.

- [ ] **Step 5: Bind the two new ports in the daemon**

In `apps/daemon/src/runtime/guild.ts`, bind `hasCategoryRow` to an
`archive_channels` lookup filtered to `scope_kind = 'category'` **and the
guild**, and `parentIncludesThreads` to that row's `include_threads`, defaulting
to `true` when no row exists.

- [ ] **Step 6: Run and watch them pass**

Run: `npx vitest run packages/core/src/archive/`
Expected: PASS.

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/core/src/archive/ apps/daemon/src/runtime/guild.ts
git commit -m "feat(archive): ingest thread and forum messages under their parent's authorization"
```

---

### Task 5: Backfill walks existing threads

**Files:**

- Modify: `packages/core/src/archive/backfill.ts`
- Modify: the archive port that fetches history (add thread enumeration)
- Test: `packages/core/src/archive/backfill.test.ts`

**Interfaces:**

- Consumes: Task 4's `threadId` on writes.
- Produces: port method
  `listThreads(channelId: Snowflake): Promise<readonly { id: Snowflake; isPrivate: boolean }[]>`.

Enumerate **active** threads (`GET /guilds/{id}/threads/active`, filtered to
this parent) and **archived public** threads
(`GET /channels/{id}/threads/archived/public`, paginated). Never fetch archived
*private* threads — decision 2 means they would be discarded anyway, and not
fetching them is the stronger guarantee.

- [ ] **Step 1: Write the failing test**

```typescript
it('backfills each public thread under the channel, with its own cursor', async () => {
  const ports = fakeBackfillPorts({
    threads: [{ id: 'T1', isPrivate: false }, { id: 'T2', isPrivate: false }],
    messages: { P: ['p1'], T1: ['t1a', 't1b'], T2: ['t2a'] },
  });
  await backfillChannel(ports, { guildId: 'G', channelId: 'P' });
  expect(ports.upserted.map((u) => [u.channelId, u.threadId, u.messageId])).toEqual([
    ['P', undefined, 'p1'],
    ['P', 'T1', 't1a'], ['P', 'T1', 't1b'],
    ['P', 'T2', 't2a'],
  ]);
});

it('never fetches or stores a private thread', async () => {
  const ports = fakeBackfillPorts({
    threads: [{ id: 'T1', isPrivate: true }],
    messages: { P: [], T1: ['secret'] },
  });
  await backfillChannel(ports, { guildId: 'G', channelId: 'P' });
  expect(ports.fetchedChannels).not.toContain('T1');
  expect(ports.upserted).toHaveLength(0);
});

it('backfilling a forum stores only thread messages', async () => {
  const ports = fakeBackfillPorts({
    isForum: true, threads: [{ id: 'POST', isPrivate: false }],
    messages: { POST: ['a'] },
  });
  await backfillChannel(ports, { guildId: 'G', channelId: 'F' });
  expect(ports.upserted[0]).toMatchObject({ channelId: 'F', threadId: 'POST' });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run packages/core/src/archive/backfill.test.ts`
Expected: FAIL — no thread enumeration exists.

- [ ] **Step 3: Implement the walk**

After the channel's own history, enumerate threads, skip `isPrivate`, and
backfill each with `channelId` = the parent and `threadId` = the thread. A forum
skips the channel's own history entirely — it has none.

- [ ] **Step 4: Report progress per thread**

`archive_channels.backfill_state` is one cursor per channel, which cannot
express "thread 12 of 340." Add two integer columns to `archive_channels` in
this task's own migration:

```typescript
threadsFound: integer('threads_found'),      // NULL until enumeration completes
threadsDone: integer('threads_done').notNull().default(0),
```

Set `threads_found` once enumeration finishes, increment `threads_done` as each
thread's backfill completes, and have `archive status` print
`threads: 12/340` when `threads_found` is not NULL. A counter pair rather than a
per-thread cursor table, because a thread's own backfill is short enough to
restart from the beginning if it is interrupted, and a table of transient ids
would need its own staleness story.

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run packages/core/src/archive/`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/core/src/archive/
git commit -m "feat(archive): backfill walks active and archived public threads"
```

---

### Task 6: Automod exemption inheritance and channel recording

**Files:**

- Modify: `packages/core/src/automod/subscriber.ts` (the `isExempt` call site
  ~line 284 and the `AutomodPorts.isExempt` signature ~line 119)
- Modify: the `mod_case_events` write site
- Test: `packages/core/src/automod/subscriber.test.ts`

**Interfaces:**

- Consumes: `isInScope` is **not** used here — exemption is its own predicate
  with the same parentage walk. Consumes Task 1's event fields.
- Produces: no new public interface.

**Read spec §7 before starting.** This is inside the observe-window freeze and
is safe only because `mod_rule_exemptions` holds zero rows. Do not create an
exemption on the live database.

- [ ] **Step 1: Write the failing tests**

```typescript
it('a thread inside an exempt channel is exempt', () => {
  const ports = fakePorts({ exemptChannels: ['P'] });
  run(ports, threadMessageCreate({ channelId: 'T', parentChannelId: 'P', content: 'badword' }));
  expect(ports.caseEvents).toHaveLength(0);
});

it('a thread whose parent is in an exempt category is exempt', () => {
  const ports = fakePorts({ exemptChannels: ['CAT'] });
  run(ports, threadMessageCreate({
    channelId: 'T', parentChannelId: 'P', categoryId: 'CAT', content: 'badword',
  }));
  expect(ports.caseEvents).toHaveLength(0);
});

it('a thread under a NON-exempt parent still matches', () => {
  const ports = fakePorts({ exemptChannels: [] });
  run(ports, threadMessageCreate({ channelId: 'T', parentChannelId: 'P', content: 'badword' }));
  expect(ports.caseEvents).toHaveLength(1);
});

it('records the channel the match happened in', () => {
  const ports = fakePorts({});
  run(ports, threadMessageCreate({ channelId: 'T', parentChannelId: 'P', content: 'badword' }));
  expect(ports.caseEvents[0]).toMatchObject({ channelId: 'T' });
});
```

Note the last one records the **thread's own id**, not the parent. The match
happened in the thread and a reviewer needs to open that thread. This differs
deliberately from the archive's choice in Task 4, where the parent is the
authorization unit and the FK forces it.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run packages/core/src/automod/subscriber.test.ts`
Expected: FAIL.

- [ ] **Step 3: Widen `isExempt` to walk parentage**

```typescript
isExempt(ruleId: string, input: {
  authorRoleIds: readonly string[];
  channelId: string;
  parentChannelId: string | undefined;
  categoryId: string | undefined;
}): boolean;
```

At the call site, pass `parentChannelId: event.parentChannelId` and
`categoryId: event.categoryId`. In the binding, a message is channel-exempt when
any of the three ids has an exemption row **for that rule in that guild**.

- [ ] **Step 4: Record `channel_id` on the match**

Pass `event.channelId` into the `mod_case_events` write.

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run packages/core/src/automod/`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/core/src/automod/
git commit -m "fix(automod): exemptions inherit to threads; record the channel on every match"
```

- [ ] **Step 7: Record the evaluator change**

Add a line to `docs/reports/release2-gate-signoff.md` naming the date the
evaluator changed and stating that `mod_rule_exemptions` was empty at the time,
so no collected match is affected.

---

### Task 7: The resolver for on-demand callers

**Files:**

- Create: `apps/daemon/src/channels/resolver.ts`
- Create: `apps/daemon/src/channels/resolver.test.ts`

**Interfaces:**

- Consumes: `ScopeFacts` from Task 2.
- Produces:

```typescript
export interface ResolvedChannel {
  readonly channelId: Snowflake;
  readonly parentChannelId: Snowflake | undefined;
  readonly categoryId: Snowflake | undefined;
  readonly isPrivateThread: boolean;
  readonly isThread: boolean;
  readonly isForum: boolean;
  readonly postable: boolean;
}
export const resolveChannel: (
  guildId: Snowflake, channelId: Snowflake,
) => Promise<ResolvedChannel | undefined>;
```

Cache first; on a miss, one REST fetch. Returns `undefined` when the channel is
not in that guild — **the guild check is the point**, not an afterthought.

- [ ] **Step 1: Write the failing tests**

```typescript
it('resolves a cached thread to its parent and category', async () => {
  const r = await resolveChannel('G', 'T');
  expect(r).toMatchObject({ parentChannelId: 'P', categoryId: 'CAT', isThread: true });
});

it('falls back to REST when the thread was swept from cache', async () => {
  cache.clear();
  const r = await resolveChannel('G', 'T');
  expect(r?.parentChannelId).toBe('P');
  expect(rest.calls).toHaveLength(1);
});

it('returns undefined for a channel in a different guild', async () => {
  expect(await resolveChannel('G1', 'channel-in-G2')).toBeUndefined();
});
```

The REST-fallback test is load-bearing: discord.js's default sweeper evicts
archived threads after four hours, so the cache miss is the normal case for
anything older than an afternoon.

- [ ] **Step 2: Run, implement, run again**

Run: `npx vitest run apps/daemon/src/channels/resolver.test.ts`
Expected: FAIL, then PASS after implementing.

- [ ] **Step 3: Gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add apps/daemon/src/channels/
git commit -m "feat(channels): cache-first resolver with REST fallback for on-demand callers"
```

---

### Task 8: Sending to threads, and category authorization

**Files:**

- Modify: `packages/mcp/src/tools/send.ts` (the allowlist check, the refusal
  text at :171)
- Modify: `apps/daemon/src/ops/wiring.ts` (`allowSendChannel`)
- Test: `packages/mcp/src/tools/send.test.ts`

**Interfaces:**

- Consumes: `resolveChannel` (Task 7), `isInScope` (Task 2).
- Produces: a new refusal reason `'private-thread'`.

- [ ] **Step 1: Write the failing tests**

```typescript
it('posts to a public thread whose parent is allowlisted', async () => {
  const r = await send({ guildId: 'G', channelId: 'T', content: 'hi', idempotencyKey: 'k1' });
  expect(r).toMatchObject({ ok: true });
});

it('posts to a channel whose CATEGORY is allowlisted', async () => {
  const r = await send({ guildId: 'G', channelId: 'C', content: 'hi', idempotencyKey: 'k2' });
  expect(r).toMatchObject({ ok: true });
});

it('refuses a private thread with its own distinct message', async () => {
  const r = await send({ guildId: 'G', channelId: 'PT', content: 'hi', idempotencyKey: 'k3' });
  expect(r.ok).toBe(false);
  expect(r.message).toMatch(/private thread/i);
  expect(r.message).not.toMatch(/allowlist/i);  // not the generic refusal
});

it('the not-allowlisted refusal names the guild in its suggested command', async () => {
  const r = await send({ guildId: 'G', channelId: 'NOPE', content: 'hi', idempotencyKey: 'k4' });
  expect(r.message).toContain('--guild G');
});

it('suppresses mentions on a thread send exactly as on a channel send', async () => {
  await send({ guildId: 'G', channelId: 'T', content: '@everyone', idempotencyKey: 'k5' });
  expect(rest.lastBody.allowed_mentions).toEqual({ parse: [] });
});

it('the same idempotency key still yields exactly one message in a thread', async () => {
  await send({ guildId: 'G', channelId: 'T', content: 'x', idempotencyKey: 'k6' });
  await send({ guildId: 'G', channelId: 'T', content: 'x', idempotencyKey: 'k6' });
  expect(rest.posts).toHaveLength(1);
});
```

The private-thread refusal must be **distinct** from the allowlist refusal.
A caller who gets the generic message will try to allowlist the parent and be
baffled when it still fails.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run packages/mcp/src/tools/send.test.ts`
Expected: FAIL.

- [ ] **Step 3: Route authorization through the predicate, and fix the refusal text**

```typescript
// packages/mcp/src/tools/send.ts:171 — interpolate the guild (live-run finding §7a)
`\`bananasaurs mcp allow-channel ${channelId} --guild ${guildId} --confirm\`, then retry this call.`
```

- [ ] **Step 4: Add the audit event for derived authorization**

When a send was authorized by **category or parentage** rather than by the
channel's own row, write an audit event saying so, naming which row granted it.
This is the §11 visibility mitigation — without it, a send into a channel nobody
explicitly allowlisted leaves no trace of why it was permitted.

- [ ] **Step 5: Run and watch them pass, then gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/mcp/src/tools/send.ts apps/daemon/src/ops/wiring.ts packages/mcp/src/tools/send.test.ts
git commit -m "feat(send): thread and category authorization, private-thread refusal, guild-qualified remediation"
```

---

### Task 9: The MCP read surface

**Files:**

- Create: the `list_threads` tool in `packages/mcp/src/tools/guild.ts`
- Modify: `packages/mcp/src/tools/archive.ts` (accept thread ids; envelope)
- Modify: `apps/daemon/src/mcp/wiring.ts:285-305` (`isForum`)
- Test: `packages/mcp/src/tools/guild.test.ts`, `archive.test.ts`

**Interfaces:**

- Consumes: `resolveChannel` (Task 7), `threadId` on archive rows (Task 3).
- Produces: tool `list_threads` with args `{ guildId, channelId, includeArchived? }`.

- [ ] **Step 1: Write the failing tests**

```typescript
it('lists public threads under a channel with their parent', async () => {
  const r = await listThreads({ guildId: 'G', channelId: 'P' });
  expect(r.items).toEqual([
    expect.objectContaining({ id: 'T1', parentId: 'P', archived: false }),
  ]);
});

it('never lists a private thread', async () => {
  const r = await listThreads({ guildId: 'G', channelId: 'P' });
  expect(r.items.map((i) => i.id)).not.toContain('PT');
});

it('refuses a guild the caller cannot reach', async () => {
  const r = await listThreads({ guildId: 'OTHER', channelId: 'P' });
  expect(r.ok).toBe(false);
});

it('read_channel_history on a parent returns ONLY its own messages', async () => {
  const r = await readChannelHistory({ guildId: 'G', channelId: 'P' });
  expect(r.items.every((i) => i.threadId === undefined)).toBe(true);
});

it('read_channel_history accepts a thread id and returns that thread', async () => {
  const r = await readChannelHistory({ guildId: 'G', channelId: 'T1' });
  expect(r.items.every((i) => i.threadId === 'T1')).toBe(true);
});

it('a thread-sourced result cites its thread, not just the parent', async () => {
  const r = await searchMessages({ guildId: 'G', query: 'hello' });
  expect(r.items[0]).toMatchObject({ channelId: 'P', threadId: 'T1' });
});
```

The last test is the citation guard: without `threadId` in the envelope, the AI
will attribute a thread quote to the parent channel, which is a false statement
about where someone said something.

- [ ] **Step 2: Run, implement, run again**

`read_channel_history` distinguishes by what the id resolves to: a thread id
filters `thread_id = ?`; a channel id filters `channel_id = ? AND thread_id IS NULL`
(decision 6). Both remain guild-scoped.

- [ ] **Step 3: Gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/mcp/src/tools/ apps/daemon/src/mcp/wiring.ts
git commit -m "feat(mcp): list_threads, thread-aware history and search, threadId in the evidence envelope"
```

---

### Task 10: CLI surface and the ADRs

**Files:**

- Modify: `packages/core/src/ops/commands/mcp.ts`,
  `packages/core/src/ops/commands/archive.ts`
- Create: `docs/decisions/00NN-dynamic-channel-scope.md`
- Modify: `docs/decisions/0046-*.md` (amendment)
- Test: the ops command tests

**Interfaces:**

- Consumes: everything above.
- Produces: the six commands in spec §9.

- [ ] **Step 1: Write the failing tests**

```typescript
it('allow-category writes a category-kind row', async () => {
  await run('mcp allow-category', { guildId: 'G', id: 'CAT', confirm: true });
  expect(rows()).toEqual([{ channelId: 'CAT', scopeKind: 'category' }]);
});

it('archive enable-category reports the channel and message count before acting', async () => {
  const r = await run('archive enable-category', { guildId: 'G', id: 'CAT', confirm: true });
  expect(r.text).toMatch(/\d+ channels?/);
});

it('set-threads none is refused on a forum, with a reason', async () => {
  const r = await run('archive set-threads', { guildId: 'G', id: 'FORUM', value: 'none' });
  expect(r.ok).toBe(false);
  expect(r.text).toMatch(/forum/i);
});

it('mcp allowlist shows how many channels a category row currently covers', async () => {
  const r = await run('mcp allowlist', { guildId: 'G' });
  expect(r.text).toMatch(/CAT.*covers 4 channels/);
});
```

The last one matters: under a dynamic model the coverage is **not** a property
of the row, so a listing of bare ids would make the allowlist unreadable to an
operator. It must resolve live.

- [ ] **Step 2: Run, implement, run again**

Every command takes `--guild` and every repository call carries it.

- [ ] **Step 3: Write the new ADR**

`docs/decisions/00NN-dynamic-channel-scope.md` — the dynamic-resolution decision,
and the accepted trade from spec §11: **anyone with Manage Channels can move a
channel into an authorized category and thereby grant the bot posting rights
there.** Record it as accepted with its three mitigations, and name what would
reopen it (the moderator roster growing; anyone with Manage Channels not being
trusted with the bot).

- [ ] **Step 4: Amend ADR 0046**

Decision 7 relaxes "a channel must still be enabled one at a time" to permit
category-level enabling. The amendment must say what replaces that friction: the
guild veto is unchanged, private threads are newly excluded, and
`archive enable-category` reports its scale before acting.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/core/src/ops/commands/ docs/decisions/
git commit -m "feat(cli): category and thread commands; ADR 0046 amendment and the scope-model ADR"
```

---

## Finish condition

- `npm run typecheck && npm run lint && npm run test` all pass.
- A message posted in a thread under an enabled channel is archived, with
  `channel_id` the parent and `thread_id` the thread.
- A private thread is archived by nothing and postable by nothing, proven by a
  test watched failing first.
- `search_messages` returns thread hits that cite their thread.
- A send to a thread under an allowlisted parent succeeds, suppresses mentions,
  and is idempotent under a repeated key.
- ADR 0046 no longer contradicts the code.
