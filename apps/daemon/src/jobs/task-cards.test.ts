import { afterEach, beforeEach, expect, it } from 'vitest';
import { DiscordApiError, DiscordErrorCode, parseGuildId } from '@bananasaurs/core';
import { FakeDiscord } from '@bananasaurs/testkit';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { guildRepo, taskRepo, type GuildScope } from '@bananasaurs/storage';
import { refreshOneTaskCard, refreshTaskCards } from './task-cards.js';

let db: MigratedTestDatabase, scope: GuildScope, fake: FakeDiscord;
const G = parseGuildId('111111111111111111');
const CHANNEL = '555555555555555555';
const U1 = '100000000000000001';
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
const MEMBER_ACTOR = { actorType: 'member', actorId: U1, via: 'gateway' } as const;
const T0 = Date.parse('2026-09-28T15:00:00Z');
let catSeq = 0;

beforeEach(() => {
  db = openMigratedTestDatabase();
  scope = db.scopes.forGuild(G);
  guildRepo.upsertGuild(scope, { name: 'A', now: 0 });
  fake = new FakeDiscord({ guildId: G });
  catSeq = 0;
});
afterEach(() => db.close());

/** A task with a posted, anchored message. `rendered` marks the anchor as a card at version 1. */
const seed = async (opts?: { rendered?: boolean }): Promise<string> => {
  catSeq += 1;
  const teamId = taskRepo.createTeam(
    scope,
    {
      name: `Team ${catSeq}`,
      categoryId: String(333333333333333330n + BigInt(catSeq)),
      announcementChannelId: '444444444444444444',
      kind: 'subteam',
    },
    ACTOR,
    1,
  );
  const taskId = taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Build',
      assignmentKind: 'team',
      dueAt: T0 + 48 * 3_600_000,
      timezone: 'America/Vancouver',
      destinationId: CHANNEL,
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
  const ref = await fake.sendMessage(G, CHANNEL, { content: 'New task: Build' });
  taskRepo.recordTaskAnchor(scope, taskId, CHANNEL, ref.messageId, 3);
  if (opts?.rendered !== false) taskRepo.markCardRendered(scope, taskId, 1, 3);
  return taskId;
};
const version = (id: string) => taskRepo.getTask(scope, id)!.version;
const lastEdit = () => {
  const calls = fake.restCalls('editMessage');
  return calls[calls.length - 1]!.args[2] as { flags?: number; components?: unknown };
};
const editText = () => JSON.stringify(lastEdit().components);
const on = { enabled: true } as const;

it('refreshes a stale card once', async () => {
  const id = await seed();
  taskRepo.setStatus(scope, id, version(id), 'in_progress', MEMBER_ACTOR, T0);
  fake.resetCalls();
  expect(await refreshTaskCards(scope, fake, T0 + 1000, on)).toBe(1);
  expect(fake.restCalls('editMessage')).toHaveLength(1);
  expect(lastEdit().flags).toBe(32768);
  expect(editText()).toContain('IN PROGRESS');
  expect(await refreshTaskCards(scope, fake, T0 + 2000, on)).toBe(0);
});

it('edits nothing in planning mode', async () => {
  const id = await seed();
  taskRepo.setStatus(scope, id, version(id), 'in_progress', MEMBER_ACTOR, T0);
  fake.resetCalls();
  expect(await refreshTaskCards(scope, fake, T0 + 1000, { enabled: false })).toBe(0);
  expect(fake.restCalls('editMessage')).toHaveLength(0);
});

it('stops retrying when the message is gone', async () => {
  const id = await seed();
  taskRepo.setStatus(scope, id, version(id), 'in_progress', MEMBER_ACTOR, T0);
  fake.resetCalls();
  fake.failNext(
    'editMessage',
    new DiscordApiError(404, DiscordErrorCode.UnknownMessage, 'Unknown Message'),
  );
  expect(await refreshTaskCards(scope, fake, T0 + 1000, on)).toBe(0);
  expect(fake.restCalls('editMessage')).toHaveLength(1);
  expect(await refreshTaskCards(scope, fake, T0 + 2000, on)).toBe(0);
  expect(fake.restCalls('editMessage')).toHaveLength(1);
});

it('retries after a transient failure', async () => {
  const id = await seed();
  taskRepo.setStatus(scope, id, version(id), 'in_progress', MEMBER_ACTOR, T0);
  fake.resetCalls();
  fake.failNext('editMessage', new DiscordApiError(500, undefined, 'boom'));
  expect(await refreshTaskCards(scope, fake, T0 + 1000, on)).toBe(0);
  expect(await refreshTaskCards(scope, fake, T0 + 2000, on)).toBe(1);
  expect(fake.restCalls('editMessage')).toHaveLength(2);
});

it('edits at most `limit` cards per pass', async () => {
  for (let i = 0; i < 12; i += 1) {
    const id = await seed();
    taskRepo.setStatus(scope, id, version(id), 'in_progress', MEMBER_ACTOR, T0 + i);
  }
  fake.resetCalls();
  expect(await refreshTaskCards(scope, fake, T0 + 5000, { ...on, limit: 10 })).toBe(10);
  expect(fake.restCalls('editMessage')).toHaveLength(10);
});

