import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Client } from 'discord.js';
import {
  createAutomodSubscriber,
  createDispatcher,
  createLogPoster,
  doctorCommand,
  formatAutomodMatch,
  JOB_KINDS,
  parseGuildId,
  parseSnowflakeId,
  Pipeline,
  type AutomodSubscriberDeps,
  type LoggingPorts,
  type MessageEvent,
  type OpsInstance,
  type OutgoingMessage,
} from '@bananasaurs/core';
import {
  automodRuleRepo,
  guildRepo,
  jobRepo,
  loggingRepo,
  modCaseRepo,
  pipelineRepo,
  read,
  schema,
  write,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { buildClientOptions } from '@bananasaurs/discord';
import { BOT_USER_ID, FakeDiscord } from '@bananasaurs/testkit';
import { automodAuthorization, automodGatewayFor, automodPortsFor } from './automod/wiring.js';
import { opsPortsFor } from './ops/wiring.js';
import type { GuildOperations } from './runtime/guild.js';

/**
 * Automod, end to end on the fake gateway (Task 12, ADR 0035).
 *
 * The pipeline dispatches a real `messageCreate`, the automod subscriber
 * converges through the matcher, the mod-case repo, and (on escalation) the
 * moderation gateway — every layer that will run in production except the
 * discord.js adapter itself. Mirrors `panels.integration.test.ts`'s exact
 * setup style: fixed snowflakes, `openMigratedTestDatabase`, a real
 * `Pipeline`, and Task 10's exported composition helpers rather than
 * re-derived wiring.
 *
 * What this proves that the unit tests (`packages/core/src/automod/
 * subscriber.test.ts`) cannot: that a real message actually reaches a
 * deletion and a case row through the pipeline's gates, and — the scenario
 * ADR 0035 was written to catch — that an escalation refused by real
 * hierarchy logic (the fake guild owner) is durably recorded rather than
 * merely logged, the exact gap Release 1's role-effect refusals had.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const MEMBER = parseSnowflakeId('444444444444444444');
const EXEMPT_MEMBER = parseSnowflakeId('555555555555555555');
const OWNER = parseSnowflakeId('666666666666666666');
const EXEMPT_ROLE = parseSnowflakeId('777777777777777777');

const RULE_ID = 'rule-1';
const CATEGORY_ID = 'cat-1';
const TERM_ID = 'term-1';
const LOG = parseSnowflakeId('777777777777777777');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let pipeline: Pipeline;
let nextMessageId: bigint;

/** Logging ports over the real repositories, the way `guild.ts` binds them. */
const loggingPortsForTest = (): LoggingPorts => ({
  guildId: GUILD,
  listEnabledRoutesFor: (eventKind) => loggingRepo.listEnabledRoutesFor(scope, eventKind),
  isChannelExcluded: (channelId) => loggingRepo.isChannelExcluded(scope, channelId),
  listEnabledLogChannels: () => loggingRepo.listEnabledLogChannels(scope),
  claim: (input) => pipelineRepo.recordFirstSight(scope, { ...input, atMs: discord.now() }),
  release: (input) => pipelineRepo.forgetFirstSight(scope, input),
  sendMessage: (channelId, message) => discord.sendMessage(GUILD, channelId, message),
  enqueueDeletionAttribution: ({ dedupeKey, payload, runAfter }) =>
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.logMessageDelete,
      payload,
      dedupeKey,
      runAfter,
      now: discord.now(),
    }),
  getMemberSnapshot: (id) => loggingRepo.getMemberSnapshot(scope, id),
  saveMemberSnapshot: (s) =>
    loggingRepo.upsertMemberSnapshot(scope, { ...s, roleIds: [...s.roleIds] }),
  deleteMemberSnapshot: (id) => {
    loggingRepo.deleteMemberSnapshot(scope, id);
  },
  now: () => discord.now(),
  logger,
});

/**
 * The automod ports with the log hook wired, exactly as `guild.ts` wires
 * them: every recorded match posts an `automod_match` card through the same
 * `createLogPoster` `/mod warn` uses, claimed on
 * `automod:<messageId>:<ruleId>`.
 */
