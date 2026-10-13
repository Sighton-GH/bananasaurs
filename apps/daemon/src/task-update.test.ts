import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, Client, type Guild } from 'discord.js';
import { pino } from 'pino';
import { parseConfig, parseGuildId } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { guildRepo, taskRepo, taskNudgeRepo } from '@bananasaurs/storage';
import { BOT_USER_ID, FakeDiscord } from '@bananasaurs/testkit';
import { buildGuildRuntime } from './runtime/guild.js';
import { createInteractionTokenSealer } from './assistant/interaction-token.js';

const GUILD = parseGuildId('111111111111111111');
const CATEGORY = '999999999999999999';
const CHANNEL = '333333333333333333';
const MEMBER_ROLE = '444444444444444444';
const MEMBER = '555555555555555555';
const OTHER = '555555555555555556';
const OUTSIDER = '777777777777777777';
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
let db: ReturnType<typeof openMigratedTestDatabase>;
let client: Client;

beforeEach(() => {
  db = openMigratedTestDatabase();
  client = new Client(buildClientOptions(() => BOT_USER_ID));
});
afterEach(async () => {
  await client.destroy();
  db.close();
});

/** Real guild composition and task subscriber, real storage and FakeDiscord.
 * Only category fetch is stubbed: no logged-in client or REST network is needed.
 * The event is delivered to the runtime's actual task subscriber, not to a
 * captured dependency or an exported start helper. No worker/timer is started. */
const setup = (options?: { postsOn?: boolean; dryRun?: boolean }) => {
  const scope = db.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'Test', now: 1 });
  guildRepo.setTaskPostsEnabled(scope, options?.postsOn ?? true, 2);
  const guild = (client as unknown as { guilds: { _add: (data: object) => Guild } }).guilds._add({
    id: GUILD,
    name: 'Test',
    owner_id: OUTSIDER,
    roles: [],
    channels: [{ id: CATEGORY, guild_id: GUILD, name: 'Tech', type: ChannelType.GuildCategory }],
    members: [],
    emojis: [],
    unavailable: false,
  });
  const category = guild.channels.cache.get(CATEGORY)!;
  // discord.js overloads fetch(id) and fetch() with different return types.
  // This harness only receives the force-fetch-by-id path from taskMemberAccess.
  vi.spyOn(guild.channels, 'fetch').mockImplementation(
    (async () => category) as unknown as typeof guild.channels.fetch,
  );
  const fake = new FakeDiscord({ guildId: GUILD });
  fake.defineRole({ id: MEMBER_ROLE, name: 'Tech member', position: 1 });
  fake.defineMember(MEMBER, [MEMBER_ROLE]);
  fake.defineMember(OTHER, [MEMBER_ROLE]);
  fake.defineMember(OUTSIDER, []);
  const teamId = taskRepo.createTeam(
    scope,
    {
      name: 'Tech',
      categoryId: CATEGORY,
      kind: 'subteam',
      memberRoleId: MEMBER_ROLE,
    },
    ACTOR,
    2,
  );
  const runtime = buildGuildRuntime({
    scope,
    instance: db.scopes.instance(),
    client,
    discord: fake,
    config: parseConfig({
      DISCORD_BOT_TOKEN: 'not.a.real.token',
      DISCORD_APPLICATION_ID: BOT_USER_ID,
      BANANASAURS_GUILD_ALLOWLIST: GUILD,
      BANANASAURS_OWNER_USER_ID: OUTSIDER,
      DASHBOARD_SESSION_SECRET: 'a'.repeat(32),
      BANANASAURS_DRY_RUN: options?.dryRun ? '1' : '0',
    }),
    logger: pino({ level: 'silent' }),
    now: () => 5,
    interactionTokenSealer: createInteractionTokenSealer(),
  });
  const subscriber = runtime.subscribers.find((s) => s.name === 'task-commands')!;
  fake.onEvent((event) => subscriber.handle(event));
  let messageSeq = 0;
  const newTask = (individual = false) => {
    const id = taskRepo.createTask(
      scope,
      {
        teamId,
        title: 'Wire the brake light harness',
        assignmentKind: individual ? 'individual' : 'team',
        ...(individual ? { assigneeId: MEMBER } : {}),
        dueAt: 3000,
        timezone: 'America/Vancouver',
        destinationId: CHANNEL,
        createdBy: 'owner',
      },
      ACTOR,
      3,
    );
    messageSeq += 1;
    const messageId = String(666666666666666660n + BigInt(messageSeq));
    fake.defineMessage({ channelId: CHANNEL, messageId, content: 'Task' });
    expect(taskRepo.recordTaskAnchor(scope, id, CHANNEL, messageId, 3)).toBe('recorded');
    taskRepo.markCardRendered(scope, id, 1, 3);
    return id;
  };
  return { scope, fake, newTask };
};

