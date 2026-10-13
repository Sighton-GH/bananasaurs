import { describe, expect, it } from 'vitest';
import { countComponents, countText } from '../ui/discord/budget.js';
import { cardCustomIds, cardTexts } from '../ui/discord/inspect.js';
import {
  banConfirmCard,
  caseRef,
  deleteConfirmCard,
  deleteOutcomeCard,
  describeCaseEvent,
  durationLabel,
  historyCard,
  modOutcomeCard,
  noteOutcomeCard,
  purgeConfirmCard,
  timeoutModal,
  warnModal,
  warnOutcomeCard,
} from './cards.js';
import { buildHistoryPage, type HistoryCaseEvent } from './history.js';

const U = '333333333333333333';
const C = '111111111111111111';
const I = '1234567890123456789';
const CASE = '0f3c9a2e-1111-4222-8333-444455556666';

const text = (c: { components: readonly unknown[] }) => cardTexts(c.components);

/** Every button's `style` in order (danger 4, secondary 2): `inspect.ts` reads texts and ids only. */
const buttonStyles = (components: readonly unknown[]): number[] => {
  const out: number[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    if (node['type'] === 2 && typeof node['style'] === 'number') out.push(node['style']);
    walk(node['components']);
  };
  walk(components);
  return out;
};

describe('durationLabel', () => {
  it.each([
    [10, '10 minutes'],
    [1, '1 minute'],
    [60, '1 hour'],
    [120, '2 hours'],
    [90, '90 minutes'],
    [1440, '1 day'],
    [10080, '7 days'],
  ])('%i → %s', (m, label) => expect(durationLabel(m)).toBe(label));
});

describe('modOutcomeCard', () => {
  const base = { targetId: U, reason: 'spam **links**', interactionId: I };

  it('says what happened, in words, with the reason escaped', () => {
    const t = text(
      modOutcomeCard({
        ...base,
        action: 'timeout',
        durationMinutes: 60,
        outcome: { status: 'applied' },
      }),
    );
    expect(t).toContain(`Timed out <@${U}> for 1 hour`);
    expect(t).toContain('Reason: spam \\*\\*links\\*\\*');
  });

  it.each([
    ['untimeout', `Ended <@${U}>'s timeout`],
    ['kick', `Kicked <@${U}>`],
    ['ban', `Banned <@${U}>`],
    ['unban', `Unbanned <@${U}>`],
  ] as const)('%s applied → %s', (action, words) => {
    expect(text(modOutcomeCard({ ...base, action, outcome: { status: 'applied' } }))).toContain(
      words,
    );
  });

  it('dry run says nothing changed and what would have', () => {
    const t = text(modOutcomeCard({ ...base, action: 'kick', outcome: { status: 'dry-run' } }));
    expect(t).toContain('Dry run is on, so nothing changed');
    expect(t).toContain(`It would have kicked <@${U}>.`);
  });

  it('a refusal reads from the catalogue, never the raw code, and carries a Ref', () => {
    const t = text(
      modOutcomeCard({
        ...base,
        action: 'kick',
        outcome: { status: 'refused', reason: 'role-above-bot' },
      }),
    );
    expect(t).toContain('That member is above the bot');
    expect(t).not.toContain('role-above-bot');
    expect(t).toContain('-# Ref 23456789');
  });

  it('a Discord failure never shows the error name', () => {
    const t = text(
      modOutcomeCard({
        ...base,
        action: 'ban',
        outcome: { status: 'failed', code: 'DiscordApiError' },
      }),
    );
    expect(t).toContain("Discord didn't accept that");
    expect(t).not.toContain('DiscordApiError');
  });

  it('never pings the target', () => {
    expect(
      modOutcomeCard({ ...base, action: 'kick', outcome: { status: 'applied' } }).allowedMentions,
    ).toEqual({ parse: [] });
  });
});

describe('warnOutcomeCard', () => {
  it('names the case and the count', () => {
    const t = text(
      warnOutcomeCard({
        targetId: U,
        reason: 'r',
        caseId: CASE,
        violationCount: 2,
        escalation: undefined,
      }),
    );
    expect(t).toContain(`Warned <@${U}>`);
    expect(t).toContain(`Case ${caseRef(CASE)} · warning 2`);
    expect(caseRef(CASE)).toBe('0f3c9a2e');
  });
  it('explains a refused escalation in words', () => {
    const t = text(
      warnOutcomeCard({
        targetId: U,
        reason: 'r',
        caseId: CASE,
        violationCount: 3,
        escalation: { status: 'refused', reason: 'killswitch' },
      }),
    );
    expect(t).toContain(
      "This reached an escalation step, but its consequence didn't run: Moderation is paused.",
    );
  });
});

