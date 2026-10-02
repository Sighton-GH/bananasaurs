import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { panelDefinitionSchema, parseGuildId } from '@bananasaurs/core';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { guildRepo, panelRepo, taskRepo, type GuildScope } from '@bananasaurs/storage';
import { protectedMessageReason } from './protected.js';

/**
 * Task 6 Step 1: the protected-message guard over real storage. A role-panel
 * message and a task anchor are refused by kind; any other message passes;
 * and another guild's protected message id is invisible here — guild scope
 * is the partition, not a predicate anyone must remember.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';
const PANEL_MESSAGE = '444444444444444444';
const ANCHOR_MESSAGE = '555555555555555555';
const OTHER_MESSAGE = '666666666666666666';
const ROLE = '777777777777777777';
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
const NOW = 1_700_000_000_000;

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

const seedPanel = (scope: GuildScope, messageId: string): void => {
  panelRepo.createPanel(
    scope,
    panelDefinitionSchema.parse({
      panelId: `roles-${messageId.slice(-4)}`,
      kind: 'adopted',
      channelId: CHANNEL,
      messageId,
      behaviour: 'toggle',
      component: 'reaction',
      options: [{ optionId: 'a', roleId: ROLE, emojiKey: 'u:1f9e0', position: 0 }],
    }),
    NOW,
    [ROLE],
  );
};

const seedAnchor = (scope: GuildScope, messageId: string): string => {
  const teamId = taskRepo.createTeam(
    scope,
    { name: 'Tech', categoryId: CHANNEL, kind: 'subteam' },
    ACTOR,
    NOW,
  );
  const taskId = taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Project',
      assignmentKind: 'team',
      dueAt: NOW + 86_400_000,
      timezone: 'America/Vancouver',
      destinationId: CHANNEL,
      createdBy: 'owner',
    },
    ACTOR,
    NOW,
  );
  expect(taskRepo.recordTaskAnchor(scope, taskId, CHANNEL, messageId, NOW)).toBe('recorded');
  return taskId;
};

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  guildRepo.upsertGuild(a, { name: 'guild a', now: NOW });
  guildRepo.upsertGuild(b, { name: 'guild b', now: NOW });
  seedPanel(a, PANEL_MESSAGE);
  seedAnchor(a, ANCHOR_MESSAGE);
});

afterEach(() => {
  t.close();
});

describe('protectedMessageReason', () => {
  it('names a role-panel message', () => {
    expect(protectedMessageReason(a, PANEL_MESSAGE)).toBe('role-panel');
  });

  it('names a task anchor', () => {
    expect(protectedMessageReason(a, ANCHOR_MESSAGE)).toBe('task-anchor');
  });

  it('passes any other message', () => {
    expect(protectedMessageReason(a, OTHER_MESSAGE)).toBeUndefined();
  });

  it("does not see another guild's panel message", () => {
    expect(protectedMessageReason(b, PANEL_MESSAGE)).toBeUndefined();
  });

  it("does not see another guild's task anchor", () => {
    expect(protectedMessageReason(b, ANCHOR_MESSAGE)).toBeUndefined();
  });
});
