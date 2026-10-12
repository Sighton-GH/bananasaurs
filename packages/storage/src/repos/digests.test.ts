import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { parseGuildId } from '@bananasaurs/core';
import * as schema from '../schema.js';
import { runMigrations } from '../db.js';
import {
  MIGRATIONS_FOLDER,
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '../test-support.js';
import { createScopeFactory } from '../scope.js';
import { guildRepo } from '../index.js';
import { appendTurn, createConversation } from './conversations.js';
import { ensureRun, getRun } from './runs.js';
import {
  deleteDigestsOlderThan,
  getDigest,
  hasDigests,
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
  it('treats LIKE wildcards in the query as literal characters', () => {
    const s = t.scopes.forGuild(G);
    putDigestOnce(s, {
      day: '2026-10-09',
      summary: { daySummary: 'The laser fund is at 100% and code a_b shipped.', memoryProposals: [] },
      conversations: BONDS,
      now: 100,
    });
    putDigestOnce(s, {
      day: '2026-10-08',
      summary: { daySummary: 'The laser fund is at 1000 and code axb shipped.', memoryProposals: [] },
      conversations: BONDS,
      now: 100,
    });
    const channels = { channelIds: ['333333333333333333'] };
    // Unescaped, `%100%%` matches any text containing `100` and `%a_b%`
    // matches `axb`: both digests would hit. Escaped, only the digest whose
    // text holds the literal characters matches.
    expect(searchDigests(s, { query: '100%', ...channels }).map((h) => h.day)).toEqual([
      '2026-10-09',
    ]);
    expect(searchDigests(s, { query: 'a_b', ...channels }).map((h) => h.day)).toEqual([
      '2026-10-09',
    ]);
  });
  it('hasDigests reports guild-scoped digest existence', () => {
    const s = t.scopes.forGuild(G);
    expect(hasDigests(s)).toBe(false);
    putDigestOnce(s, { day: '2026-10-09', summary: SUMMARY, conversations: BONDS, now: 100 });
    expect(hasDigests(s)).toBe(true);
    const other = parseGuildId('222222222222222222');
    guildRepo.upsertGuild(t.scopes.forGuild(other), { name: 'other', now: 1 });
    expect(hasDigests(t.scopes.forGuild(other))).toBe(false);
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

describe('migration 0109 keeps every run and run event', () => {
  it('rebuilds assistant_runs for the daily-digest source without losing rows', () => {
    // Filtered migrations folder, copied from search-keys.test.ts, except it
    // lives inside the repo (never /tmp) and is always removed afterwards.
    const dir = path.join(MIGRATIONS_FOLDER, '..', '.tmp-migrations-0109');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
    const entries = journal.entries.filter((entry) => entry.idx <= 108);
    fs.writeFileSync(
      path.join(dir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    for (const entry of entries)
      fs.copyFileSync(
        path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
        path.join(dir, `${entry.tag}.sql`),
      );

    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    try {
      runMigrations(raw, db, dir);
      raw
        .prepare('INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(G, 'guild', 1, 1);
      raw
        .prepare(
          `INSERT INTO assistant_runs
             (guild_id, run_id, user_id, behaviour_id, source, state, stage, attempt, queued_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(G, 'run-1', '100000000000000001', 'club', 'slash-command', 'answered', 'done', 1, 100, 100);
      const insertEvent = raw.prepare(
        `INSERT INTO assistant_run_events (guild_id, run_id, seq, at, kind, data_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insertEvent.run(G, 'run-1', 0, 100, 'queued', '{}');
      insertEvent.run(G, 'run-1', 1, 101, 'finished', '{}');

      runMigrations(raw, db, MIGRATIONS_FOLDER);

      const scope = createScopeFactory(db, { readonly: false }).forGuild(G);
      expect(getRun(scope, 'run-1')).toMatchObject({ runId: 'run-1', state: 'answered' });
      expect(
        raw
          .prepare(
            'SELECT seq, kind FROM assistant_run_events WHERE guild_id = ? AND run_id = ? ORDER BY seq',
          )
          .all(G, 'run-1'),
      ).toEqual([
        { seq: 0, kind: 'queued' },
        { seq: 1, kind: 'finished' },
      ]);
      // The rebuilt source check now admits the digest job's runs.
      ensureRun(scope, {
        runId: 'digest-2026-10-09',
        userId: '100000000000000001',
        behaviourId: 'default',
        source: 'daily-digest',
        queuedAt: 200,
      });
      expect(getRun(scope, 'digest-2026-10-09')).toMatchObject({ source: 'daily-digest' });
    } finally {
      raw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
