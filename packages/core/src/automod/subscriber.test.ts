import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { authorize, type Authorized, type AuthzStore } from '../authz.js';
import { parseGuildId, parseSnowflakeId } from '../ids.js';
import { DiscordApiError, DiscordErrorCode } from '../discord/errors.js';
import type {
  DomainEvent,
  MessageAttachment,
  MessageEvent,
  ReactionEvent,
} from '../discord/events.js';
import type { ModerationIntent, ModerationOutcome } from '../effects/moderation-gateway.js';
import type { AutomodRule } from './predicates/types.js';
import * as registry from './predicates/registry.js';
import {
  createAutomodSubscriber,
  type AutomodSafetyState,
  type AutomodSubscriberDeps,
  type ModerationGatewayPort,
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

/**
 * A real pino instance over a captured stream, so redaction runs for real —
 * no test-only stub standing in for `Logger`, which is pino's own type and
 * too large a surface to hand-fake convincingly.
 *
 * `errors` re-parses `lines` on every access rather than snapshotting a count
 * at creation, so a case that calls `handle` several times and checks
 * `errors.length` between calls sees the truth each time — precisely the
 * property the "logs once per rule, not once per message" tests below rely
 * on. Pino's numeric `level` is 50 for `error` (trace 10 … fatal 60).
 */
const capturingLogger = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    logger: pino({ level: 'info' }, stream),
    lines,
    get errors(): { ruleId?: string; msg?: string }[] {
      return lines
        .map((l) => JSON.parse(l) as { level: number; ruleId?: string; msg?: string })
        .filter((l) => l.level === 50);
    },
  };
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

const rule = (over: Partial<AutomodRule> & { ruleId: string }): AutomodRule => ({
  kind: 'keyword_filter',
  config: '{}',
  mode: 'enforce',
  terms: [{ text: 'badword', categoryId: 'cat-1' }],
  allowlist: [],
  inviteAllowlist: [],
  linkDomains: [],
  // ADR 0042's default: a rule feeds the escalation counter unless it opts
  // out, so a test that does not care about this field gets the stricter,
  // pre-existing behaviour every other test in this file already asserts.
  countsAsViolation: true,
  ...over,
});

/**
 * A `keyword_filter` rule named only by its word list, for the
 * cache-invalidation tests below — those cases mutate `terms`/`allowlist`
 * between messages, so the shape they want is "one rule, everything else
 * defaulted" rather than `rule`'s `ruleId`-first shape.
 */
const ruleWith = (
  terms: readonly { text: string; categoryId: string }[],
  allowlist: readonly string[] = [],
): AutomodRule => rule({ ruleId: 'cache-rule', terms, allowlist });

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
    captureFixture: {
      messageId: string;
      content: string;
      authorId: string;
      atMs: number;
      attachments: readonly MessageAttachment[];
    }[];
  };
}

/** Everything live: not read-only, not stopped, not dry-run. */
const LIVE: AutomodSafetyState = {
  killswitch: false,
  breakerOpen: false,
  dryRun: false,
  automodTestingMode: false,
};

