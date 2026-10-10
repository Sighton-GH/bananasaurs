import { describe, expect, it } from 'vitest';
import { buildCapabilityBlock } from './capabilities.js';
import { CLUB_ASSISTANT_SKILLS } from './skills.js';

const skill = (id: string) => CLUB_ASSISTANT_SKILLS.find((s) => s.id === id)!;

describe('buildCapabilityBlock (ADR 0136)', () => {
  it('lists each offered tool once, under its group, with the group description', () => {
    const text = buildCapabilityBlock({
      offeredTools: ['set_reminder', 'my_reminders', 'search_sources', 'web_search'],
      skills: [skill('reminders'), skill('search-club')],
      unavailable: [],
    });
    expect(text.startsWith('WHAT YOU CAN DO RIGHT NOW')).toBe(true);
    expect(text).toContain(
      '- Reminders and scheduled posts (my_reminders, set_reminder): post a message later',
    );
    expect(text).toContain('- Club knowledge (search_sources):');
    expect(text).toContain('- The web (web_search):');
    expect(text).not.toContain('This channel');
    expect(text.match(/set_reminder/g)?.length).toBe(1);
  });

  it('never names a tool that was not offered', () => {
    const text = buildCapabilityBlock({
      offeredTools: ['search_sources'],
      skills: [],
      unavailable: [],
    });
    for (const absent of ['set_reminder', 'web_search', 'cancel_reminder'])
      expect(text).not.toContain(absent);
  });

  it('tells the model the list is authoritative, to use it, to answer capability questions, and to batch lookups', () => {
    const text = buildCapabilityBlock({
      offeredTools: ['search_sources'],
      skills: [],
      unavailable: [],
    });
    expect(text).toContain('complete, current list');
    expect(text).toContain('When a member asks for something these cover, do it.');
    expect(text).toContain('When asked what you can do, describe these in plain words.');
    expect(text).toContain("Don't show tool names to members.");
    expect(text).toContain('call them together');
  });

  it('lists prose skills under "You also help with", without the old suffixes', () => {
    const text = buildCapabilityBlock({
      offeredTools: [],
      skills: [skill('draft-agenda'), skill('reminders')],
      unavailable: [],
    });
    expect(text).toContain('You also help with:');
    expect(text).toContain('Draft a meeting agenda: Draft a meeting agenda from club context');
    expect(text).not.toContain('You really can do this');
    expect(text).not.toContain('outside what you help with');
  });

  it('names what is not available to this member and why, addressed by name', () => {
    const text = buildCapabilityBlock({
      offeredTools: ['search_sources'],
      skills: [],
      unavailable: [{ name: 'Reminders', reason: 'owner only' }],
      askerName: 'Kacey',
    });
    expect(text).toContain('NOT AVAILABLE TO KACEY RIGHT NOW');
    expect(text).toContain('- Reminders: owner only');
    expect(text).toContain("say plainly that it isn't available to them and why");
  });

  it('with no tools at all says to answer only', () => {
    const text = buildCapabilityBlock({ offeredTools: [], skills: [], unavailable: [] });
    expect(text).toContain(
      'No tools this turn. Answer from what you know; do not claim an action.',
    );
  });
});
