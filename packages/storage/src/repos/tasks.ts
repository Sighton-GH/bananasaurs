import { randomUUID } from 'node:crypto';
import { eq, isNull, asc, and, sql } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write, type WriteTx } from '../write.js';
import {
  auditEvents,
  clubTasks,
  taskAssignees,
  taskChildren,
  taskMessageAnchors,
  taskNudgeSlots,
  taskNudgeSlotTasks,
  taskQuietHours,
  taskReports,
  taskTeams,
} from '../schema.js';

/** Who performed a task write. Recorded verbatim on the audit row. */
export interface TaskActor {
  readonly actorType: 'dashboard' | 'mcp_operator' | 'member';
  readonly actorId: string;
  readonly via: 'http' | 'gateway';
}

const audit = (
  db: WriteTx['db'],
  scope: GuildScope,
  actor: TaskActor,
  now: number,
  action: string,
  subjectType: string,
  subjectId: string,
  before: unknown,
  after: unknown,
) =>
  db
    .insert(auditEvents)
    .values({
      guildId: scope.guildId,
      at: now,
      actorType: actor.actorType,
      actorId: actor.actorId,
      via: actor.via,
      action,
      subjectType,
      subjectId,
      before: before === undefined ? null : JSON.stringify(before),
      after: after === undefined ? null : JSON.stringify(after),
      dryRun: 0,
    })
    .run();

export interface NewTeam {
  readonly name: string;
  readonly categoryId: string;
  readonly kind: 'subteam' | 'exec';
  readonly announcementChannelId?: string | undefined;
  readonly leadRoleId?: string | undefined;
  readonly memberRoleId?: string | undefined;
}
export interface NewTask {
  readonly teamId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly priority?: 'normal' | 'urgent' | undefined;
  readonly assignmentKind: 'team' | 'individual';
  readonly assigneeId?: string | undefined;
  readonly assigneeIds?: readonly string[] | undefined;
  readonly dueAt: number;
  readonly timezone: string;
  readonly destinationId: string;
  readonly createdBy: string;
  readonly extraReminderAt?: readonly number[] | undefined;
}
export type TaskRow = typeof clubTasks.$inferSelect;

export const listTeams = (scope: GuildScope) =>
  read(scope, (db) =>
    db.select().from(taskTeams).where(scope.only(taskTeams)).orderBy(asc(taskTeams.name)).all(),
  );

export const createTeam = (
  scope: GuildScope,
  input: NewTeam,
  actor: TaskActor,
  now: number,
): string => {
  const teamId = randomUUID();
  write(scope, ({ db }) => {
    const existing = db
      .select({ teamId: taskTeams.teamId })
      .from(taskTeams)
      .where(scope.only(taskTeams, eq(taskTeams.categoryId, input.categoryId)))
      .get();
    if (existing) throw new Error('category-in-use');
    db.insert(taskTeams)
      .values({
        guildId: scope.guildId,
        teamId,
        name: input.name,
        categoryId: input.categoryId,
        kind: input.kind,
        announcementChannelId: input.announcementChannelId ?? null,
        leadRoleId: input.leadRoleId ?? null,
        memberRoleId: input.memberRoleId ?? null,
        createdAt: now,
      })
      .run();
    audit(db, scope, actor, now, 'task.team_created', 'task_team', teamId, undefined, {
      name: input.name,
      categoryId: input.categoryId,
      kind: input.kind,
    });
  });
  return teamId;
};

export const updateTeam = (
  scope: GuildScope,
  teamId: string,
  patch: {
    readonly name?: string | undefined;
    readonly announcementChannelId?: string | null | undefined;
    readonly leadRoleId?: string | null | undefined;
    readonly memberRoleId?: string | null | undefined;
  },
  actor: TaskActor,
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    const before = db
      .select()
      .from(taskTeams)
      .where(scope.only(taskTeams, eq(taskTeams.teamId, teamId)))
      .get();
    if (!before) return false;
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set['name'] = patch.name;
    if (patch.announcementChannelId !== undefined)
      set['announcementChannelId'] = patch.announcementChannelId;
    if (patch.leadRoleId !== undefined) set['leadRoleId'] = patch.leadRoleId;
    if (patch.memberRoleId !== undefined) set['memberRoleId'] = patch.memberRoleId;
    if (Object.keys(set).length > 0)
      db.update(taskTeams)
        .set(set)
        .where(scope.only(taskTeams, eq(taskTeams.teamId, teamId)))
        .run();
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    for (const key of ['name', 'announcementChannelId', 'leadRoleId', 'memberRoleId'] as const) {
      if (patch[key] !== undefined) {
        changedBefore[key] = before[key];
        changedAfter[key] = patch[key];
      }
    }
    audit(
      db,
      scope,
      actor,
      now,
      'task.team_configured',
      'task_team',
      teamId,
      changedBefore,
      changedAfter,
    );
    return true;
  });

