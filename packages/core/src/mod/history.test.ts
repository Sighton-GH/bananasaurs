import { vi, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { AuthzStore } from '../authz.js';
import type { SlashCommandEvent } from '../discord/events.js';
import type { InteractionRef, OutgoingMessage, Snowflake } from '../discord/port.js';
import { parseGuildId } from '../ids.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import { countComponents, countText } from '../ui/discord/budget.js';
import { cardCustomIds, cardTexts } from '../ui/discord/inspect.js';
import { historyCard } from './cards.js';
import {
  buildHistoryPage,
  handleHistory,
  showHistoryPage,
  type HistoryCase,
  type HistoryCaseEvent,
  type HistoryCasePorts,
  type HistoryDeps,
} from './history.js';

/**
 * Unit tests for `/mod history` as a paged card (P2 Task 8). Same level
 * `commands.test.ts` and `confirmations.test.ts` test at — every port faked,
 * nothing touches a real database or Discord.
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
    editOriginal: { ref: InteractionRef; message: OutgoingMessage }[];
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
    editOriginal: [],
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
    editOriginal: async (ref, message) => {
      calls.editOriginal.push({ ref, message });
    },
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

const replyTexts = (calls: Harness['calls']): string =>
  cardTexts(calls.respond.at(-1)?.message.components ?? []);

describe('buildHistoryPage', () => {
  it('pages 20 events across two cases: 8 newest first on page 0, oldest 4 on page 2', () => {
    const caseA = openCase({ caseId: 'case-A' });
    const caseB = openCase({ caseId: 'case-B' });
    const eventsA = Array.from({ length: 12 }, (_, i) =>
      event({ eventId: `evt-A-${String(i).padStart(2, '0')}`, caseId: 'case-A', at: NOW_MS - i * 2_000 }),
    );
    const eventsB = Array.from({ length: 8 }, (_, i) =>
      event({ eventId: `evt-B-${String(i).padStart(2, '0')}`, caseId: 'case-B', at: NOW_MS - 1_000 - i * 2_000 }),
    );
    const byCase = new Map([
      ['case-A', eventsA],
      ['case-B', eventsB],
    ]);

    const first = buildHistoryPage(TARGET, [caseA, caseB], byCase, 0);
    expect(first.pageCount).toBe(3);
    expect(first.page).toBe(0);
    expect(first.events).toHaveLength(8);
    const ats = first.events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
    expect(first.events[0]?.at).toBe(NOW_MS);

    const last = buildHistoryPage(TARGET, [caseA, caseB], byCase, 2);
    expect(last.events).toHaveLength(4);
    const seen = new Set([
      ...first.events.map((e) => e.eventId),
      ...buildHistoryPage(TARGET, [caseA, caseB], byCase, 1).events.map((e) => e.eventId),
      ...last.events.map((e) => e.eventId),
    ]);
    expect(seen.size).toBe(20);
  });

  it('clamps the page: -1 shows the newest page, 99 shows the oldest', () => {
    const oneCase = openCase();
    const byCase = new Map([
      ['case-1', Array.from({ length: 9 }, (_, i) => event({ eventId: `evt-${i}`, at: NOW_MS - i * 1_000 }))],
    ]);
    expect(buildHistoryPage(TARGET, [oneCase], byCase, -1).page).toBe(0);
    const clamped = buildHistoryPage(TARGET, [oneCase], byCase, 99);
    expect(clamped.page).toBe(1);
    expect(clamped.events).toHaveLength(1);
  });

  it('breaks equal timestamps by event id', () => {
    const oneCase = openCase();
    const byCase = new Map([
      [
        'case-1',
        [event({ eventId: 'evt-b', at: NOW_MS }), event({ eventId: 'evt-a', at: NOW_MS })],
      ],
    ]);
    const page = buildHistoryPage(TARGET, [oneCase], byCase, 0);
    expect(page.events.map((e) => e.eventId)).toEqual(['evt-a', 'evt-b']);
  });

  it('counts every event by readable kind across all pages', () => {
    const oneCase = openCase();
    const kinds: HistoryCaseEvent[] = [
      event({ eventId: 'e1', actionTaken: 'warned', escalationAction: undefined, matchedCategory: 'warn' }),
      event({ eventId: 'e2', actionTaken: 'warned', escalationAction: undefined, matchedCategory: 'warn' }),
      event({ eventId: 'e3', actionTaken: 'warned', escalationAction: undefined, matchedCategory: 'warn' }),
      event({ eventId: 'e4', actionTaken: 'manual_applied', escalationAction: 'timeout', matchedCategory: 'timeout' }),
      event({ eventId: 'e5', actionTaken: 'manual_applied', escalationAction: 'kick', matchedCategory: 'kick' }),
      event({ eventId: 'e6', actionTaken: 'manual_applied', escalationAction: 'ban', matchedCategory: 'ban' }),
      event({ eventId: 'e7', actionTaken: 'manual_applied', escalationAction: 'unban', matchedCategory: 'unban' }),
      event({ eventId: 'e8', actionTaken: 'deleted', escalationAction: undefined, matchedCategory: 'spam' }),
      event({ eventId: 'e9', actionTaken: 'deleted_and_escalated', escalationAction: 'timeout', matchedCategory: 'spam' }),
      event({ eventId: 'e10', actionTaken: 'native_blocked', escalationAction: undefined, matchedCategory: 'automod' }),
      event({ eventId: 'e11', actionTaken: 'note', escalationAction: undefined, matchedCategory: 'note', matchedSnippet: 'a note' }),
      event({ eventId: 'e12', actionTaken: 'note', escalationAction: undefined, matchedCategory: 'note', matchedSnippet: 'another' }),
      event({ eventId: 'e13', actionTaken: 'evidence_added', escalationAction: undefined, matchedCategory: 'evidence', matchedSnippet: 'https://example.com/x.png' }),
      event({ eventId: 'e14', actionTaken: 'escalation_refused', escalationAction: 'timeout', refusalReason: 'unauthorized', matchedCategory: 'timeout' }),
      event({ eventId: 'e15', actionTaken: 'escalation_refused', escalationAction: undefined, refusalReason: 'unauthorized', matchedCategory: 'history', matchedSnippet: '' }),
      event({ eventId: 'e16', actionTaken: 'would_delete', escalationAction: undefined, matchedCategory: 'spam' }),
      event({ eventId: 'e17', actionTaken: 'purged', escalationAction: undefined, matchedCategory: 'purge' }),
    ];
    const page = buildHistoryPage(TARGET, [oneCase], new Map([['case-1', kinds]]), 0);
    expect(page.countsByKind).toEqual({
      warnings: 3,
      timeouts: 1,
      kicks: 1,
      bans: 1,
      unbans: 1,
      automodDeletes: 2,
      nativeAutomod: 1,
      notes: 2,
      evidence: 1,
      refused: 2,
    });
    expect(page.totalEvents).toBe(17);
  });

  it('an empty history is one empty page', () => {
    const page = buildHistoryPage(TARGET, [openCase()], new Map([['case-1', []]]), 0);
    expect(page.pageCount).toBe(1);
    expect(page.page).toBe(0);
    expect(page.events).toEqual([]);
    expect(page.countsByKind).toEqual({});
    expect(page.totalEvents).toBe(0);
  });
});

describe('showHistoryPage', () => {
  describe('unauthorized caller', () => {
    it('refuses with the not-allowed card, never reads any case, and calls fetchInvokerRoleIds with the real invoker', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      await showHistoryPage(
        deps,
        { actorId: MODERATOR, targetId: TARGET, page: 0, interactionId: 'interaction-1' },
        REF,
        'reply',
      );

      expect(calls.fetchInvokerRoleIds).toEqual([MODERATOR]);
      expect(calls.listCasesForMember).toHaveLength(0);
      expect(calls.listCaseEvents).toHaveLength(0);
      expect(calls.respond).toHaveLength(1);
      expect(calls.respond[0]?.ref).toEqual(REF);
      expect(replyTexts(calls)).toContain("You can't take moderation actions");
      expect(calls.editOriginal).toHaveLength(0);
    });

    it('durably records the refusal on the target member’s case: escalation_refused / unauthorized, actor is the real caller', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      await showHistoryPage(
        deps,
        { actorId: MODERATOR, targetId: TARGET, page: 0, interactionId: 'interaction-1' },
        REF,
        'reply',
      );

      expect(calls.openOrResolveCase).toEqual([{ memberId: TARGET, countsAsViolation: false }]);
      expect(calls.recordCaseEvent).toHaveLength(1);
      const refusal = calls.recordCaseEvent[0]!;
      expect(refusal.caseId).toBe('refusal-case-1');
      expect(refusal.memberId).toBe(TARGET);
      expect(refusal.actorId).toBe(MODERATOR);
      expect(refusal.actionTaken).toBe('escalation_refused');
      expect(refusal.refusalReason).toBe('unauthorized');
      expect(refusal.matchedCategory).toBe('history');
      expect(refusal.at).toBe(NOW_MS);
    });

    it('in edit mode an unauthorized page click answers privately and never edits the card', async () => {
      const { deps, calls } = buildHarness({ authorized: false });
      await showHistoryPage(
        deps,
        { actorId: MODERATOR, targetId: TARGET, page: 1, interactionId: 'interaction-9' },
        REF,
        'edit',
      );

      expect(calls.editOriginal).toHaveLength(0);
      expect(calls.respond).toHaveLength(1);
      expect(replyTexts(calls)).toContain("You can't take moderation actions");
      expect(calls.recordCaseEvent).toHaveLength(1);
      expect(calls.recordCaseEvent[0]?.actionTaken).toBe('escalation_refused');
    });
  });

  describe('authorized caller', () => {
    it('reports no history with the no-history card', async () => {
      const { deps, calls } = buildHarness({ authorized: true, cases: [] });
      await showHistoryPage(
        deps,
        { actorId: MODERATOR, targetId: TARGET, page: 0, interactionId: 'interaction-1' },
        REF,
        'reply',
      );

      expect(calls.listCasesForMember).toEqual([TARGET]);
      expect(calls.respond).toHaveLength(1);
      const t = replyTexts(calls);
      expect(t).toContain('No case history for');
      expect(t).toContain(TARGET);
    });

    it('replies with the history card: case footer, readable words, actor and timestamp', async () => {
      const oneCase = openCase({ violationCount: 4, escalationTier: 1, status: 'open' });
      const evt = event({ actionTaken: 'manual_applied', actorId: MODERATOR, at: NOW_MS });
      const { deps, calls } = buildHarness({
        authorized: true,
        cases: [oneCase],
        eventsByCase: { 'case-1': [evt] },
      });
      await showHistoryPage(
        deps,
        { actorId: MODERATOR, targetId: TARGET, page: 0, interactionId: 'interaction-1' },
        REF,
        'reply',
      );

      expect(calls.listCaseEvents).toEqual(['case-1']);
      expect(calls.respond).toHaveLength(1);
      expect(calls.editOriginal).toHaveLength(0);
      const t = replyTexts(calls);
      expect(t).toContain('-# 📂 CASE HISTORY');
      expect(t).toContain('Case case-1 (open, 4 violations, tier 1)');
      expect(t).toContain('Timed out');
      expect(t).not.toContain('manual_applied');
      expect(t).toContain(MODERATOR);
      expect(t).toContain(`<t:${Math.floor(NOW_MS / 1000)}:d>`);
    });

    it('keeps violations off the case row and marks self-authored events as moderator actions', async () => {
      const selfMemberId = MODERATOR;
      const oneCase = openCase({ caseId: 'case-mod', memberId: selfMemberId, violationCount: 0 });
      const purgeEvent = event({
        eventId: 'evt-purge',
        caseId: 'case-mod',
        memberId: selfMemberId,
        matchedCategory: 'purge',
        actionTaken: 'purged',
        escalationAction: undefined,
        actorId: selfMemberId,
      });
      const timeoutAgainstThem = event({
        eventId: 'evt-timeout',
        caseId: 'case-mod',
        memberId: selfMemberId,
        matchedCategory: 'timeout',
        actionTaken: 'manual_applied',
        actorId: '999999999999999999',
      });
      const { deps, calls } = buildHarness({
        authorized: true,
        cases: [oneCase],
        eventsByCase: { 'case-mod': [purgeEvent, timeoutAgainstThem] },
      });
      await showHistoryPage(
        deps,
        { actorId: MODERATOR, targetId: selfMemberId, page: 0, interactionId: 'interaction-1' },
        REF,
        'reply',
      );

      const t = replyTexts(calls);
      expect(t).toContain('0 violations');
      expect(t).toContain('Ran a purge');
      expect(t).toContain('(as a moderator)');
      expect(t).not.toMatch(/was purged/i);
    });

    it('lists several cases newest-page-first in the footer, in repo order', async () => {
      const first = openCase({ caseId: 'case-open', status: 'open' });
      const second = openCase({ caseId: 'case-closed', status: 'closed' });
      const { deps, calls } = buildHarness({ authorized: true, cases: [first, second] });
      await showHistoryPage(
        deps,
        { actorId: MODERATOR, targetId: TARGET, page: 0, interactionId: 'interaction-1' },
        REF,
        'reply',
      );

      const t = replyTexts(calls);
      expect(t).toContain('2 cases');
      expect(t.indexOf('case-open')).toBeLessThan(t.indexOf('case-closed'));
    });

    it('writes nothing — a successful read records no case event', async () => {
      const oneCase = openCase();
      const { deps, calls } = buildHarness({
        authorized: true,
        cases: [oneCase],
        eventsByCase: { 'case-1': [event()] },
      });
      await showHistoryPage(
        deps,
        { actorId: MODERATOR, targetId: TARGET, page: 0, interactionId: 'interaction-1' },
        REF,
        'reply',
      );

      expect(calls.openOrResolveCase).toHaveLength(0);
      expect(calls.recordCaseEvent).toHaveLength(0);
    });

    it('in edit mode replaces the card in place instead of replying', async () => {
      const oneCase = openCase();
      const many = Array.from({ length: 9 }, (_, i) =>
        event({
          eventId: `evt-${i}`,
          actionTaken: 'warned',
          escalationAction: undefined,
          matchedCategory: 'warn',
          matchedSnippet: `marker-${String(i).padStart(2, '0')}`,
          at: NOW_MS - i * 1_000,
        }),
      );
      const { deps, calls } = buildHarness({
        authorized: true,
        cases: [oneCase],
        eventsByCase: { 'case-1': many },
      });
      await showHistoryPage(
        deps,
        { actorId: MODERATOR, targetId: TARGET, page: 1, interactionId: 'interaction-1' },
        REF,
        'edit',
      );

      expect(calls.respond).toHaveLength(0);
      expect(calls.editOriginal).toHaveLength(1);
      expect(calls.editOriginal[0]?.ref).toEqual(REF);
      const t = cardTexts(calls.editOriginal[0]?.message.components ?? []);
      expect(t).toContain('Page 2 of 2');
      expect(t).toContain('marker-08');
      expect(calls.recordCaseEvent).toHaveLength(0);
    });

    it('a full page of long snippets stays within the card budget', () => {
      const oneCase = openCase();
      const many = Array.from({ length: 8 }, (_, i) =>
        event({
          eventId: `evt-${i}`,
          actionTaken: 'warned',
          escalationAction: undefined,
          matchedCategory: 'warn',
          matchedSnippet: 'x'.repeat(500),
          at: NOW_MS - i * 1_000,
        }),
      );
      const page = buildHistoryPage(TARGET, [oneCase], new Map([['case-1', many]]), 0);
      const rendered = historyCard(page);
      expect(countText(rendered.components)).toBeLessThanOrEqual(4000);
      expect(countComponents(rendered.components)).toBeLessThanOrEqual(40);
    });

    it('page buttons point at the neighbouring pages, and a single page has none', () => {
      const oneCase = openCase();
      const many = Array.from({ length: 20 }, (_, i) => event({ eventId: `evt-${i}`, at: NOW_MS - i * 1_000 }));
      const byCase = new Map([['case-1', many]]);
      expect(cardCustomIds(historyCard(buildHistoryPage(TARGET, [oneCase], byCase, 0)).components)).toEqual([
        `bs.mod:history:${TARGET}:1`,
      ]);
      expect(cardCustomIds(historyCard(buildHistoryPage(TARGET, [oneCase], byCase, 1)).components)).toEqual([
        `bs.mod:history:${TARGET}:0`,
        `bs.mod:history:${TARGET}:2`,
      ]);
      expect(cardCustomIds(historyCard(buildHistoryPage(TARGET, [oneCase], byCase, 2)).components)).toEqual([
        `bs.mod:history:${TARGET}:1`,
      ]);
      const single = buildHistoryPage(TARGET, [oneCase], new Map([['case-1', [event()]]]), 0);
      expect(cardCustomIds(historyCard(single).components)).toEqual([]);
    });
  });
});

describe('handleHistory', () => {
  it('shows the first page as a reply', async () => {
    const oneCase = openCase();
    const { deps, calls } = buildHarness({
      authorized: true,
      cases: [oneCase],
      eventsByCase: { 'case-1': [event()] },
    });
    await handleHistory(deps, slashCommandEvent(), REF);

    expect(calls.respond).toHaveLength(1);
    expect(replyTexts(calls)).toContain('-# 📂 CASE HISTORY');
  });

  it('an unauthorized slash call gets the not-allowed card and is recorded', async () => {
    const { deps, calls } = buildHarness({ authorized: false });
    await handleHistory(deps, slashCommandEvent(), REF);

    expect(replyTexts(calls)).toContain("You can't take moderation actions");
    expect(calls.recordCaseEvent).toHaveLength(1);
    expect(calls.recordCaseEvent[0]?.actionTaken).toBe('escalation_refused');
  });
});
