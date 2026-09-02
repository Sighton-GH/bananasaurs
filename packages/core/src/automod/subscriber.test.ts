import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { authorize, type Authorized, type AuthzStore } from '../authz.js';
import { parseGuildId, parseSnowflakeId } from '../ids.js';
import { DiscordApiError, DiscordErrorCode } from '../discord/errors.js';
import type { DomainEvent, MessageEvent, ReactionEvent } from '../discord/events.js';
import type {
  ModerationIntent,
  ModerationOutcome,
  ModerationSafetyState,
} from '../effects/moderation-gateway.js';
import {
  createAutomodSubscriber,
  type AutomodSubscriberDeps,
  type ModerationGatewayPort,
  type RuleWithWordList,
} from './subscriber.js';

/**
 * Unit tests for the automod subscriber's decision logic, at the same level
 * `logging/subscriber.test.ts` tests at: every port is faked, nothing
 * touches a real database or Discord.
 */

const GUILD = parseGuildId('111111111111111111');
const AUTHOR = '222222222222222222';
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';
const NOW_MS = 1_700_000_000_000;

const silentLogger = pino({ level: 'silent' });

/** A real pino instance over a captured stream, so redaction runs for real. */
const capturingLogger = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
};

const permissiveAuthz: AuthzStore = { hasGrant: () => true };

/** `system` bypasses the grant check entirely (authz.ts), so this needs no store setup. */
const moderationAuth: Authorized<'moderation.act'> = (() => {
  const result = authorize(
    {
      store: permissiveAuthz,
      guildId: GUILD,
      actor: { type: 'system', id: undefined, roleIds: [] },
    },
    'moderation.act',
  );
  if (!result.ok) throw new Error('test setup: expected authorization to succeed');
  return result.value;
})();

const rule = (over: Partial<RuleWithWordList> & { ruleId: string }): RuleWithWordList => ({
  mode: 'enforce',
  terms: [{ text: 'badword', categoryId: 'cat-1' }],
  allowlist: [],
  ...over,
});

