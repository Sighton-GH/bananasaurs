import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, Client, type Guild } from 'discord.js';
import { pino } from 'pino';
import { parseConfig, parseGuildId } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { guildRepo, taskRepo } from '@bananasaurs/storage';
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
  const click = (id: string, userId = MEMBER, version = 1) =>
    fake.emitInteraction({
      customId: `bs.task:start:${id}:${version}`,
      userId,
      channelId: CHANNEL,
      messageId: taskRepo.anchorFor(scope, id)?.messageId ?? '666666666666666669',
    });
  const privateCard = (interactionId: string, title: string) => {
    expect(fake.wasUpdateDeferred(interactionId)).toBe(true);
    const replies = fake.interactionReplies(interactionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.flags).toBe(32768);
    expect(replies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(replies[0]?.files ?? []).toEqual([]);
    expect(JSON.stringify(replies[0]?.components)).not.toContain('attachment://');
    expect(JSON.stringify(replies[0]?.components)).toContain(title);
    // Private follow-up route, never a channel send; the REST adapter supplies ephemeral.
    expect(
      fake
        .restCalls('respondToInteraction')
        .some((c) => (c.args[1] as { interactionId: string }).interactionId === interactionId),
    ).toBe(true);
    expect(fake.restCalls('sendMessage')).toHaveLength(0);
  };
  return { scope, fake, newTask, click, privateCard };
};

describe("I'm on it (real guild runtime)", () => {
  it('moves a role-backed member task to in progress, bumps version and refreshes its anchor', async () => {
    const h = setup();
    const id = h.newTask();
    const click = await h.click(id);
    expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'in_progress', version: 2 });
    expect(h.fake.wasUpdateDeferred(click)).toBe(true);
    expect(h.fake.interactionReplies(click)).toEqual([]);
    const edits = h.fake.restCalls('editMessage');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.args[1]).toEqual(taskRepo.anchorFor(h.scope, id));
    const message = edits[0]?.args[2] as { components: unknown; allowedMentions: unknown };
    expect(JSON.stringify(message.components)).toContain('IN PROGRESS');
    expect(message.allowedMentions).toEqual({ parse: [] });
    const second = await h.click(id, OTHER);
    h.privateCard(second, 'This card was out of date');
    expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'in_progress', version: 2 });
  });

  it('two concurrent clicks change the status once; the second is stale', async () => {
    const h = setup();
    const id = h.newTask();
    const clicks = await Promise.all([h.click(id), h.click(id, OTHER)]);
    const replies = clicks.map((click) => h.fake.interactionReplies(click));
    expect(replies.map((r) => r.length).sort()).toEqual([0, 1]);
    const stale = clicks.find((click) => h.fake.interactionReplies(click).length === 1)!;
    h.privateCard(stale, 'This card was out of date');
    for (const click of clicks) expect(h.fake.wasUpdateDeferred(click)).toBe(true);
    expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'in_progress', version: 2 });
  });

  it('an outsider on a fresh task is not-yours and nothing changes', async () => {
    const h = setup();
    const id = h.newTask();
    h.privateCard(await h.click(id, OUTSIDER), "This task isn't yours to pick up");
    expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'not_started', version: 1 });
    expect(h.fake.restCalls('editMessage')).toHaveLength(0);
  });

  it('a task awaiting review is not-open', async () => {
    const h = setup();
    const id = h.newTask();
    expect(
      taskRepo.requestCompletion(
        h.scope,
        id,
        1,
        { actorType: 'member', actorId: MEMBER, via: 'gateway' },
        4,
      ),
    ).toBe(true);
    h.privateCard(await h.click(id, MEMBER, 2), 'This task is closed');
    expect(taskRepo.getTask(h.scope, id)).toMatchObject({
      status: 'awaiting_approval',
      version: 2,
    });
    expect(h.fake.restCalls('editMessage')).toHaveLength(0);
  });

  it('an unknown task is not-open', async () => {
    const h = setup();
    const id = '00000000-0000-4000-8000-000000000009';
    h.privateCard(await h.click(id), 'This task is closed');
    expect(taskRepo.getTask(h.scope, id)).toBeUndefined();
    expect(h.fake.restCalls('editMessage')).toHaveLength(0);
  });

  it('an assigned current team member can start an individual task', async () => {
    const h = setup();
    const id = h.newTask(true);
    const click = await h.click(id);
    expect(h.fake.wasUpdateDeferred(click)).toBe(true);
    expect(h.fake.interactionReplies(click)).toEqual([]);
    expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'in_progress', version: 2 });
    expect(h.fake.restCalls('editMessage')).toHaveLength(1);
  });

  it('an unassigned teammate cannot start an individual task', async () => {
    const h = setup();
    const id = h.newTask(true);
    h.privateCard(await h.click(id, OTHER), "This task isn't yours to pick up");
    expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'not_started', version: 1 });
    expect(h.fake.restCalls('editMessage')).toHaveLength(0);
  });

  it('an assigned member no longer on the team cannot start an individual task', async () => {
    const h = setup();
    const id = h.newTask(true);
    h.fake.defineMember(MEMBER, []);
    h.privateCard(await h.click(id), "This task isn't yours to pick up");
    expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'not_started', version: 1 });
    expect(h.fake.restCalls('editMessage')).toHaveLength(0);
  });

  it.each([{ postsOn: false }, { dryRun: true }])(
    'planning mode %j changes storage but never edits Discord',
    async (options) => {
      const h = setup(options);
      const id = h.newTask();
      const click = await h.click(id);
      expect(h.fake.wasUpdateDeferred(click)).toBe(true);
      expect(h.fake.interactionReplies(click)).toEqual([]);
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'in_progress', version: 2 });
      h.privateCard(await h.click(id, OTHER), 'This card was out of date');
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'in_progress', version: 2 });
      expect(h.fake.restCalls('editMessage')).toHaveLength(0);
    },
  );
});