describe('Post update (real guild runtime)', () => {
  const submit = (
    h: ReturnType<typeof setup>,
    id: string,
    userId = MEMBER,
    interactionId?: string,
  ) =>
    h.fake.emitModalSubmit({
      customId: `bs.task:update:${id}`,
      userId,
      channelId: CHANNEL,
      fields: { body: ' Left side done ', blocker: ' connectors ' },
      ...(interactionId === undefined ? {} : { interactionId }),
    });
  it('opens a form immediately even for an outsider, then checks authority on submit', async () => {
    const h = setup();
    const id = h.newTask();
    const click = await h.fake.emitInteraction({
      customId: `bs.task:update:${id}`,
      userId: OUTSIDER,
      channelId: CHANNEL,
      messageId: '666666666666666661',
    });
    expect(h.fake.modalsShown(click)).toHaveLength(1);
    expect(h.fake.wasUpdateDeferred(click)).toBe(false);
    const submitted = await submit(h, id, OUTSIDER);
    expect(taskRepo.listReports(h.scope, id)).toEqual([]);
    expect(JSON.stringify(h.fake.interactionReplies(submitted))).toContain(
      "Your update wasn't saved",
    );
    expect(JSON.stringify(h.fake.interactionReplies(submitted))).toContain('Left side done');
  });
  it('records and schedules exactly once for a replayed submit, bumps the card version', async () => {
    const h = setup();
    const id = h.newTask();
    const submitted = await submit(h, id);
    await submit(h, id, MEMBER, submitted);
    expect(taskRepo.listReports(h.scope, id)).toMatchObject([
      {
        reportId: `modal:${submitted}`,
        body: 'Left side done\n\nBlocked: connectors',
        authorId: MEMBER,
      },
    ]);
    expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'in_progress', version: 2 });
    expect(taskNudgeRepo.listSlots(h.scope).filter((s) => s.kind === 'update')).toMatchObject([
      { slotId: `update:modal:${submitted}`, state: 'pending' },
    ]);
    expect(h.fake.restCalls('sendMessage')).toHaveLength(0);
  });
  it('refuses an individual task from another team member', async () => {
    const h = setup();
    const id = h.newTask(true);
    const submitted = await submit(h, id, OTHER);
    expect(taskRepo.listReports(h.scope, id)).toEqual([]);
    expect(JSON.stringify(h.fake.interactionReplies(submitted))).toContain(
      "Your update wasn't saved",
    );
  });
  it('refuses a task finished between opening the form and submitting and returns the typed text', async () => {
    const h = setup();
    const id = h.newTask();
    await h.fake.emitInteraction({
      customId: `bs.task:update:${id}`,
      userId: MEMBER,
      channelId: CHANNEL,
      messageId: '666666666666666661',
    });
    expect(taskRepo.requestCompletion(h.scope, id, 1, ACTOR, 4)).toBe(true);
    expect(taskRepo.approveTask(h.scope, id, 2, ACTOR, 4)).toBe(true);
    expect(taskRepo.getTask(h.scope, id)?.status).toBe('done');
    const submitted = await submit(h, id);
    expect(taskRepo.listReports(h.scope, id)).toEqual([]);
    expect(JSON.stringify(h.fake.interactionReplies(submitted))).toContain('Blocked: connectors');
    expect(taskNudgeRepo.listSlots(h.scope).filter((s) => s.kind === 'update')).toEqual([]);
  });
  it('refuses a task moved to awaiting approval while live membership is being fetched', async () => {
    const h = setup();
    const id = h.newTask();
    const realFetchMember = h.fake.fetchMember.bind(h.fake);
    vi.spyOn(h.fake, 'fetchMember').mockImplementation(async (guildId, userId) => {
      expect(taskRepo.requestCompletion(h.scope, id, 1, ACTOR, 4)).toBe(true);
      return realFetchMember(guildId, userId);
    });
    const submitted = await submit(h, id);
    expect(taskRepo.getTask(h.scope, id)?.status).toBe('awaiting_approval');
    expect(taskRepo.listReports(h.scope, id)).toEqual([]);
    expect(JSON.stringify(h.fake.interactionReplies(submitted))).toContain(
      "Your update wasn't saved",
    );
    expect(taskNudgeRepo.listSlots(h.scope).filter((s) => s.kind === 'update')).toEqual([]);
  });
  it.each([{ postsOn: false }, { postsOn: true, dryRun: true }])(
    'records privately with posts off: %j',
    async (options) => {
      const h = setup(options);
      const id = h.newTask();
      const submitted = await submit(h, id);
      expect(taskRepo.listReports(h.scope, id)).toHaveLength(1);
      expect(JSON.stringify(h.fake.interactionReplies(submitted))).toContain('nothing was posted');
      expect(h.fake.restCalls('sendMessage')).toHaveLength(0);
    },
  );
});