describe('noteOutcomeCard', () => {
  it('a note names the target and carries the note text', () => {
    const c = noteOutcomeCard({ kind: 'note', targetId: U, content: 'seen near the raid server' });
    expect(text(c)).toContain(`Added a note to <@${U}>'s case`);
    expect(text(c)).toContain('seen near the raid server');
    expect(c.allowedMentions).toEqual({ parse: [] });
  });
  it('an evidence link names the target and carries the URL', () => {
    const c = noteOutcomeCard({
      kind: 'evidence',
      targetId: U,
      content: 'https://example.com/screenshot.png',
    });
    expect(text(c)).toContain(`Added an evidence link to <@${U}>'s case`);
    expect(text(c)).toContain('https://example.com/screenshot.png');
    expect(c.allowedMentions).toEqual({ parse: [] });
  });
});

describe('confirm cards', () => {
  it('a ban preview states scope and offers a danger Confirm and a Cancel', () => {
    const c = banConfirmCard({ targetId: U, reason: 'raid', intentId: 'abc' });
    expect(text(c)).toContain(`Ban <@${U}>?`);
    expect(text(c)).toContain('Nothing has happened yet.');
    expect(cardCustomIds(c.components)).toEqual(['modconfirm:abc', 'modcancel:abc']);
    expect(buttonStyles(c.components)).toEqual([4, 2]);
    expect(JSON.stringify(c.components)).toContain('"style":4');
  });
  it('a purge preview states exact scope', () => {
    const c = purgeConfirmCard({
      channelId: C,
      total: 37,
      fresh: 30,
      old: 7,
      newestAtMs: 1_760_000_000_000,
      reason: 'spam',
      intentId: 'abc',
    });
    const t = text(c);
    expect(t).toContain(`Delete 37 messages from <#${C}>?`);
    expect(t).toContain('Newest <t:1760000000:R>');
    expect(t).toContain('30 can go in bulk. 7 are older than 14 days and go one at a time.');
    expect(buttonStyles(c.components)).toEqual([4, 2]);
  });
});

describe('moderator modals', () => {
  it('Warn asks for a required reason, up to 500 characters', () => {
    const m = warnModal(U);
    expect(m.custom_id).toBe(`bs.mod:warn:${U}`);
    expect(m.title).toBe('Warn member');
    const json = JSON.stringify(m.components);
    expect(json).toContain('"custom_id":"reason"');
    expect(json).toContain('"required":true');
    expect(json).toContain('"max_length":500');
  });
  it('Timeout offers 10 minutes, 1 hour and 1 day, with 1 hour chosen', () => {
    const m = timeoutModal(U);
    expect(m.custom_id).toBe(`bs.mod:timeout:${U}`);
    const radio = JSON.stringify(m.components);
    expect(radio).toContain('"value":"10"');
    expect(radio).toContain('"value":"60","label":"1 hour","default":true');
    expect(radio).toContain('"value":"1440"');
  });
});