it('converts a legacy open post to a card, but not a done one', async () => {
  const open = await seed({ rendered: false });
  fake.resetCalls();
  expect(await refreshTaskCards(scope, fake, T0 + 1000, on)).toBe(1);
  expect(taskRepo.anchorFor(scope, open)).toBeDefined();

  const done = await seed({ rendered: false });
  expect(taskRepo.setStatus(scope, done, version(done), 'in_progress', MEMBER_ACTOR, T0)).toBe(
    true,
  );
  db.raw.prepare("UPDATE club_tasks SET status = 'done' WHERE task_id = ?").run(done);
  fake.resetCalls();
  expect(await refreshTaskCards(scope, fake, T0 + 2000, on)).toBe(0);
  expect(fake.restCalls('editMessage')).toHaveLength(0);
});

it('refreshes after a report with no status change', async () => {
  const id = await seed();
  expect(
    taskRepo.recordReport(scope, id, 'r1', U1, 'Soldered the board', MEMBER_ACTOR, T0 + 500),
  ).toBe('recorded');
  fake.resetCalls();
  expect(await refreshTaskCards(scope, fake, T0 + 1000, on)).toBe(1);
  expect(editText()).toContain('Last update');
});

it('refreshOneTaskCard edits that task now', async () => {
  const id = await seed();
  taskRepo.setStatus(scope, id, version(id), 'in_progress', MEMBER_ACTOR, T0);
  fake.resetCalls();
  await refreshOneTaskCard(scope, fake, id, T0 + 1000, on);
  expect(fake.restCalls('editMessage')).toHaveLength(1);
});

it('gives up on an anchored card whose task is archived: no edit, and it is not retried', async () => {
  const id = await seed();
  expect(taskRepo.archiveTask(scope, id, version(id), ACTOR, T0)).toBe(true);
  const archivedVersion = version(id);
  const rendered = () =>
    (
      db.raw
        .prepare('SELECT rendered_version AS v FROM task_message_anchors WHERE task_id = ?')
        .get(id) as { v: number }
    ).v;
  expect(rendered()).toBeLessThan(archivedVersion);
  fake.resetCalls();
  await refreshOneTaskCard(scope, fake, id, T0 + 1000, on);
  expect(fake.restCalls('editMessage')).toHaveLength(0);
  expect(rendered()).toBe(archivedVersion);
  expect(await refreshTaskCards(scope, fake, T0 + 2000, on)).toBe(0);
  expect(fake.restCalls('editMessage')).toHaveLength(0);
});

it('a report deletion during same-version refresh remains queued', async () => {
  const id = await seed();
  taskRepo.recordReport(scope, id, 'race-report', U1, 'DELETE ME', MEMBER_ACTOR, T0);
  expect(taskRepo.requestCompletion(scope, id, version(id), MEMBER_ACTOR, T0 + 1)).toBe(true);
  const reviewVersion = version(id);
  const original = fake.editMessage.bind(fake);
  let deleted = false;
  fake.editMessage = async (...args) => {
    if (!deleted) {
      deleted = true;
      expect(taskRepo.deleteReport(scope, id, 'race-report', ACTOR, T0 + 3)).toBe('ok');
    }
    return original(...args);
  };
  expect(await refreshTaskCards(scope, fake, T0 + 2, on)).toBe(1);
  expect(editText()).toContain('DELETE ME');
  expect(version(id)).toBe(reviewVersion);
  expect(taskRepo.listReports(scope, id)).toEqual([]);
  expect(taskRepo.staleTaskCards(scope, 10)).toHaveLength(1);
  expect(await refreshTaskCards(scope, fake, T0 + 4, on)).toBe(1);
  expect(editText()).not.toContain('DELETE ME');
});

it('normal awaiting deletion refresh clears dirty without looping', async () => {
  const id = await seed();
  taskRepo.recordReport(scope, id, 'gone', U1, 'DELETE ME', MEMBER_ACTOR, T0);
  taskRepo.requestCompletion(scope, id, version(id), MEMBER_ACTOR, T0 + 1);
  await refreshTaskCards(scope, fake, T0 + 2, on);
  taskRepo.deleteReport(scope, id, 'gone', ACTOR, T0 + 3);
  expect(await refreshTaskCards(scope, fake, T0 + 4, on)).toBe(1);
  expect(editText()).not.toContain('DELETE ME');
  expect(await refreshTaskCards(scope, fake, T0 + 5, on)).toBe(0);
});

it('refreshOneTaskCard: a report deletion during the awaited edit keeps the card stale', async () => {
  const id = await seed();
  taskRepo.recordReport(scope, id, 'race-report', U1, 'DELETE ME', MEMBER_ACTOR, T0);
  expect(taskRepo.requestCompletion(scope, id, version(id), MEMBER_ACTOR, T0 + 1)).toBe(true);
  await refreshTaskCards(scope, fake, T0 + 2, on);
  expect(taskRepo.staleTaskCards(scope, 10)).toHaveLength(0);
  const original = fake.editMessage.bind(fake);
  let deleted = false;
  fake.editMessage = async (...args) => {
    if (!deleted) {
      deleted = true;
      expect(taskRepo.deleteReport(scope, id, 'race-report', ACTOR, T0 + 3)).toBe('ok');
    }
    return original(...args);
  };
  await refreshOneTaskCard(scope, fake, id, T0 + 4, on);
  // The edit used the pre-delete view, so the deleted update is on the card...
  expect(editText()).toContain('DELETE ME');
  // ...but the fence (updatedAt read before the render) no longer matches, so
  // the completion is dropped and the dirty marker survives.
  expect(taskRepo.staleTaskCards(scope, 10)).toHaveLength(1);
  expect(await refreshTaskCards(scope, fake, T0 + 5, on)).toBe(1);
  expect(editText()).not.toContain('DELETE ME');
});