const messageCreate = (over: Partial<MessageEvent> = {}): DomainEvent => ({
  kind: 'messageCreate',
  guildId: GUILD,
  receivedAtMs: NOW_MS,
  channelId: CHANNEL,
  messageId: MESSAGE,
  authorId: AUTHOR,
  authorIsBot: false,
  content: 'this message has badword in it',
  editedTimestampMs: undefined,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

interface Harness {
  deps: AutomodSubscriberDeps;
  calls: {
    listRules: number;
    isExempt: { ruleId: string; input: { authorRoleIds: readonly string[]; channelId: string } }[];
    deleteMessage: { channelId: string; messageId: string; reason: string }[];
    openOrResolveCase: { memberId: string; countsAsViolation: boolean }[];
    recordCaseEvent: Parameters<AutomodSubscriberDeps['recordCaseEvent']>[0][];
    applyAction: { auth: unknown; intent: ModerationIntent }[];
    readSafetyState: number;
    authorRoleIds: string[];
    nextEscalationTier: number[];
  };
}

/** Everything live: not read-only, not stopped, not dry-run. */
const LIVE: ModerationSafetyState = { killswitch: false, breakerOpen: false, dryRun: false };

function buildHarness(
  opts: {
    rules?: readonly RuleWithWordList[];
    exemptRuleIds?: ReadonlySet<string>;
    violationCount?: number;
    tier?: { action: 'timeout' | 'kick' | undefined; timeoutMs: number | undefined };
    applyActionResult?: ModerationOutcome;
    logger?: typeof silentLogger;
    /** `null` stands for "this guild is not in the database at all". */
    safetyState?: ModerationSafetyState | null;
    /** Which rules have a role-type exemption configured (a cheap local read). */
    roleExemptRuleIds?: ReadonlySet<string>;
    /** Thrown by `deleteMessage`, mimicking `DiscordPort`'s real failures. */
    deleteMessageError?: Error;
    /** Thrown by `authorRoleIds`, i.e. `fetchMember` rejecting. */
    authorRoleIdsError?: Error;
    authorRoleIds?: readonly string[];
  } = {},
): Harness {
  const calls: Harness['calls'] = {
    listRules: 0,
    isExempt: [],
    deleteMessage: [],
    openOrResolveCase: [],
    recordCaseEvent: [],
    applyAction: [],
    readSafetyState: 0,
    authorRoleIds: [],
    nextEscalationTier: [],
  };

  const exempt = opts.exemptRuleIds ?? new Set<string>();
  let counted = 0;
  const tier = opts.tier ?? { action: undefined, timeoutMs: undefined };
  const moderationGateway: ModerationGatewayPort = {
    async applyAction(auth, intent) {
      calls.applyAction.push({ auth, intent });
      return opts.applyActionResult ?? { status: 'applied' };
    },
  };

  const deps: AutomodSubscriberDeps = {
    logger: opts.logger ?? silentLogger,
    moderationAuth,
    listRules: () => {
      calls.listRules += 1;
      return opts.rules ?? [];
    },
    isExempt: (ruleId, input) => {
      calls.isExempt.push({ ruleId, input });
      return exempt.has(ruleId);
    },
    hasRoleExemption: (ruleId) => (opts.roleExemptRuleIds ?? new Set<string>()).has(ruleId),
    deleteMessage: async (channelId, messageId, reason) => {
      calls.deleteMessage.push({ channelId, messageId, reason });
      if (opts.deleteMessageError !== undefined) throw opts.deleteMessageError;
    },
    // Stateful, like the real repo: a counting call moves the counter and a
    // non-counting one does not. `opts.violationCount` overrides it outright
    // for tests that want to start at a specific tier.
    openOrResolveCase: (memberId, options) => {
      calls.openOrResolveCase.push({ memberId, countsAsViolation: options.countsAsViolation });
      if (options.countsAsViolation) counted += 1;
      return { caseId: 'case-1', violationCount: opts.violationCount ?? counted };
    },
    recordCaseEvent: (input) => {
      calls.recordCaseEvent.push(input);
    },
    nextEscalationTier: (violationCount) => {
      calls.nextEscalationTier.push(violationCount);
      return tier;
    },
    moderationGateway,
    authorRoleIds: async (userId) => {
      calls.authorRoleIds.push(userId);
      if (opts.authorRoleIdsError !== undefined) throw opts.authorRoleIdsError;
      return opts.authorRoleIds ?? [];
    },
    readSafetyState: () => {
      calls.readSafetyState += 1;
      const state = opts.safetyState === undefined ? LIVE : opts.safetyState;
      return state ?? undefined;
    },
  };

  return { deps, calls };
}

describe('automod subscriber', () => {
  it('ignores an event that is not messageCreate or messageUpdate', async () => {
    const { deps, calls } = buildHarness({ rules: [rule({ ruleId: 'rule-1' })] });
    const subscriber = createAutomodSubscriber(deps);

    const reaction: ReactionEvent = {
      kind: 'reactionAdd',
      guildId: GUILD,
      receivedAtMs: NOW_MS,
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId: AUTHOR,
      emoji: '👍',
      wasPartial: false,
    };
    await subscriber.handle(reaction);

    expect(calls.listRules).toBe(0);
    expect(calls.deleteMessage).toHaveLength(0);
    expect(calls.recordCaseEvent).toHaveLength(0);
  });

  /**
   * I4: discord.js emits `MessageCreate` for the bot's own messages too, and
   * the `message_delete` logging route quotes the deleted content by default
   * (docs/SMOKE_TESTS.md §B). An enforce-mode rule therefore closed a loop:
   * automod deletes a flagged message -> the deletion is logged, with the
   * flagged word in it -> that log message is itself a `messageCreate` that
   * matches -> automod deletes its own log message -> logged again, forever,
   * incrementing a case against the bot's own user id every lap.
   *
   * Every bot and webhook author is skipped, not only this bot's own id:
   * that is the standard way Discord bots avoid self-triggering, and a
   * *different* bot's output is not a member's speech to moderate either.
   */
  it('never processes a message authored by a bot, however well it matches', async () => {
    const { deps, calls } = buildHarness({
      rules: [rule({ ruleId: 'rule-bot', mode: 'enforce' })],
    });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate({ authorIsBot: true }));

    expect(calls.listRules).toBe(0);
    expect(calls.deleteMessage).toHaveLength(0);
    expect(calls.openOrResolveCase).toHaveLength(0);
    expect(calls.recordCaseEvent).toHaveLength(0);
  });

  it('deletes a message that matches an enforce-mode rule', async () => {
    const { deps, calls } = buildHarness({ rules: [rule({ ruleId: 'rule-2', mode: 'enforce' })] });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate());

    expect(calls.deleteMessage).toEqual([
      { channelId: CHANNEL, messageId: MESSAGE, reason: 'automod: rule-2' },
    ]);
    expect(calls.openOrResolveCase).toEqual([{ memberId: AUTHOR, countsAsViolation: true }]);
    expect(calls.recordCaseEvent).toEqual([
      {
        caseId: 'case-1',
        ruleId: 'rule-2',
        memberId: AUTHOR,
        matchedCategory: 'cat-1',
        matchedSnippet: 'badword',
        actionTaken: 'deleted',
        escalationAction: undefined,
        refusalReason: undefined,
      },
    ]);
    expect(calls.applyAction).toHaveLength(0);
  });

  it('does not call Discord in test mode, but still records what would have happened', async () => {
    const { deps, calls } = buildHarness({ rules: [rule({ ruleId: 'rule-3', mode: 'test' })] });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate());

    expect(calls.deleteMessage).toHaveLength(0);
    expect(calls.applyAction).toHaveLength(0);
    // Not `'deleted'`: nothing was deleted, and the record must say so.
    expect(calls.recordCaseEvent).toEqual([
      expect.objectContaining({ ruleId: 'rule-3', actionTaken: 'would_delete' }),
    ]);
  });

  it('does not call Discord in observe mode either', async () => {
    const { deps, calls } = buildHarness({ rules: [rule({ ruleId: 'rule-4', mode: 'observe' })] });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate());

    expect(calls.deleteMessage).toHaveLength(0);
    expect(calls.applyAction).toHaveLength(0);
    // Distinguishable from the test-mode case by which rule triggered it.
    expect(calls.recordCaseEvent).toEqual([
      expect.objectContaining({ ruleId: 'rule-4', actionTaken: 'would_delete' }),
    ]);
  });

  it('skips an exempt author/channel entirely', async () => {
    const { deps, calls } = buildHarness({
      rules: [rule({ ruleId: 'rule-5', mode: 'enforce' })],
      exemptRuleIds: new Set(['rule-5']),
    });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate());

    expect(calls.isExempt).toEqual([
      { ruleId: 'rule-5', input: { authorRoleIds: [], channelId: CHANNEL } },
    ]);
    expect(calls.deleteMessage).toHaveLength(0);
    expect(calls.openOrResolveCase).toHaveLength(0);
    expect(calls.recordCaseEvent).toHaveLength(0);
    expect(calls.applyAction).toHaveLength(0);
  });

  it('escalates and records the applied action when the violation count crosses a tier', async () => {
    const { deps, calls } = buildHarness({
      rules: [rule({ ruleId: 'rule-6', mode: 'enforce' })],
      violationCount: 3,
      tier: { action: 'timeout', timeoutMs: 600_000 },
      applyActionResult: { status: 'applied' },
    });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate());

    expect(calls.deleteMessage).toHaveLength(1);
    expect(calls.applyAction).toEqual([
      {
        auth: moderationAuth,
        intent: {
          userId: parseSnowflakeId(AUTHOR),
          action: 'timeout',
          timeoutMs: 600_000,
          dedupeKey: `${GUILD}:case-1:rule-6:${MESSAGE}`,
          reason: 'automod escalation: rule-6',
        },
      },
    ]);
    expect(calls.recordCaseEvent).toEqual([
      {
        caseId: 'case-1',
        ruleId: 'rule-6',
        memberId: AUTHOR,
        matchedCategory: 'cat-1',
        matchedSnippet: 'badword',
        actionTaken: 'deleted_and_escalated',
        escalationAction: 'timeout',
        refusalReason: undefined,
      },
    ]);
  });

  it('records a refused escalation durably, not just deletes the message', async () => {
    const { deps, calls } = buildHarness({
      rules: [rule({ ruleId: 'rule-7', mode: 'enforce' })],
      violationCount: 6,
      tier: { action: 'kick', timeoutMs: undefined },
      applyActionResult: { status: 'refused', reason: 'discord-owner' },
    });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate());

    // The message deletion already succeeded before escalation was attempted,
    // and a refusal does not undo it.
    expect(calls.deleteMessage).toEqual([
      { channelId: CHANNEL, messageId: MESSAGE, reason: 'automod: rule-7' },
    ]);
    expect(calls.recordCaseEvent).toEqual([
      {
        caseId: 'case-1',
        ruleId: 'rule-7',
        memberId: AUTHOR,
        matchedCategory: 'cat-1',
        matchedSnippet: 'badword',
        actionTaken: 'escalation_refused',
        escalationAction: 'kick',
        refusalReason: 'discord-owner',
      },
    ]);
  });

  it('a matcher throwing is caught, logged, and does not stop the message from being processed by other rules', async () => {
    const { logger, lines } = capturingLogger();
    const brokenRule = rule({
      ruleId: 'rule-8-broken',
      terms: [{ text: '[unclosed', categoryId: 'cat-x' }],
    });
    const okRule = rule({ ruleId: 'rule-8-ok', mode: 'enforce' });
    const { deps, calls } = buildHarness({ rules: [brokenRule, okRule], logger });
    const subscriber = createAutomodSubscriber(deps);

    await expect(subscriber.handle(messageCreate())).resolves.toBeUndefined();

    // The broken rule logged an error and produced no case event of its own...
    const parsed = lines.map((l) => JSON.parse(l) as { ruleId?: string; msg?: string });
    expect(
      parsed.some((l) => l.ruleId === 'rule-8-broken' && (l.msg ?? '').includes('matcher threw')),
    ).toBe(true);
    // ...while the second rule still ran and matched normally.
    expect(calls.deleteMessage).toEqual([
      { channelId: CHANNEL, messageId: MESSAGE, reason: 'automod: rule-8-ok' },
    ]);
    expect(calls.recordCaseEvent).toEqual([
      expect.objectContaining({ ruleId: 'rule-8-ok', actionTaken: 'deleted' }),
    ]);
  });

  /**
   * CLAUDE.md rule 2: "every query, cache key, job payload, index, export,
   * log line and provider request carries an explicit guild ID".
   *
   * The matcher cache is module-level and was keyed on the bare `ruleId`.
   * `daemon.ts` seeds every guild's default rule under the *same* id
   * (`'default-word-filter'`), and the daemon structurally supports N guilds
   * via its allowlist — so whichever guild's message arrived first built the
   * matcher for that id and every other guild was then matched against the
   * first guild's word list.
   */
  it('never matches one guild against another guild’s word list', async () => {
    const SHARED_RULE_ID = 'default-word-filter';
    const GUILD_2 = parseGuildId('999999999999999999');

    const first = buildHarness({
      rules: [
        rule({ ruleId: SHARED_RULE_ID, terms: [{ text: 'alpha', categoryId: 'cat-alpha' }] }),
      ],
    });
    const second = buildHarness({
      rules: [rule({ ruleId: SHARED_RULE_ID, terms: [{ text: 'beta', categoryId: 'cat-beta' }] })],
    });

    // Guild 1 goes first, so it is the one that populates the cache.
    await createAutomodSubscriber(first.deps).handle(
      messageCreate({ content: 'an alpha message' }),
    );
    expect(first.calls.deleteMessage).toHaveLength(1);

    const subscriber2 = createAutomodSubscriber(second.deps);
    await subscriber2.handle(messageCreate({ guildId: GUILD_2, content: 'a beta message' }));
    // Guild 2's own word. With the shared key this was matched against guild
    // 1's list and missed entirely.
    expect(second.calls.deleteMessage).toHaveLength(1);
    expect(second.calls.recordCaseEvent).toEqual([
      expect.objectContaining({ matchedCategory: 'cat-beta', matchedSnippet: 'beta' }),
    ]);

    // ...and the converse: guild 1's word is not a violation in guild 2.
    await subscriber2.handle(messageCreate({ guildId: GUILD_2, content: 'an alpha message' }));
    expect(second.calls.deleteMessage).toHaveLength(1);
  });

  /**
   * docs/18 Layer 6: the kill switch "stops all Discord side effects
   * immediately", and a dry-run guild performs "no writes at all". The
   * deletion is a Discord side effect like any other, and dry run is the
   * DEFAULT state of an unconfigured guild — so an automod rule flipped to
   * enforce before the owner turns dry run off must not delete a real
   * member's message.
   */
  describe('safety gates on the deletion path', () => {
    const blocked: [string, ModerationSafetyState | null, string][] = [
      ['the kill switch is on', { ...LIVE, killswitch: true }, 'delete_blocked_killswitch'],
      ['the circuit breaker is open', { ...LIVE, breakerOpen: true }, 'delete_blocked_breaker'],
      ['the guild is in dry run', { ...LIVE, dryRun: true }, 'delete_blocked_dry_run'],
      ['the guild is not in the database', null, 'delete_blocked_guild_unknown'],
    ];

    for (const [name, safetyState, actionTaken] of blocked) {
      it(`does not delete when ${name}, and records why`, async () => {
        const { deps, calls } = buildHarness({
          rules: [rule({ ruleId: 'rule-safety', mode: 'enforce' })],
          safetyState,
          violationCount: 6,
          tier: { action: 'kick', timeoutMs: undefined },
        });
        const subscriber = createAutomodSubscriber(deps);

        await subscriber.handle(messageCreate());

        expect(calls.deleteMessage).toHaveLength(0);
        // Nor may a blocked deletion fall through into an escalation — the
        // kill switch stops *every* side effect, not only the delete.
        expect(calls.applyAction).toHaveLength(0);
        expect(calls.recordCaseEvent).toEqual([
          expect.objectContaining({ ruleId: 'rule-safety', actionTaken }),
        ]);
      });
    }

    it('reads the safety state before every enforce-mode deletion', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-live', mode: 'enforce' })],
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      expect(calls.readSafetyState).toBeGreaterThan(0);
      expect(calls.deleteMessage).toHaveLength(1);
    });

    it('does not read the safety state for a non-enforce rule', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-observe', mode: 'observe' })],
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      expect(calls.readSafetyState).toBe(0);
    });
  });

  /**
   * I3: `authorRoleIds` is a real, uncached `GET /guilds/{g}/members/{u}`
   * (`automod/wiring.ts` binds it to `DiscordPort.fetchMember`). It used to
   * run for *every* message in the guild, before anything had established
   * that there was a rule to check or a role exemption to check it against —
   * REST latency and 429 exposure on every message, ahead of the deletion.
   */
  describe('the author role fetch', () => {
    it('does not happen at all when there are no rules', async () => {
      const { deps, calls } = buildHarness({ rules: [] });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      expect(calls.authorRoleIds).toEqual([]);
      expect(calls.isExempt).toHaveLength(0);
    });

    it('does not happen when no rule has a role exemption configured', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-no-role-exempt', mode: 'enforce' })],
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      // Channel exemptions still get their chance — that check is a local
      // read, not a REST call.
      expect(calls.authorRoleIds).toEqual([]);
      expect(calls.isExempt).toEqual([
        { ruleId: 'rule-no-role-exempt', input: { authorRoleIds: [], channelId: CHANNEL } },
      ]);
      expect(calls.deleteMessage).toHaveLength(1);
    });

    it('happens once, at most, however many rules need it', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-a' }), rule({ ruleId: 'rule-b' })],
        roleExemptRuleIds: new Set(['rule-a', 'rule-b']),
        authorRoleIds: ['555555555555555555'],
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      expect(calls.authorRoleIds).toEqual([AUTHOR]);
      expect(calls.isExempt.map((c) => c.input.authorRoleIds)).toEqual([
        ['555555555555555555'],
        ['555555555555555555'],
      ]);
    });

    /**
     * `fetchMember` throws for an author who is not a guild member — a
     * webhook, an application-owned message, or somebody who left between
     * posting and processing. That used to escape `handle` uncaught.
     */
    it('failing leaves the author with no roles rather than crashing the handler', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-fetch-fails', mode: 'enforce' })],
        roleExemptRuleIds: new Set(['rule-fetch-fails']),
        authorRoleIdsError: new Error('unknown member'),
      });
      const subscriber = createAutomodSubscriber(deps);

      await expect(subscriber.handle(messageCreate())).resolves.toBeUndefined();

      expect(calls.isExempt).toEqual([
        { ruleId: 'rule-fetch-fails', input: { authorRoleIds: [], channelId: CHANNEL } },
      ]);
      // The message is still evaluated; no role-based exemption applies.
      expect(calls.deleteMessage).toHaveLength(1);
    });
  });

  /**
   * I2: the delete had no try/catch, so a rejection escaped `handle` — after
   * `openOrResolveCase` had already incremented the violation counter, with
   * no `mod_case_events` row to show for it, and with every later rule for
   * that message skipped.
   */
  describe('when the deletion fails', () => {
    it('treats an already-deleted message as success (design spec §6)', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-gone', mode: 'enforce' })],
        deleteMessageError: new DiscordApiError(
          404,
          DiscordErrorCode.UnknownMessage,
          'Unknown Message',
        ),
        violationCount: 3,
        tier: { action: 'timeout', timeoutMs: 600_000 },
      });
      const subscriber = createAutomodSubscriber(deps);

      await expect(subscriber.handle(messageCreate())).resolves.toBeUndefined();

      // "The outcome (message gone) is what the rule wanted" — so processing
      // continues into escalation exactly as if we had deleted it ourselves.
      expect(calls.applyAction).toHaveLength(1);
      expect(calls.recordCaseEvent).toEqual([
        expect.objectContaining({ actionTaken: 'deleted_and_escalated' }),
      ]);
    });

    it('records the failure and keeps going on any other error', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-403', mode: 'enforce' }), rule({ ruleId: 'rule-after' })],
        deleteMessageError: new DiscordApiError(
          403,
          DiscordErrorCode.MissingPermissions,
          'Missing Permissions',
        ),
        violationCount: 3,
        tier: { action: 'timeout', timeoutMs: 600_000 },
      });
      const subscriber = createAutomodSubscriber(deps);

      await expect(subscriber.handle(messageCreate())).resolves.toBeUndefined();

      // The violation is not silently lost from case history...
      expect(calls.recordCaseEvent[0]).toEqual(
        expect.objectContaining({ ruleId: 'rule-403', actionTaken: 'delete_failed' }),
      );
      // ...nothing is escalated off a deletion that did not happen...
      expect(calls.applyAction).toHaveLength(0);
      // ...and the next rule for this message still runs.
      expect(calls.recordCaseEvent).toHaveLength(2);
      expect(calls.recordCaseEvent[1]).toEqual(
        expect.objectContaining({ ruleId: 'rule-after', actionTaken: 'delete_failed' }),
      );
    });
  });

  /**
   * I5: the documented rollout (spec §8) is "ship in test mode, the operator
   * reviews and tunes, then flips to enforce". `openOrResolveCase` used to
   * increment the per-member violation counter for *every* mode, so ordinary
   * members' counts climbed silently throughout the observation period — and
   * the very first real match after the flip could read an already-high count
   * and go straight to a kick, defeating the entire point of the staged
   * rollout.
   */
  describe('the violation counter', () => {
    it('does not move for a test-mode match, so flipping to enforce starts at one', async () => {
      const rules: RuleWithWordList[] = [rule({ ruleId: 'rule-rollout', mode: 'test' })];
      const { deps, calls } = buildHarness({ rules });
      const subscriber = createAutomodSubscriber(deps);

      // A long observation period: five matches while the operator tunes.
      for (let i = 0; i < 5; i += 1) await subscriber.handle(messageCreate());
      expect(calls.openOrResolveCase.every((c) => !c.countsAsViolation)).toBe(true);

      rules[0] = rule({ ruleId: 'rule-rollout', mode: 'enforce' });
      await subscriber.handle(messageCreate());

      // The first *real* violation is violation number one — not number six,
      // which `nextEscalationTier` would have answered with a kick.
      expect(calls.nextEscalationTier).toEqual([1]);
      expect(calls.applyAction).toHaveLength(0);
    });

    it('does not move when a safety layer blocked the deletion', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-blocked', mode: 'enforce' })],
        safetyState: { ...LIVE, dryRun: true },
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      // Same reasoning as test mode: no enforcement happened, so nothing
      // should accrue towards a kick the moment dry run is turned off.
      expect(calls.openOrResolveCase).toEqual([{ memberId: AUTHOR, countsAsViolation: false }]);
    });
  });

  /**
   * I1: `ModerationOutcome` has five variants and `action_taken` used to
   * collapse four of them onto `'deleted_and_escalated'` — recording a
   * timeout or a kick that never happened.
   */
  describe('every moderation outcome is recorded honestly', () => {
    const outcomes: [ModerationOutcome, string][] = [
      [{ status: 'applied' }, 'deleted_and_escalated'],
      [{ status: 'refused', reason: 'role-above-bot' }, 'escalation_refused'],
      [{ status: 'failed', code: 'DiscordApiError' }, 'escalation_failed'],
      [{ status: 'dry-run' }, 'escalation_dry_run'],
      [{ status: 'skipped', reason: 'already-applied' }, 'escalation_skipped'],
    ];

    for (const [outcome, actionTaken] of outcomes) {
      it(`records a ${outcome.status} escalation as ${actionTaken}`, async () => {
        const { deps, calls } = buildHarness({
          rules: [rule({ ruleId: 'rule-outcome', mode: 'enforce' })],
          violationCount: 3,
          tier: { action: 'timeout', timeoutMs: 600_000 },
          applyActionResult: outcome,
        });
        const subscriber = createAutomodSubscriber(deps);

        await subscriber.handle(messageCreate());

        expect(calls.deleteMessage).toHaveLength(1);
        expect(calls.recordCaseEvent).toEqual([
          expect.objectContaining({
            actionTaken,
            escalationAction: 'timeout',
            refusalReason: outcome.status === 'refused' ? outcome.reason : undefined,
          }),
        ]);
      });
    }
  });
});