describe('history cards', () => {
  const MOD = '222222222222222222';
  const CASE = 'case-1';

  const historyEvent = (over: Partial<HistoryCaseEvent> = {}): HistoryCaseEvent => ({
    eventId: 'evt-1',
    caseId: CASE,
    ruleId: 'manual',
    memberId: U,
    at: 1_760_000_000_000,
    matchedCategory: 'warn',
    matchedSnippet: '',
    actionTaken: 'warned',
    escalationAction: undefined,
    refusalReason: undefined,
    actorId: MOD,
    ...over,
  });

  /** Every `ModCaseActionTaken` value on 2026-10-10 (23), in readable words — never a raw code. */
  const WORD_CASES: { actionTaken: string; over?: Partial<HistoryCaseEvent>; words: string }[] = [
    { actionTaken: 'warned', words: 'Warned' },
    {
      actionTaken: 'manual_applied',
      over: { escalationAction: 'timeout', matchedCategory: 'timeout' },
      words: 'Timed out',
    },
    {
      actionTaken: 'manual_applied',
      over: { escalationAction: 'kick', matchedCategory: 'kick' },
      words: 'Kicked',
    },
    {
      actionTaken: 'manual_applied',
      over: { escalationAction: 'ban', matchedCategory: 'ban' },
      words: 'Banned',
    },
    {
      actionTaken: 'manual_applied',
      over: { escalationAction: 'unban', matchedCategory: 'unban' },
      words: 'Unbanned',
    },
    {
      actionTaken: 'manual_applied',
      over: { escalationAction: undefined, matchedCategory: 'untimeout' },
      words: 'Timeout ended',
    },
    {
      actionTaken: 'manual_applied',
      over: { escalationAction: undefined, matchedCategory: 'kick' },
      words: 'Kicked',
    },
    { actionTaken: 'deleted', words: 'Message deleted' },
    {
      actionTaken: 'deleted_and_escalated',
      over: { escalationAction: 'timeout' },
      words: 'Message deleted',
    },
    {
      actionTaken: 'deleted',
      over: { ruleId: 'rule-1', matchedCategory: 'spam' },
      words: 'Message deleted by automod',
    },
    { actionTaken: 'would_delete', words: 'Automod match (watch only)' },
    { actionTaken: 'delete_blocked_killswitch', words: 'Delete blocked: the kill switch is on' },
    { actionTaken: 'delete_blocked_breaker', words: 'Delete blocked: the safety breaker is open' },
    { actionTaken: 'delete_blocked_dry_run', words: 'Delete blocked: dry run is on' },
    {
      actionTaken: 'delete_blocked_guild_unknown',
      words: "Delete blocked: the server isn't set up",
    },
    { actionTaken: 'delete_failed', words: "Delete didn't go through" },
    {
      actionTaken: 'escalation_refused',
      over: {
        escalationAction: 'timeout',
        refusalReason: 'role-above-bot',
        matchedCategory: 'timeout',
      },
      words: 'Timeout refused: That member is above the bot',
    },
    {
      actionTaken: 'escalation_refused',
      over: {
        escalationAction: 'timeout',
        refusalReason: 'unauthorized',
        matchedCategory: 'timeout',
      },
      words: 'Timeout refused: Not allowed',
    },
    {
      actionTaken: 'escalation_failed',
      over: { escalationAction: 'kick', matchedCategory: 'kick' },
      words: "Kick didn't go through",
    },
    {
      actionTaken: 'escalation_dry_run',
      over: { escalationAction: 'ban', matchedCategory: 'ban' },
      words: 'Ban (dry run)',
    },
    {
      actionTaken: 'escalation_skipped',
      over: { escalationAction: 'unban', matchedCategory: 'unban' },
      words: 'Unban (already done)',
    },
    { actionTaken: 'note', over: { matchedCategory: 'note' }, words: 'Note' },
    {
      actionTaken: 'evidence_added',
      over: { matchedCategory: 'evidence' },
      words: 'Evidence',
    },
    { actionTaken: 'purged', over: { matchedCategory: 'purge' }, words: 'Ran a purge' },
    { actionTaken: 'purge_refused', over: { matchedCategory: 'purge' }, words: 'Purge refused' },
    {
      actionTaken: 'purge_failed',
      over: { matchedCategory: 'purge' },
      words: "Purge didn't go through",
    },
    {
      actionTaken: 'native_blocked',
      over: { matchedCategory: 'automod' },
      words: 'Discord AutoMod blocked a message',
    },
    {
      actionTaken: 'native_alerted',
      over: { matchedCategory: 'automod' },
      words: 'Discord AutoMod sent an alert',
    },
    {
      actionTaken: 'native_timeout',
      over: { matchedCategory: 'automod' },
      words: 'Discord AutoMod timed them out',
    },
    {
      actionTaken: 'native_blocked_interaction',
      over: { matchedCategory: 'automod' },
      words: 'Discord AutoMod blocked an interaction',
    },
  ];

  it.each(WORD_CASES.map((c) => [c.actionTaken, c.words] as const))(
    '%s reads %s',
    (actionTaken, words) => {
      const found = WORD_CASES.find((c) => c.actionTaken === actionTaken && c.words === words)!;
      const line = describeCaseEvent(historyEvent({ actionTaken, ...found.over }), U);
      expect(line).toContain(words);
      if (actionTaken.includes('_')) expect(line).not.toContain(actionTaken);
    },
  );

  it('an unknown future action is humanised, never shown raw', () => {
    expect(describeCaseEvent(historyEvent({ actionTaken: 'some_future_action' }), U)).toContain(
      'Some future action',
    );
  });

  it('a full line names the time, the words, the actor and the snippet', () => {
    const line = describeCaseEvent(
      historyEvent({
        actionTaken: 'manual_applied',
        escalationAction: 'timeout',
        matchedCategory: 'timeout',
        matchedSnippet: 'raid',
        at: 1_760_000_000_000,
      }),
      U,
    );
    expect(line).toBe(`<t:1760000000:d> **Timed out** by <@${MOD}> — "raid"`);
  });

  it('a refusal line carries the catalogue title, not the code', () => {
    const line = describeCaseEvent(
      historyEvent({
        actionTaken: 'escalation_refused',
        escalationAction: 'timeout',
        matchedCategory: 'timeout',
        refusalReason: 'role-above-bot',
      }),
      U,
    );
    expect(line).toContain('**Timeout refused: That member is above the bot**');
    expect(line).toContain(`by <@${MOD}>`);
    expect(line).not.toContain('role-above-bot');
  });

  it('self-authored events read as moderator actions, with no by-line at themself', () => {
    const line = describeCaseEvent(
      historyEvent({ actionTaken: 'purged', matchedCategory: 'purge', actorId: U }),
      U,
    );
    expect(line).toContain('**Ran a purge** (as a moderator)');
    expect(line).not.toContain(`by <@${U}>`);
    expect(line).not.toMatch(/was purged/i);
  });

  it('the snippet is escaped inline and capped at 120 characters', () => {
    const snippet = `**x** @everyone ${'y'.repeat(500)}`;
    const line = describeCaseEvent(historyEvent({ matchedSnippet: snippet }), U);
    expect(line).toContain('\\*\\*x\\*\\*');
    expect(line).not.toContain(snippet);
    expect(line).toContain('…');
  });

  it('an event with no actor and no snippet has neither', () => {
    const line = describeCaseEvent(
      historyEvent({ actionTaken: 'would_delete', actorId: undefined, matchedSnippet: '' }),
      U,
    );
    expect(line).toBe('<t:1760000000:d> **Automod match (watch only)**');
  });

  const pageOf = (n: number, page = 0) => {
    const oneCase = {
      caseId: 'case-1',
      memberId: U,
      openedAt: 1_760_000_000_000 - 10_000,
      violationCount: 3,
      escalationTier: 1,
      status: 'open' as const,
    };
    const events = Array.from({ length: n }, (_, i) =>
      historyEvent({
        eventId: `evt-${i}`,
        matchedSnippet: `s${i}`,
        at: 1_760_000_000_000 - i * 1_000,
      }),
    );
    return buildHistoryPage(U, [oneCase], new Map([['case-1', events]]), page);
  };

  it('shows the eyebrow, the member header, the counts and the footer', () => {
    const t = text(historyCard(pageOf(1)));
    expect(t).toContain('-# 📂 CASE HISTORY');
    expect(t).toContain(`**<@${U}>** · 1 case · 1 event`);
    expect(t).toContain('1 warning');
    expect(t).toContain('-# Page 1 of 1 · Case case-1 (open, 3 violations, tier 1)');
  });

  it('counts pluralise in a fixed order and leave out zero kinds', () => {
    const oneCase = {
      caseId: 'case-1',
      memberId: U,
      openedAt: 1_760_000_000_000 - 10_000,
      violationCount: 3,
      escalationTier: 1,
      status: 'open' as const,
    };
    const events = [
      historyEvent({ eventId: 'a', actionTaken: 'warned' }),
      historyEvent({ eventId: 'b', actionTaken: 'warned' }),
      historyEvent({ eventId: 'c', actionTaken: 'warned' }),
      historyEvent({
        eventId: 'd',
        actionTaken: 'manual_applied',
        escalationAction: 'timeout',
        matchedCategory: 'timeout',
      }),
      historyEvent({ eventId: 'e', actionTaken: 'deleted', matchedCategory: 'spam' }),
      historyEvent({ eventId: 'f', actionTaken: 'deleted', matchedCategory: 'spam' }),
      historyEvent({
        eventId: 'g',
        actionTaken: 'note',
        matchedCategory: 'note',
        matchedSnippet: 'n',
      }),
    ];
    const t = text(historyCard(buildHistoryPage(U, [oneCase], new Map([['case-1', events]]), 0)));
    expect(t).toContain('3 warnings · 1 timeout · 2 automod deletes · 1 note');
    expect(t).not.toContain('kick');
  });

  it('is neutral, pings nobody and carries no art', () => {
    const c = historyCard(pageOf(1));
    expect((c.components[0] as { accent_color: number }).accent_color).toBe(0x64748b);
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(c.art).toEqual([]);
  });

  it('a full page of 500-character snippets stays in budget', () => {
    const oneCase = {
      caseId: 'case-1',
      memberId: U,
      openedAt: 1_760_000_000_000 - 10_000,
      violationCount: 3,
      escalationTier: 1,
      status: 'open' as const,
    };
    const events = Array.from({ length: 8 }, (_, i) =>
      historyEvent({
        eventId: `evt-${i}`,
        matchedSnippet: 'z'.repeat(500),
        at: 1_760_000_000_000 - i,
      }),
    );
    const c = historyCard(buildHistoryPage(U, [oneCase], new Map([['case-1', events]]), 0));
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
    expect(countComponents(c.components)).toBeLessThanOrEqual(40);
  });

  it('shortens a long case list with an and-more tail', () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({
      caseId: `case-${String(i).padStart(2, '0')}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      memberId: U,
      openedAt: 1_760_000_000_000 - 10_000,
      violationCount: 1,
      escalationTier: 0,
      status: 'open' as const,
    }));
    const t = text(historyCard(buildHistoryPage(U, cases, new Map(), 0)));
    expect(t).toContain('more cases');
  });
});

describe('renderer caps after formatting', () => {
  it('caps escaped moderation reasons and notes', () => {
    const big = '*_~@<'.repeat(2000);
    const outcome = modOutcomeCard({
      action: 'kick',
      targetId: U,
      reason: big,
      outcome: { status: 'applied' },
      interactionId: I,
    });
    const note = noteOutcomeCard({ kind: 'note', targetId: U, content: big });
    expect(countText(outcome.components)).toBeLessThanOrEqual(4000);
    expect(countText(note.components)).toBeLessThanOrEqual(4000);
    expect(text(outcome)).toContain('…');
    expect(text(note)).toContain('…');
  });

  it('caps a case-history line after escaping its snippet', () => {
    const line = describeCaseEvent(
      {
        eventId: 'evt-cap',
        caseId: CASE,
        ruleId: 'manual',
        memberId: U,
        at: 1_760_000_000_000,
        matchedCategory: 'warn',
        matchedSnippet: '*_~@<'.repeat(2000),
        actionTaken: 'warned',
        escalationAction: undefined,
        refusalReason: undefined,
        actorId: '222222222222222222',
      },
      U,
    );
    expect(line.length).toBeLessThanOrEqual(600);
    expect(line).toContain('…');
  });
});

describe('delete cards', () => {
  it('the confirm card names the author and channel and links the message', () => {
    const c = deleteConfirmCard({
      guildId: '9',
      channelId: C,
      messageId: '2',
      authorId: U,
      intentId: 'abc',
    });
    expect(cardTexts(c.components)).toContain(`Delete this message by <@${U}> in <#${C}>?`);
    expect(cardTexts(c.components)).toContain(`https://discord.com/channels/9/${C}/2`);
    expect(cardCustomIds(c.components)).toEqual(['modconfirm:abc', 'modcancel:abc']);
  });
  it.each([
    [{ status: 'applied' } as const, 'Deleted the message'],
    [{ status: 'skipped', reason: 'message-gone' } as const, 'That message was already gone'],
    [{ status: 'skipped', reason: 'already-applied' } as const, 'Already done'],
    [{ status: 'dry-run' } as const, 'Dry run is on, so nothing changed'],
    [{ status: 'refused', reason: 'killswitch' } as const, 'Moderation is paused'],
    [{ status: 'failed', code: 'DiscordApiError' } as const, "Discord didn't accept that"],
  ])('%o → %s', (outcome, words) => {
    expect(cardTexts(deleteOutcomeCard(outcome, I).components)).toContain(words);
  });
});
