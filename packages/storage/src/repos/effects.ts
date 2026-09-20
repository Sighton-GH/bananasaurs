import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, isNull, ne, notInArray, or } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { auditEvents, effectBatches, managedRoleAssignments, roleEffects } from '../schema.js';

/**
 * Effects, batches and the audit trail.
 *
 * The batch is the unit of undo: every effect belongs to one, so
 * `bananasaurs undo <batch>` has something to name and the audit trail has
 * something to group by.
 */

export interface OpenBatchInput {
  batchId?: string;
  source: 'interaction' | 'reaction' | 'adoption' | 'reconcile' | 'cli' | 'dashboard';
  actorType: string;
  actorId: string | undefined;
  now: number;
}

export const openBatch = (scope: GuildScope, input: OpenBatchInput): string =>
  write(scope, ({ db }) => {
    const batchId = input.batchId ?? randomUUID();
    db.insert(effectBatches)
      .values({
        guildId: scope.guildId,
        batchId,
        source: input.source,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        startedAt: input.now,
      })
      .onConflictDoNothing()
      .run();
    return batchId;
  });

export const closeBatch = (scope: GuildScope, batchId: string, now: number): void =>
  write(scope, ({ db }) => {
    db.update(effectBatches)
      .set({ finishedAt: now })
      .where(scope.only(effectBatches, eq(effectBatches.batchId, batchId)))
      .run();
  });

export const markBatchUndone = (scope: GuildScope, batchId: string, now: number): void =>
  write(scope, ({ db }) => {
    db.update(effectBatches)
      .set({ undoneAt: now })
      .where(scope.only(effectBatches, eq(effectBatches.batchId, batchId)))
      .run();
  });

export interface BatchRow {
  batchId: string;
  source: string;
  actorType: string;
  actorId: string | null;
  startedAt: number;
  finishedAt: number | null;
  undoneAt: number | null;
}

export const findBatch = (scope: GuildScope, batchId: string): BatchRow | undefined =>
  read(scope, (db) =>
    db
      .select({
        batchId: effectBatches.batchId,
        source: effectBatches.source,
        actorType: effectBatches.actorType,
        actorId: effectBatches.actorId,
        startedAt: effectBatches.startedAt,
        finishedAt: effectBatches.finishedAt,
        undoneAt: effectBatches.undoneAt,
      })
      .from(effectBatches)
      .where(scope.only(effectBatches, eq(effectBatches.batchId, batchId)))
      .get(),
  );

export interface ClaimEffectInput {
  dedupeKey: string;
  batchId: string;
  userId: string;
  roleId: string;
  action: 'grant' | 'revoke';
  hadRoleBefore: boolean;
  panelId: string | undefined;
  now: number;
}

export interface ClaimResult {
  /** False when this exact effect was already recorded — a replay. */
  claimed: boolean;
  effectId: string;
}

/**
 * **The idempotency constraint, exercised.**
 *
 * `role_effects_dedupe` is UNIQUE on `(guild_id, dedupe_key)`. An insert that
 * conflicts changes zero rows, and zero rows means this effect already
 * happened — so the caller skips the REST call rather than performing it a
 * second time. Gateway events replay on reconnect; this is what makes that
 * harmless rather than a double grant.
 *
 * The existing effect id is returned on a conflict so the caller can still
 * point at the original in logs and in the audit trail.
 */
export const claimEffect = (scope: GuildScope, input: ClaimEffectInput): ClaimResult =>
  write(scope, ({ db }) => {
    const effectId = randomUUID();
    const result = db
      .insert(roleEffects)
      .values({
        guildId: scope.guildId,
        effectId,
        batchId: input.batchId,
        dedupeKey: input.dedupeKey,
        userId: input.userId,
        roleId: input.roleId,
        action: input.action,
        state: 'planned',
        hadRoleBefore: input.hadRoleBefore ? 1 : 0,
        panelId: input.panelId ?? null,
        attemptedAt: input.now,
      })
      .onConflictDoNothing()
      .run();

    if (result.changes === 1) return { claimed: true, effectId };

    const existing = db
      .select({ effectId: roleEffects.effectId })
      .from(roleEffects)
      .where(scope.only(roleEffects, eq(roleEffects.dedupeKey, input.dedupeKey)))
      .get();
    return { claimed: false, effectId: existing?.effectId ?? effectId };
  });

export interface RecordOutcomeInput {
  effectId: string;
  state: 'applied' | 'failed' | 'dry_run' | 'skipped';
  completedAt: number;
  errorCode?: string | undefined;
}

export const recordOutcome = (scope: GuildScope, input: RecordOutcomeInput): void =>
  write(scope, ({ db }) => {
    db.update(roleEffects)
      .set({
        state: input.state,
        completedAt: input.completedAt,
        errorCode: input.errorCode ?? null,
      })
      .where(scope.only(roleEffects, eq(roleEffects.effectId, input.effectId)))
      .run();
  });

