import { describe, expect, it } from 'vitest';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  requireAnyReachableGuild,
  requireReachableGuild,
  type McpPrincipal,
} from './scope.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

const principalWith = (...guilds: readonly GuildId[]): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
});

describe('requireReachableGuild', () => {
  it('obligation 1 (ADR 0044 §4): an empty reachable set refuses even a well-formed guild', () => {
    expect(requireReachableGuild(principalWith(), '111111111111111111')).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
  });

  it('refuses a well-formed guild id outside the reachable set', () => {
    expect(requireReachableGuild(principalWith(GUILD_A), '222222222222222222')).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
  });

  it.each(['not-a-snowflake', '', '1'.repeat(40)])(
    'refuses malformed guild id %j without throwing',
    (bad) => {
      const principal = principalWith(GUILD_A);
      expect(() => requireReachableGuild(principal, bad)).not.toThrow();
      expect(requireReachableGuild(principal, bad)).toEqual({
        ok: false,
        message: GUILD_REFUSAL_MESSAGE,
      });
    },
  );

  it('returns exactly the same message for empty, malformed, and unreachable refusals', () => {
    const outcomes = [
      requireReachableGuild(principalWith(), '111111111111111111'),
      requireReachableGuild(principalWith(GUILD_A), 'not-a-snowflake'),
      requireReachableGuild(principalWith(GUILD_A), '222222222222222222'),
      requireAnyReachableGuild(principalWith()),
    ];
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.message).toBe(GUILD_REFUSAL_MESSAGE);
    }
  });

  it('resolves a guild in the set to ok:true with the parsed GuildId', () => {
    expect(requireReachableGuild(principalWith(GUILD_A, GUILD_B), '222222222222222222')).toEqual(
      {
        ok: true,
        guildId: GUILD_B,
      },
    );
  });

  it('isolates two principals with the same refusal message in both directions', () => {
    expect(requireReachableGuild(principalWith(GUILD_A), '222222222222222222')).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(requireReachableGuild(principalWith(GUILD_B), '111111111111111111')).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
  });
});

describe('requireAnyReachableGuild', () => {
  it('obligation 1 (ADR 0044 §4): an empty reachable set refuses tools that take no guild', () => {
    expect(requireAnyReachableGuild(principalWith())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
  });

  it('succeeds with a non-empty set', () => {
    expect(requireAnyReachableGuild(principalWith(GUILD_A))).toEqual({ ok: true });
  });
});