export const deleteTeam = (
  scope: GuildScope,
  teamId: string,
  actor: TaskActor,
  now: number,
): 'deleted' | 'not-found' | 'has-tasks' =>
  write(scope, ({ db }) => {
    const referenced = db
      .select({ taskId: clubTasks.taskId })
      .from(clubTasks)
      .where(scope.only(clubTasks, eq(clubTasks.teamId, teamId)))
      .get();
    if (referenced) return 'has-tasks';
    const before = db
      .select()
      .from(taskTeams)
      .where(scope.only(taskTeams, eq(taskTeams.teamId, teamId)))
      .get();
    if (!before) return 'not-found';
    db.delete(taskTeams)
      .where(scope.only(taskTeams, eq(taskTeams.teamId, teamId)))
      .run();
    audit(
      db,
      scope,
      actor,
      now,
      'task.team_deleted',
      'task_team',
      teamId,
      {
        name: before.name,
        categoryId: before.categoryId,
        kind: before.kind,
      },
      undefined,
    );
    return 'deleted';
  });

export const listTasks = (
  scope: GuildScope,
  filter?: {
    readonly teamId?: string | undefined;
    readonly includeDone?: boolean | undefined;
    readonly includeArchived?: boolean | undefined;
  },
) =>
  read(scope, (db) =>
    db
      .select()
      .from(clubTasks)
      .where(
        scope.only(
          clubTasks,
          filter?.teamId ? eq(clubTasks.teamId, filter.teamId) : undefined,
          filter?.includeArchived ? undefined : isNull(clubTasks.archivedAt),
          filter?.includeDone ? undefined : sql`${clubTasks.status} <> 'done'`,
        ),
      )
      .orderBy(asc(clubTasks.dueAt))
      .all(),
  );

export const getTask = (scope: GuildScope, taskId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(clubTasks)
      .where(scope.only(clubTasks, eq(clubTasks.taskId, taskId)))
      .get(),
  );

/** Backward compatible single-assignee input plus a bounded multi-member list.
 * Validation at the HTTP boundary verifies each member's current guild/team. */
export const normalizeAssignees = (
  input: Pick<NewTask, 'assignmentKind' | 'assigneeId' | 'assigneeIds'>,
): string[] => {
  const ids = input.assigneeIds ?? (input.assigneeId ? [input.assigneeId] : []);
  if (
    ids.length > 25 ||
    new Set(ids).size !== ids.length ||
    (input.assignmentKind === 'team' && ids.length !== 0) ||
    (input.assignmentKind === 'individual' && ids.length === 0) ||
    (input.assigneeId !== undefined && input.assigneeId !== ids[0])
  )
    throw new Error('invalid-task-assignees');
  return [...ids];
};

