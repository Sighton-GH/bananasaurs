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
  insertDecisionDraft,
  transitionDecision,
  listDecisions,
  recordResourceFetch,
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
      promptVersion: 1,
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
  recordResourceFetch(s, 'web', { status: 'ok', at: 15, detail: 'text/html; fresh' });
  expect(listResources(s)[0]).toMatchObject({ fetchStatus: 'ok', lastFetchedAt: 15 });
  expect(listReminders(s)[0]?.status).toBe('scheduled');
  expect(listSkillActivity(s)[0]?.skillId).toBe('search-club');
  insertDecisionDraft(s, {
    id: 'd',
    kind: 'decision',
    summary: 'Draft',
    requesterId: '333333333333333333',
    provenance: 'test',
    at: 10,
  });
  expect(transitionDecision(s, 'd', 'draft', 'reviewed')).toBe(true);
  expect(transitionDecision(s, 'd', 'reviewed', 'saved')).toBe(true);
  expect(transitionDecision(s, 'd', 'reviewed', 'saved')).toBe(false);
  expect(listDecisions(s)[0]?.status).toBe('saved');
});
it('clears mentionRoleId and ticketChannelId when a re-put omits them', () => {
  const s = t.scopes.forGuild(G);
  const base = {
    id: 'club',
    guildId: G,
    surface: 'bananasaurs' as const,
    name: 'Club',
    systemPrompt: 'Canadian English',
    allowedSkillIds: [] as const,
    reviewerRoleIds: [] as const,
    callerRoleIds: [] as const,
    resourceIds: [] as const,
    enabled: true,
  };
  putBehaviour(
    s,
    { ...base, promptVersion: 1, mentionRoleId: '222222222222222222', ticketChannelId: '666666666666666666' },
    10,
  );
  expect(listBehaviours(s)[0]).toMatchObject({
    mentionRoleId: '222222222222222222',
    ticketChannelId: '666666666666666666',
  });
  // Second save without either value: "cleared" must survive the upsert
  // (Drizzle drops undefined from update sets, so the repo normalises to
  // NULL). A stale value here kept routing to a channel the UI no longer
  // showed (review finding 5).
  putBehaviour(s, { ...base, promptVersion: 2 }, 20);
  const saved = listBehaviours(s)[0];
  expect(saved?.promptVersion).toBe(2);
  expect(saved?.mentionRoleId).toBeUndefined();
  expect(saved?.ticketChannelId).toBeUndefined();
});