const buildAutomodPorts = (): AutomodSubscriberDeps => {
  const automodGateway = automodGatewayFor(scope, discord, logger, () => discord.now());
  const automodAuth = automodAuthorization(scope);
  const logPoster = createLogPoster(loggingPortsForTest());
  return automodPortsFor(
    scope,
    discord,
    automodGateway,
    automodAuth,
    logger,
    () => discord.now(),
    (info) =>
      logPoster.post({
        eventKind: 'automod_match',
        fingerprint: `automod:${info.messageId}:${info.ruleId}`,
        source: {
          channelId: parseSnowflakeId(info.channelId),
          parentChannelId:
            info.parentChannelId === undefined ? undefined : parseSnowflakeId(info.parentChannelId),
          categoryId: info.categoryId === undefined ? undefined : parseSnowflakeId(info.categoryId),
        },
        view: (includeContent) => formatAutomodMatch(info, includeContent),
      }),
  );
};

/** Wires the automod subscriber onto the pipeline, exactly as `guild.ts` will. */
const buildPipeline = (): Pipeline => {
  const automodPorts = buildAutomodPorts();

  return new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: {
      firstSight: (input) => pipelineRepo.recordFirstSight(scope, input),
    },
    subscribers: [createAutomodSubscriber(automodPorts)],
    leaveGuild: async () => undefined,
    logger,
  });
};

/** Creates one enabled `keyword_filter` rule with a single term, 'badword'. */
const seedRule = (): void => {
  automodRuleRepo.createRule(scope, {
    ruleId: RULE_ID,
    kind: 'keyword_filter',
    name: 'test rule',
    config: '{}',
    now: discord.now(),
  });
  automodRuleRepo.addCategory(scope, {
    categoryId: CATEGORY_ID,
    ruleId: RULE_ID,
    name: 'test category',
    defaultAction: 'delete_and_case',
  });
  automodRuleRepo.addTerm(scope, { termId: TERM_ID, categoryId: CATEGORY_ID, text: 'badword' });
};

/** Registers a fake message and dispatches it as a real `messageCreate`. */
const sendMessage = async (authorId: string, content: string): Promise<void> => {
  nextMessageId += 1n;
  const messageId = nextMessageId.toString();
  discord.defineMessage({ channelId: CHANNEL, messageId, authorId });
  await discord.emitMessageCreate({ channelId: CHANNEL, messageId, authorId, content });
};

function findCase(memberId: string) {
  return read(scope, (db) =>
    db
      .select()
      .from(schema.modCases)
      .where(scope.only(schema.modCases))
      .all()
      .find((row) => row.memberId === memberId),
  );
}

beforeEach(() => {
  nextMessageId = 100_000_000_000_000_000n;
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  // docs/18 Layer 4: an unconfigured guild is dry-run. A test that exercises
  // real calls turns it off deliberately.
  write(scope, ({ db }) => {
    db.update(schema.guilds).set({ dryRun: 0 }).where(scope.only(schema.guilds)).run();
  });
  // ADR 0121: automod runs only when the guild-wide switch is on. Most tests
  // here exercise real calls, so they switch it on deliberately; the watch
  // tests below set it back.
  guildRepo.setAutomodState(scope, 'on', 0);

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  discord.defineRole({ id: EXEMPT_ROLE, name: 'exempt', position: 5 });
  discord.defineMember(MEMBER, []);
  discord.defineMember(EXEMPT_MEMBER, [EXEMPT_ROLE]);
  discord.defineMember(OWNER, [], true);

  pipeline = buildPipeline();
  // Exactly what the discord.js adapter will do in production: every gateway
  // event goes through the pipeline, allowlist gate and dedupe gate included.
  discord.onEvent(async (event) => {
    await pipeline.dispatch(event);
  });
});

afterEach(() => {
  t.close();
});

/** Every Text Display joined: the card's headline, quote and footer. */
const textOf = (message: OutgoingMessage): string => {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o['type'] === 10 && typeof o['content'] === 'string') out.push(o['content']);
    walk(o['components']);
  };
  walk(message.components);
  return out.join('\n');
};

