import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { guildRepo } from '../index.js';
import {
  listBehaviours,
  listResources,
  listReminders,
  listSkillActivity,
  putBehaviour,
  putResource,
  insertReminder,
  recordSkillActivity,
} from './assistant.js';
let t: MigratedTestDatabase;
const G = parseGuildId('111111111111111111');
beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(G), { name: 'guild', now: 1 });
});
afterEach(() => t.close());
it('round-trips guild-scoped assistant settings and activity', () => {
  const s = t.scopes.forGuild(G);
  putBehaviour(
    s,
    {
      id: 'club',
      guildId: G,
      surface: 'bananasaurs',
      mentionRoleId: '222222222222222222',
      name: 'Club',
      systemPrompt: 'Canadian English',
      allowedSkillIds: ['search-club'],
      reviewerRoleIds: [],
      callerRoleIds: ['555555555555555555'],
      resourceIds: ['web'],
      enabled: true,
    },
    10,
  );
  putResource(s, {
    id: 'web',
    guildId: G,
    title: 'Site',
    url: 'https://sfuracerbot.ca',
    kind: 'website',
    enabled: true,
    reviewedAt: new Date(10).toISOString(),
  });
  insertReminder(s, {
    id: 'r',
    guildId: G,
    creatorId: '333333333333333333',
    destinationId: '444444444444444444',
    text: 'Meet',
    dueAt: 20,
    createdAt: 10,
    status: 'scheduled',
    dedupeKey: 'reminder:g:r',
  });
  recordSkillActivity(s, {
    id: 'a',
    at: 10,
    behaviourId: 'club',
    skillId: 'search-club',
    actorId: '333333333333333333',
    outcome: 'ok',
  });
  expect(listBehaviours(s)[0]?.id).toBe('club');
  expect(listResources(s)[0]?.url).toBe('https://sfuracerbot.ca');
  expect(listReminders(s)[0]?.status).toBe('scheduled');
  expect(listSkillActivity(s)[0]?.skillId).toBe('search-club');
});
