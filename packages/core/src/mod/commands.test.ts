import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { AuthzStore } from '../authz.js';
import type { ModerationGatewayPort } from '../automod/subscriber.js';
import type { SlashCommandEvent } from '../discord/events.js';
import type { InteractionRef, OutgoingMessage, Snowflake } from '../discord/port.js';
import type { ModerationIntent, ModerationOutcome } from '../effects/moderation-gateway.js';
import { parseGuildId } from '../ids.js';
import type { SlashResponder } from '../ops/commands/status-slash.js';
import {
  createModCommandSubscriber,
  MAX_TIMEOUT_MS,
  type ModCommandCasePorts,
  type ModCommandDeps,
} from './commands.js';
import type { WarnCasePorts } from './warn.js';

/**
 * Unit tests for the `/mod` slash-command subscriber, at the same level
 * `automod/subscriber.test.ts` tests at: every port is faked, nothing
 * touches a real database or Discord.
 */

const GUILD = parseGuildId('111111111111111111');
const MODERATOR: Snowflake = '222222222222222222';
const TARGET: Snowflake = '333333333333333333';
const NOW_MS = 1_700_000_000_000;

const silentLogger = pino({ level: 'silent' });

const slashCommandEvent = (over: Partial<SlashCommandEvent> = {}): SlashCommandEvent => ({
  kind: 'slashCommand',
  guildId: GUILD,
  receivedAtMs: NOW_MS,
  interactionId: 'interaction-1',
  token: 'token-1',
  commandName: 'mod',
  subcommandPath: ['timeout'],
  options: [
    { name: 'target', value: TARGET },
    { name: 'reason', value: 'being disruptive' },
  ],
  channelId: '444444444444444444',
  userId: MODERATOR,
  ...over,
});

interface Harness {
  deps: ModCommandDeps;
  calls: {
    applyAction: { auth: unknown; intent: ModerationIntent }[];
    openOrResolveCase: { memberId: string; countsAsViolation: boolean }[];
    recordCaseEvent: Parameters<ModCommandCasePorts['recordCaseEvent']>[0][];
    warnRecordCaseEvent: Parameters<WarnCasePorts['recordCaseEvent']>[0][];
    defer: { ref: InteractionRef; options: { ephemeral: boolean } }[];
    respond: { ref: InteractionRef; message: OutgoingMessage }[];
    fetchInvokerRoleIds: Snowflake[];
  };
}

function buildHarness(
  opts: {
    authorized?: boolean;
    applyActionResult?: ModerationOutcome;
    violationCount?: number;
    tier?: { tier: number; action: 'timeout' | 'kick' | undefined; timeoutMs: number | undefined };
  } = {},
): Harness {
  const calls: Harness['calls'] = {
    applyAction: [],
    openOrResolveCase: [],
    recordCaseEvent: [],
    warnRecordCaseEvent: [],
    defer: [],
    respond: [],
    fetchInvokerRoleIds: [],
  };

  const authz: AuthzStore = { hasGrant: () => opts.authorized ?? true };

  const moderationGateway: ModerationGatewayPort = {
    async applyAction(auth, intent) {
      calls.applyAction.push({ auth, intent });
      return opts.applyActionResult ?? { status: 'applied' };
    },
  };

  const cases: ModCommandCasePorts = {
    openOrResolveCase: (input) => {
      calls.openOrResolveCase.push({
        memberId: input.memberId,
        countsAsViolation: input.countsAsViolation,
      });
      return { caseId: 'case-1', violationCount: 1 };
    },
    recordCaseEvent: (input) => {
      calls.recordCaseEvent.push(input);
    },
  };

  const warnRepo: WarnCasePorts = {
    openOrResolveCase: (input) => {
      calls.openOrResolveCase.push({
        memberId: input.memberId,
        countsAsViolation: input.countsAsViolation,
      });
      return { caseId: 'case-1', violationCount: opts.violationCount ?? 1 };
    },
    recordCaseEvent: (input) => {
      calls.warnRecordCaseEvent.push(input);
    },
    nextEscalationTier: () => opts.tier ?? { tier: 0, action: undefined, timeoutMs: undefined },
    recordEscalationOutcome: () => {},
  };

  const responder: SlashResponder = {
    defer: async (ref, options) => {
      calls.defer.push({ ref, options });
    },
    respond: async (ref, message) => {
      calls.respond.push({ ref, message });
    },
  };

  const deps: ModCommandDeps = {
    guildId: GUILD,
    authz,
    fetchInvokerRoleIds: async (userId) => {
      calls.fetchInvokerRoleIds.push(userId);
      return [];
    },
    moderationGateway,
    cases,
    warnRepo,
    responder,
    now: () => NOW_MS,
    logger: silentLogger,
  };

  return { deps, calls };
}

