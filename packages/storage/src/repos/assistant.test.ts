import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLUB_ASSISTANT_SKILLS,
  DEFAULT_WIZARD_ANSWERS,
  parseGuildId,
  STARTER_SKILL_IDS,
  type AssistantBehaviour,
  type AssistantTrace,
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
  setResourceEnabled,
  putServerCard,
  getServerCard,
  putMemory,
  listMemories,
  memoryPreference,
  setMemoryOptOut,
  forgetMember,
  saveMemoryProposal,
  setBotTagBehaviour,
  getAssistantSettings,
  setLogChannel,
  getConversationRetention,
  setConversationRetention,
} from './assistant.js';
import { appendTurn, createConversation, getConversation, recentTurns } from './conversations.js';
import { getTrace, insertTrace } from './traces.js';
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

describe('assistant settings (ADR 0065)', () => {
  it('has no log channel until one is set, and clears it with null', () => {
    const s = t.scopes.forGuild(G);
    expect(getAssistantSettings(s)).toEqual({});
    setLogChannel(s, '444444444444444444', 10);
    expect(getAssistantSettings(s)).toEqual({ logChannelId: '444444444444444444' });
    setLogChannel(s, '555555555555555555', 11);
    expect(getAssistantSettings(s)).toEqual({ logChannelId: '555555555555555555' });
    setLogChannel(s, null, 12);
    expect(getAssistantSettings(s)).toEqual({});
  });

  it('keeps each guild its own log channel', () => {
    const other = parseGuildId('999999999999999999');
    guildRepo.upsertGuild(t.scopes.forGuild(other), { name: 'other', now: 1 });
    setLogChannel(t.scopes.forGuild(G), '444444444444444444', 10);
    expect(getAssistantSettings(t.scopes.forGuild(other))).toEqual({});
  });

  it('refuses a log channel that is not a snowflake', () => {
    expect(() => setLogChannel(t.scopes.forGuild(G), 'general', 10)).toThrow();
  });
});

describe('github-repo / github-org kinds with parentId + meta (Task 17)', () => {
  const org = {
    id: 'gh-acme',
    guildId: G,
    title: 'acme',
    url: 'https://github.com/acme',
    kind: 'github-org' as const,
    enabled: true,
    reviewedAt: new Date(10).toISOString(),
    meta: { owner: 'acme', includeForks: false, includeArchived: false },
  };
  const child = {
    id: 'gh-acme-widget',
    guildId: G,
    title: 'acme/widget',
    url: 'https://github.com/acme/widget',
    kind: 'github-repo' as const,
    enabled: true,
    reviewedAt: new Date(11).toISOString(),
    parentId: 'gh-acme',
    meta: { owner: 'acme', repo: 'widget', branch: 'main', autoDiscovered: true },
  };

  it('round-trips the org and its auto-discovered child', () => {
    const s = t.scopes.forGuild(G);
    putResource(s, org);
    putResource(s, child);
    const rows = listResources(s);
    expect(rows.find((r) => r.id === 'gh-acme')).toMatchObject({
      kind: 'github-org',
      meta: { owner: 'acme', includeForks: false, includeArchived: false },
    });
    expect(rows.find((r) => r.id === 'gh-acme')?.parentId).toBeUndefined();
    expect(rows.find((r) => r.id === 'gh-acme-widget')).toMatchObject({
      kind: 'github-repo',
      parentId: 'gh-acme',
      meta: { owner: 'acme', repo: 'widget', branch: 'main', autoDiscovered: true },
    });
  });

  it('reads resources without meta or parent as absent fields', () => {
    const s = t.scopes.forGuild(G);
    putResource(s, {
      id: 'web',
      guildId: G,
      title: 'Site',
      url: 'https://sfuracerbot.ca',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(10).toISOString(),
    });
    const row = listResources(s).find((r) => r.id === 'web');
    expect(row?.parentId).toBeUndefined();
    expect(row?.meta).toBeUndefined();
  });

  it('reads corrupt meta_json as undefined instead of throwing', () => {
    const s = t.scopes.forGuild(G);
    putResource(s, org);
    t.raw
      .prepare(
        'UPDATE assistant_resources SET meta_json = ? WHERE guild_id = ? AND resource_id = ?',
      )
      .run('not-json{', G, 'gh-acme');
    expect(listResources(s).find((r) => r.id === 'gh-acme')?.meta).toBeUndefined();
    t.raw
      .prepare(
        'UPDATE assistant_resources SET meta_json = ? WHERE guild_id = ? AND resource_id = ?',
      )
      .run(JSON.stringify({ repo: 'widget' }), G, 'gh-acme');
    expect(listResources(s).find((r) => r.id === 'gh-acme')?.meta).toBeUndefined();
  });

  it('clearing meta and parent on re-put stores NULL', () => {
    const s = t.scopes.forGuild(G);
    putResource(s, child);
    putResource(s, {
      id: child.id,
      guildId: child.guildId,
      title: child.title,
      url: child.url,
      kind: child.kind,
      enabled: child.enabled,
      reviewedAt: child.reviewedAt,
    });
    const row = listResources(s).find((r) => r.id === 'gh-acme-widget');
    expect(row?.parentId).toBeUndefined();
    expect(row?.meta).toBeUndefined();
    expect(
      t.raw
        .prepare(
          'SELECT parent_id AS p, meta_json AS m FROM assistant_resources WHERE guild_id = ? AND resource_id = ?',
        )
        .get(G, 'gh-acme-widget'),
    ).toEqual({ p: null, m: null });
  });
});

