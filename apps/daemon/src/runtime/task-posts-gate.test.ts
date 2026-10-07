import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { guildRepo } from '@bananasaurs/storage';
import { taskPostsEnabledFor } from './task-posts-gate.js';

/**
 * ADR 0131: the per-guild task-posts switch, read live on every nudge pass.
 * Two guilds, the switch on for A only — B must never ride on A's row.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const NOW = 1_700_000_000_000;

let t: ReturnType<typeof openMigratedTestDatabase>;

beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: NOW });
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: NOW });
  guildRepo.setTaskPostsEnabled(t.scopes.forGuild(GUILD_A), true, NOW);
});

afterEach(() => {
  t.close();
});

describe('taskPostsEnabledFor', () => {
  it('is true only for the guild whose switch is on', () => {
    expect(taskPostsEnabledFor(t.scopes.forGuild(GUILD_A), false)).toBe(true);
    expect(taskPostsEnabledFor(t.scopes.forGuild(GUILD_B), false)).toBe(false);
  });

  it('is false for both guilds while dry run is on', () => {
    expect(taskPostsEnabledFor(t.scopes.forGuild(GUILD_A), true)).toBe(false);
    expect(taskPostsEnabledFor(t.scopes.forGuild(GUILD_B), true)).toBe(false);
  });

  it('reads the row live: flipping the switch off takes effect on the next call', () => {
    expect(taskPostsEnabledFor(t.scopes.forGuild(GUILD_A), false)).toBe(true);
    guildRepo.setTaskPostsEnabled(t.scopes.forGuild(GUILD_A), false, NOW + 1);
    expect(taskPostsEnabledFor(t.scopes.forGuild(GUILD_A), false)).toBe(false);
  });
});