function buildHarness(
  opts: {
    rules?: readonly AutomodRule[];
    exemptRuleIds?: ReadonlySet<string>;
    violationCount?: number;
    tier?: { action: 'timeout' | 'kick' | undefined; timeoutMs: number | undefined };
    applyActionResult?: ModerationOutcome;
    logger?: typeof silentLogger;
    /** `null` stands for "this guild is not in the database at all". */
    safetyState?: AutomodSafetyState | null;
    /** Which rules have a role-type exemption configured (a cheap local read). */
    roleExemptRuleIds?: ReadonlySet<string>;
    /** Thrown by `deleteMessage`, mimicking `DiscordPort`'s real failures. */
    deleteMessageError?: Error;
    /** Thrown by `authorRoleIds`, i.e. `fetchMember` rejecting. */
    authorRoleIdsError?: Error;
    authorRoleIds?: readonly string[];
    /** What `captureFixture` returns; `undefined` by default (nothing captured). */
    captureFixtureResult?: string;
    /** Thrown by `captureFixture`, mimicking a corpus write failure. */
    captureFixtureError?: Error;
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
    captureFixture: [],
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
    captureFixture: (input) => {
      calls.captureFixture.push(input);
      if (opts.captureFixtureError !== undefined) throw opts.captureFixtureError;
      return opts.captureFixtureResult;
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
        // The predicate's own trace, threaded through unchanged (Task 5):
        // `matchedOn` names the *configured* term, not the possibly-evasive
        // matched spelling, which is what Slice 9's suppression will key on.
        trace: expect.objectContaining({ kind: 'keyword_filter', matchedOn: 'badword' }),
      },
    ]);
    expect(calls.applyAction).toHaveLength(0);
  });

  /**
   * ADR 0042 §2: `caps` and any future high-risk predicate can ship
   * delete-only, held to the 5% false-positive bar instead of the zero bar a
   * counter-feeding rule must clear — but only if the subscriber actually
   * reads the flag from the rule rather than hard-coding `true` on every
   * enforce-mode match, which is what it did before this task.
   *
   * Asserts the deletion *and* the flag together (plan Task 4's own
   * stated ambiguity): an implementation that skipped the action entirely
   * — never calling `deleteMessage` or `openOrResolveCase` at all — would
   * satisfy an assertion on the flag alone without actually enforcing
   * anything.
   */
  it('honours countsAsViolation: false on the enforce path — deletes, but does not feed the counter', async () => {
    const { deps, calls } = buildHarness({
      rules: [rule({ ruleId: 'rule-delete-only', mode: 'enforce', countsAsViolation: false })],
    });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate());

    expect(calls.deleteMessage).toEqual([
      { channelId: CHANNEL, messageId: MESSAGE, reason: 'automod: rule-delete-only' },
    ]);
    expect(calls.openOrResolveCase).toEqual([{ memberId: AUTHOR, countsAsViolation: false }]);
    expect(calls.recordCaseEvent).toEqual([
      expect.objectContaining({ ruleId: 'rule-delete-only', actionTaken: 'deleted' }),
    ]);
  });

  /**
   * The test above passes without reaching the escalation branch at all: the
   * harness defaults to `tier: { action: undefined }`, so the "has this member
   * crossed a tier" path is never entered and nothing about escalation is
   * asserted. That is the decorative shape `docs/22` catalogues, and this is
   * the case it was hiding.
   *
   * Not feeding the counter is not the same as not reading it.
   * `openOrResolveCase` returns the member's *existing* count — earned by other
   * rules — and the subscriber passed that straight to `nextEscalationTier`,
   * which compares with `>=`. So a delete-only rule matching a member who is
   * already sitting on a tier timed out or kicked them, and did it again on
   * every subsequent match, because the dedupe key includes `messageId`.
   *
   * Why that is a correctness bug and not a policy choice: ADR 0042 §4 holds a
   * delete-only rule to a 5% false-positive rate instead of zero **because its
   * only consequence is removing the message**. A rule that can also time out a
   * member has not earned that tolerance — the looser tier was granted against
   * a promise the code did not keep. One in twenty of its matches being wrong
   * is acceptable for a deletion and plainly not acceptable for a timeout.
   */
  it('a delete-only rule does not escalate, even for a member already on a tier', async () => {
    const { deps, calls } = buildHarness({
      rules: [
        rule({ ruleId: 'rule-delete-only-tiered', mode: 'enforce', countsAsViolation: false }),
      ],
      // The member is already deep enough that the ladder would fire — earned
      // by *other* rules, since this one never incremented anything.
      violationCount: 6,
      tier: { action: 'timeout', timeoutMs: 600_000 },
    });
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate());

    // The deletion is the rule's whole job and still happens.
    expect(calls.deleteMessage).toEqual([
      { channelId: CHANNEL, messageId: MESSAGE, reason: 'automod: rule-delete-only-tiered' },
    ]);
    // Nothing was sent to Discord's moderation surface.
    expect(calls.applyAction).toHaveLength(0);
    // And the record says "deleted", not "deleted_and_escalated".
    expect(calls.recordCaseEvent).toEqual([
      expect.objectContaining({ ruleId: 'rule-delete-only-tiered', actionTaken: 'deleted' }),
    ]);
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

  /**
   * ADR 0041 §2 / plan ruling PR-2: the review corpus captures a matched
   * message only for a rule in `test` or `observe` mode, never `enforce` —
   * `PRIVACY.md` promises deleted-message content is kept 30 days, and a
   * fixture has no expiry, so capturing what the bot just deleted would make
   * that policy untrue. Plan ruling PR-8: the capture is best-effort and must
   * never cost a moderation record.
   */
  describe('capturing review evidence', () => {
    it('captures a matched message as review evidence in test mode', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-capture', mode: 'test' })],
        captureFixtureResult: 'fixture-1',
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      expect(calls.captureFixture).toEqual([
        {
          messageId: MESSAGE,
          content: 'this message has badword in it',
          authorId: AUTHOR,
          atMs: NOW_MS,
          attachments: [],
        },
      ]);
    });

    it('carries the message’s attachments into the corpus', async () => {
      // The ambiguity that makes this non-decorative: the message has an
      // attachment AND content, so an implementation that passed `[]`
      // through would still capture the fixture and still pass every other
      // assertion in this file. Only this expectation goes red.
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-capture-attachments', mode: 'test' })],
        captureFixtureResult: 'fixture-1',
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(
        messageCreate({
          attachments: [{ fileName: 'a.exe', contentType: undefined, sizeBytes: 7 }],
        }),
      );

      expect(calls.captureFixture[0]?.attachments).toEqual([
        { fileName: 'a.exe', contentType: undefined, sizeBytes: 7 },
      ]);
    });

    it('does not capture in enforce mode', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-enforce-no-capture', mode: 'enforce' })],
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      expect(calls.captureFixture).toHaveLength(0);
      expect(calls.deleteMessage).toHaveLength(1);
    });

    it('does not capture a message no rule matched', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-no-match', mode: 'test' })],
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate({ content: 'nothing to see here' }));

      expect(calls.captureFixture).toHaveLength(0);
      expect(calls.recordCaseEvent).toHaveLength(0);
    });

    it('records the fixture id and the trace on the case event', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-fixture-id', mode: 'observe' })],
        captureFixtureResult: 'fixture-xyz',
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      expect(calls.recordCaseEvent).toEqual([
        expect.objectContaining({
          fixtureId: 'fixture-xyz',
          trace: expect.objectContaining({ kind: 'keyword_filter', matchedOn: 'badword' }),
        }),
      ]);
    });

    /**
     * A message matching two rules — an `observe`-mode rule whose capture
     * fails, followed by an `enforce`-mode rule. Deliberately not a
     * single-rule enforce-mode case: `captureFixture` is never called for an
     * `enforce`-mode match (PR-2), so a single enforce-mode rule could never
     * exercise a capture throw at all. This proves what the try/catch is
     * actually for — a capture failure on one rule must not abort the loop
     * and skip every rule after it, deletion and escalation included.
     */
    it('still deletes and escalates when capture throws', async () => {
      const observeRule = rule({ ruleId: 'rule-observe-throws', mode: 'observe' });
      const enforceRule = rule({ ruleId: 'rule-enforce-after', mode: 'enforce' });
      const { deps, calls } = buildHarness({
        rules: [observeRule, enforceRule],
        captureFixtureError: new Error('disk full'),
        violationCount: 3,
        tier: { action: 'timeout', timeoutMs: 600_000 },
      });
      const subscriber = createAutomodSubscriber(deps);

      await expect(subscriber.handle(messageCreate())).resolves.toBeUndefined();

      expect(calls.captureFixture).toHaveLength(1);
      expect(calls.deleteMessage).toEqual([
        { channelId: CHANNEL, messageId: MESSAGE, reason: `automod: ${enforceRule.ruleId}` },
      ]);
      expect(calls.applyAction).toHaveLength(1);
      expect(calls.recordCaseEvent).toEqual([
        expect.objectContaining({
          ruleId: 'rule-observe-throws',
          actionTaken: 'would_delete',
          fixtureId: undefined,
        }),
        expect.objectContaining({
          ruleId: 'rule-enforce-after',
          actionTaken: 'deleted_and_escalated',
        }),
      ]);
    });
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
        trace: expect.objectContaining({ kind: 'keyword_filter', matchedOn: 'badword' }),
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
        trace: expect.objectContaining({ kind: 'keyword_filter', matchedOn: 'badword' }),
      },
    ]);
  });

  it('a rule whose word list fails to compile is caught, logged, and does not stop the message from being processed by other rules', async () => {
    const { logger, lines } = capturingLogger();
    const brokenRule = rule({
      ruleId: 'rule-8-broken',
      terms: [{ text: '[unclosed', categoryId: 'cat-x' }],
    });
    const okRule = rule({ ruleId: 'rule-8-ok', mode: 'enforce' });
    const { deps, calls } = buildHarness({ rules: [brokenRule, okRule], logger });
    const subscriber = createAutomodSubscriber(deps);

    await expect(subscriber.handle(messageCreate())).resolves.toBeUndefined();

    // The broken rule logged an error and produced no case event of its own.
    // The message names "could not be compiled" now, not "matcher threw":
    // `[unclosed` is an invalid `obscenity` pattern, so `buildMatcher` throws
    // inside `Predicate.compile` itself, which `compileRule` (Task 3) catches
    // as `compile-failed` before the subscriber ever gets to evaluate a
    // message — a compile-time failure, not a per-message one, which is the
    // whole point of caching it behind the fingerprint (ADR 0040 §4).
    const parsed = lines.map(
      (l) => JSON.parse(l) as { ruleId?: string; msg?: string; compileError?: string },
    );
    expect(
      parsed.some(
        (l) => l.ruleId === 'rule-8-broken' && (l.msg ?? '').includes('could not be compiled'),
      ),
    ).toBe(true);
    // The free-text reason — not just the `reason` code — reaches the log.
    // `compileRule` is the source of truth for what that text actually is;
    // asserting against its own output (rather than a hard-coded string this
    // test would have to keep in sync with `obscenity`'s wording) proves the
    // value that made it into `safeLogFields` is the same one `compileRule`
    // produced, not merely that *some* string is present.
    const directResult = registry.compileRule(brokenRule);
    expect(directResult.ok).toBe(false);
    const expectedDetail = directResult.ok ? '' : directResult.detail;
    expect(expectedDetail.length).toBeGreaterThan(0);
    expect(parsed.find((l) => l.ruleId === 'rule-8-broken')?.compileError).toBe(expectedDetail);
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
    const blocked: [string, AutomodSafetyState | null, string][] = [
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
   * ADR 0042 §5's third lever: an operator watching a newly-flipped enforce
   * rule should not have to disable role panels to do it (F3/F4). Distinct
   * from the safety-gate tests above — those record a `delete_blocked_*`
   * action because a layer *stopped* an attempted enforcement; testing mode
   * is not "stopped", it is "record this exactly as `test` mode would",
   * which is why the assertion below expects `would_delete`, matching the
   * non-enforce recording verbatim rather than a new blocked value.
   */
  describe('automod_testing_mode (ADR 0042 §5)', () => {
    it('does not delete or count a violation, but records the match exactly as test mode would', async () => {
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-testing-mode', mode: 'enforce' })],
        safetyState: { ...LIVE, automodTestingMode: true },
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      expect(calls.deleteMessage).toHaveLength(0);
      expect(calls.applyAction).toHaveLength(0);
      expect(calls.openOrResolveCase).toEqual([{ memberId: AUTHOR, countsAsViolation: false }]);
      expect(calls.recordCaseEvent).toEqual([
        expect.objectContaining({ ruleId: 'rule-testing-mode', actionTaken: 'would_delete' }),
      ]);
    });

    it('takes precedence over the killswitch in what gets recorded', async () => {
      // The check sits *ahead* of the `if (blocked !== undefined)` block, and
      // that order is a decision with an observable consequence, so it gets a
      // guard: move the testing-mode branch below the block that *acts* on
      // `blocked` and this test goes red while the one above stays green.
      //
      // Below the *computation* of `blocked` is not the same mutation and
      // proves nothing — `blocked` is only assigned there, and the
      // testing-mode branch still `continue`s before anything reads it. That
      // was the first mutation tried here, it left all 47 green, and the
      // conclusion to draw was "the mutation was too weak", not "the test is
      // decorative". Worth writing down: a mutation that stays green means
      // either an unfalsifiable test or a mutation that changed no behaviour,
      // and telling those apart is the whole job.
      //
      // Why this way round. `delete_blocked_killswitch` means "automod tried to
      // act and an emergency lever stopped it". Under testing mode automod
      // never tried — an operator has said "observe only" for this subsystem.
      // Recording a blocked value would misattribute a deliberate
      // configuration choice to an emergency, and make the killswitch look
      // load-bearing for a rule that was not going to act either way.
      //
      // What it costs, stated so nobody discovers it as a surprise: the event
      // row does not show that the killswitch was also engaged. That is
      // acceptable because the killswitch is guild-wide and `doctor` reports
      // it — it was never per-event information.
      const { deps, calls } = buildHarness({
        rules: [rule({ ruleId: 'rule-both-levers', mode: 'enforce' })],
        safetyState: { ...LIVE, automodTestingMode: true, killswitch: true },
      });
      const subscriber = createAutomodSubscriber(deps);

      await subscriber.handle(messageCreate());

      expect(calls.deleteMessage).toHaveLength(0);
      expect(calls.recordCaseEvent).toEqual([
        expect.objectContaining({ ruleId: 'rule-both-levers', actionTaken: 'would_delete' }),
      ]);
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
      const rules: AutomodRule[] = [rule({ ruleId: 'rule-rollout', mode: 'test' })];
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

describe('the compiled-predicate cache', () => {
  // No reset hook: the cache lives in `createAutomodSubscriber`'s closure, so
  // each `createAutomodSubscriber(...)` call below starts empty. Each of these
  // cases builds ONE subscriber and sends it several messages — building a new
  // subscriber per message would clear the cache and test nothing.

  it('picks up an added term on the very next message, with no restart', async () => {
    // The gap ADR 0035 left and ADR 0039 made sharper: the operator adds a
    // term through the dashboard, sees it listed, and it never matches.
    let terms = [{ text: 'badword', categoryId: 'c' }];
    const { deps, calls } = buildHarness({ rules: [] });
    deps.listRules = () => [ruleWith(terms)];
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate({ content: 'spammer here' }));
    expect(calls.recordCaseEvent).toHaveLength(0);

    terms = [
      { text: 'badword', categoryId: 'c' },
      { text: 'spammer', categoryId: 'c' },
    ];
    await subscriber.handle(messageCreate({ content: 'spammer here' }));
    expect(calls.recordCaseEvent).toHaveLength(1);
  });

  it('picks up a removed term on the very next message', async () => {
    let terms = [{ text: 'badword', categoryId: 'c' }];
    const { deps, calls } = buildHarness({ rules: [] });
    deps.listRules = () => [ruleWith(terms)];
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate({ content: 'badword here' }));
    expect(calls.recordCaseEvent).toHaveLength(1);

    terms = [];
    await subscriber.handle(messageCreate({ content: 'badword here' }));
    expect(calls.recordCaseEvent).toHaveLength(1); // no second record
  });

  it('picks up a changed allowlist on the very next message', async () => {
    let allowlist: string[] = [];
    const { deps, calls } = buildHarness({ rules: [] });
    deps.listRules = () => [ruleWith([{ text: 'badword', categoryId: 'c' }], allowlist)];
    const subscriber = createAutomodSubscriber(deps);

    await subscriber.handle(messageCreate({ content: 'a badword phrase' }));
    expect(calls.recordCaseEvent).toHaveLength(1);

    allowlist = ['a badword phrase'];
    await subscriber.handle(messageCreate({ content: 'a badword phrase' }));
    expect(calls.recordCaseEvent).toHaveLength(1);
  });

  it('does not recompile when nothing changed', async () => {
    // The cache still has to be a cache, or this task has replaced a
    // correctness bug with a performance one. `obscenity` compilation is the
    // cost being avoided, so the assertion is on the number of compiles.
    const spy = vi.spyOn(registry, 'compileRule');
    const { deps, calls } = buildHarness({
      rules: [ruleWith([{ text: 'badword', categoryId: 'c' }])],
    });
    const subscriber = createAutomodSubscriber(deps);
    await subscriber.handle(messageCreate({ content: 'badword one' }));
    await subscriber.handle(messageCreate({ content: 'badword two' }));
    await subscriber.handle(messageCreate({ content: 'badword three' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls.recordCaseEvent).toHaveLength(3);
    spy.mockRestore();
  });

  /**
   * `daemon.ts` seeds every guild's default rule under the same id
   * (`'default-word-filter'`). A bare rule-id key let whichever guild spoke
   * first decide what every other guild was matched against — CLAUDE.md
   * rule 2 names cache keys explicitly.
   *
   * Defence in depth as of this slice: the cache now lives per subscriber
   * and the daemon builds one per guild, so a bare key would not actually
   * leak today. This asserts the property anyway, because "today's
   * composition root happens to make it safe" is caller discipline, which
   * rule 2 exists to replace. ONE subscriber, two guilds' events.
   *
   * **Verified this test is not decorative** (the concern `docs/22` records):
   * with a bare `rule.ruleId` key, the *matching outcome* below still passes
   * — the fingerprint check catches the content difference between guild
   * one's and guild two's rule regardless of what the cache key is, and
   * recompiles from the caller's own current rule object either way, so no
   * guild is ever matched against the wrong word list even with a bare key.
   * What a bare key actually breaks is caching itself: two guilds sharing an
   * id would evict each other's entry on every message, recompiling forever
   * instead of once each. The third `handle` call and the compile-count
   * assertion below exist to catch exactly that regression, which the
   * matching-outcome assertion alone cannot.
   */
  it('keeps two guilds’ rules apart even when they share a rule id', async () => {
    const rulesByGuild: Record<string, string> = {
      '111111111111111111': 'alpha',
      '222222222222222222': 'beta',
    };
    let currentGuild = '111111111111111111';
    const { deps, calls } = buildHarness({ rules: [] });
    deps.listRules = () => [ruleWith([{ text: rulesByGuild[currentGuild]!, categoryId: 'c' }])];
    const subscriber = createAutomodSubscriber(deps);
    const spy = vi.spyOn(registry, 'compileRule');

    await subscriber.handle(
      messageCreate({ guildId: parseGuildId(currentGuild), content: 'alpha here' }),
    );
    currentGuild = '222222222222222222';
    await subscriber.handle(
      messageCreate({ guildId: parseGuildId(currentGuild), content: 'alpha here' }),
    );

    // One match, from guild one. Guild two's rule matches `beta`, and a
    // guild-scoped key is the only thing that stops it reusing guild one's
    // compiled `alpha` matcher.
    expect(calls.recordCaseEvent).toHaveLength(1);

    // Back to guild one, same content as its first message. A guild-scoped
    // key still has guild one's untouched cache entry from the first call —
    // no third compile. A bare key would have had its one shared entry
    // overwritten by guild two's compile above, so guild one's unchanged
    // rule would look "changed" (the cached fingerprint is now guild two's)
    // and force a third, wasted compile.
    currentGuild = '111111111111111111';
    await subscriber.handle(
      messageCreate({ guildId: parseGuildId(currentGuild), content: 'alpha here' }),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('a rule that cannot be compiled', () => {
  it('is skipped, and every other rule still runs', async () => {
    const { deps, calls } = buildHarness({
      rules: [
        { ...ruleWith([]), ruleId: 'broken', kind: 'caps', config: '{not json' },
        { ...ruleWith([{ text: 'badword', categoryId: 'c' }]), ruleId: 'working' },
      ],
    });
    await createAutomodSubscriber(deps).handle(messageCreate({ content: 'badword' }));
    expect(calls.recordCaseEvent.map((r) => r.ruleId)).toEqual(['working']);
  });

  it('logs it once per rule, not once per message', async () => {
    // `capturing` (not a destructured `errors`) deliberately: `errors` is a
    // getter that re-reads the captured stream on every access, and
    // destructuring it here would freeze it at zero — exactly the
    // decorative-guard trap this test exists to avoid falling into itself.
    const capturing = capturingLogger();
    const { deps } = buildHarness({
      rules: [{ ...ruleWith([]), ruleId: 'broken', kind: 'caps', config: '{not json' }],
      logger: capturing.logger,
    });
    const subscriber = createAutomodSubscriber(deps);
    await subscriber.handle(messageCreate({ content: 'one' }));
    await subscriber.handle(messageCreate({ content: 'two' }));
    await subscriber.handle(messageCreate({ content: 'three' }));
    expect(capturing.errors).toHaveLength(1);
  });

  it('carries the compile error message itself through safeLogFields, not just the reason code', async () => {
    // `compileRule`'s `detail` — the actual Zod/`obscenity` text explaining
    // *what* was wrong, not just the `reason` code — must reach the emitted
    // log line under the `compileError` field. Guards against the field being
    // dropped silently: `safeLogFields` (`packages/core/src/obs/logger.ts`)
    // drops any key absent from `LOGGABLE_FIELDS` with no error of its own, so
    // a field-name mismatch here fails only by the value going missing, which
    // is exactly what this test watches for.
    const capturing = capturingLogger();
    const brokenRule = {
      ...ruleWith([{ text: '[unclosed', categoryId: 'cat-x' }]),
      ruleId: 'broken-detail',
    };
    const { deps } = buildHarness({ rules: [brokenRule], logger: capturing.logger });
    const directResult = registry.compileRule(brokenRule);
    expect(directResult.ok).toBe(false);
    const expectedDetail = directResult.ok ? '' : directResult.detail;
    expect(expectedDetail.length).toBeGreaterThan(0);

    await createAutomodSubscriber(deps).handle(messageCreate());

    const parsedLines = capturing.lines.map(
      (l) => JSON.parse(l) as { ruleId?: string; compileError?: string; droppedFields?: number },
    );
    const line = parsedLines.find((l) => l.ruleId === 'broken-detail');
    expect(line?.compileError).toBe(expectedDetail);
    expect(line?.droppedFields).toBeUndefined();
  });

  it('logs again after the config changes, because the operator may have fixed it', async () => {
    // `kind: 'keyword_filter'` (the `ruleWith` default) deliberately, not
    // `'caps'`: `'caps'` has no registered predicate, so `compileRule` returns
    // `'no-predicate'` before it ever reaches `JSON.parse` — this test would
    // then exercise the no-predicate path while its name and its `'{not json'`
    // fixture both claim to be about a config that can be fixed. With a real
    // predicate registered, both configs below genuinely fail
    // `keywordFilterConfig`'s `.strict()` schema — the first is not JSON at
    // all, the second is valid JSON with a field the schema rejects — so this
    // now tests what it says it tests, while still exercising the fingerprint
    // recompile-and-relog behaviour it was written for.
    let config = '{not json';
    const capturing = capturingLogger();
    const { deps } = buildHarness({ rules: [], logger: capturing.logger });
    deps.listRules = () => [{ ...ruleWith([]), ruleId: 'broken', config }];
    const subscriber = createAutomodSubscriber(deps);
    await subscriber.handle(messageCreate({ content: 'one' }));
    config = '{"still":"wrong"}';
    await subscriber.handle(messageCreate({ content: 'two' }));
    expect(capturing.errors).toHaveLength(2);
  });
});