describe('mod command subscriber', () => {
  it('ignores an event that is not a slash command', async () => {
    const { deps, calls } = buildHarness();
    const subscriber = createModCommandSubscriber(deps);
    await subscriber.handle({
      kind: 'connection',
      guildId: GUILD,
      receivedAtMs: NOW_MS,
      resumed: true,
      disconnectedAtMs: NOW_MS,
    });
    expect(calls.defer).toHaveLength(0);
  });

  it('ignores a slash command that is not /mod', async () => {
    const { deps, calls } = buildHarness();
    const subscriber = createModCommandSubscriber(deps);
    await subscriber.handle(slashCommandEvent({ commandName: 'status' }));
    expect(calls.defer).toHaveLength(0);
  });

  it('ignores an unrecognised subcommand rather than guessing', async () => {
    const { deps, calls } = buildHarness();
    const subscriber = createModCommandSubscriber(deps);
    await subscriber.handle(slashCommandEvent({ subcommandPath: ['ban'] }));
    expect(calls.defer).toHaveLength(0);
    expect(calls.applyAction).toHaveLength(0);
  });

  describe('unauthorized caller', () => {
    it('replies ephemeral refusal, makes no gateway call, and records a refusal case event', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['kick'] }));

      expect(calls.defer).toEqual([
        { ref: { interactionId: 'interaction-1', token: 'token-1' }, options: { ephemeral: true } },
      ]);
      expect(calls.applyAction).toHaveLength(0);
      expect(calls.respond).toHaveLength(1);
      expect(calls.respond[0]?.message.content).toMatch(/do not have permission/i);

      expect(calls.recordCaseEvent).toHaveLength(1);
      const event = calls.recordCaseEvent[0]!;
      expect(event.memberId).toBe(TARGET);
      expect(event.actorId).toBe(MODERATOR);
      expect(event.actionTaken).toBe('escalation_refused');
      expect(event.refusalReason).toBe('unauthorized');
      expect(event.escalationAction).toBe('kick');
      expect(event.matchedSnippet).toBe('being disruptive');
      expect(event.at).toBe(NOW_MS);
    });

    it('also refuses warn without ever calling issueWarn’s repo', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['warn'] }));

      expect(calls.applyAction).toHaveLength(0);
      expect(calls.warnRecordCaseEvent).toHaveLength(0);
      expect(calls.recordCaseEvent).toHaveLength(1);
      expect(calls.recordCaseEvent[0]?.actionTaken).toBe('escalation_refused');
      expect(calls.recordCaseEvent[0]?.refusalReason).toBe('unauthorized');
      expect(calls.respond[0]?.message.content).toMatch(/do not have permission/i);
    });
  });

  describe('timeout', () => {
    it('clamps the requested duration to Discord’s 28-day maximum', async () => {
      const { deps, calls } = buildHarness();
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['timeout'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'reason', value: 'spamming' },
            // Far beyond 28 days (40,320 minutes).
            { name: 'duration_minutes', value: 999_999 },
          ],
        }),
      );

      expect(calls.applyAction).toHaveLength(1);
      expect(calls.applyAction[0]?.intent.timeoutMs).toBe(MAX_TIMEOUT_MS);
      expect(calls.applyAction[0]?.intent.action).toBe('timeout');
      expect(calls.applyAction[0]?.intent.userId).toBe(TARGET);
      expect(calls.applyAction[0]?.intent.reason).toBe('spamming');
    });

    it('records target, reason, timestamp, and outcome on an applied action', async () => {
      const { deps, calls } = buildHarness({ applyActionResult: { status: 'applied' } });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['timeout'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'reason', value: 'spamming' },
            { name: 'duration_minutes', value: 10 },
          ],
        }),
      );

      expect(calls.recordCaseEvent).toHaveLength(1);
      const event = calls.recordCaseEvent[0]!;
      expect(event.memberId).toBe(TARGET);
      expect(event.matchedSnippet).toBe('spamming');
      expect(event.at).toBe(NOW_MS);
      expect(event.actionTaken).toBe('manual_applied');
      expect(event.escalationAction).toBe('timeout');
      expect(event.actorId).toBe(MODERATOR);
      expect(calls.respond[0]?.message.content).toMatch(/applied/);
    });
  });

  describe('kick', () => {
    it('refuses on hierarchy and records the case event with actor_id and refusal reason', async () => {
      const { deps, calls } = buildHarness({
        applyActionResult: { status: 'refused', reason: 'role-above-bot' },
      });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['kick'] }));

      expect(calls.applyAction).toHaveLength(1);
      expect(calls.applyAction[0]?.intent.action).toBe('kick');

      expect(calls.recordCaseEvent).toHaveLength(1);
      const event = calls.recordCaseEvent[0]!;
      expect(event.actionTaken).toBe('escalation_refused');
      expect(event.refusalReason).toBe('role-above-bot');
      expect(event.escalationAction).toBe('kick');
      expect(event.actorId).toBe(MODERATOR);
      expect(event.memberId).toBe(TARGET);
      expect(calls.respond[0]?.message.content).toMatch(/refused/);
    });
  });

  describe('untimeout and unban execute without the command layer adding a hierarchy check', () => {
    it('untimeout calls the gateway once and records manual_applied with no escalation_action', async () => {
      const { deps, calls } = buildHarness({ applyActionResult: { status: 'applied' } });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['untimeout'] }));

      expect(calls.applyAction).toHaveLength(1);
      expect(calls.applyAction[0]?.intent.action).toBe('untimeout');
      expect(calls.applyAction[0]?.intent.userId).toBe(TARGET);

      const event = calls.recordCaseEvent[0]!;
      expect(event.actionTaken).toBe('manual_applied');
      // The real gap: `escalation_action`'s CHECK constraint has no
      // 'untimeout' value, so it is left absent rather than written invalid.
      expect(event.escalationAction).toBeUndefined();
      expect(event.memberId).toBe(TARGET);
      expect(event.actorId).toBe(MODERATOR);
      expect(event.at).toBe(NOW_MS);
      expect(calls.respond[0]?.message.content).toMatch(/applied/);
    });

    it('unban calls the gateway once and records manual_applied with escalation_action unban', async () => {
      const { deps, calls } = buildHarness({ applyActionResult: { status: 'applied' } });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['unban'] }));

      expect(calls.applyAction).toHaveLength(1);
      expect(calls.applyAction[0]?.intent.action).toBe('unban');

      const event = calls.recordCaseEvent[0]!;
      expect(event.actionTaken).toBe('manual_applied');
      expect(event.escalationAction).toBe('unban');
      expect(event.memberId).toBe(TARGET);
      expect(event.actorId).toBe(MODERATOR);
    });
  });

  describe('warn', () => {
    it('calls issueWarn and surfaces the violation count with no escalation below tier', async () => {
      const { deps, calls } = buildHarness({ violationCount: 1 });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['warn'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'reason', value: 'first offense' },
          ],
        }),
      );

      expect(calls.applyAction).toHaveLength(0);
      expect(calls.warnRecordCaseEvent).toHaveLength(1);
      expect(calls.warnRecordCaseEvent[0]?.actionTaken).toBe('warned');
      expect(calls.warnRecordCaseEvent[0]?.actorId).toBe(MODERATOR);
      expect(calls.respond[0]?.message.content).toMatch(/Violation count: 1/);
      expect(calls.respond[0]?.message.content).not.toMatch(/escalation tier/);
    });

    it('surfaces the escalation outcome when the warning crosses a tier', async () => {
      const { deps, calls } = buildHarness({
        violationCount: 3,
        tier: { tier: 1, action: 'timeout', timeoutMs: 600_000 },
        applyActionResult: { status: 'applied' },
      });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['warn'] }));

      expect(calls.applyAction).toHaveLength(1);
      expect(calls.applyAction[0]?.intent.action).toBe('timeout');
      expect(calls.respond[0]?.message.content).toMatch(/Violation count: 3/);
      expect(calls.respond[0]?.message.content).toMatch(/escalation tier/i);
      expect(calls.respond[0]?.message.content).toMatch(/applied/);
    });
  });

  it('an internal failure after deferring still answers ephemeral, not a hung interaction', async () => {
    const { deps, calls } = buildHarness();
    const subscriber = createModCommandSubscriber(deps);
    // No 'reason' option at all is tolerated (defaults to ''), but a missing
    // 'target' cannot be parsed as a snowflake and throws inside the handler
    // — exercising the outer catch's honest fallback.
    await subscriber.handle(
      slashCommandEvent({ subcommandPath: ['kick'], options: [{ name: 'reason', value: 'x' }] }),
    );

    expect(calls.defer).toHaveLength(1);
    expect(calls.respond).toHaveLength(1);
    expect(calls.respond[0]?.message.content).toMatch(/something went wrong/i);
    expect(calls.applyAction).toHaveLength(0);
  });
});
