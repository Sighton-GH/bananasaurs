import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { guildRepo } from '../index.js';
import { appendTurn, createConversation } from './conversations.js';
import {
  deleteDigestsOlderThan,
  getDigest,
  listDigests,
  putDigestOnce,
  searchDigests,
  turnsForDay,
} from './digests.js';

let t: MigratedTestDatabase;
const G = parseGuildId('111111111111111111');
beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(G), { name: 'guild', now: 1 });
});
afterEach(() => t.close());

const SUMMARY = { daySummary: 'Talked about the build night.', memoryProposals: [] };
const BONDS = [{ conversationId: 'conv-1', channelId: '333333333333333333', title: 'Build night' }];

describe('digest store (ADR 0150 decision 4)', () => {
  it('writes once per guild and day; a replay is a duplicate', () => {
    const s = t.scopes.forGuild(G);
    expect(
      putDigestOnce(s, { day: '2026-10-09', summary: SUMMARY, conversations: BONDS, now: 100 }),
    ).toBe('created');
    expect(
      putDigestOnce(s, { day: '2026-10-09', summary: SUMMARY, conversations: BONDS, now: 200 }),
    ).toBe('duplicate');
    expect(getDigest(s, '2026-10-09')).toMatchObject({ day: '2026-10-09' });
    expect(getDigest(s, '2026-10-08')).toBeUndefined();
  });
  it('is guild-scoped: another guild writes the same day', () => {
    const other = parseGuildId('222222222222222222');
    guildRepo.upsertGuild(t.scopes.forGuild(other), { name: 'other', now: 1 });
    const s = t.scopes.forGuild(G);
    putDigestOnce(s, { day: '2026-10-09', summary: SUMMARY, conversations: BONDS, now: 100 });
    expect(
      putDigestOnce(t.scopes.forGuild(other), {
        day: '2026-10-09',
        summary: SUMMARY,
        conversations: BONDS,
        now: 100,
      }),
    ).toBe('created');
    expect(listDigests(s, 10).map((d) => d.day)).toEqual(['2026-10-09']);
  });
  it('deletes rows older than the retention cutoff day', () => {
    const s = t.scopes.forGuild(G);
    putDigestOnce(s, { day: '2026-10-01', summary: SUMMARY, conversations: BONDS, now: 100 });
    putDigestOnce(s, { day: '2026-10-09', summary: SUMMARY, conversations: BONDS, now: 100 });
    expect(deleteDigestsOlderThan(s, '2026-10-09')).toBe(1);
    expect(listDigests(s, 10).map((d) => d.day)).toEqual(['2026-10-09']);
  });
  it('reads the day turns grouped by conversation', () => {
    const s = t.scopes.forGuild(G);
    createConversation(s, {
      conversationId: 'conv-1',
      channelId: '333333333333333333',
      behaviourId: 'club',
      startedBy: '100000000000000001',
      title: 'Build night',
      source: 'discord',
      at: 1_790_000_000_000,
    });
    appendTurn(s, {
      conversationId: 'conv-1',
      turnId: 't1',
      at: 1_790_000_001_000,
      role: 'user',
      authorId: '100000000000000001',
      authorName: 'Sam L',
      text: 'When is build night?',
    });
    appendTurn(s, {
      conversationId: 'conv-1',
      turnId: 't2',
      at: 1_790_000_002_000,
      role: 'assistant',
      authorName: 'Bananasaurs',
      text: 'Friday.',
    });
    const groups = turnsForDay(s, 1_790_000_000_000, 1_790_100_000_000);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.turns.map((x) => x.turnId)).toEqual(['t1', 't2']);
    expect(turnsForDay(s, 1_790_100_000_000, 1_790_200_000_000)).toEqual([]);
  });
  it('searches digests but only through the given channels', () => {
    const s = t.scopes.forGuild(G);
    putDigestOnce(s, {
      day: '2026-10-09',
      summary: { daySummary: 'Talked about the build night parade.', memoryProposals: [] },
      conversations: BONDS,
      now: 100,
    });
    expect(
      searchDigests(s, { query: 'build night', channelIds: ['333333333333333333'], limit: 5 }),
    ).toHaveLength(1);
    expect(
      searchDigests(s, { query: 'build night', channelIds: ['444444444444444444'], limit: 5 }),
    ).toEqual([]);
    expect(
      searchDigests(s, { query: 'xylophone', channelIds: ['333333333333333333'], limit: 5 }),
    ).toEqual([]);
  });
  it('excludes a mixed-channel digest unless every covered channel is allowed', () => {
    const s = t.scopes.forGuild(G);
    putDigestOnce(s, {
      day: '2026-10-09',
      summary: SUMMARY,
      conversations: [
        ...BONDS,
        { conversationId: 'conv-2', channelId: '444444444444444444', title: 'Private build night' },
      ],
      now: 100,
    });
    expect(searchDigests(s, { query: 'build night', channelIds: ['333333333333333333'] })).toEqual(
      [],
    );
    expect(searchDigests(s, { query: 'build night', channelIds: ['444444444444444444'] })).toEqual(
      [],
    );
    expect(
      searchDigests(s, {
        query: 'build night',
        channelIds: ['333333333333333333', '444444444444444444'],
      }),
    ).toHaveLength(1);
  });
  it('excludes unknown coverage and an empty caller channel set', () => {
    const s = t.scopes.forGuild(G);
    putDigestOnce(s, { day: '2026-10-09', summary: SUMMARY, conversations: [], now: 100 });
    expect(searchDigests(s, { query: 'build night', channelIds: ['333333333333333333'] })).toEqual(
      [],
    );
    putDigestOnce(s, { day: '2026-10-08', summary: SUMMARY, conversations: BONDS, now: 100 });
    expect(searchDigests(s, { query: 'build night', channelIds: [] })).toEqual([]);
  });

  it('fails closed for malformed persisted JSON and incomplete coverage', () => {
    const s = t.scopes.forGuild(G);
    putDigestOnce(s, { day: '2026-10-09', summary: SUMMARY, conversations: BONDS, now: 100 });
    const update = t.raw.prepare(
      'UPDATE assistant_daily_digests SET summary_json = ? WHERE guild_id = ? AND day = ?',
    );
    for (const value of [
      'null',
      '{',
      JSON.stringify({ summary: SUMMARY, conversations: [null] }),
      JSON.stringify({
        summary: SUMMARY,
        conversations: [{ conversationId: 'conv-1', title: 'Build night' }],
      }),
      JSON.stringify({
        summary: SUMMARY,
        conversations: [...BONDS, { conversationId: 'conv-2', channelId: '', title: 'Private' }],
      }),
      JSON.stringify(SUMMARY),
    ]) {
      update.run(value, G, '2026-10-09');
      expect(() => getDigest(s, '2026-10-09')).not.toThrow();
      expect(
        searchDigests(s, { query: 'build night', channelIds: ['333333333333333333'] }),
      ).toEqual([]);
    }
  });
  it('keeps reads, search and retention within the caller guild', () => {
    const other = parseGuildId('222222222222222222');
    const s = t.scopes.forGuild(G);
    const o = t.scopes.forGuild(other);
    guildRepo.upsertGuild(o, { name: 'other', now: 1 });
    putDigestOnce(o, { day: '2026-10-01', summary: SUMMARY, conversations: BONDS, now: 100 });
    expect(getDigest(s, '2026-10-01')).toBeUndefined();
    expect(listDigests(s, 10)).toEqual([]);
    expect(searchDigests(s, { query: 'build night', channelIds: ['333333333333333333'] })).toEqual(
      [],
    );
    expect(deleteDigestsOlderThan(s, '2026-10-09')).toBe(0);
    expect(getDigest(o, '2026-10-01')).toBeDefined();
  });
});