export interface EffectRow {
  effectId: string;
  batchId: string;
  userId: string;
  roleId: string;
  action: string;
  state: string;
  hadRoleBefore: number;
  panelId: string | null;
  completedAt: number | null;
  errorCode: string | null;
}

const effectColumns = {
  effectId: roleEffects.effectId,
  batchId: roleEffects.batchId,
  userId: roleEffects.userId,
  roleId: roleEffects.roleId,
  action: roleEffects.action,
  state: roleEffects.state,
  hadRoleBefore: roleEffects.hadRoleBefore,
  panelId: roleEffects.panelId,
  completedAt: roleEffects.completedAt,
  errorCode: roleEffects.errorCode,
};

export const effectsInBatch = (scope: GuildScope, batchId: string): EffectRow[] =>
  read(scope, (db) =>
    db
      .select(effectColumns)
      .from(roleEffects)
      .where(scope.only(roleEffects, eq(roleEffects.batchId, batchId)))
      .all(),
  );

export const findEffect = (scope: GuildScope, effectId: string): EffectRow | undefined =>
  read(scope, (db) =>
    db
      .select(effectColumns)
      .from(roleEffects)
      .where(scope.only(roleEffects, eq(roleEffects.effectId, effectId)))
      .get(),
  );

/**
 * Did we just do this ourselves?
 *
 * Amendment 5: `GUILD_MEMBER_UPDATE` fires for our own mutations too. Naively
 * repairing on every update produces a feedback loop in which the bot reacts to
 * its own grant, re-grants, and reacts again. The handler ignores a delta that
 * matches an effect completed inside a short window and treats only the
 * remainder as external drift.
 *
 * Backed by the `role_effects_recent` index; without it this is a scan on the
 * busiest table in the schema.
 */
export const wasRecentlyApplied = (
  scope: GuildScope,
  input: { userId: string; roleId: string; sinceMs: number; action?: 'grant' | 'revoke' },
): boolean =>
  read(scope, (db) => {
    const row = db
      .select({ effectId: roleEffects.effectId })
      .from(roleEffects)
      .where(
        scope.only(
          roleEffects,
          and(
            eq(roleEffects.userId, input.userId),
            eq(roleEffects.roleId, input.roleId),
            eq(roleEffects.state, 'applied'),
            gte(roleEffects.completedAt, input.sinceMs),
            // Optional, and the caller that matters always passes it. Without a
            // direction, our own grant of a role makes a *removal* of that same
            // role inside the window look like ours too — so a moderator taking
            // the role away seconds later is silently ignored until the timer
            // pass. Matching the direction keeps the loop suppressed (our grant
            // echoes as an addition, and we did grant) while leaving the
            // opposite move visible as the external change it is.
            input.action === undefined ? undefined : eq(roleEffects.action, input.action),
          ),
        ),
      )
      .get();
    return row !== undefined;
  });

// --- managed role assignments (provenance, not current state) ---------------

/**
 * Records which panel granted a role, when, under which effect.
 *
 * Amendment 4: this is **not** the source of truth for current state. Discord
 * is. Convergence diffs the desired set against the member's live Discord
 * roles, because a role removed by hand would otherwise leave this table
 * reading "granted", convergence would compute an empty change set, and the
 * drift would never be repaired.
 */
export const recordAssignment = (
  scope: GuildScope,
  input: { userId: string; roleId: string; panelId: string; effectId: string; now: number },
): void =>
  write(scope, ({ db }) => {
    db.insert(managedRoleAssignments)
      .values({
        guildId: scope.guildId,
        userId: input.userId,
        roleId: input.roleId,
        panelId: input.panelId,
        grantedAt: input.now,
        grantedByEffect: input.effectId,
      })
      .onConflictDoUpdate({
        target: [
          managedRoleAssignments.guildId,
          managedRoleAssignments.userId,
          managedRoleAssignments.roleId,
        ],
        set: { panelId: input.panelId, grantedAt: input.now, grantedByEffect: input.effectId },
      })
      .run();
  });

/**
 * The members this panel is known to have granted a role to.
 *
 * **A candidate list, not a diff.** Amendment 4 forbids deciding what to change
 * by comparing against this table, and this does not: it answers "who is worth
 * looking at", after which reconciliation reads the member's live roles and the
 * message's live reactions and diffs *those*. The distinction matters because
 * without it a reaction withdrawn while the bot was offline is unrepairable —
 * the member is in no reaction set, so a pass driven only by reactors never
 * visits them and the role stays forever.
 *
 * A row is deleted as soon as the role is revoked, so the list stays the size
 * of the panel's current membership rather than growing with its history.
 */
export const listAssignedUsers = (scope: GuildScope, panelId: string): string[] =>
  read(scope, (db) =>
    db
      .selectDistinct({ userId: managedRoleAssignments.userId })
      .from(managedRoleAssignments)
      .where(scope.only(managedRoleAssignments, eq(managedRoleAssignments.panelId, panelId)))
      .all()
      .map((r) => r.userId),
  );

