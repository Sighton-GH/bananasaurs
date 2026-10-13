import { vi, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { AuthzStore } from '../authz.js';
import type { SlashCommandEvent } from '../discord/events.js';
import type { InteractionRef, OutgoingMessage, Snowflake } from '../discord/port.js';
import { parseGuildId } from '../ids.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import {
  handleHistory,
  type HistoryCase,
  type HistoryCaseEvent,
  type HistoryCasePorts,
  type HistoryDeps,
} from './history.js';

/**
 * Unit tests for `/mod history` (Task 9), the last `/mod` subcommand: a
 * read-only search over a member's case(s). Same level `commands.test.ts`
 * and `confirmations.test.ts` test at — every port faked, nothing touches a
 * real database or Discord.
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
  subcommandPath: ['history'],
  options: [{ name: 'target', value: TARGET }],
  channelId: '444444444444444444',
  userId: MODERATOR,
  ...over,
});

const REF: InteractionRef = { interactionId: 'interaction-1', token: 'token-1' };

interface Harness {
  deps: HistoryDeps;
  calls: {
    listCasesForMember: string[];
    listCaseEvents: string[];
    openOrResolveCase: { memberId: string; countsAsViolation: boolean }[];
    recordCaseEvent: Parameters<HistoryCasePorts['recordCaseEvent']>[0][];
    fetchInvokerRoleIds: Snowflake[];
    respond: { ref: InteractionRef; message: OutgoingMessage }[];
  };
}

function buildHarness(
  opts: {
    authorized?: boolean;
    cases?: readonly HistoryCase[];
    eventsByCase?: Record<string, readonly HistoryCaseEvent[]>;
  } = {},
): Harness {
  const calls: Harness['calls'] = {
    listCasesForMember: [],
    listCaseEvents: [],
    openOrResolveCase: [],
    recordCaseEvent: [],
    fetchInvokerRoleIds: [],
    respond: [],
  };

  const authz: AuthzStore = { hasGrant: () => opts.authorized ?? true };

  const cases: HistoryCasePorts = {
    listCasesForMember: (memberId) => {
      calls.listCasesForMember.push(memberId);
      return opts.cases ?? [];
    },
    listCaseEvents: (caseId) => {
      calls.listCaseEvents.push(caseId);
      return opts.eventsByCase?.[caseId] ?? [];
    },
    openOrResolveCase: (input) => {
      calls.openOrResolveCase.push({
        memberId: input.memberId,
        countsAsViolation: input.countsAsViolation,
      });
      return { caseId: 'refusal-case-1', violationCount: 0 };
    },
    recordCaseEvent: (input) => {
      calls.recordCaseEvent.push(input);
    },
  };

  const responder: SlashResponder = {
    deferUpdate: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    editOriginal: vi.fn(async () => undefined),
    defer: async () => {},
    respond: async (ref, message) => {
      calls.respond.push({ ref, message });
    },
  };

  const deps: HistoryDeps = {
    guildId: GUILD,
    authz,
    fetchInvokerRoleIds: async (userId) => {
      calls.fetchInvokerRoleIds.push(userId);
      return [];
    },
    cases,
    responder,
    now: () => NOW_MS,
    logger: silentLogger,
  };

  return { deps, calls };
}

const openCase = (over: Partial<HistoryCase> = {}): HistoryCase => ({
  caseId: 'case-1',
  memberId: TARGET,
  openedAt: NOW_MS - 10_000,
  violationCount: 3,
  escalationTier: 1,
  status: 'open',
  ...over,
});

const event = (over: Partial<HistoryCaseEvent> = {}): HistoryCaseEvent => ({
  eventId: 'evt-1',
  caseId: 'case-1',
  ruleId: 'manual',
  memberId: TARGET,
  at: NOW_MS - 5_000,
  matchedCategory: 'timeout',
  matchedSnippet: 'being disruptive',
  actionTaken: 'manual_applied',
  escalationAction: 'timeout',
  refusalReason: undefined,
  actorId: MODERATOR,
  ...over,
});

describe('handleHistory', () => {
  describe('unauthorized caller', () => {
    it('refuses with a plain ephemeral reply, never reads any case, and calls fetchInvokerRoleIds with the real invoker', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      await handleHistory(deps, slashCommandEvent(), REF);

      expect(calls.fetchInvokerRoleIds).toEqual([MODERATOR]);
      expect(calls.listCasesForMember).toHaveLength(0);
      expect(calls.listCaseEvents).toHaveLength(0);
      expect(calls.respond).toHaveLength(1);
      expect(calls.respond[0]?.ref).toEqual(REF);
      expect(calls.respond[0]?.message.content).toMatch(/do not have permission/i);
    });

    /**
     * Added in the fix round after this task's first review: an unauthorized
     * `/mod history <member>` probe is durably recorded on the *target's*
     * case, the same way `warn`/the direct actions/`ban`/`purge`/`note`/
     * `evidence` already record their own unauthorized attempts
     * (`commands.ts`'s `recordDirectRefusal`) — an unauthorized attempt to
     * read a specific member's disciplinary history is itself reconnaissance
     * worth a trace, not only a log line.
     */
    it('durably records the refusal on the target member’s case: escalation_refused / unauthorized, actor is the real caller', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      await handleHistory(deps, slashCommandEvent(), REF);

      expect(calls.openOrResolveCase).toEqual([{ memberId: TARGET, countsAsViolation: false }]);
      expect(calls.recordCaseEvent).toHaveLength(1);
      const refusal = calls.recordCaseEvent[0]!;
      expect(refusal.caseId).toBe('refusal-case-1');
      expect(refusal.memberId).toBe(TARGET);
      expect(refusal.actorId).toBe(MODERATOR);
      expect(refusal.actionTaken).toBe('escalation_refused');
      expect(refusal.refusalReason).toBe('unauthorized');
      expect(refusal.at).toBe(NOW_MS);
    });
  });

  describe('authorized caller', () => {
    it('reports no history for a member with no case', async () => {
      const { deps, calls } = buildHarness({ authorized: true, cases: [] });
      await handleHistory(deps, slashCommandEvent(), REF);

      expect(calls.listCasesForMember).toEqual([TARGET]);
      expect(calls.respond).toHaveLength(1);
      expect(calls.respond[0]?.message.content).toMatch(/no case history/i);
      expect(calls.respond[0]?.message.content).toContain(TARGET);
    });

    it('renders a case’s status, opened time, violation count, and escalation tier straight off the case row', async () => {
      const oneCase = openCase({ violationCount: 4, escalationTier: 1, status: 'open' });
      const { deps, calls } = buildHarness({ authorized: true, cases: [oneCase] });
      await handleHistory(deps, slashCommandEvent(), REF);

      const content = calls.respond[0]?.message.content ?? '';
      expect(content).toContain('case-1');
      expect(content).toContain('open');
      expect(content).toContain('violations: 4');
      expect(content).toContain('escalation tier: 1');
    });

    it('renders each event with actor, outcome, and timestamp', async () => {
      const oneCase = openCase();
      const evt = event({ actionTaken: 'manual_applied', actorId: MODERATOR, at: NOW_MS });
      const { deps, calls } = buildHarness({
        authorized: true,
        cases: [oneCase],
        eventsByCase: { 'case-1': [evt] },
      });
      await handleHistory(deps, slashCommandEvent(), REF);

      expect(calls.listCaseEvents).toEqual(['case-1']);
      const content = calls.respond[0]?.message.content ?? '';
      expect(content).toContain('manual_applied');
      expect(content).toContain(MODERATOR);
      expect(content).toContain(new Date(NOW_MS).toISOString());
    });

    /**
     * The Task 9 brief's central requirement (point 5, from two separate
     * task reviews): a purge/note/evidence/refusal event recorded against a
     * case whose *actor* is the case's own member (the moderator who ran
     * the command) is that member acting, not the member being acted upon.
     * `violationCount` on the case header must come from the case row, never
     * from `events.length` — these events never touch it.
     */
    it('separates events the case member authored as a moderator from events done to them, and keys violations off violationCount, not event count', async () => {
      const selfMemberId = MODERATOR; // this case belongs to the moderator themself
      const oneCase = openCase({ caseId: 'case-mod', memberId: selfMemberId, violationCount: 0 });
      const purgeEvent = event({
        eventId: 'evt-purge',
        caseId: 'case-mod',
        memberId: selfMemberId,
        matchedCategory: 'purge',
        actionTaken: 'purged',
        escalationAction: undefined,
        actorId: selfMemberId, // the case owner ran this purge themselves
      });
      const timeoutAgainstThem = event({
        eventId: 'evt-timeout',
        caseId: 'case-mod',
        memberId: selfMemberId,
        matchedCategory: 'timeout',
        actionTaken: 'manual_applied',
        actorId: '999999999999999999', // a DIFFERENT moderator acted on them
      });

      const { deps, calls } = buildHarness({
        authorized: true,
        cases: [oneCase],
        eventsByCase: { 'case-mod': [purgeEvent, timeoutAgainstThem] },
      });
      await handleHistory(
        deps,
        slashCommandEvent({ options: [{ name: 'target', value: selfMemberId }] }),
        REF,
      );

      const content = calls.respond[0]?.message.content ?? '';
      // The header's violation count is 0 — from the case row — even though
      // two events are recorded on the case.
      expect(content).toContain('violations: 0');
      // Both sections appear, and each event lands in the right one.
      expect(content).toMatch(/actions this member took as a moderator/i);
      expect(content).toMatch(/recorded against this member/i);

      const ownSectionIndex = content.search(/actions this member took as a moderator/i);
      const againstSectionIndex = content.search(/recorded against this member/i);
      const purgeIndex = content.indexOf('purged');
      const timeoutIndex = content.indexOf('manual_applied');

      // "purged" (self-authored) falls after the "took as a moderator"
      // header; "manual_applied" (done to them) falls after the "recorded
      // against" header — whichever header comes first in the render.
      expect(purgeIndex).toBeGreaterThan(ownSectionIndex);
      expect(timeoutIndex).toBeGreaterThan(againstSectionIndex);
    });

    it('renders multiple cases, in the order the repo returned them (open-first, newest-first is the repo’s job)', async () => {
      const first = openCase({ caseId: 'case-open', status: 'open' });
      const second = openCase({ caseId: 'case-closed', status: 'closed' });
      const { deps, calls } = buildHarness({ authorized: true, cases: [first, second] });
      await handleHistory(deps, slashCommandEvent(), REF);

      const content = calls.respond[0]?.message.content ?? '';
      expect(content).toContain('2 case(s)');
      expect(content.indexOf('case-open')).toBeLessThan(content.indexOf('case-closed'));
    });

    it('writes nothing — a successful read records no case event', async () => {
      const oneCase = openCase();
      const { deps, calls } = buildHarness({
        authorized: true,
        cases: [oneCase],
        eventsByCase: { 'case-1': [event()] },
      });
      await handleHistory(deps, slashCommandEvent(), REF);

      expect(calls.openOrResolveCase).toHaveLength(0);
      expect(calls.recordCaseEvent).toHaveLength(0);
    });

    /**
     * Added in the fix round: a case's event log has no upper bound — there
     * is no case-closing feature, so an actively-moderated member's open
     * case can accumulate events indefinitely, and the fully-rendered
     * content can legitimately exceed Discord's 2000-character message
     * ceiling. This drives it well past that with 60 events (each roughly
     * 100+ characters once rendered) and proves the response still fits,
     * keeps the most recent events, and says how many it dropped.
     */
    it('truncates to stay under Discord’s 2000-character content limit, keeping the most recent events', async () => {
      const oneCase = openCase({ violationCount: 60 });
      const manyEvents = Array.from({ length: 60 }, (_, i) =>
        event({
          eventId: `evt-${i}`,
          // Oldest first, per `listCaseEvents`'s own contract — index 0 is
          // the oldest, index 59 the most recent.
          at: NOW_MS - (60 - i) * 1000,
          matchedSnippet: `distinguishable-marker-${String(i).padStart(3, '0')}`,
        }),
      );
      const { deps, calls } = buildHarness({
        authorized: true,
        cases: [oneCase],
        eventsByCase: { 'case-1': manyEvents },
      });
      await handleHistory(deps, slashCommandEvent(), REF);

      const content = calls.respond[0]?.message.content ?? '';
      expect(content.length).toBeLessThanOrEqual(2000);
      expect(content).toMatch(/omitted/i);
      // The most recent event survives; the oldest does not.
      expect(content).toContain('distinguishable-marker-059');
      expect(content).not.toContain('distinguishable-marker-000');
    });
  });
});
