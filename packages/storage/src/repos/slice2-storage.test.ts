import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, type Reminder } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { guildRepo } from '../index.js';
import { getReminder, insertReminder } from './assistant.js';
import { findEligibility } from './provider-eligibility.js';
import { addSearchKey, listSearchKeys } from './search-keys.js';

const G = parseGuildId('234567890123456789');
const NOW = 1_800_000_000_000;

let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(G), { name: 'guild', now: 1 });
});
afterEach(() => t.close());

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'rem_style_1',
  guildId: G,
  creatorId: '456789012345678901',
  destinationId: '111111111111111111',
  text: 'Evening post',
  dueAt: NOW + 3_600_000,
  createdAt: NOW,
  status: 'scheduled',
  dedupeKey: 'style:1',
  mentions: { userIds: [], roleIds: [], everyone: false, here: false },
  deliveredCount: 0,
  ...over,
});

describe('Slice 2 storage (ADR 0145, 0147)', () => {
  it('round-trips a message-style reminder and defaults old rows to reminder', () => {
    const scope = t.scopes.forGuild(G);
    expect(insertReminder(scope, reminder({ id: 'a', style: 'message' }))).toBe('created');
    expect(insertReminder(scope, reminder({ id: 'b', dedupeKey: 'style:2' }))).toBe('created');
    expect(getReminder(scope, 'a')?.style).toBe('message');
    expect(getReminder(scope, 'b')?.style).toBe('reminder');
  });
  it('stores a parallel search key and lists it under its source', () => {
    const scope = t.scopes.instance();
    const keyId = addSearchKey(scope, {
      source: 'parallel',
      label: 'Parallel key',
      apiKeyEnc: 'sealed-parallel',
      monthlyLimit: 4500,
      dailyLimit: null,
      now: NOW,
    });
    expect(listSearchKeys(scope).find((k) => k.keyId === keyId)?.source).toBe('parallel');
  });
  it('refuses an unknown reminder style', () => {
    const scope = t.scopes.forGuild(G);
    expect(() =>
      insertReminder(scope, reminder({ id: 'c', style: 'banner' as unknown as 'reminder' })),
    ).toThrow(/unexpected reminder style/);
  });
  it('accepts parallel in the provider config CHECK and rejects an unknown source', () => {
    t.raw
      .prepare("INSERT INTO assistant_provider_config (config_id, updated_at) VALUES ('active', 1)")
      .run();
    t.raw.prepare("UPDATE assistant_provider_config SET search_source = 'parallel'").run();
    expect(t.raw.prepare('SELECT search_source AS s FROM assistant_provider_config').get()).toEqual(
      { s: 'parallel' },
    );
    expect(() =>
      t.raw.prepare("UPDATE assistant_provider_config SET search_source = 'bad'").run(),
    ).toThrow();
  });
  it('seeds the parallel provider-eligibility row as may-train', () => {
    expect(findEligibility(t.scopes.instance(), 'parallel')).toMatchObject({
      trainsOnInput: 'yes',
    });
  });
});