describe('behaviour promptWizard answers (Task 18)', () => {
  const behaviour = (id: string): AssistantBehaviour => ({
    id,
    guildId: G,
    surface: 'bananasaurs',
    mentionRoleId: '222222222222222222',
    name: id,
    systemPrompt: 'Be helpful.',
    promptVersion: 1,
    allowedSkillIds: ['search-club'],
    reviewerRoleIds: [],
    callerRoleIds: [],
    resourceIds: [],
    enabled: true,
  });
  const corrupt = (json: string) => {
    t.raw
      .prepare(
        'UPDATE assistant_behaviours SET prompt_wizard_json = ? WHERE guild_id = ? AND behaviour_id = ?',
      )
      .run(json, G, 'club');
  };

  it('round-trips stored answers and clears them when a re-save omits them', () => {
    const s = t.scopes.forGuild(G);
    const answers = DEFAULT_WIZARD_ANSWERS.club;
    putBehaviour(s, { ...behaviour('club'), promptWizard: answers }, 10);
    expect(listBehaviours(s)[0]?.promptWizard).toEqual(answers);
    // A re-save without answers writes the column back to null.
    putBehaviour(s, behaviour('club'), 11);
    expect(listBehaviours(s)[0]?.promptWizard).toBeUndefined();
    expect(
      t.raw
        .prepare(
          'SELECT prompt_wizard_json AS json FROM assistant_behaviours WHERE guild_id = ? AND behaviour_id = ?',
        )
        .get(G, 'club'),
    ).toEqual({ json: null });
  });

  it('reads corrupt or schema-invalid JSON as undefined instead of throwing', () => {
    const s = t.scopes.forGuild(G);
    putBehaviour(s, { ...behaviour('club'), promptWizard: DEFAULT_WIZARD_ANSWERS.club }, 10);
    corrupt('not-json{');
    expect(listBehaviours(s)[0]?.promptWizard).toBeUndefined();
    corrupt(JSON.stringify({ audience: [] }));
    expect(listBehaviours(s)[0]?.promptWizard).toBeUndefined();
    corrupt(JSON.stringify(null));
    expect(listBehaviours(s)[0]?.promptWizard).toBeUndefined();
  });
});

describe('conversation retention (Task 19)', () => {
  const OTHER_GUILD = parseGuildId('999999999999999999');

  it('defaults to 6 months, round-trips the four choices, and keeps each guild its own', () => {
    const s = t.scopes.forGuild(G);
    expect(getConversationRetention(s)).toBe(182);
    for (const days of [61, 365, null, 182] as const) {
      setConversationRetention(s, days, 10);
      expect(getConversationRetention(s)).toBe(days);
    }
    guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: 1 });
    const other = t.scopes.forGuild(OTHER_GUILD);
    expect(getConversationRetention(other)).toBe(182);
    setConversationRetention(other, 61, 11);
    expect(getConversationRetention(s)).toBe(182);
    expect(getConversationRetention(other)).toBe(61);
  });

  it('keeps the log channel when the retention changes, and vice versa', () => {
    const s = t.scopes.forGuild(G);
    setLogChannel(s, '444444444444444444', 10);
    setConversationRetention(s, 61, 11);
    expect(getAssistantSettings(s)).toEqual({ logChannelId: '444444444444444444' });
    expect(getConversationRetention(s)).toBe(61);
    setLogChannel(s, null, 12);
    expect(getConversationRetention(s)).toBe(61);
  });

  it('refuses a retention outside 61, 182 and 365 days', () => {
    const s = t.scopes.forGuild(G);
    expect(() => setConversationRetention(s, 30 as 61, 10)).toThrow();
    expect(getConversationRetention(s)).toBe(182);
  });
});