export const removeAssignment = (
  scope: GuildScope,
  input: { userId: string; roleId: string },
): void =>
  write(scope, ({ db }) => {
    db.delete(managedRoleAssignments)
      .where(
        scope.only(
          managedRoleAssignments,
          and(
            eq(managedRoleAssignments.userId, input.userId),
            eq(managedRoleAssignments.roleId, input.roleId),
          ),
        ),
      )
      .run();
  });

// --- audit ------------------------------------------------------------------

export interface AuditRecordInput {
  at: number;
  actorType: string;
  actorId: string | undefined;
  actorUnixUserClaimed?: string | undefined;
  via?: 'ssh' | 'http' | 'gateway' | undefined;
  action: string;
  subjectType: string;
  subjectId: string | undefined;
  batchId?: string | undefined;
  before?: unknown;
  after?: unknown;
  dryRun: boolean;
  /** REVIEW C4: attribution from the Discord audit log is a guess. */
  inferred?: boolean;
}

export const recordAudit = (scope: GuildScope, input: AuditRecordInput): void =>
  write(scope, ({ db }) => {
    db.insert(auditEvents)
      .values({
        guildId: scope.guildId,
        at: input.at,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        actorUnixUserClaimed: input.actorUnixUserClaimed ?? null,
        via: input.via ?? null,
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId ?? null,
        batchId: input.batchId ?? null,
        before: input.before === undefined ? null : JSON.stringify(input.before),
        after: input.after === undefined ? null : JSON.stringify(input.after),
        dryRun: input.dryRun ? 1 : 0,
        inferred: input.inferred === true ? 1 : 0,
      })
      .run();
  });

export interface AuditRow {
  auditId: number;
  at: number;
  actorType: string;
  actorId: string | null;
  actorUnixUserClaimed: string | null;
  /** `ssh` (operator socket) | `http` (dashboard) | `gateway` (Discord). */
  via: string | null;
  action: string;
  subjectType: string;
  subjectId: string | null;
  batchId: string | null;
  before: string | null;
  after: string | null;
  dryRun: number;
  inferred: number;
}

export interface TailAuditInput {
  limit?: number | undefined;
  /** `--since 2h`, as an absolute millisecond timestamp the caller computed. */
  sinceMs?: number | undefined;
  /**
   * The caller's *own* reads to leave out of the result (ADR 0050):
   * `list_audit_events` audits its own reads, and the tool must not return
   * the rows the caller's own reads generate — otherwise watching the trail
   * makes it grow. Both halves are required together: an action alone would
   * hide every operator's reads of the trail, so a second operator's
   * trail-reading would be invisible to the first, which is the opposite of
   * what an audit trail is for.
   *
   * Filtered in SQL, not in memory: a post-limit filter would let a page
   * full of excluded rows empty the result while older, wanted rows exist.
   * An empty action list filters nothing.
   */
  excludeOwnActions?: { readonly actions: readonly string[]; readonly actorId: string } | undefined;
}

/**
 * `NOT (action IN (...) AND actor_id = <me>)`, written as its De Morgan
 * twin so a NULL `actor_id` cannot swallow a row. `actor_id` is nullable —
 * SSH-originated rows carry none — and in SQL `NULL = 'tok_x'` is NULL, not
 * false, so the negation of the naive form evaluates to NULL and the row
 * silently vanishes from the page. The explicit `IS NULL` arm keeps every
 * row that is not provably the caller's own.
 */
const notOwnAction = (own: { readonly actions: readonly string[]; readonly actorId: string }) =>
  or(
    notInArray(auditEvents.action, [...own.actions]),
    isNull(auditEvents.actorId),
    ne(auditEvents.actorId, own.actorId),
  );

/**
 * Newest first, on the `audit_tail` index.
 *
 * The `since` bound is an absolute timestamp rather than a duration: parsing
 * "2h" is presentation, and a repository that took a duration would need a
 * clock, which is the one thing a query has no business owning.
 */
export const tailAudit = (scope: GuildScope, input: TailAuditInput = {}): AuditRow[] =>
  read(scope, (db) =>
    db
      .select({
        auditId: auditEvents.auditId,
        at: auditEvents.at,
        actorType: auditEvents.actorType,
        actorId: auditEvents.actorId,
        actorUnixUserClaimed: auditEvents.actorUnixUserClaimed,
        via: auditEvents.via,
        action: auditEvents.action,
        subjectType: auditEvents.subjectType,
        subjectId: auditEvents.subjectId,
        batchId: auditEvents.batchId,
        before: auditEvents.before,
        after: auditEvents.after,
        dryRun: auditEvents.dryRun,
        inferred: auditEvents.inferred,
      })
      .from(auditEvents)
      .where(
        scope.only(
          auditEvents,
          and(
            input.sinceMs === undefined ? undefined : gte(auditEvents.at, input.sinceMs),
            input.excludeOwnActions === undefined || input.excludeOwnActions.actions.length === 0
              ? undefined
              : notOwnAction(input.excludeOwnActions),
          ),
        ),
      )
      .orderBy(desc(auditEvents.at), desc(auditEvents.auditId))
      .limit(input.limit ?? 50)
      .all(),
  );