export const createTask = (
  scope: GuildScope,
  input: NewTask,
  actor: TaskActor,
  now: number,
  /** An explicit id for idempotent callers (MCP `create_club_task` derives one
   * from the client's request id). When a task with that id already exists in
   * this guild, the existing id is returned and nothing new is written — no
   * slots, no audit row — the same duplicate rule `recordReport` uses. */
  explicitTaskId?: string,
): string => {
  const taskId = explicitTaskId ?? randomUUID();
  const assignees = normalizeAssignees(input);
  const extra = input.extraReminderAt ?? [];
  for (const at of extra) {
    if (!(now < at && at < input.dueAt)) throw new Error('invalid-extra-reminder');
  }
  write(scope, ({ db }) => {
    if (explicitTaskId !== undefined) {
      const existing = db
        .select({ taskId: clubTasks.taskId })
        .from(clubTasks)
        .where(scope.only(clubTasks, eq(clubTasks.taskId, explicitTaskId)))
        .get();
      if (existing) return;
    }
    const team = db
      .select()
      .from(taskTeams)
      .where(scope.only(taskTeams, eq(taskTeams.teamId, input.teamId)))
      .get();
    if (!team) throw new Error('unknown-team');
    // Destination category validation requires live Discord metadata; the owner-only
    // interim slice must not post reminders based only on this stored ID.
    db.insert(clubTasks)
      .values({
        guildId: scope.guildId,
        taskId,
        teamId: input.teamId,
        title: input.title,
        description: input.description ?? '',
        status: 'not_started',
        priority: input.priority ?? 'normal',
        assignmentKind: input.assignmentKind,
        assigneeId: assignees[0] ?? null,
        dueAt: input.dueAt,
        timezone: input.timezone,
        destinationId: input.destinationId,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (assignees.length)
      db.insert(taskAssignees)
        .values(
          assignees.map((discordUserId) => ({
            guildId: scope.guildId,
            taskId,
            discordUserId,
          })),
        )
        .run();
    db.insert(taskNudgeSlots)
      .values({
        guildId: scope.guildId,
        slotId: `announce:${taskId}`,
        taskId,
        kind: 'announce',
        dueAt: now,
        updatedAt: now,
      })
      .run();
    for (const at of extra) {
      db.insert(taskNudgeSlots)
        .values({
          guildId: scope.guildId,
          slotId: `custom:${taskId}:${at}`,
          taskId,
          kind: 'custom',
          dueAt: at,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    audit(db, scope, actor, now, 'task.created', 'club_task', taskId, undefined, {
      teamId: input.teamId,
      priority: input.priority ?? 'normal',
      assignmentKind: input.assignmentKind,
      assigneeIds: assignees,
      dueAt: input.dueAt,
      destinationId: input.destinationId,
    });
  });
  return taskId;
};

/** The requester of the task's most recent `review:` slot, so a re-issued
 * review after an edit still credits whoever asked for completion. Falls
 * back to undefined when no earlier review slot exists. */
const latestReviewRequester = (
  db: WriteTx['db'],
  scope: GuildScope,
  taskId: string,
): string | undefined => {
  const rows = db
    .select({ payload: taskNudgeSlots.payload })
    .from(taskNudgeSlots)
    .where(
      scope.only(
        taskNudgeSlots,
        eq(taskNudgeSlots.taskId, taskId),
        eq(taskNudgeSlots.kind, 'review'),
      ),
    )
    .all();
  let best: { version: number; requestedBy: string } | undefined;
  for (const row of rows) {
    if (typeof row.payload !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      !('requestedBy' in parsed)
    )
      continue;
    const { version, requestedBy } = parsed as Record<string, unknown>;
    if (typeof version !== 'number' || typeof requestedBy !== 'string') continue;
    if (!best || version > best.version) best = { version, requestedBy };
  }
  return best?.requestedBy;
};

/** Mutate a dated child only when the parent version is still current. Every
 * successful mutation advances that version, so stale views cannot clobber it. */
export const changeChild = (
  scope: GuildScope,
  taskId: string,
  expectedVersion: number,
  change:
    | { readonly kind: 'add'; readonly title: string; readonly dueAt: number }
    | {
        readonly kind: 'edit';
        readonly childId: string;
        readonly title: string;
        readonly dueAt: number;
      }
    | { readonly kind: 'complete' | 'delete'; readonly childId: string },
  actor: TaskActor,
  now: number,
): { readonly childId: string; readonly version: number } | undefined =>
  write(scope, ({ db }) => {
    const parent = db
      .select({ version: clubTasks.version, status: clubTasks.status })
      .from(clubTasks)
      .where(
        scope.only(
          clubTasks,
          eq(clubTasks.taskId, taskId),
          eq(clubTasks.version, expectedVersion),
          isNull(clubTasks.archivedAt),
          sql`${clubTasks.status} <> 'done'`,
        ),
      )
      .get();
    if (!parent) return undefined;
    const childId = change.kind === 'add' ? randomUUID() : change.childId;
    const existing =
      change.kind === 'add'
        ? undefined
        : db
            .select()
            .from(taskChildren)
            .where(
              scope.only(
                taskChildren,
                eq(taskChildren.taskId, taskId),
                eq(taskChildren.childId, childId),
              ),
            )
            .get();
    if (
      change.kind !== 'add' &&
      (!existing || (change.kind !== 'delete' && existing.status === 'done'))
    )
      return undefined;
    const changed =
      db
        .update(clubTasks)
        .set({
          updatedAt: now,
          version: sql`${clubTasks.version} + 1`,
        })
        .where(
          scope.only(
            clubTasks,
            eq(clubTasks.taskId, taskId),
            eq(clubTasks.version, expectedVersion),
            isNull(clubTasks.archivedAt),
            sql`${clubTasks.status} <> 'done'`,
          ),
        )
        .run().changes === 1;
    if (!changed) return undefined;
    switch (change.kind) {
      case 'add':
        db.insert(taskChildren)
          .values({
            guildId: scope.guildId,
            taskId,
            childId,
            title: change.title,
            dueAt: change.dueAt,
            status: 'not_started',
            createdAt: now,
          })
          .run();
        break;
      case 'edit':
        db.update(taskChildren)
          .set({ title: change.title, dueAt: change.dueAt })
          .where(
            scope.only(
              taskChildren,
              eq(taskChildren.taskId, taskId),
              eq(taskChildren.childId, childId),
            ),
          )
          .run();
        break;
      case 'complete':
        db.update(taskChildren)
          .set({ status: 'done', completedAt: now })
          .where(
            scope.only(
              taskChildren,
              eq(taskChildren.taskId, taskId),
              eq(taskChildren.childId, childId),
            ),
          )
          .run();
        break;
      case 'delete':
        db.delete(taskChildren)
          .where(
            scope.only(
              taskChildren,
              eq(taskChildren.taskId, taskId),
              eq(taskChildren.childId, childId),
            ),
          )
          .run();
        break;
    }
    // An edit to an awaiting task re-opens review: approvers decide on the new
    // content, so the review post is re-issued for the bumped version.
    if (parent.status === 'awaiting_approval') {
      db.insert(taskNudgeSlots)
        .values({
          guildId: scope.guildId,
          slotId: `review:${taskId}:${expectedVersion + 1}`,
          taskId,
          kind: 'review',
          dueAt: now,
          payload: JSON.stringify({
            version: expectedVersion + 1,
            requestedBy: latestReviewRequester(db, scope, taskId) ?? actor.actorId,
          }),
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    audit(
      db,
      scope,
      actor,
      now,
      `task.child_${change.kind}`,
      'club_task',
      taskId,
      { version: expectedVersion, child: existing ?? null },
      { version: expectedVersion + 1, childId },
    );
    return { childId, version: expectedVersion + 1 };
  });

export const listChildren = (scope: GuildScope, taskId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(taskChildren)
      .where(scope.only(taskChildren, eq(taskChildren.taskId, taskId)))
      .orderBy(asc(taskChildren.dueAt))
      .all(),
  );

/** An idempotent progress report write. The caller supplies the report id (a
 * first-party Discord message id for gateway replies, a namespaced id for
 * operator writes). Report bodies are member content: the audit records
 * provenance and size, never the body. */
export const recordReport = (
  scope: GuildScope,
  taskId: string,
  reportId: string,
  authorId: string,
  body: string,
  actor: TaskActor,
  now: number,
): 'recorded' | 'duplicate' | 'not-open' =>
  write(scope, ({ db }) => {
    const task = db
      .select({ status: clubTasks.status, version: clubTasks.version })
      .from(clubTasks)
      .where(scope.only(clubTasks, eq(clubTasks.taskId, taskId), isNull(clubTasks.archivedAt)))
      .get();
    if (!task || task.status === 'done') return 'not-open';
    const inserted =
      db
        .insert(taskReports)
        .values({
          guildId: scope.guildId,
          taskId,
          reportId,
          authorId,
          body,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run().changes === 1;
    if (!inserted) return 'duplicate';
    const statusChanged = task.status === 'not_started';
    if (statusChanged) {
      db.update(clubTasks)
        .set({ status: 'in_progress', updatedAt: now, version: sql`${clubTasks.version} + 1` })
        .where(scope.only(clubTasks, eq(clubTasks.taskId, taskId)))
        .run();
    }
    audit(db, scope, actor, now, 'task.report_recorded', 'club_task', taskId, undefined, {
      reportId,
      authorId,
      bodyChars: body.length,
      statusChanged,
    });
    return 'recorded';
  });

export const listReports = (scope: GuildScope, taskId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(taskReports)
      .where(scope.only(taskReports, eq(taskReports.taskId, taskId)))
      .orderBy(asc(taskReports.createdAt))
      .all(),
  );

/** Delete one progress report by hand. The audit records provenance and size,
 * never the body — the same rule as `recordReport`. */
export const deleteReport = (
  scope: GuildScope,
  taskId: string,
  reportId: string,
  actor: TaskActor,
  now: number,
): 'ok' | 'missing' =>
  write(scope, ({ db }) => {
    const before = db
      .select()
      .from(taskReports)
      .where(
        scope.only(taskReports, eq(taskReports.taskId, taskId), eq(taskReports.reportId, reportId)),
      )
      .get();
    if (!before) return 'missing';
    db.delete(taskReports)
      .where(
        scope.only(taskReports, eq(taskReports.taskId, taskId), eq(taskReports.reportId, reportId)),
      )
      .run();
    audit(db, scope, actor, now, 'task.report_deleted', 'club_task', taskId, undefined, {
      reportId,
      authorId: before.authorId,
      bodyChars: before.body.length,
    });
    return 'ok';
  });

export type TaskEdit = Pick<
  NewTask,
  | 'title'
  | 'description'
  | 'priority'
  | 'assignmentKind'
  | 'assigneeId'
  | 'assigneeIds'
  | 'dueAt'
  | 'timezone'
  | 'destinationId'
>;

/** Compare-and-swap, scoped to one guild and an unarchived task. */
export const updateTask = (
  scope: GuildScope,
  taskId: string,
  expectedVersion: number,
  input: TaskEdit,
  actor: TaskActor,
  now: number,
): 'ok' | 'stale' | 'anchored-destination' => {
  const assignees = normalizeAssignees(input);
  return write(scope, ({ db }) => {
    // An existing posted anchor binds replies to the original destination.
    // Moving the task without a deliberate re-anchor would strand those replies.
    const anchor = db
      .select({ channelId: taskMessageAnchors.channelId })
      .from(taskMessageAnchors)
      .where(scope.only(taskMessageAnchors, eq(taskMessageAnchors.taskId, taskId)))
      .get();
    if (anchor && anchor.channelId !== input.destinationId) return 'anchored-destination';
    const before = db
      .select()
      .from(clubTasks)
      .where(
        scope.only(
          clubTasks,
          eq(clubTasks.taskId, taskId),
          eq(clubTasks.version, expectedVersion),
          isNull(clubTasks.archivedAt),
          sql`${clubTasks.status} <> 'done'`,
        ),
      )
      .get();
    if (!before) return 'stale';
    const beforeAssignees = db
      .select({ discordUserId: taskAssignees.discordUserId })
      .from(taskAssignees)
      .where(scope.only(taskAssignees, eq(taskAssignees.taskId, taskId)))
      .all()
      .map((row) => row.discordUserId);
    const changed =
      db
        .update(clubTasks)
        .set({
          title: input.title,
          description: input.description ?? '',
          priority: input.priority ?? 'normal',
          assignmentKind: input.assignmentKind,
          assigneeId: assignees[0] ?? null,
          dueAt: input.dueAt,
          timezone: input.timezone,
          destinationId: input.destinationId,
          updatedAt: now,
          version: sql`${clubTasks.version} + 1`,
        })
        .where(
          scope.only(
            clubTasks,
            and(
              eq(clubTasks.taskId, taskId),
              eq(clubTasks.version, expectedVersion),
              isNull(clubTasks.archivedAt),
              sql`${clubTasks.status} <> 'done'`,
            ),
          ),
        )
        .run().changes === 1;
    if (!changed) return 'stale';
    db.delete(taskAssignees)
      .where(scope.only(taskAssignees, eq(taskAssignees.taskId, taskId)))
      .run();
    if (assignees.length)
      db.insert(taskAssignees)
        .values(
          assignees.map((discordUserId) => ({
            guildId: scope.guildId,
            taskId,
            discordUserId,
          })),
        )
        .run();
    // An edit to an awaiting task re-opens review: approvers decide on the new
    // content, so the review post is re-issued for the bumped version.
    if (before.status === 'awaiting_approval') {
      db.insert(taskNudgeSlots)
        .values({
          guildId: scope.guildId,
          slotId: `review:${taskId}:${expectedVersion + 1}`,
          taskId,
          kind: 'review',
          dueAt: now,
          payload: JSON.stringify({
            version: expectedVersion + 1,
            requestedBy: latestReviewRequester(db, scope, taskId) ?? actor.actorId,
          }),
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    audit(
      db,
      scope,
      actor,
      now,
      'task.edited',
      'club_task',
      taskId,
      {
        priority: before.priority,
        assignmentKind: before.assignmentKind,
        assigneeIds: beforeAssignees,
        dueAt: before.dueAt,
        destinationId: before.destinationId,
        version: expectedVersion,
      },
      {
        priority: input.priority ?? 'normal',
        assignmentKind: input.assignmentKind,
        assigneeIds: assignees,
        dueAt: input.dueAt,
        destinationId: input.destinationId,
        version: expectedVersion + 1,
      },
    );
    return 'ok';
  });
};

/** Versioned status transition with an audit record in the same transaction. */
export const requestCompletion = (
  scope: GuildScope,
  taskId: string,
  expectedVersion: number,
  actor: TaskActor,
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    const before = db
      .select({ status: clubTasks.status })
      .from(clubTasks)
      .where(
        scope.only(
          clubTasks,
          eq(clubTasks.taskId, taskId),
          eq(clubTasks.version, expectedVersion),
          isNull(clubTasks.archivedAt),
          sql`${clubTasks.status} IN ('not_started','in_progress')`,
        ),
      )
      .get();
    if (!before) return false;
    const changed =
      db
        .update(clubTasks)
        .set({
          status: 'awaiting_approval',
          updatedAt: now,
          version: sql`${clubTasks.version} + 1`,
        })
        .where(
          scope.only(
            clubTasks,
            eq(clubTasks.taskId, taskId),
            eq(clubTasks.version, expectedVersion),
            isNull(clubTasks.archivedAt),
            sql`${clubTasks.status} IN ('not_started','in_progress')`,
          ),
        )
        .run().changes === 1;
    if (!changed) return false;
    db.insert(taskNudgeSlots)
      .values({
        guildId: scope.guildId,
        slotId: `review:${taskId}:${expectedVersion + 1}`,
        taskId,
        kind: 'review',
        dueAt: now,
        payload: JSON.stringify({ version: expectedVersion + 1, requestedBy: actor.actorId }),
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    audit(
      db,
      scope,
      actor,
      now,
      'task.completion_requested',
      'club_task',
      taskId,
      { status: before.status, version: expectedVersion },
      { status: 'awaiting_approval', version: expectedVersion + 1 },
    );
    return true;
  });

/** The caller has already checked the actor's live Discord authority. This
 * transaction guarantees stale approvals cannot overwrite other edits.
 * Approval archives the task in the same write: completed work stays on file
 * with its reports and steps, and leaves the default listing at once. */
export const approveTask = (
  scope: GuildScope,
  taskId: string,
  expectedVersion: number,
  actor: TaskActor,
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    const changed =
      db
        .update(clubTasks)
        .set({
          status: 'done',
          archivedAt: now,
          updatedAt: now,
          version: sql`${clubTasks.version} + 1`,
        })
        .where(
          scope.only(
            clubTasks,
            eq(clubTasks.taskId, taskId),
            eq(clubTasks.version, expectedVersion),
            isNull(clubTasks.archivedAt),
            eq(clubTasks.status, 'awaiting_approval'),
          ),
        )
        .run().changes === 1;
    if (!changed) return false;
    audit(
      db,
      scope,
      actor,
      now,
      'task.approved',
      'club_task',
      taskId,
      { status: 'awaiting_approval', version: expectedVersion },
      { status: 'done', version: expectedVersion + 1, archivedAt: now },
    );
    return true;
  });

/** Send an awaiting task back to progress. Only an awaiting task can be sent back. */
export const rejectTask = (
  scope: GuildScope,
  taskId: string,
  expectedVersion: number,
  actor: TaskActor,
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    const changed =
      db
        .update(clubTasks)
        .set({ status: 'in_progress', updatedAt: now, version: sql`${clubTasks.version} + 1` })
        .where(
          scope.only(
            clubTasks,
            eq(clubTasks.taskId, taskId),
            eq(clubTasks.version, expectedVersion),
            isNull(clubTasks.archivedAt),
            eq(clubTasks.status, 'awaiting_approval'),
          ),
        )
        .run().changes === 1;
    if (!changed) return false;
    audit(
      db,
      scope,
      actor,
      now,
      'task.sent_back',
      'club_task',
      taskId,
      { status: 'awaiting_approval', version: expectedVersion },
      { status: 'in_progress', version: expectedVersion + 1 },
    );
    return true;
  });

/** Reopen or park a non-archived task at a working status, from any status. */
export const setStatus = (
  scope: GuildScope,
  taskId: string,
  expectedVersion: number,
  status: 'not_started' | 'in_progress',
  actor: TaskActor,
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    const before = db
      .select({ status: clubTasks.status })
      .from(clubTasks)
      .where(
        scope.only(
          clubTasks,
          eq(clubTasks.taskId, taskId),
          eq(clubTasks.version, expectedVersion),
          isNull(clubTasks.archivedAt),
        ),
      )
      .get();
    if (!before) return false;
    const changed =
      db
        .update(clubTasks)
        .set({ status, updatedAt: now, version: sql`${clubTasks.version} + 1` })
        .where(
          scope.only(
            clubTasks,
            eq(clubTasks.taskId, taskId),
            eq(clubTasks.version, expectedVersion),
            isNull(clubTasks.archivedAt),
          ),
        )
        .run().changes === 1;
    if (!changed) return false;
    audit(
      db,
      scope,
      actor,
      now,
      'task.status_set',
      'club_task',
      taskId,
      { status: before.status, version: expectedVersion },
      { status, version: expectedVersion + 1 },
    );
    return true;
  });

/** Hide a non-archived task from the default listing. */
export const archiveTask = (
  scope: GuildScope,
  taskId: string,
  expectedVersion: number,
  actor: TaskActor,
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    const changed =
      db
        .update(clubTasks)
        .set({ archivedAt: now, updatedAt: now, version: sql`${clubTasks.version} + 1` })
        .where(
          scope.only(
            clubTasks,
            eq(clubTasks.taskId, taskId),
            eq(clubTasks.version, expectedVersion),
            isNull(clubTasks.archivedAt),
          ),
        )
        .run().changes === 1;
    if (!changed) return false;
    audit(
      db,
      scope,
      actor,
      now,
      'task.archived',
      'club_task',
      taskId,
      { version: expectedVersion },
      { version: expectedVersion + 1, archivedAt: now },
    );
    return true;
  });

/** Restore an archived task to the default listing. */
export const unarchiveTask = (
  scope: GuildScope,
  taskId: string,
  expectedVersion: number,
  actor: TaskActor,
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    const existing = db
      .select({ archivedAt: clubTasks.archivedAt })
      .from(clubTasks)
      .where(
        scope.only(clubTasks, eq(clubTasks.taskId, taskId), eq(clubTasks.version, expectedVersion)),
      )
      .get();
    if (!existing || existing.archivedAt === null) return false;
    const changed =
      db
        .update(clubTasks)
        .set({ archivedAt: null, updatedAt: now, version: sql`${clubTasks.version} + 1` })
        .where(
          scope.only(
            clubTasks,
            eq(clubTasks.taskId, taskId),
            eq(clubTasks.version, expectedVersion),
          ),
        )
        .run().changes === 1;
    if (!changed) return false;
    audit(
      db,
      scope,
      actor,
      now,
      'task.unarchived',
      'club_task',
      taskId,
      { version: expectedVersion, archivedAt: existing.archivedAt },
      { version: expectedVersion + 1 },
    );
    return true;
  });

/** Delete a task by hand, with everything that belongs to it: steps, progress
 * reports, assignees, anchors, nudge slots filed under it, and check-in rows
 * that list it. Nothing about tasks is deleted automatically; this is the
 * owner's manual path. Compare-and-swap on the version: a stale view gets
 * 'stale', an unknown or other-guild task gets 'missing'. The audit keeps the
 * task title for identification but no descriptions or report bodies. */
export const deleteTask = (
  scope: GuildScope,
  taskId: string,
  expectedVersion: number,
  actor: TaskActor,
  now: number,
): 'ok' | 'stale' | 'missing' =>
  write(scope, ({ db }) => {
    const before = db
      .select()
      .from(clubTasks)
      .where(scope.only(clubTasks, eq(clubTasks.taskId, taskId)))
      .get();
    if (!before) return 'missing';
    if (before.version !== expectedVersion) return 'stale';
    db.delete(taskChildren)
      .where(scope.only(taskChildren, eq(taskChildren.taskId, taskId)))
      .run();
    db.delete(taskReports)
      .where(scope.only(taskReports, eq(taskReports.taskId, taskId)))
      .run();
    db.delete(taskAssignees)
      .where(scope.only(taskAssignees, eq(taskAssignees.taskId, taskId)))
      .run();
    db.delete(taskMessageAnchors)
      .where(scope.only(taskMessageAnchors, eq(taskMessageAnchors.taskId, taskId)))
      .run();
    db.delete(taskNudgeSlots)
      .where(scope.only(taskNudgeSlots, eq(taskNudgeSlots.taskId, taskId)))
      .run();
    db.delete(taskNudgeSlotTasks)
      .where(scope.only(taskNudgeSlotTasks, eq(taskNudgeSlotTasks.taskId, taskId)))
      .run();
    db.delete(clubTasks)
      .where(
        scope.only(clubTasks, eq(clubTasks.taskId, taskId), eq(clubTasks.version, expectedVersion)),
      )
      .run();
    audit(
      db,
      scope,
      actor,
      now,
      'task.deleted',
      'club_task',
      taskId,
      { title: before.title, status: before.status, version: before.version },
      undefined,
    );
    return 'ok';
  });

/** Persist the one confirmed Discord post that identifies a task. A second
 * message cannot silently replace it: reconcile the original before retry. */
export const recordTaskAnchor = (
  scope: GuildScope,
  taskId: string,
  channelId: string,
  messageId: string,
  now: number,
): 'recorded' | 'already-recorded' | 'conflict' =>
  write(scope, ({ db }) => {
    const task = db
      .select({ destinationId: clubTasks.destinationId })
      .from(clubTasks)
      .where(scope.only(clubTasks, eq(clubTasks.taskId, taskId), isNull(clubTasks.archivedAt)))
      .get();
    if (!task || task.destinationId !== channelId) return 'conflict';
    const existing = db
      .select()
      .from(taskMessageAnchors)
      .where(scope.only(taskMessageAnchors, eq(taskMessageAnchors.taskId, taskId)))
      .get();
    if (existing)
      return existing.channelId === channelId && existing.messageId === messageId
        ? 'already-recorded'
        : 'conflict';
    const other = db
      .select()
      .from(taskMessageAnchors)
      .where(scope.only(taskMessageAnchors, eq(taskMessageAnchors.messageId, messageId)))
      .get();
    if (other) return 'conflict';
    db.insert(taskMessageAnchors)
      .values({ guildId: scope.guildId, taskId, channelId, messageId, createdAt: now })
      .run();
    return 'recorded';
  });

/** A referenced message identifies a task only in the same guild and channel. */
export const taskForAnchor = (scope: GuildScope, channelId: string, messageId: string) =>
  read(
    scope,
    (db) =>
      db
        .select({ taskId: taskMessageAnchors.taskId })
        .from(taskMessageAnchors)
        .where(
          scope.only(
            taskMessageAnchors,
            eq(taskMessageAnchors.channelId, channelId),
            eq(taskMessageAnchors.messageId, messageId),
          ),
        )
        .get()?.taskId,
  );

/** A historical assignment alone never grants action authority: callers must
 * independently check current guild and team membership. */
export const isTaskAssignee = (scope: GuildScope, taskId: string, discordUserId: string): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ taskId: taskAssignees.taskId })
        .from(taskAssignees)
        .where(
          scope.only(
            taskAssignees,
            eq(taskAssignees.taskId, taskId),
            eq(taskAssignees.discordUserId, discordUserId),
          ),
        )
        .get() !== undefined,
  );

export const listTaskAssignees = (scope: GuildScope, taskId: string): string[] =>
  read(scope, (db) =>
    db
      .select({ discordUserId: taskAssignees.discordUserId })
      .from(taskAssignees)
      .where(scope.only(taskAssignees, eq(taskAssignees.taskId, taskId)))
      .all()
      .map((row) => row.discordUserId),
  );

// --- reminder configuration (stored only; the reminder worker owns delivery) ---

export const DEFAULT_QUIET_HOURS = {
  startMinute: 0,
  endMinute: 480,
  timezone: 'America/Los_Angeles',
} as const;

export const setQuietHours = (
  scope: GuildScope,
  window: { readonly startMinute: number; readonly endMinute: number; readonly timezone: string },
  actor: TaskActor,
  now: number,
): void =>
  write(scope, ({ db }) => {
    const values = {
      guildId: scope.guildId,
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      timezone: window.timezone,
      updatedBy: actor.actorId,
      updatedAt: now,
    };
    db.insert(taskQuietHours)
      .values(values)
      .onConflictDoUpdate({
        target: [taskQuietHours.guildId],
        set: {
          startMinute: window.startMinute,
          endMinute: window.endMinute,
          timezone: window.timezone,
          updatedBy: actor.actorId,
          updatedAt: now,
        },
      })
      .run();
    audit(
      db,
      scope,
      actor,
      now,
      'task.quiet_hours_configured',
      'guild',
      scope.guildId,
      undefined,
      window,
    );
  });

export const getQuietHours = (scope: GuildScope) =>
  read(scope, (db) => db.select().from(taskQuietHours).where(scope.only(taskQuietHours)).get());