describe('forgetMember removes conversation turns (Task 19)', () => {
  const MEMBER = '444444444444444444';
  const OTHER = '555555555555555555';

  it("deletes the member's turns and drops conversations left with no user turn", () => {
    const s = t.scopes.forGuild(G);
    createConversation(s, {
      conversationId: 'conv-mine',
      channelId: '333333333333333333',
      behaviourId: 'club',
      startedBy: MEMBER,
      title: 'my question',
      source: 'discord',
      at: 1_000,
    });
    appendTurn(s, {
      conversationId: 'conv-mine',
      turnId: 'turn-user',
      at: 1_000,
      role: 'user',
      authorId: MEMBER,
      authorName: 'Bryan',
      text: 'where is the handbook?',
    });
    appendTurn(s, {
      conversationId: 'conv-mine',
      turnId: 'turn-assistant',
      at: 1_001,
      role: 'assistant',
      authorName: 'Bananasaurs',
      text: 'in the resources.',
    });
    createConversation(s, {
      conversationId: 'conv-theirs',
      channelId: '333333333333333333',
      behaviourId: 'club',
      startedBy: OTHER,
      title: 'their question',
      source: 'discord',
      at: 2_000,
    });
    appendTurn(s, {
      conversationId: 'conv-theirs',
      turnId: 'turn-other',
      at: 2_000,
      role: 'user',
      authorId: OTHER,
      authorName: 'Sasha',
      text: 'when is the meeting?',
    });

    forgetMember(s, MEMBER, 3_000);

    expect(getConversation(s, 'conv-mine')).toBeUndefined();
    expect(recentTurns(s, 'conv-mine', { maxTurns: 12, maxChars: 6_000 })).toEqual([]);
    expect(getConversation(s, 'conv-theirs')).toBeDefined();
    expect(recentTurns(s, 'conv-theirs', { maxTurns: 12, maxChars: 6_000 })).toHaveLength(1);
  });

  /** Stored-data fixture: fixed ids and timestamps, no narrative. */
  const traceFixture = (over: Partial<AssistantTrace> = {}): AssistantTrace => ({
    traceId: 'trace-1',
    at: 1_790_000_000_000,
    userId: MEMBER,
    channelId: '333333333333333333',
    behaviourId: 'club',
    command: 'ask',
    source: 'mention',
    conversationId: 'conv-mine',
    turnId: 'turn-assistant',
    question: 'where is the handbook?',
    answer: 'in the resources.',
    outcome: 'answered',
    durationMs: 1200,
    attempts: [{ provider: 'gemini', model: 'gemini-2.5-flash', outcome: 'ok', ms: 900 }],
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 20, thinkingTokens: 10 },
    sections: [{ name: 'system', chars: 12, estTokens: 3, text: 'Be helpful.' }],
    toolCalls: [],
    guard: { removed: [] },
    timeline: [{ label: 'posted', atMs: 1200 }],
    discordMessageIds: [],
    sources: [],
    flags: [],
    ...over,
  });

  it("deletes the member's assistant traces and keeps everyone else's", () => {
    const OTHER_GUILD = parseGuildId('999999999999999999');
    guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: 1 });
    const s = t.scopes.forGuild(G);
    const other = t.scopes.forGuild(OTHER_GUILD);
    insertTrace(s, traceFixture({ traceId: 'mine', userId: MEMBER }));
    insertTrace(s, traceFixture({ traceId: 'theirs', userId: OTHER }));
    insertTrace(other, traceFixture({ traceId: 'mine', userId: MEMBER }));

    forgetMember(s, MEMBER, 3_000);

    expect(getTrace(s, 'mine')).toBeUndefined();
    expect(getTrace(s, 'theirs')).toBeDefined();
    expect(getTrace(other, 'mine')).toBeDefined();
  });

  it("deletes every conversation trace where the member took part, not just their own", () => {
    const OTHER_GUILD = parseGuildId('999999999999999999');
    guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: 1 });
    const s = t.scopes.forGuild(G);
    const other = t.scopes.forGuild(OTHER_GUILD);
    createConversation(s, {
      conversationId: 'conv-c1',
      channelId: '333333333333333333',
      behaviourId: 'club',
      startedBy: MEMBER,
      title: 'shared question',
      source: 'discord',
      at: 1_000,
    });
    appendTurn(s, {
      conversationId: 'conv-c1',
      turnId: 'turn-a',
      at: 1_000,
      role: 'user',
      authorId: MEMBER,
      authorName: 'Member A',
      text: 'first question',
    });
    appendTurn(s, {
      conversationId: 'conv-c1',
      turnId: 'turn-b',
      at: 1_001,
      role: 'user',
      authorId: OTHER,
      authorName: 'Member B',
      text: 'second question',
    });
    insertTrace(s, traceFixture({ traceId: 'trace-a1', userId: MEMBER, conversationId: 'conv-c1' }));
    insertTrace(s, traceFixture({ traceId: 'trace-b1', userId: OTHER, conversationId: 'conv-c1' }));
    insertTrace(s, traceFixture({ traceId: 'trace-b2', userId: OTHER, conversationId: 'conv-c2' }));
    insertTrace(
      other,
      traceFixture({ traceId: 'trace-other', userId: MEMBER, conversationId: 'conv-c1' }),
    );

    forgetMember(s, MEMBER, 3_000);

    expect(getTrace(s, 'trace-a1')).toBeUndefined();
    expect(getTrace(s, 'trace-b1')).toBeUndefined();
    expect(getTrace(s, 'trace-b2')).toBeDefined();
    expect(getTrace(other, 'trace-other')).toBeDefined();
  });
});

