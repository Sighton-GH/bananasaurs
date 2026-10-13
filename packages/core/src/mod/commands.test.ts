import { vi, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { AuthzStore } from '../authz.js';
import type { ModerationGatewayPort } from '../automod/subscriber.js';
import type { SlashCommandEvent } from '../discord/events.js';
import type { InteractionRef, OutgoingMessage, Snowflake } from '../discord/port.js';
import type { ModerationIntent, ModerationOutcome } from '../effects/moderation-gateway.js';
import { parseGuildId } from '../ids.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import {
  createModCommandSubscriber,
  MAX_TIMEOUT_MS,
  type ModCommandCasePorts,
  type ModCommandDeps,
  type NoteEvidenceCasePorts,
} from './commands.js';
import type { HistoryCase, HistoryCaseEvent, HistoryCasePorts } from './history.js';
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
    noteEvidenceRecordCaseEvent: Parameters<NoteEvidenceCasePorts['recordCaseEvent']>[0][];
    noteEvidenceOpenOrResolveCase: { memberId: string; countsAsViolation: boolean }[];
    historyListCasesForMember: string[];
    historyListCaseEvents: string[];
    historyOpenOrResolveCase: { memberId: string; countsAsViolation: boolean }[];
    historyRecordCaseEvent: Parameters<HistoryCasePorts['recordCaseEvent']>[0][];
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
    historyCases?: readonly HistoryCase[];
    historyEventsByCase?: Record<string, readonly HistoryCaseEvent[]>;
    onWarned?: ModCommandDeps['onWarned'];
  } = {},
): Harness {
  const calls: Harness['calls'] = {
    applyAction: [],
    openOrResolveCase: [],
    recordCaseEvent: [],
    warnRecordCaseEvent: [],
    noteEvidenceRecordCaseEvent: [],
    noteEvidenceOpenOrResolveCase: [],
    historyListCasesForMember: [],
    historyListCaseEvents: [],
    historyOpenOrResolveCase: [],
    historyRecordCaseEvent: [],
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

  const noteEvidenceCases: NoteEvidenceCasePorts = {
    openOrResolveCase: (input) => {
      calls.noteEvidenceOpenOrResolveCase.push({
        memberId: input.memberId,
        countsAsViolation: input.countsAsViolation,
      });
      // A note/evidence event never counts, so a fresh case opens at 0 —
      // the fake mirrors `openOrResolveCase`'s own real behaviour for a
      // non-counting open (`packages/storage/src/repos/mod-cases.ts`).
      return { caseId: 'case-1', violationCount: 0 };
    },
    recordCaseEvent: (input) => {
      calls.noteEvidenceRecordCaseEvent.push(input);
    },
  };

  const historyCases: HistoryCasePorts = {
    listCasesForMember: (memberId) => {
      calls.historyListCasesForMember.push(memberId);
      return opts.historyCases ?? [];
    },
    listCaseEvents: (caseId) => {
      calls.historyListCaseEvents.push(caseId);
      return opts.historyEventsByCase?.[caseId] ?? [];
    },
    openOrResolveCase: (input) => {
      calls.historyOpenOrResolveCase.push({
        memberId: input.memberId,
        countsAsViolation: input.countsAsViolation,
      });
      return { caseId: 'case-1', violationCount: 0 };
    },
    recordCaseEvent: (input) => {
      calls.historyRecordCaseEvent.push(input);
    },
  };

  const responder: SlashResponder = {
    deferUpdate: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
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
    noteEvidenceCases,
    ...(opts.onWarned !== undefined ? { onWarned: opts.onWarned } : {}),
    history: {
      guildId: GUILD,
      authz,
      fetchInvokerRoleIds: async (userId) => {
        calls.fetchInvokerRoleIds.push(userId);
        return [];
      },
      cases: historyCases,
      responder,
      now: () => NOW_MS,
      logger: silentLogger,
    },
    responder,
    now: () => NOW_MS,
    logger: silentLogger,
    // Task 7's ban/purge preview deps. Never exercised by this file — it
    // only proves `commands.ts` routes `ban`/`purge` to `confirmations.ts`,
    // in the "ignores an unrecognised subcommand" test below (which
    // predates Task 7 and now needs updating — see that test).
    confirmations: {
      guildId: GUILD,
      authz,
      fetchInvokerRoleIds: async () => [],
      moderationGateway,
      cases: {
        openOrResolveCase: () => ({ caseId: 'case-1', violationCount: 1 }),
        recordCaseEvent: () => {},
      },
      pendingActions: { put: () => {}, take: () => undefined, peek: () => undefined },
      fetchRecentMessages: async () => ({ messages: [], nextBefore: undefined }),
      enqueuePurgeJob: () => {},
      responder,
      now: () => NOW_MS,
      logger: silentLogger,
    },
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
    // A stale/future registration this subscriber does not (yet) know.
    await subscriber.handle(slashCommandEvent({ subcommandPath: ['bogus-subcommand'] }));
    expect(calls.defer).toHaveLength(0);
    expect(calls.applyAction).toHaveLength(0);
  });

  describe('ban and purge route to the confirmation preview, not direct execution', () => {
    it('ban defers and never calls the gateway directly from this subscriber', async () => {
      const { deps, calls } = buildHarness();
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['ban'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'reason', value: 'raiding' },
          ],
        }),
      );
      expect(calls.defer).toHaveLength(1);
      // The preview writes no case event and calls no gateway — only a
      // confirmed click does, and that lives entirely in confirmations.ts.
      expect(calls.applyAction).toHaveLength(0);
      expect(calls.recordCaseEvent).toHaveLength(0);
      expect(calls.respond[0]?.message.content).toMatch(/ban preview/i);
    });

    it('purge defers and never calls the gateway directly from this subscriber', async () => {
      const { deps, calls } = buildHarness();
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['purge'],
          options: [
            { name: 'channel', value: '555555555555555555' },
            { name: 'reason', value: 'spam cleanup' },
          ],
        }),
      );
      expect(calls.defer).toHaveLength(1);
      expect(calls.applyAction).toHaveLength(0);
      expect(calls.respond[0]?.message.content).toMatch(/purge preview/i);
    });
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

    it('calls onWarned once with the warn info after a successful warn', async () => {
      const seen: {
        memberId: string;
        actorId: string;
        warnId: string;
        reason: string;
        caseId: string;
        violationCount: number;
      }[] = [];
      const { deps, calls } = buildHarness({
        violationCount: 2,
        onWarned: async (info) => {
          seen.push({ ...info });
        },
      });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          interactionId: 'interaction-9',
          subcommandPath: ['warn'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'reason', value: 'first offense' },
          ],
        }),
      );

      expect(seen).toEqual([
        {
          memberId: TARGET,
          actorId: MODERATOR,
          warnId: 'interaction-9',
          reason: 'first offense',
          caseId: 'case-1',
          violationCount: 2,
        },
      ]);
      expect(calls.respond).toHaveLength(1);
    });

    it('a throwing onWarned does not stop the reply', async () => {
      const { deps, calls } = buildHarness({
        onWarned: async () => {
          throw new Error('log is down');
        },
      });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['warn'] }));

      expect(calls.respond).toHaveLength(1);
      expect(calls.respond[0]?.message.content).toMatch(/Warning recorded/);
    });

    it('an absent onWarned replies normally', async () => {
      const { deps, calls } = buildHarness();
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['warn'] }));

      expect(calls.respond).toHaveLength(1);
      expect(calls.respond[0]?.message.content).toMatch(/Warning recorded/);
    });
  });

  describe('note', () => {
    it('lands as action_taken=note, rule_id=manual, actor_id set — never touches the gateway', async () => {
      const { deps, calls } = buildHarness();
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['note'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'text', value: 'seen hanging around a raid server' },
          ],
        }),
      );

      expect(calls.applyAction).toHaveLength(0);
      expect(calls.noteEvidenceRecordCaseEvent).toHaveLength(1);
      const event = calls.noteEvidenceRecordCaseEvent[0]!;
      expect(event.actionTaken).toBe('note');
      expect(event.ruleId).toBe('manual');
      expect(event.actorId).toBe(MODERATOR);
      expect(event.memberId).toBe(TARGET);
      expect(event.matchedSnippet).toBe('seen hanging around a raid server');
      expect(event.at).toBe(NOW_MS);
      expect(calls.respond[0]?.message.content).toMatch(/note recorded/i);
    });

    it('opens a non-counting case at count 0 when the member has no open case', async () => {
      const { deps, calls } = buildHarness();
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['note'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'text', value: 'first observation' },
          ],
        }),
      );

      expect(calls.noteEvidenceOpenOrResolveCase).toEqual([
        { memberId: TARGET, countsAsViolation: false },
      ]);
    });
  });

  describe('evidence', () => {
    it('lands as action_taken=evidence_added with the URL as matchedSnippet', async () => {
      const { deps, calls } = buildHarness();
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['evidence'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'url', value: 'https://example.com/screenshot.png' },
          ],
        }),
      );

      expect(calls.applyAction).toHaveLength(0);
      expect(calls.noteEvidenceRecordCaseEvent).toHaveLength(1);
      const event = calls.noteEvidenceRecordCaseEvent[0]!;
      expect(event.actionTaken).toBe('evidence_added');
      expect(event.matchedCategory).toBe('evidence');
      expect(event.ruleId).toBe('manual');
      expect(event.actorId).toBe(MODERATOR);
      expect(event.memberId).toBe(TARGET);
      expect(event.matchedSnippet).toBe('https://example.com/screenshot.png');
      expect(calls.respond[0]?.message.content).toMatch(/evidence.*recorded/i);
    });

    it('also opens a non-counting case at count 0 when the member has no open case', async () => {
      const { deps, calls } = buildHarness();
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['evidence'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'url', value: 'https://example.com/log.txt' },
          ],
        }),
      );

      expect(calls.noteEvidenceOpenOrResolveCase).toEqual([
        { memberId: TARGET, countsAsViolation: false },
      ]);
    });
  });

  describe('unauthorized caller: note and evidence', () => {
    it('refuses note, never records a note event, but durably records the refusal', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['note'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'text', value: 'should never land' },
          ],
        }),
      );

      expect(calls.respond[0]?.message.content).toMatch(/do not have permission/i);
      expect(calls.noteEvidenceRecordCaseEvent).toHaveLength(1);
      const event = calls.noteEvidenceRecordCaseEvent[0]!;
      expect(event.actionTaken).toBe('escalation_refused');
      expect(event.refusalReason).toBe('unauthorized');
      expect(event.actorId).toBe(MODERATOR);
      expect(event.memberId).toBe(TARGET);
      // Never the raw note/action_taken values a successful write would use.
      expect(event.actionTaken).not.toBe('note');
    });

    it('refuses evidence, never records an evidence_added event, but durably records the refusal', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(
        slashCommandEvent({
          subcommandPath: ['evidence'],
          options: [
            { name: 'target', value: TARGET },
            { name: 'url', value: 'https://example.com/should-not-land' },
          ],
        }),
      );

      expect(calls.respond[0]?.message.content).toMatch(/do not have permission/i);
      expect(calls.noteEvidenceRecordCaseEvent).toHaveLength(1);
      const event = calls.noteEvidenceRecordCaseEvent[0]!;
      expect(event.actionTaken).toBe('escalation_refused');
      expect(event.refusalReason).toBe('unauthorized');
      expect(event.actorId).toBe(MODERATOR);
      expect(event.memberId).toBe(TARGET);
      expect(event.actionTaken).not.toBe('evidence_added');
    });
  });

  describe('history', () => {
    it('without moderation.act, refuses and durably records the refusal on the target’s case — the dispatch-level proof that history is gated and audited like every other subcommand', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['history'] }));

      expect(calls.respond[0]?.message.content).toMatch(/do not have permission/i);
      expect(calls.historyListCasesForMember).toHaveLength(0);

      // history's own refusal port records it — an unauthorized probe of a
      // specific member's disciplinary history is reconnaissance worth a
      // durable trace, the same as every other subcommand's refusal.
      expect(calls.historyOpenOrResolveCase).toEqual([
        { memberId: TARGET, countsAsViolation: false },
      ]);
      expect(calls.historyRecordCaseEvent).toHaveLength(1);
      const refusal = calls.historyRecordCaseEvent[0]!;
      expect(refusal.memberId).toBe(TARGET);
      expect(refusal.actorId).toBe(MODERATOR);
      expect(refusal.actionTaken).toBe('escalation_refused');
      expect(refusal.refusalReason).toBe('unauthorized');

      // Never routed onto any of the other three ports' write paths — the
      // refusal lands only through history's own narrow port.
      expect(calls.recordCaseEvent).toHaveLength(0);
      expect(calls.noteEvidenceRecordCaseEvent).toHaveLength(0);
      expect(calls.warnRecordCaseEvent).toHaveLength(0);
    });

    it('with moderation.act, routes to the history handler and renders cases and events', async () => {
      const { deps, calls } = buildHarness({
        authorized: true,
        historyCases: [
          {
            caseId: 'case-1',
            memberId: TARGET,
            openedAt: NOW_MS - 10_000,
            violationCount: 2,
            escalationTier: 0,
            status: 'open',
          },
        ],
        historyEventsByCase: {
          'case-1': [
            {
              eventId: 'evt-1',
              caseId: 'case-1',
              ruleId: 'manual',
              memberId: TARGET,
              at: NOW_MS,
              matchedCategory: 'warn',
              matchedSnippet: 'being disruptive',
              actionTaken: 'warned',
              escalationAction: undefined,
              refusalReason: undefined,
              actorId: MODERATOR,
            },
          ],
        },
      });
      const subscriber = createModCommandSubscriber(deps);
      await subscriber.handle(slashCommandEvent({ subcommandPath: ['history'] }));

      expect(calls.historyListCasesForMember).toEqual([TARGET]);
      expect(calls.historyListCaseEvents).toEqual(['case-1']);
      const content = calls.respond[0]?.message.content ?? '';
      expect(content).toContain('case-1');
      expect(content).toContain('warned');
      expect(content).toContain(MODERATOR);
      expect(content).toContain('violations: 2');
      // A successful read writes nothing — reading is not an action.
      expect(calls.historyOpenOrResolveCase).toHaveLength(0);
      expect(calls.historyRecordCaseEvent).toHaveLength(0);
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