const sentTo = (channelId: string): OutgoingMessage[] =>
  discord
    .restCalls('sendMessage')
    .filter((call) => call.args[1] === channelId)
    .map((call) => call.args[2] as OutgoingMessage);

describe('automod, end to end on the fake gateway', () => {
  it('deletes a matching message and opens a case when the switch is on', async () => {
    seedRule();

    await sendMessage(MEMBER, 'badword here');

    expect(discord.restCalls('deleteMessage')).toHaveLength(1);
    const modCase = findCase(MEMBER);
    expect(modCase?.violationCount).toBe(1);
    expect(modCase?.status).toBe('open');
  });

  /**
   * The feedback loop this closes: the bot deletes a flagged message, the
   * `message_delete` logging route posts the deleted content, discord.js
   * emits that post as a `messageCreate`, and an enabled rule matches
   * the quoted word in the bot's own log entry.
   */
  it('never acts on its own messages', async () => {
    seedRule();

    await sendMessage(BOT_USER_ID, 'badword here');

    expect(discord.restCalls('deleteMessage')).toHaveLength(0);
    expect(findCase(BOT_USER_ID)).toBeUndefined();
  });

  it('does not delete from an exempt role', async () => {
    seedRule();
    automodRuleRepo.addRoleExemption(scope, { ruleId: RULE_ID, roleId: EXEMPT_ROLE });

    await sendMessage(EXEMPT_MEMBER, 'badword here');

    expect(discord.restCalls('deleteMessage')).toHaveLength(0);
    expect(findCase(EXEMPT_MEMBER)).toBeUndefined();
  });

  it('makes no Discord call when the switch is on watch', async () => {
    guildRepo.setAutomodState(scope, 'watch', discord.now());
    seedRule();

    await sendMessage(MEMBER, 'badword here');

    expect(discord.restCalls('deleteMessage')).toHaveLength(0);
    const modCase = findCase(MEMBER);
    // A case exists so the observation has somewhere to live, but the counter
    // the escalation ladder reads has not moved — nothing was enforced.
    expect(modCase?.violationCount).toBe(0);
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actionTaken).toBe('would_delete');
  });

  /**
   * docs/18 Layer 4/6, end to end: dry run is the DEFAULT for an unconfigured
   * guild, so a rule in a guild whose owner has not turned dry
   * run off must delete nothing. `beforeEach` clears the flag for every other
   * test here; this one puts it back deliberately.
   */
  it('deletes nothing while the guild is in dry run', async () => {
    write(scope, ({ db }) => {
      db.update(schema.guilds).set({ dryRun: 1 }).where(scope.only(schema.guilds)).run();
    });
    seedRule();

    await sendMessage(MEMBER, 'badword here');

    expect(discord.restCalls('deleteMessage')).toHaveLength(0);
    const modCase = findCase(MEMBER);
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    expect(events.map((e) => e.actionTaken)).toEqual(['delete_blocked_dry_run']);
  });

  /**
   * Design spec §6: a message already deleted by a human moderator by the
   * time Bananasaurs gets to it "is treated as success, not a failure — the
   * outcome (message gone) is what the rule wanted". `FakeDiscord` raises the
   * real `DiscordApiError`/10008 for this, so the branch is exercised against
   * the same error shape production sees.
   */
  it('treats a message that is already gone as a successful deletion', async () => {
    seedRule();
    nextMessageId += 1n;
    const messageId = nextMessageId.toString();
    discord.defineMessage({ channelId: CHANNEL, messageId, authorId: MEMBER });
    // A human moderator got there first.
    await discord.deleteMessage(GUILD, { channelId: CHANNEL, messageId }, 'by hand');

    await discord.emitMessageCreate({
      channelId: CHANNEL,
      messageId,
      authorId: MEMBER,
      content: 'badword here',
    });

    const modCase = findCase(MEMBER);
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    expect(events.map((e) => e.actionTaken)).toEqual(['deleted']);
  });

  it('deletes nothing while the kill switch is on', async () => {
    write(scope, ({ db }) => {
      db.update(schema.guilds).set({ killswitch: 1 }).where(scope.only(schema.guilds)).run();
    });
    seedRule();

    await sendMessage(MEMBER, 'badword here');

    expect(discord.restCalls('deleteMessage')).toHaveLength(0);
    const modCase = findCase(MEMBER);
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    expect(events.map((e) => e.actionTaken)).toEqual(['delete_blocked_killswitch']);
  });

  /**
   * ADR 0121's rollout, end to end: the switch sits on watch while the owner
   * reviews, then flips to on. The violation counter must reflect only what
   * was actually enforced — otherwise the first real match after the flip
   * reads a count of seven and kicks a member for their first enforced
   * violation.
   */
  it('does not carry watch matches into the escalation ladder', async () => {
    guildRepo.setAutomodState(scope, 'watch', discord.now());
    seedRule();

    for (let i = 0; i < 6; i += 1) {
      await sendMessage(MEMBER, 'badword here');
    }
    expect(discord.restCalls('deleteMessage')).toHaveLength(0);
    expect(findCase(MEMBER)?.violationCount).toBe(0);

    guildRepo.setAutomodState(scope, 'on', discord.now());
    await sendMessage(MEMBER, 'badword here');

    // One real violation, not seven — so no kick (the tier at 6).
    expect(findCase(MEMBER)?.violationCount).toBe(1);
    expect(discord.restCalls('kickMember')).toHaveLength(0);
    expect(discord.restCalls('timeoutMember')).toHaveLength(0);
    expect(discord.restCalls('deleteMessage')).toHaveLength(1);

    const events = modCaseRepo.listCaseEvents(scope, findCase(MEMBER)!.caseId);
    expect(events.map((e) => e.actionTaken)).toEqual([
      ...Array<string>(6).fill('would_delete'),
      'deleted',
    ]);
  });

  it('an escalation against a fake owner member is refused and durably recorded', async () => {
    seedRule();

    // Drive violationCount to 6 (the kick tier, mod-cases.ts's
    // `nextEscalationTier`) via repeated matching messages from the owner.
    for (let i = 0; i < 6; i += 1) {
      await sendMessage(OWNER, 'badword here');
    }

    // The message deletion happens unconditionally with automod On, before
    // escalation is even attempted, and a refusal does not undo it.
    expect(discord.restCalls('deleteMessage')).toHaveLength(6);

    const modCase = findCase(OWNER);
    expect(modCase?.violationCount).toBe(6);
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.actionTaken).toBe('escalation_refused');
    expect(lastEvent?.refusalReason).toBe('discord-owner');
    expect(lastEvent?.escalationAction).toBe('kick');

    // The gateway refuses on the live hierarchy check (member.isGuildOwner)
    // before it ever reaches the Discord call for either escalation action —
    // this is the exact assertion "would have caught tonight's finding about
    // refusals being log-only, had it existed for role effects."
    expect(discord.restCalls('timeoutMember')).toHaveLength(0);
    expect(discord.restCalls('kickMember')).toHaveLength(0);
    expect(discord.memberModerationState(OWNER)).toBeUndefined();
  });

  /**
   * End-to-end proof of ADR 0040 §5 against a real database: the unit test in
   * `subscriber.test.ts` fakes `listRules`, so this is the one that shows the
   * repository, the fingerprint and the cache agreeing — a term added mid-run
   * takes effect on the very next message, with no daemon restart. That gap
   * is what ADR 0035 left open and ADR 0039 made sharper.
   */
  it('applies a term added after the subscriber has already matched, with no restart', async () => {
    seedRule();

    await sendMessage(MEMBER, 'zapzap incoming');
    expect(discord.restCalls('deleteMessage')).toHaveLength(0);
    expect(findCase(MEMBER)).toBeUndefined();

    automodRuleRepo.addTerm(scope, { termId: 'term-2', categoryId: CATEGORY_ID, text: 'zapzap' });

    await sendMessage(MEMBER, 'zapzap incoming');

    expect(discord.restCalls('deleteMessage')).toHaveLength(1);
    const modCase = findCase(MEMBER);
    expect(modCase?.violationCount).toBe(1);
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    expect(events).toHaveLength(1);
    expect(events[0]?.matchedCategory).toBe(CATEGORY_ID);
  });

  /**
   * `doctor`, end to end against the same real database and the real
   * `apps/daemon/src/ops/wiring.ts#opsPortsFor` this daemon runs in
   * production — not the fakes `packages/core/src/ops/commands/reads.test.ts`
   * uses for its own unit coverage. An unusable rule must never silently do
   * nothing.
   *
   * **Repointed from `no-predicate` to `no-terms` in Slice 4 Task 5a.** This
   * test used to create a `rapid_spam` rule, relying on that kind being one of
   * the `mod_rules_kind` values with no predicate registered yet — and was
   * repointed three times as successive slices shipped the kind it borrowed
   * ('caps', then 'mention_spam', then 'rapid_spam'). After Task 5a, all ten
   * kinds have a predicate in production (`predicates/registry.ts`'s
   * `PREDICATES`), so `no-predicate` is unreachable through this real,
   * end-to-end stack — `predicates/registry.test.ts` covers it instead,
   * against an explicitly empty registry (`compileRuleWith({}, rule)`), which
   * is the only way left to construct that state. This test still needs
   * end-to-end coverage that *an* unusable rule is inert and loud in `doctor`,
   * so it uses `no-terms` instead: a `keyword_filter` rule with no enabled
   * terms, which — unlike `no-predicate` — stays reachable forever, because an
   * operator can always disable the last term of a real rule.
   */
  it('a rule that cannot be compiled is inert and shows up in doctor', async () => {
    automodRuleRepo.createRule(scope, {
      ruleId: 'no-terms-rule',
      kind: 'keyword_filter',
      name: 'a rule with nothing enabled',
      config: '{}',
      now: discord.now(),
    });
    // Deliberately no `addCategory`/`addTerm` call: zero enabled terms is what
    // makes `compileRule` report `no-terms` (registry.ts).

    // Never called by `doctor`: `opsPortsFor` only reaches `GuildOperations`
    // through `publishPanel`/the adoption allowance ports, none of which the
    // `doctor` command touches.
    const notUsedByDoctor = (name: string) => (): never => {
      throw new Error(`GuildOperations.${name} was called but this test did not stub it`);
    };
    const operations: GuildOperations = {
      publishPanel: notUsedByDoctor('publishPanel'),
      unpublishPanel: notUsedByDoctor('unpublishPanel'),
      createPanel: notUsedByDoctor('createPanel'),
      updatePanel: notUsedByDoctor('updatePanel'),
      grantAdoptionAllowance: notUsedByDoctor('grantAdoptionAllowance'),
      adoptionAllowance: notUsedByDoctor('adoptionAllowance'),
    };
    // Never connected to the gateway — `opsPortsFor`'s only use of the client
    // is `listKeywordFilterRulesMissingManageMessages`, which stays silent
    // for a guild absent from `client.guilds.cache` (see that function's own
    // comment), exactly this client's state.
    const client = new Client(buildClientOptions(() => BOT_USER_ID));
    const ports = opsPortsFor(
      scope,
      t.scopes.instance(),
      operations,
      () => discord.now(),
      client,
      false,
    );

    const notUsedByDoctorInstance = (name: string) => (): never => {
      throw new Error(`OpsInstance.${name} was called but this test did not stub it`);
    };
    const instance: OpsInstance = {
      startedAtMs: 0,
      readonly: false,
      env: 'test',
      gateway: notUsedByDoctorInstance('gateway'),
      doctor: () => ({ ok: true, text: 'gateway: ok', data: null }),
      // All-clear, not "not used": `doctor` reads this member on every run,
      // and this test's subject is the unusable automod rule, not the tunnel.
      probePublicSurface: () =>
        Promise.resolve({
          probed: false,
          ok: true,
          text: 'public surface    not probed (MCP_PUBLIC_URL unset)',
          data: null,
        }),
      redactedConfig: notUsedByDoctorInstance('redactedConfig'),
      reissueBootstrapToken: notUsedByDoctorInstance('reissueBootstrapToken'),
      backupNow: notUsedByDoctorInstance('backupNow'),
      backupList: notUsedByDoctorInstance('backupList'),
      mcpClients: notUsedByDoctorInstance('mcpClients'),
      mcpTokens: notUsedByDoctorInstance('mcpTokens'),
      mcpRevokeToken: notUsedByDoctorInstance('mcpRevokeToken'),
      mcpRevokeClient: notUsedByDoctorInstance('mcpRevokeClient'),
      mcpConnections: notUsedByDoctorInstance('mcpConnections'),
      mcpDisconnect: notUsedByDoctorInstance('mcpDisconnect'),
      mcpDeleteConnection: notUsedByDoctorInstance('mcpDeleteConnection'),
      mcpDeleteToken: notUsedByDoctorInstance('mcpDeleteToken'),
      mcpCleanup: notUsedByDoctorInstance('mcpCleanup'),
      // All-clear, not "not used": `doctor` reads this member on every run,
      // and this test's subject is the unusable automod rule, not eligibility.
      providerEligibilityWarnings: () => [],
      providerReview: notUsedByDoctorInstance('providerReview'),
      accountList: notUsedByDoctorInstance('accountList'),
      accountSetDisabled: notUsedByDoctorInstance('accountSetDisabled'),
      accountDelete: notUsedByDoctorInstance('accountDelete'),
      accountRevokeCredentials: notUsedByDoctorInstance('accountRevokeCredentials'),
      accountCreate: notUsedByDoctorInstance('accountCreate'),
      accountSetPassword: notUsedByDoctorInstance('accountSetPassword'),
      accountRevealPassword: notUsedByDoctorInstance('accountRevealPassword'),
    };

    const dispatcher = createDispatcher({
      commands: [doctorCommand],
      guildIds: [GUILD],
      contextFor: () => ({ guildId: GUILD, now: () => discord.now(), ports }),
      instance,
    });

    const res = await dispatcher.dispatch({ v: 1, command: 'doctor', args: {} });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('no-terms-rule');
    expect(res.text).toContain('no-terms');
    expect(res.data).toMatchObject({
      ok: false,
      unusableAutomodRules: [
        {
          ruleId: 'no-terms-rule',
          kind: 'keyword_filter',
          reason: 'no-terms',
        },
      ],
    });
  });

  /**
   * P2 Task 4 (ADR 0141 decision 3): a Watch-mode match posts one
   * `automod_match` card to the route channel. The subscriber is driven
   * directly — twice with the same event — because the pipeline's own gate-2
   * dedupe would swallow the redelivery before the claim fingerprint is ever
   * consulted, and it is the claim (`automod:<messageId>:<ruleId>`) this test
   * is about.
   */
  it('posts one automod_match card per message, even when the message is redelivered', async () => {
    guildRepo.setAutomodState(scope, 'watch', discord.now());
    seedRule();
    loggingRepo.createRoute(scope, {
      name: 'automod matches',
      channelId: LOG,
      includeContent: true,
      enabled: true,
      eventKinds: ['automod_match'],
      excludedChannelIds: [],
      nowMs: 0,
    });

    const subscriber = createAutomodSubscriber(buildAutomodPorts());
    const event: MessageEvent = {
      kind: 'messageCreate',
      guildId: GUILD,
      receivedAtMs: discord.now(),
      channelId: CHANNEL,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageId: '200000000000000000',
      authorId: MEMBER,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: 'badword here',
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
    };
    await subscriber.handle(event);
    await subscriber.handle(event);

    const cards = sentTo(LOG);
    expect(cards).toHaveLength(1);
    const text = textOf(cards[0]!);
    expect(text).toContain('AUTOMOD MATCH');
    expect(text).toContain('Watch only');
    expect(JSON.stringify(cards[0]!.components)).toContain('bs.mod:delete:');
  });
});
