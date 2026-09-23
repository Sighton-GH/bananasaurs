import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLUB_ASSISTANT_SKILLS,
  parseGuildId,
  STARTER_SKILL_IDS,
  type AssistantBehaviour,
} from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { guildRepo } from '../index.js';
import {
  addRolesToSkillGrants,
  listBehaviours,
  listResources,
  listReminders,
  listSkillActivity,
  listSkillGrants,
  putBehaviour,
  putResource,
  putSkillGrant,
  insertReminder,
  recordSkillActivity,
  insertDecisionDraft,
  transitionDecision,
  listDecisions,
  recordResourceFetch,
  putServerCard,
  getServerCard,
  putMemory,
  listMemories,
  memoryPreference,
  setMemoryOptOut,
  forgetMember,
  saveMemoryProposal,
  setBotTagBehaviour,
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
it('resets fetched resource evidence when reviewed resource details change', () => {
  const s = t.scopes.forGuild(G);
  const resource = {
    id: 'web',
    guildId: G,
    title: 'Site',
    url: 'https://one.example',
    kind: 'website' as const,
    enabled: true,
    reviewedAt: new Date(10).toISOString(),
  };
  putResource(s, resource);
  recordResourceFetch(s, 'web', { status: 'ok', at: 15, detail: 'old evidence' });
  putResource(s, { ...resource, url: 'https://two.example' });
  expect(listResources(s)[0]).toMatchObject({ url: 'https://two.example', fetchStatus: 'pending' });
  expect(listResources(s)[0]?.lastFetchedAt).toBeUndefined();
  expect(listResources(s)[0]?.fetchDetail).toBeUndefined();
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
    {
      ...base,
      promptVersion: 1,
      mentionRoleId: '222222222222222222',
      ticketChannelId: '666666666666666666',
    },
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
it('stores a sectioned curated memory, server card, and member opt-out', () => {
  const s = t.scopes.forGuild(G);
  putServerCard(s, 'SFU team assistant', 10);
  putMemory(
    s,
    { id: 'm1', section: 'Exec team', content: 'Prepare budget', subjectId: '333333333333333333' },
    11,
  );
  expect(getServerCard(s)).toBe('SFU team assistant');
  expect(listMemories(s)).toEqual([
    expect.objectContaining({ id: 'm1', section: 'Exec team', content: 'Prepare budget' }),
  ]);
  expect(memoryPreference(s, '333333333333333333')).toEqual({ optedOut: false });
  setMemoryOptOut(s, '333333333333333333', true, 12);
  expect(memoryPreference(s, '333333333333333333')).toEqual({ optedOut: true });
  expect(forgetMember(s, '333333333333333333', 13)).toBe(1);
  expect(listMemories(s)).toEqual([]);
});
it('updates the section when an existing curated memory is saved', () => {
  const s = t.scopes.forGuild(G);
  putMemory(s, { id: 'moved', section: 'Old', content: 'Keep this' }, 10);
  putMemory(s, { id: 'moved', section: 'New', content: 'Keep this' }, 11);
  expect(listMemories(s)[0]).toMatchObject({
    id: 'moved',
    section: 'New',
    content: 'Keep this',
    updatedAt: 11,
  });
});
it('stores a memory proposal without changing memory before review', () => {
  const s = t.scopes.forGuild(G);
  insertDecisionDraft(s, {
    id: 'mp',
    kind: 'memory',
    summary: 'Exec team: Prepare budget',
    requesterId: '333333333333333333',
    provenance: 'assistant proposal',
    at: 20,
  });
  expect(listDecisions(s)[0]).toMatchObject({ id: 'mp', kind: 'memory', status: 'draft' });
  expect(listMemories(s)).toEqual([]);
});
it('saves a reviewed memory proposal atomically', () => {
  const s = t.scopes.forGuild(G);
  insertDecisionDraft(s, {
    id: 'memory-save',
    kind: 'memory',
    summary: 'draft',
    requesterId: '333333333333333333',
    provenance: 'test',
    at: 20,
  });
  expect(transitionDecision(s, 'memory-save', 'draft', 'reviewed')).toBe(true);
  expect(
    saveMemoryProposal(s, 'memory-save', { section: 'Exec', content: 'Confirm budget' }, 21),
  ).toBe(true);
  expect(listDecisions(s)[0]).toMatchObject({ status: 'saved' });
  expect(listMemories(s)[0]).toMatchObject({ section: 'Exec', content: 'Confirm budget' });
  expect(saveMemoryProposal(s, 'memory-save', { section: 'x', content: 'retry' }, 22)).toBe(false);
});

describe('STARTER_SKILL_IDS', () => {
  it('is exactly the nine everyday skills', () => {
    expect([...STARTER_SKILL_IDS]).toEqual([
      'search-club',
      'open-resource',
      'review-plan',
      'onboarding-guide',
      'draft-agenda',
      'summarise-meeting',
      'draft-announcement',
      'event-checklist',
      'draft-handoff',
    ]);
  });
  it('excludes confirmation-class and owner-only skills', () => {
    for (const excluded of [
      'create-reminder',
      'send-reminder',
      'propose-memory',
      'record-decision',
    ]) {
      expect(STARTER_SKILL_IDS).not.toContain(excluded);
    }
    expect(STARTER_SKILL_IDS).toHaveLength(9);
    for (const id of STARTER_SKILL_IDS) {
      const skill = CLUB_ASSISTANT_SKILLS.find((item) => item.id === id);
      expect(skill?.ownerOnly).not.toBe(true);
      expect(skill?.requiresConfirmation).toBe(false);
    }
  });
});

describe('addRolesToSkillGrants', () => {
  const ROLE_A = '222222222222222222';
  const ROLE_B = '333333333333333333';
  const USER_A = '444444444444444444';
  const OTHER_GUILD = parseGuildId('999999999999999999');
  it('creates missing grants, unions into existing ones, and stays idempotent', () => {
    const s = t.scopes.forGuild(G);
    putSkillGrant(s, { skillId: 'search-club', roleIds: [ROLE_A], userIds: [USER_A] }, 10);
    const first = addRolesToSkillGrants(
      s,
      { skillIds: ['search-club', 'open-resource'], roleIds: [ROLE_A, ROLE_B] },
      11,
    );
    expect(first.map((grant) => grant.skillId)).toEqual(['search-club', 'open-resource']);
    expect(first[0]).toEqual({
      skillId: 'search-club',
      roleIds: [ROLE_A, ROLE_B],
      userIds: [USER_A],
    });
    expect(first[1]).toEqual({
      skillId: 'open-resource',
      roleIds: [ROLE_A, ROLE_B],
      userIds: [],
    });
    expect(listSkillGrants(s).find((grant) => grant.skillId === 'search-club')).toEqual({
      skillId: 'search-club',
      roleIds: [ROLE_A, ROLE_B],
      userIds: [USER_A],
    });
    const second = addRolesToSkillGrants(
      s,
      { skillIds: ['search-club', 'open-resource'], roleIds: [ROLE_A, ROLE_B] },
      12,
    );
    expect(second).toEqual(first);
    expect(listSkillGrants(s).find((grant) => grant.skillId === 'search-club')?.roleIds).toEqual([
      ROLE_A,
      ROLE_B,
    ]);
  });
  it('never touches another guild grants', () => {
    const s = t.scopes.forGuild(G);
    guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: 1 });
    const other = t.scopes.forGuild(OTHER_GUILD);
    putSkillGrant(other, { skillId: 'search-club', roleIds: [ROLE_B], userIds: [] }, 10);
    addRolesToSkillGrants(s, { skillIds: ['search-club'], roleIds: [ROLE_A] }, 11);
    expect(listSkillGrants(other).find((grant) => grant.skillId === 'search-club')).toEqual({
      skillId: 'search-club',
      roleIds: [ROLE_B],
      userIds: [],
    });
    expect(listSkillGrants(s).find((grant) => grant.skillId === 'search-club')).toEqual({
      skillId: 'search-club',
      roleIds: [ROLE_A],
      userIds: [],
    });
  });
});

describe('setBotTagBehaviour (ADR 0063)', () => {
  const OTHER_GUILD = parseGuildId('999999999999999999');
  const behaviour = (id: string, guildId: string = G): AssistantBehaviour => ({
    id,
    guildId,
    surface: 'bananasaurs',
    mentionRoleId: `22222222222222222${id.length}`,
    name: id,
    systemPrompt: 'Canadian English',
    promptVersion: 1,
    allowedSkillIds: ['search-club'],
    reviewerRoleIds: [],
    callerRoleIds: [],
    resourceIds: [],
    enabled: true,
  });
  const flags = (scope = t.scopes.forGuild(G)) =>
    Object.fromEntries(listBehaviours(scope).map((b) => [b.id, b.answersBotTag]));

  beforeEach(() => {
    const s = t.scopes.forGuild(G);
    putBehaviour(s, behaviour('a'), 10);
    putBehaviour(s, behaviour('bb'), 10);
  });

  it('reads back false for a new behaviour', () => {
    expect(flags()).toEqual({ a: false, bb: false });
  });

  it('moves the flag to exactly one behaviour and clears it with null', () => {
    const s = t.scopes.forGuild(G);
    expect(setBotTagBehaviour(s, 'a', 11)).toBe(true);
    expect(flags()).toEqual({ a: true, bb: false });
    expect(setBotTagBehaviour(s, 'bb', 12)).toBe(true);
    expect(flags()).toEqual({ a: false, bb: true });
    expect(setBotTagBehaviour(s, null, 13)).toBe(true);
    expect(flags()).toEqual({ a: false, bb: false });
  });

  it('returns false and changes nothing for an unknown id', () => {
    const s = t.scopes.forGuild(G);
    setBotTagBehaviour(s, 'a', 11);
    expect(setBotTagBehaviour(s, 'missing', 12)).toBe(false);
    expect(flags()).toEqual({ a: true, bb: false });
  });

  it('keeps the flag when the behaviour is saved again', () => {
    const s = t.scopes.forGuild(G);
    setBotTagBehaviour(s, 'a', 11);
    putBehaviour(s, { ...behaviour('a'), name: 'renamed', answersBotTag: false }, 12);
    putBehaviour(s, { ...behaviour('a'), name: 'renamed again' }, 13);
    expect(flags()).toEqual({ a: true, bb: false });
  });

  it('never touches another guild', () => {
    guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: 1 });
    const other = t.scopes.forGuild(OTHER_GUILD);
    putBehaviour(other, behaviour('a', OTHER_GUILD), 10);
    setBotTagBehaviour(other, 'a', 11);
    setBotTagBehaviour(t.scopes.forGuild(G), 'bb', 12);
    expect(flags(other)).toEqual({ a: true });
    // An id that exists only in the other guild is unknown here.
    setBotTagBehaviour(t.scopes.forGuild(G), null, 13);
    expect(flags(other)).toEqual({ a: true });
  });

  it('lets the database refuse two flagged behaviours in one guild', () => {
    expect(() =>
      t.raw
        .prepare('UPDATE assistant_behaviours SET answers_bot_tag = 1 WHERE guild_id = ?')
        .run(G),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
