# Slice M1 — Archive schema, ingestion, retention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `opencode-delegate:opencode-driven-development` (the controller writes briefs from these tasks; an opencode model implements and reviews). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Messages from owner-enabled channels in owner-listed guilds land in SQLite; edits, deletions and bulk deletions are recorded; a restart resumes backfill from its cursor; deleted content expires on the three-tier schedule; nothing is enabled by default and the club guild cannot be enabled at all until the privacy surface ships.

**Architecture:** Four `archive_*` tables under the guild partition key. A pipeline subscriber after automod (read-side only) writes live rows through `packages/storage/src/repos/archive.ts`. Two job kinds on the existing job table: `archive_backfill` (one page per run, cursor persisted, continuation enqueued — purge's shape) and `archive_expiry` (produced daily by a timer on the backup timer's shape). Five `archive …` operator commands through `OpsPorts`; two `doctor` lines.

**Tech Stack:** Drizzle + better-sqlite3 (migration via `npm run db:generate`), Zod, the pipeline in `packages/core/src/pipeline`, the job worker in `packages/core/src/jobs`, `FakeDiscord` from `packages/testkit`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md` §7 and §11; `docs/superpowers/plans/2026-09-12-mcp-operator-server-plan.md` "Slice M1"; **ADR 0046 including Amendment 1 (rulings PR-66..PR-70)** — the amendment overrides the slice text where they differ.

## Global Constraints

- **Read `docs/reports/briefs/SANDBOX_RULES.md` before running any command.** Explicit paths on every `rg` and `git`; gates by exit code; `git restore` to undo experiments; never read `.env`, `data/**`, `backups/**`.
- **No new dependency.** One migration, generated only by `npm run db:generate`; never hand-written.
- **Do not modify** `mod_rules`, `mod_cases` or `mod_case_events` (schema or writers), `setRuleMode`, `setRuleConfig`, `recordVerdict`, `packages/core/src/automod/**`, `packages/core/src/mod/**`, or `packages/core/src/effects/gateway.ts`. The observe window is running on two real guilds. The archive **reads** `mod_cases` through the existing `findCase` in `automod-admin.ts` and `mod_case_events` through one new read in `archive.ts`; it writes neither.
- **Guild scope (rule 2):** every new table has `guild_id` with `snowflakeCheck` and, where it has a parent, a composite FK that leads with `guild_id` and cascades; `schema-invariants.test.ts` discovers new tables automatically — make it pass, do not exempt anything. Every repo function takes `GuildScope` first and goes through `scope.only(...)`; every one has a two-guild test whose other-guild rows use **colliding ids**.
- **Two vetoes plus one (ADR 0046 D1):** a row is written only if the guild is in `BANANASAURS_ARCHIVE_GUILDS` **and** the channel is in `archive_channels` **and** the channel is not in `log_excluded_channels`. All three tested in both directions.
- **Attachment bytes are not fetched (PR-67).** No outbound HTTP anywhere in this slice. `attachment_policy` is stored; `bytes` is refused at the CLI.
- **Zod at every boundary (rule 3):** job payloads, ops command args, the config variable.
- **No secrets, no member content in logs (rule 4):** new log fields are `archiveChannelId`-free — use the existing `channelId`, `messageId`, `jobKind`, `count` names; never log `content`.
- **Break it and watch it fail:** the five retention/scope tests are written first and their red run is the first commit of Task 3; the vetoes' red runs are the first commit of Task 4.
- **`PRIVACY.md` rows land in the migration commit** (Task 2).
- **`OpsPorts` is implemented in four literals** — `apps/daemon/src/ops/wiring.ts`, `packages/http/src/test-support.ts`, `packages/core/src/ops/test-fixtures.ts`, `packages/storage/src/repos/automod-rule-lists.test.ts` — every new member updates all four. Core may not import from `@bananasaurs/storage`; re-declare shapes in `ports.ts`.
- **Gates run alone, read by exit code:** `npm run typecheck`, `npm run lint`, `npm run test`.

---

## File map

| File | Responsibility |
| --- | --- |
| `packages/core/src/discord/events.ts` | `MessageBulkDeleteEvent`, `MessageAttachment.attachmentId` (Task 1) |
| `packages/core/src/discord/port.ts` | `FetchedMessage.editedTimestampMs`, `.attachments` (Task 1) |
| `packages/core/src/pipeline/fingerprint.ts` | `messageDeleteBulk` fingerprint (Task 1) |
| `packages/discord/src/events.ts`, `packages/discord/src/rest/port.ts` | adapter translations (Task 1) |
| `packages/testkit/src/fake-discord.ts` | `emitMessageUpdate`, `emitMessageDelete`, `emitMessageDeleteBulk`, attachments on seeded messages (Task 1) |
| `packages/core/src/config/schema.ts` | `BANANASAURS_ARCHIVE_GUILDS` (Task 2) |
| `packages/storage/src/schema.ts`, `drizzle/00NN_*.sql`, `PRIVACY.md` | four tables + rows (Task 2) |
| `packages/storage/src/repos/archive.ts` (+ `.test.ts`) | the repository (Task 3) |
| `packages/core/src/archive/subscriber.ts` (+ `.test.ts`) | live ingestion (Task 4) |
| `packages/core/src/jobs/kinds.ts`, `packages/core/src/archive/backfill.ts`, `packages/core/src/archive/expiry.ts` (+ tests) | the two job handlers (Task 5) |
| `apps/daemon/src/runtime/archive-expiry-timer.ts`, `apps/daemon/src/runtime/guild.ts`, `apps/daemon/src/runtime/daemon.ts` | wiring (Tasks 4–5) |
| `packages/core/src/ops/ports.ts`, the four literals, `packages/core/src/ops/commands/archive.ts` (+ `.test.ts`), `packages/core/src/ops/registry.ts`, `apps/daemon/src/runtime/doctor.ts` | operator surface (Task 6) |

---

### Task 1: The pipeline learns bulk deletion; fetched messages carry edits and attachments (PR-66, PR-68)

**Files:**
- Modify: `packages/core/src/discord/events.ts`, `packages/core/src/discord/port.ts`, `packages/core/src/pipeline/fingerprint.ts`, `packages/core/src/pipeline/fingerprint.test.ts`
- Modify: `packages/discord/src/events.ts`, `packages/discord/src/events.test.ts`, `packages/discord/src/rest/port.ts`, `packages/discord/src/rest/port.test.ts`
- Modify: `packages/testkit/src/fake-discord.ts`
- Modify (only if typecheck demands an exhaustive-switch arm): `packages/core/src/logging/subscriber.ts` and any other `switch (event.kind)` that fails to compile — add a no-op arm, nothing else.

**Interfaces — Produces:**
```ts
// events.ts
export interface MessageAttachment {
  readonly attachmentId: Snowflake;          // NEW — Discord's attachment id
  readonly fileName: string;
  readonly contentType: string | undefined;
  readonly sizeBytes: number;
}
export interface MessageBulkDeleteEvent extends Base {
  kind: 'messageDeleteBulk';
  channelId: Snowflake;
  /** Every id Discord named, in the order it named them. Never empty. */
  messageIds: readonly Snowflake[];
}
// DomainEvent union gains MessageBulkDeleteEvent.
// port.ts
export interface FetchedMessage {
  messageId: Snowflake;
  authorId: Snowflake | undefined;
  createdAtMs: number;
  content: string | undefined;
  editedTimestampMs: number | undefined;     // NEW — from `edited_timestamp`
  attachments: readonly MessageAttachment[]; // NEW — metadata only
}
```

- [ ] **Step 1: Failing fingerprint test.** In `fingerprint.test.ts` add: a `messageDeleteBulk` event with ids `['3','1','2']` in channel `C` fingerprints equal to the same event with ids `['1','2','3']`, and differs from the same ids in channel `D`. Run `npx vitest run packages/core/src/pipeline/fingerprint.test.ts` — expect a type error / failure.
- [ ] **Step 2: Types.** Add `attachmentId` to `MessageAttachment`, `MessageBulkDeleteEvent`, extend the `DomainEvent` union and `FetchedMessage` exactly as above. In `fingerprint.ts` add the arm:
  ```ts
  case 'messageDeleteBulk':
    // A bulk delete is identified by the channel and the set of ids; Discord
    // may order the list differently on a replay, so sort before digesting.
    return digest(event.channelId, ...[...event.messageIds].sort());
  ```
  (read `digest`'s signature first; if it takes a fixed arity, join the sorted ids with `,` into one argument and say so).
- [ ] **Step 3: Adapter.** In `packages/discord/src/events.ts` map `attachmentId: a.id` in the existing attachment mapper, and add after the `MessageDelete` handler:
  ```ts
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    translate('messageDeleteBulk', () => ({
      kind: 'messageDeleteBulk',
      guildId: /* the same guild resolution the three message handlers use */,
      receivedAtMs: now(),
      channelId: channel.id,
      messageIds: [...messages.keys()],
    }));
  });
  ```
  Read `toMessageEvent` for how `guildId` is resolved and mirror it; a DM channel (no guild) is skipped the way the others skip it. Test in `events.test.ts` with the file's existing fake-client pattern: a bulk delete of two ids yields one event with both ids; an empty collection yields no event.
  In `packages/discord/src/rest/port.ts` `fetchRecentMessages`, add `editedTimestampMs: message.edited_timestamp ? Date.parse(message.edited_timestamp) : undefined` and `attachments: message.attachments.map((a) => ({ attachmentId: a.id, fileName: a.filename, contentType: a.content_type ?? undefined, sizeBytes: a.size }))`. Test in `rest/port.test.ts`: a message body with `edited_timestamp` and one attachment maps both.
- [ ] **Step 4: Fake.** In `fake-discord.ts`: seeded messages gain optional `attachments` and `editedTimestampMs` (defaults `[]` / `undefined`) and `fetchRecentMessages` returns them; add `emitMessageUpdate(p: { channelId; messageId; authorId; content; editedTimestampMs })`, `emitMessageDelete(p: { channelId; messageId; authorId?: Snowflake })`, `emitMessageDeleteBulk(p: { channelId; messageIds })` on the shape of `emitMessageCreate` (`fake-discord.ts:330-350`), each also updating the fake's own `messages` map (update content, mark deleted) so `fetchRecentMessages` agrees with the events. Existing `emitMessageCreate` gains optional `attachments`.
- [ ] **Step 5: Gates, commit.** `npx vitest run packages/core/src/pipeline packages/discord/src` green; `npm run typecheck` 0. Commit: `feat(pipeline): messageDeleteBulk event; fetched messages carry edits and attachments (M1 task 1)`.

---

### Task 2: Config, schema, migration, PRIVACY.md — in one commit

**Files:**
- Modify: `packages/core/src/config/schema.ts`, `packages/core/src/config/schema.test.ts` (or `load.test.ts` — whichever tests `BANANASAURS_GUILD_ALLOWLIST`)
- Modify: `packages/storage/src/schema.ts`
- Create (generated): `drizzle/00NN_<name>.sql`, `drizzle/meta/*`
- Modify: `PRIVACY.md`

**Interfaces — Produces:**
```ts
// config: BANANASAURS_ARCHIVE_GUILDS: string[]  (empty when unset)
// schema.ts exports: archiveChannels, archiveMessages, archiveMessageEdits, archiveAttachments
```

- [ ] **Step 1: Config.** After `BANANASAURS_GUILD_ALLOWLIST` (`config/schema.ts:38-47`) add:
  ```ts
  /**
   * Guilds that may hold archive channels at all (ADR 0046 D1). Empty by
   * default: nothing is archived until the operator lists a guild here AND
   * enables a channel. The club guild stays off this list until /mydata and
   * /forgetme ship — that is the privacy precondition, enforced by absence.
   */
  BANANASAURS_ARCHIVE_GUILDS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(snowflake)),
  ```
  Tests: unset → `[]`; `'a,b'` with two snowflakes → both; `'not-a-snowflake'` → parse error.
- [ ] **Step 2: Tables.** In `schema.ts`, after `automodLinkDomains` (`schema.ts:844-863`), on its exact shape (`snowflake('guild_id')`, `snowflakeCheck`, cascade FK to `guilds` where there is no closer parent — read how `modCases` references `guilds`):
  ```ts
  export const archiveChannels = sqliteTable('archive_channels', {
    guildId: snowflake('guild_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    attachmentPolicy: text('attachment_policy').notNull().default('none'),
    enabledAt: integer('enabled_at').notNull(),
    cursorMessageId: text('cursor_message_id'),          // NULL = not started or done
    backfillState: text('backfill_state').notNull().default('pending'),
  }, (t) => [
    primaryKey({ columns: [t.guildId, t.channelId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('archive_channels_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('archive_channels_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('archive_channels_attachment_policy', sql`${t.attachmentPolicy} IN ('none','bytes')`),
    check('archive_channels_backfill_state', sql`${t.backfillState} IN ('pending','running','done','failed')`),
  ]);

  export const archiveMessages = sqliteTable('archive_messages', {
    guildId: snowflake('guild_id').notNull(),
    messageId: snowflake('message_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    authorId: text('author_id'),                          // NULL for webhook/system
    content: text('content'),                             // NULL after purge, or never known
    createdAt: integer('created_at').notNull(),
    editedAt: integer('edited_at'),
    deletedAt: integer('deleted_at'),
    retentionClass: text('retention_class').notNull().default('default'),
    caseId: text('case_id'),                              // PR-69; no FK
    contentPurgedAt: integer('content_purged_at'),
  }, (t) => [
    primaryKey({ columns: [t.guildId, t.messageId] }),
    foreignKey({ columns: [t.guildId, t.channelId], foreignColumns: [archiveChannels.guildId, archiveChannels.channelId] }).onDelete('cascade'),
    index('archive_messages_channel_created').on(t.guildId, t.channelId, t.createdAt),
    index('archive_messages_deleted').on(t.guildId, t.deletedAt),
    check('archive_messages_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('archive_messages_message_id_snowflake', snowflakeCheck(t.messageId)),
    check('archive_messages_retention_class', sql`${t.retentionClass} IN ('default','case','preserve')`),
  ]);

  export const archiveMessageEdits = sqliteTable('archive_message_edits', {
    guildId: snowflake('guild_id').notNull(),
    messageId: snowflake('message_id').notNull(),
    editSeq: integer('edit_seq').notNull(),
    content: text('content'),                             // the content BEFORE this edit
    editedAt: integer('edited_at').notNull(),
  }, (t) => [
    primaryKey({ columns: [t.guildId, t.messageId, t.editSeq] }),
    foreignKey({ columns: [t.guildId, t.messageId], foreignColumns: [archiveMessages.guildId, archiveMessages.messageId] }).onDelete('cascade'),
    check('archive_message_edits_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ]);

  export const archiveAttachments = sqliteTable('archive_attachments', {
    guildId: snowflake('guild_id').notNull(),
    messageId: snowflake('message_id').notNull(),
    attachmentId: snowflake('attachment_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type'),
    size: integer('size').notNull(),
    sha256: text('sha256'),                               // always NULL in M1 (PR-67)
    bytesPath: text('bytes_path'),                        // always NULL in M1 (PR-67)
  }, (t) => [
    primaryKey({ columns: [t.guildId, t.messageId, t.attachmentId] }),
    foreignKey({ columns: [t.guildId, t.messageId], foreignColumns: [archiveMessages.guildId, archiveMessages.messageId] }).onDelete('cascade'),
    check('archive_attachments_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ]);
  ```
  If `guilds`' primary key is not `guildId` or the FK helper differs, read `modCases` (`schema.ts:866-891`) and copy its exact reference. Run `npm run db:generate` once; do not edit the SQL. Run `npx vitest run packages/storage/src/schema-invariants.test.ts` — it must pass with the four new tables discovered; if it fails, fix the **schema**, never the test.
- [ ] **Step 3: PRIVACY.md.** In the retention table (`PRIVACY.md:74-77`) add rows in the same format:
  ```
  | Archived messages from channels the owner enabled | Kept until the owner disables the channel or purges; nothing is archived unless the owner lists the server and enables the channel |
  | Archived messages that were deleted | Content removed 30 days after deletion; the fact that a message existed is kept |
  | Archived messages linked to a moderation case | Content kept until the case closes, then 90 days |
  | Archived messages the owner marked preserved | Kept indefinitely; the audit log records who preserved it and when |
  | Attachments on archived messages | File name, type and size only; no file contents are downloaded |
  ```
- [ ] **Step 4: Gates, commit.** `npm run typecheck` 0, `npx vitest run packages/storage/src packages/core/src/config` green. **One commit** with the config, schema, migration and PRIVACY.md: `feat(storage): archive tables and migration; BANANASAURS_ARCHIVE_GUILDS; PRIVACY.md archive rows (M1 task 2)`.

---

### Task 3: The repository — tests first

**Files:**
- Create: `packages/storage/src/repos/archive.ts`, `packages/storage/src/repos/archive.test.ts`
- Modify: `packages/storage/src/index.ts` (export)

**Interfaces — Produces (all `GuildScope`-first, all through `read`/`write` from `../write.js`):**
```ts
export type AttachmentPolicy = 'none' | 'bytes';
export type BackfillState = 'pending' | 'running' | 'done' | 'failed';
export type RetentionClass = 'default' | 'case' | 'preserve';
export interface ArchiveChannel { channelId: string; attachmentPolicy: AttachmentPolicy; enabledAt: number; cursorMessageId: string | undefined; backfillState: BackfillState }
export interface ArchiveAttachmentInput { attachmentId: string; filename: string; contentType: string | undefined; size: number }
export interface UpsertMessageInput { messageId: string; channelId: string; authorId: string | undefined; content: string | undefined; createdAt: number; editedAt: number | undefined; attachments: readonly ArchiveAttachmentInput[] }

export const enableChannel = (scope, input: { channelId: string; attachmentPolicy: AttachmentPolicy; now: number }): 'enabled' | 'already-enabled';
export const disableChannel = (scope, channelId: string): 'disabled' | 'not-enabled';   // deletes the row; cascades
export const isChannelEnabled = (scope, channelId: string): boolean;
export const listChannels = (scope): ArchiveChannel[];                                   // ordered by channelId
export const findChannel = (scope, channelId: string): ArchiveChannel | undefined;
export const setBackfillCursor = (scope, input: { channelId: string; cursorMessageId: string | undefined; state: BackfillState }): void;
/** INSERT ... ON CONFLICT(guild_id, message_id) DO NOTHING; attachments likewise. Returns true when the message row was new. Live rows and backfill rows never overwrite each other. */
export const upsertMessage = (scope, input: UpsertMessageInput): boolean;
/** Appends an edit row holding the PREVIOUS content (edit_seq = count+1), then sets content/edited_at. 'no-such-message' when the row is absent (an edit to a message created before the channel was enabled — Discord sends full content on update, so the caller may upsert first; this function does not). */
export const recordEdit = (scope, input: { messageId: string; content: string | undefined; editedAt: number }): 'recorded' | 'no-such-message';
/** Sets deleted_at if null. 'no-such-message' when absent; 'already-deleted' when deleted_at was set. */
export const recordDelete = (scope, input: { messageId: string; deletedAt: number }): 'recorded' | 'no-such-message' | 'already-deleted';
export const recordBulkDelete = (scope, input: { messageIds: readonly string[]; deletedAt: number }): number;  // rows newly marked
export const markPreserve = (scope, messageId: string): 'preserved' | 'no-such-message' | 'already-preserved';
/** PR-69: requires the case to exist in scope with status 'open' (read through mod_cases; never written). */
export const linkToCase = (scope, input: { messageId: string; caseId: string }): 'linked' | 'no-such-message' | 'no-such-case' | 'case-closed' | 'already-linked';
/** Latest mod_case_events.at for a closed case, else undefined. Read-only. */
export const caseClosedAt = (scope, caseId: string): number | undefined;
/**
 * The three tiers (ADR 0046 D3). Purges content (content = NULL, content_purged_at = now)
 * and deletes the message's edit rows, for rows where deleted_at IS NOT NULL AND content IS NOT NULL AND:
 *   default:  deleted_at <= now - 30d
 *   case:     caseClosedAt(caseId) is defined AND caseClosedAt <= now - 90d
 *   preserve: never
 * Returns the count purged. One transaction.
 */
export const expireContent = (scope, now: number): number;
export const countMessages = (scope, channelId: string): number;
export const ARCHIVE_DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ARCHIVE_CASE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
```

- [ ] **Step 1: The five failing tests, plus two-guild.** In `archive.test.ts`, using the same in-memory DB helper as `automod-admin.test.ts` (read its top 40 lines for `openTestDb`/scope construction and the guild seeding — copy that exactly), write and **watch fail** (commit the red run as step 1's commit):
  - (c) `expireContent` at `deletedAt + 30d` nulls `content`, stamps `content_purged_at`, deletes the edit rows, keeps the row; at `+30d − 1ms` purges nothing.
  - (d) a `case`-class message whose case is **open** survives `+400d`; whose case is **closed** (seed `mod_cases` row with `status='closed'` and one `mod_case_events` row at `T` — seed through raw `db.insert` on the tables, not through any mod writer) purges at `T + 90d` and not at `T + 90d − 1ms`.
  - (e) two guilds: seed guild B with a colliding `messageId`/`channelId`; every read/write above under A leaves B's rows untouched and invisible (assert `listChannels`, `countMessages`, `findChannel`, `upsertMessage` returning `true` for the same id in the other guild, `recordDelete` under A not marking B).
  - `preserve` never purges at `+10y`.
  - `upsertMessage` twice with different content returns `true` then `false` and keeps the first content.
  - `recordEdit` appends `edit_seq` 1 then 2 holding the previous contents.
  - `linkToCase` on a closed case → `'case-closed'`; on an unknown case → `'no-such-case'`.
  Tests (a) and (b) — the vetoes — belong to Task 4's subscriber; note that in a comment.
- [ ] **Step 2: Implement** `archive.ts` on `mod-cases.ts`'s conventions (`read`/`write`, `scope.only`, `now` passed in). `expireContent` in one `write` transaction: select candidate rows, filter per tier in JS using `caseClosedAt` for `case` rows (there will be few), then `UPDATE` and `DELETE FROM archive_message_edits` for the ids.
- [ ] **Step 3: Export** from `packages/storage/src/index.ts` as `archiveRepo` (read how `automodAdminRepo` is exported and mirror it).
- [ ] **Step 4: Gates, commit.** `npx vitest run packages/storage/src/repos/archive.test.ts` green; typecheck 0. Commit: `feat(storage): archive repository — channels, messages, edits, deletes, preserve, case link, three-tier expiry (M1 task 3)`.

---

### Task 4: The live subscriber, with both vetoes and the guild allowlist — tests first

**Files:**
- Create: `packages/core/src/archive/subscriber.ts`, `packages/core/src/archive/subscriber.test.ts`, `packages/core/src/archive/ports.ts`
- Modify: `packages/core/src/index.ts` (export), `apps/daemon/src/runtime/guild.ts` (wire after `createAutomodSubscriber`, `guild.ts:589-611`), `apps/daemon/src/archive.integration.test.ts` (create)

**Interfaces — Produces:**
```ts
// packages/core/src/archive/ports.ts — core may not import storage; re-declare
export interface ArchivePorts {
  /** ADR 0046 D1: the guild must be in BANANASAURS_ARCHIVE_GUILDS. Closed over by the daemon. */
  readonly guildArchiveEnabled: boolean;
  isChannelEnabled(channelId: string): boolean;
  isChannelExcluded(channelId: string): boolean;          // log_excluded_channels
  upsertMessage(input: UpsertMessageInput): boolean;
  recordEdit(input: { messageId; content; editedAt }): 'recorded' | 'no-such-message';
  recordDelete(input: { messageId; deletedAt }): 'recorded' | 'no-such-message' | 'already-deleted';
  recordBulkDelete(input: { messageIds; deletedAt }): number;
  readonly logger: Logger;
}
export const createArchiveSubscriber = (ports: ArchivePorts): Subscriber;   // name: 'archive'
```

- [ ] **Step 1: Failing veto tests.** In `subscriber.test.ts` with a hand-rolled fake `ArchivePorts` (a Map-backed store; assert on calls, not mocks): (a) `messageCreate` in a channel not enabled → `upsertMessage` never called; (b) enabled but excluded → never called; (a′) enabled, not excluded, but `guildArchiveEnabled: false` → never called; the positive case → called once with `content`, `authorId`, `createdAt = receivedAtMs`, `editedAt`, and attachments mapped `{ attachmentId, filename: fileName, contentType, size: sizeBytes }`. Watch all fail against a subscriber whose `handle` is empty; commit the red run.
- [ ] **Step 2: Implement.** `handle(event)`: return unless `event.kind` is one of the four; return unless `guildArchiveEnabled`; for `messageDeleteBulk` there is no per-message channel → use `event.channelId`; check enabled then excluded; then:
  - `messageCreate` → `upsertMessage`.
  - `messageUpdate` → `recordEdit({ messageId, content, editedAt: editedTimestampMs ?? receivedAtMs })`; on `'no-such-message'` → `upsertMessage` with the event's fields (the message predates enablement; Discord sends full content on update) and log at debug `{ messageId, channelId }` `'archive: edit to unknown message, inserted'`.
  - `messageDelete` → `recordDelete({ messageId, deletedAt: receivedAtMs })`; `'no-such-message'` is silent (a message we never held).
  - `messageDeleteBulk` → `recordBulkDelete`.
  Bot-authored messages are archived too (the archive is a record, not a filter); a test says so.
- [ ] **Step 3: Wire.** In `guild.ts`, build `archivePorts` from `archiveRepo` + `loggingRepo.isChannelExcluded` (the logging port already closes over it, `guild.ts:259`) + `config.BANANASAURS_ARCHIVE_GUILDS.includes(guildId)` and append `createArchiveSubscriber(archivePorts)` **after** `createAutomodSubscriber(...)` in the `subscribers` array, with a comment: "after automod so a message the automod deletes is archived as created-then-deleted (ADR 0046 D5); read-side only". Read how `config` reaches `guild.ts` (it may need threading from `daemon.ts`).
- [ ] **Step 4: Integration test.** `apps/daemon/src/archive.integration.test.ts` on `automod.integration.test.ts`'s harness: with the guild listed and a channel enabled through `archiveRepo.enableChannel`, `fake.emitMessageCreate` → one row; `emitMessageUpdate` → edit row + new content; `emitMessageDelete` → `deleted_at` set; `emitMessageDeleteBulk` of two → both marked; replaying the same create (same `messageId`) → still one row (dedupe). With the guild **not** listed → zero rows for the same sequence.
- [ ] **Step 5: Gates, commit.** Commit: `feat(archive): live subscriber after automod — three vetoes, create/edit/delete/bulk (M1 task 4)`.

---

### Task 5: Backfill and expiry jobs; the daily timer

**Files:**
- Modify: `packages/core/src/jobs/kinds.ts`
- Create: `packages/core/src/archive/backfill.ts`, `packages/core/src/archive/backfill.test.ts`, `packages/core/src/archive/expiry.ts`, `packages/core/src/archive/expiry.test.ts`
- Create: `apps/daemon/src/runtime/archive-expiry-timer.ts`, `apps/daemon/src/runtime/archive-expiry-timer.test.ts`
- Modify: `apps/daemon/src/runtime/guild.ts` (register both handlers in the `JobWorker` handlers array, `guild.ts:613-628`), `apps/daemon/src/runtime/daemon.ts` (start/stop the timer beside the backup timer)

**Interfaces — Produces:**
```ts
// kinds.ts
JOB_KINDS.archiveBackfill = 'archive_backfill'; JOB_KINDS.archiveExpiry = 'archive_expiry';
export const archiveBackfillPayload = z.object({ channelId: snowflakeIdSchema });
export const archiveBackfillDedupeKey = (channelId: string) => `${JOB_KINDS.archiveBackfill}:${channelId}`;   // ADR 0016 (guild, channel)
export const archiveExpiryPayload = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export const archiveExpiryDedupeKey = (day: string) => `${JOB_KINDS.archiveExpiry}:${day}`;
// backfill.ts
export interface BackfillPorts {
  fetchRecentMessages(channelId: string, before: string | undefined): Promise<RecentMessagesPage>;   // limit 100, through DiscordPort
  findChannel(channelId): ArchiveChannel | undefined;
  upsertMessage(input: UpsertMessageInput): boolean;
  setBackfillCursor(input: { channelId; cursorMessageId; state }): void;
  enqueueContinuation(input: { channelId: string; runAfter: number }): void;
  now(): number; readonly logger: Logger;
}
export const archiveBackfillHandler = (ports: BackfillPorts): JobHandler<{ channelId: string }>;
// expiry.ts
export const archiveExpiryHandler = (ports: { expireContent(now: number): number; now(): number; logger: Logger }): JobHandler<{ day: string }>;
// archive-expiry-timer.ts — on backup-timer.ts's shape
export function createArchiveExpiryTimer(deps: { guilds: () => readonly { scope: GuildScope }[]; enqueue(scope, input: EnqueueInput): unknown; now(): number; logger: Logger }): { runOnce(): void; start(): void; stop(): void };
```

- [ ] **Step 1: Backfill handler, resume test first.** `run({ channelId })`: `findChannel` — absent (disabled mid-backfill) → log and return (job done). Set state `running`. `fetchRecentMessages(channelId, channel.cursorMessageId)`; for each message `upsertMessage` (attachments from `FetchedMessage.attachments`, `editedAt` from `editedTimestampMs`, `createdAt` from `createdAtMs`); then **persist the cursor before anything else**: `setBackfillCursor({ channelId, cursorMessageId: page.nextBefore, state: page.nextBefore === undefined ? 'done' : 'running' })`; if `nextBefore` defined, `enqueueContinuation({ channelId, runAfter: now() })`. A `DiscordApiError` with `isRateLimit` **propagates** (the worker's backoff is the retry, ADR 0018) — do not catch it. Tests with a hand-rolled `BackfillPorts` over `FakeDiscord` seeded with 250 messages: three runs land 250 rows, the cursor after run 1 is the 100th id, state `done` after run 3 and no further continuation; **the resume test**: run 1, then construct a *new* handler over the same store (simulating a restart) and run 2 — it starts from the persisted cursor and never re-fetches page 1 (assert `fake.calls` for `fetchRecentMessages` carry `before = cursor`). A `rateLimited` failure injected on run 2 leaves the cursor at run 1's value and throws.
- [ ] **Step 2: Expiry handler and timer.** `archiveExpiryHandler.run({ day })` → `const n = expireContent(now())`; log `{ jobKind, count: n }` at info. Test with a frozen clock at day 29 / 30 / 31 after a deletion: 0 / 1 / 1 purged (use `archiveRepo` on the test DB — this is where the 30-day boundary is exercised end-to-end). The timer, on `backup-timer.ts:60-100`'s shape: `runOnce` enqueues `{ kind: archiveExpiry, payload: JSON.stringify({ day }), dedupeKey: archiveExpiryDedupeKey(day), now }` for every guild, where `day` is the UTC date of `now()`; `start` runs once then every 24 h with `unref()`. Test: two `runOnce` calls on the same day enqueue one job per guild (the dedupe index refuses the second — assert through the real `jobRepo` on a test DB); the next day enqueues again.
- [ ] **Step 3: Wire.** Register `archiveBackfillHandler` and `archiveExpiryHandler` in `guild.ts`'s handlers array with ports built from `archiveRepo`, the guild's `DiscordPort` (`fetchRecentMessages(guildId, channelId, { before, limit: 100 })`), and `jobRepo.enqueue` for the continuation (copy `enqueuePurgeContinuation`'s shape, `guild.ts:370-378`, with `archiveBackfillDedupeKey`). Start the timer in `daemon.ts` next to the backup timer and stop it in the same shutdown path.
- [ ] **Step 4: Gates, commit.** Commit: `feat(archive): resumable backfill job, three-tier expiry job, daily expiry timer (M1 task 5)`.

---

### Task 6: Operator surface — ports ×4, five commands, two doctor lines

**Files:**
- Modify: `packages/core/src/ops/ports.ts`, `apps/daemon/src/ops/wiring.ts`, `packages/http/src/test-support.ts`, `packages/core/src/ops/test-fixtures.ts`, `packages/storage/src/repos/automod-rule-lists.test.ts`
- Create: `packages/core/src/ops/commands/archive.ts`, `packages/core/src/ops/commands/archive.test.ts`
- Modify: `packages/core/src/ops/registry.ts`, `apps/daemon/src/runtime/doctor.ts`, `apps/daemon/src/runtime/doctor.test.ts` (if present; else the doctor's existing test file)

**Interfaces — Produces (`OpsPorts` members):**
```ts
archiveEnableChannel(input: { channelId: string; attachmentPolicy: 'none' | 'bytes' }): 'enabled' | 'already-enabled' | 'guild-not-archive-enabled';
archiveDisableChannel(channelId: string): 'disabled' | 'not-enabled';
archiveStatus(): readonly { channelId; attachmentPolicy; enabledAt; cursorMessageId; backfillState; messageCount: number }[];
archivePreserve(messageId: string): 'preserved' | 'no-such-message' | 'already-preserved';
archiveLinkCase(input: { messageId; caseId }): 'linked' | 'no-such-message' | 'no-such-case' | 'case-closed' | 'already-linked';
enqueueArchiveBackfill(channelId: string): void;
/** doctor: archive-enabled channels the bot cannot read (ViewChannel + ReadMessageHistory). */
listUnreadableArchiveChannels(): readonly { channelId: string; reason: 'missing' | 'no-view' | 'no-history' }[];
```

- [ ] **Step 1: Ports ×4.** Declare the seven members in `ports.ts` with doc comments on the file's shape; implement in `wiring.ts` over `archiveRepo` and `jobRepo.enqueue` (backfill dedupe key), with `guildArchiveEnabled` from config closed over (`'guild-not-archive-enabled'` when false — **before** any write); `test-support.ts` the same over the test DB with a settable `archiveGuildEnabled` flag; `test-fixtures.ts` `unstubbed(...)` ×7; `automod-rule-lists.test.ts` `notNeeded(...)` ×7. `listUnreadableArchiveChannels` in `wiring.ts` reads the discord.js guild the way `doctor.ts:255-275` computes `held` — if that object is not reachable from `wiring.ts`, implement the check inside `doctor.ts` instead and make the port return the channel list only; say which in the report.
- [ ] **Step 2: Commands.** In `commands/archive.ts` on `commands/automod.ts:1145-1170`'s `defineCommand` shape, `write: true` where noted, args through Zod:
  - `archive enable-channel <channelId> [--attachments none|bytes]` (write): `bytes` → usage answer `{ ok: false, reason: 'attachments-bytes-not-built' }` (PR-67) **before** calling the port; `'guild-not-archive-enabled'` → `{ ok: false, reason, guildId, variable: 'BANANASAURS_ARCHIVE_GUILDS' }`; `'enabled'` → enqueue backfill, audit `archive.channel_enabled` with `after: { channelId, attachmentPolicy }`; `'already-enabled'` → `{ ok: false, reason }`, no audit.
  - `archive disable-channel <channelId>` (write): audit `archive.channel_disabled`.
  - `archive status` (read): one line per channel: `channelId  policy  backfill:<state>  cursor:<id|–>  messages:<n>`.
  - `archive preserve <messageId>` (write): audit `archive.message_preserved`, subjectId = messageId.
  - `archive link-case <messageId> <caseId>` (write): audit `archive.message_linked_to_case`, `after: { caseId }`.
  Register all five in `OPERATOR_COMMANDS`. Tests in `commands/archive.test.ts` on `commands/automod.test.ts`'s harness: every outcome above, the `bytes` refusal never reaching the port, and that each write returns an audit record (the dispatcher records it — `dispatch.ts:316-335`).
- [ ] **Step 3: Doctor.** In `doctor.ts`'s report: (i) every id in `config.BANANASAURS_ARCHIVE_GUILDS` not in `BANANASAURS_GUILD_ALLOWLIST` → `  ARCHIVE GUILD NOT ALLOWLISTED: <id>` and `ok: false`; (ii) per guild, each unreadable archive channel → `    ARCHIVE CHANNEL UNREADABLE: <channelId> (<reason>)` and `ok: false`. Tests: one of each, and the clean case.
- [ ] **Step 4: Gates, commit.** Commit: `feat(ops): archive commands, ports x4, doctor archive lines (M1 task 6)`.

---

## Self-review notes

- Spec coverage: schema ✓ (T2), repo ✓ (T3), subscriber + vetoes ✓ (T4), backfill + resume ✓ (T5), attachments → metadata only, bytes refused (PR-67) ✓ (T2/T6), expiry three tiers + day 29/30/31 ✓ (T3/T5), CLI ✓ (T6), PRIVACY.md ✓ (T2), doctor ✓ (T6), bulk delete (PR-66) ✓ (T1/T4), case link (PR-69) ✓ (T3/T6), daily producer (PR-70) ✓ (T5).
- Names used across tasks: `archiveRepo.*` as declared in T3; `UpsertMessageInput.attachments[].filename/size` (repo) vs `MessageAttachment.fileName/sizeBytes` (events) — the subscriber and backfill map between them; `ArchiveChannel.cursorMessageId: string | undefined`.
- Not in M1: search, MCP, dashboard, attachment bytes, automatic case linking.
