import { describe, expect, it } from 'vitest';
import { cardCustomIds, cardTexts } from '../ui/discord/inspect.js';
import {
  banConfirmCard,
  caseRef,
  durationLabel,
  modOutcomeCard,
  purgeConfirmCard,
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
    const t = text(modOutcomeCard({ ...base, action: 'timeout', durationMinutes: 60, outcome: { status: 'applied' } }));
    expect(t).toContain(`Timed out <@${U}> for 1 hour`);
    expect(t).toContain('Reason: spam \\*\\*links\\*\\*');
  });

  it.each([
    ['untimeout', `Ended <@${U}>'s timeout`],
    ['kick', `Kicked <@${U}>`],
    ['ban', `Banned <@${U}>`],
    ['unban', `Unbanned <@${U}>`],
  ] as const)('%s applied → %s', (action, words) => {
    expect(text(modOutcomeCard({ ...base, action, outcome: { status: 'applied' } }))).toContain(words);
  });

  it('dry run says nothing changed and what would have', () => {
    const t = text(modOutcomeCard({ ...base, action: 'kick', outcome: { status: 'dry-run' } }));
    expect(t).toContain('Dry run is on, so nothing changed');
    expect(t).toContain(`It would have kicked <@${U}>.`);
  });

  it('a refusal reads from the catalogue, never the raw code, and carries a Ref', () => {
    const t = text(modOutcomeCard({ ...base, action: 'kick', outcome: { status: 'refused', reason: 'role-above-bot' } }));
    expect(t).toContain('That member is above the bot');
    expect(t).not.toContain('role-above-bot');
    expect(t).toContain('-# Ref 23456789');
  });

  it('a Discord failure never shows the error name', () => {
    const t = text(modOutcomeCard({ ...base, action: 'ban', outcome: { status: 'failed', code: 'DiscordApiError' } }));
    expect(t).toContain("Discord didn't accept that");
    expect(t).not.toContain('DiscordApiError');
  });

  it('never pings the target', () => {
    expect(modOutcomeCard({ ...base, action: 'kick', outcome: { status: 'applied' } }).allowedMentions).toEqual({ parse: [] });
  });
});

describe('warnOutcomeCard', () => {
  it('names the case and the count', () => {
    const t = text(warnOutcomeCard({ targetId: U, reason: 'r', caseId: CASE, violationCount: 2, escalation: undefined }));
    expect(t).toContain(`Warned <@${U}>`);
    expect(t).toContain(`Case ${caseRef(CASE)} · warning 2`);
    expect(caseRef(CASE)).toBe('0f3c9a2e');
  });
  it('explains a refused escalation in words', () => {
    const t = text(
      warnOutcomeCard({ targetId: U, reason: 'r', caseId: CASE, violationCount: 3, escalation: { status: 'refused', reason: 'killswitch' } }),
    );
    expect(t).toContain("This reached an escalation step, but its consequence didn't run: Moderation is paused.");
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
    const t = text(purgeConfirmCard({ channelId: C, total: 37, fresh: 30, old: 7, newestAtMs: 1_760_000_000_000, reason: 'spam', intentId: 'abc' }));
    expect(t).toContain(`Delete 37 messages from <#${C}>?`);
    expect(t).toContain('Newest <t:1760000000:R>');
    expect(t).toContain('30 can go in bulk. 7 are older than 14 days and go one at a time.');
  });
});