describe('setResourceEnabled (Task 8c)', () => {
  const OTHER_GUILD = parseGuildId('999999999999999999');
  const resource = {
    id: 'web',
    guildId: G,
    title: 'Site',
    url: 'https://one.example',
    kind: 'website' as const,
    enabled: true,
    reviewedAt: new Date(10).toISOString(),
  };

  it('toggles enabled and meta without touching fetch status', () => {
    const s = t.scopes.forGuild(G);
    putResource(s, resource);
    recordResourceFetch(s, 'web', { status: 'ok', at: 123, detail: 'fresh evidence' });
    expect(
      setResourceEnabled(s, 'web', {
        enabled: false,
        meta: { owner: 'acme', disabledByOwner: true },
      }),
    ).toBe(true);
    expect(listResources(s)[0]).toMatchObject({
      id: 'web',
      enabled: false,
      meta: { owner: 'acme', disabledByOwner: true },
      fetchStatus: 'ok',
      lastFetchedAt: 123,
      title: 'Site',
      url: 'https://one.example',
    });
  });

  it('is guild-scoped: another guild is untouched and an unknown id returns false', () => {
    guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: 1 });
    const s = t.scopes.forGuild(G);
    const other = t.scopes.forGuild(OTHER_GUILD);
    putResource(s, resource);
    recordResourceFetch(s, 'web', { status: 'ok', at: 123, detail: 'fresh evidence' });
    putResource(other, { ...resource, guildId: OTHER_GUILD });
    expect(setResourceEnabled(other, 'web', { enabled: false, meta: undefined })).toBe(true);
    expect(listResources(other)[0]).toMatchObject({ enabled: false });
    expect(listResources(s)[0]).toMatchObject({ enabled: true, fetchStatus: 'ok' });
    expect(setResourceEnabled(other, 'missing', { enabled: false, meta: undefined })).toBe(false);
    expect(listResources(other)).toHaveLength(1);
    expect(listResources(s)).toHaveLength(1);
  });

  it('clears meta with meta: undefined and keeps fetch status', () => {
    const s = t.scopes.forGuild(G);
    putResource(s, { ...resource, meta: { owner: 'acme' } });
    recordResourceFetch(s, 'web', { status: 'ok', at: 123, detail: 'fresh evidence' });
    expect(setResourceEnabled(s, 'web', { enabled: true, meta: undefined })).toBe(true);
    const row = listResources(s)[0];
    expect(row?.meta).toBeUndefined();
    expect(row).toMatchObject({ fetchStatus: 'ok', lastFetchedAt: 123 });
  });
});
