import { describe, expect, it } from 'vitest';
import { cardCustomIds, cardTexts } from '../ui/discord/inspect.js';
import {
  banConfirmCard,
  caseRef,
  deleteConfirmCard,
  deleteOutcomeCard,
  durationLabel,
  modOutcomeCard,
  noteOutcomeCard,
  purgeConfirmCard,
  timeoutModal,
  warnModal,
  warnOutcomeCard,
} from './cards.js';

const U = '333333333333333333';
const C = '111111111111111111';
const I = '1234567890123456789';
const CASE = '0f3c9a2e-1111-4222-8333-444455556666';

const text = (c: { components: readonly unknown[] }) => cardTexts(c.components);

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
    expect(JSON.stringify(c.components)).toContain('"style":4');
  });
  it('a purge preview states exact scope', () => {
    const t = text(
      purgeConfirmCard({
        channelId: C,
        total: 37,
        fresh: 30,
        old: 7,
        newestAtMs: 1_760_000_000_000,
        reason: 'spam',
        intentId: 'abc',
      }),
    );
    expect(t).toContain(`Delete 37 messages from <#${C}>?`);
    expect(t).toContain('Newest <t:1760000000:R>');
    expect(t).toContain('30 can go in bulk. 7 are older than 14 days and go one at a time.');
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
