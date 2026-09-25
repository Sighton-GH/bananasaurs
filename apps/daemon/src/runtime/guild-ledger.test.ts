import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'discord.js';
import { pino } from 'pino';
import { parseConfig, parseGuildId } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { guildRepo } from '@bananasaurs/storage';
import type * as assistantServiceModule from '../assistant/service.js';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';
import { QuotaLedger } from '../assistant/quota-ledger.js';
import { buildGuildRuntime } from './guild.js';
import { createInteractionTokenSealer } from '../assistant/interaction-token.js';

const seen = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('../assistant/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof assistantServiceModule>();
  return {
    ...actual,
    createAssistantService: (...args: unknown[]) => {
      seen.calls.push(args);
      return {
        behavioursForGuild: () => Promise.resolve([]),
        invoke: async (): Promise<never> => {
          throw new Error('unused in this test');
        },
      };
    },
  };
});

/**
 * Task 8 fix round 1, finding 1: the process-wide QuotaLedger must reach
 * every guild's assistant service as the same instance. The services
 * themselves are internal to the runtime, so this captures the
 * `createAssistantService` arguments `buildGuildRuntime` passes and asserts
 * both guilds received the one shared ledger, positionally. Sharing
 * behaviour itself (a key marked exhausted through one service is skipped
 * by the other) is proved in `service.test.ts` with two services on one
 * ledger; this proves the guild wiring hands them that one ledger.
 */

const GUILD_A = parseGuildId('811111111111111111');
const GUILD_B = parseGuildId('822222222222222222');
const BOT = '123456789012345678';
const OWNER = '345678901234567890';
const NOW = 1_700_000_000_000;

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let client: Client;

beforeEach(() => {
  t = openMigratedTestDatabase();
  seen.calls.length = 0;
  client = new Client(buildClientOptions(() => BOT));
});

afterEach(() => {
  t.close();
});

describe('guild runtimes share one QuotaLedger', () => {
  it('hands the same ledger instance to both guilds’ assistant services', () => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    const scopeB = t.scopes.forGuild(GUILD_B);
    guildRepo.upsertGuild(scopeA, { name: 'guild a', now: NOW });
    guildRepo.upsertGuild(scopeB, { name: 'guild b', now: NOW });
    const config = parseConfig({
      DISCORD_BOT_TOKEN: 'NOT.A.REALTOKEN',
      DISCORD_APPLICATION_ID: BOT,
      BANANASAURS_GUILD_ALLOWLIST: `${GUILD_A},${GUILD_B}`,
      BANANASAURS_OWNER_USER_ID: OWNER,
      DASHBOARD_SESSION_SECRET: 'b'.repeat(32),
    });
    const ledger = new QuotaLedger();
    const sealer = createInteractionTokenSealer();
    buildGuildRuntime({
      scope: scopeA,
      instance: t.scopes.instance(),
      config,
      discord: new FakeDiscord({ guildId: GUILD_A, botHighestRolePosition: 100 }),
      client,
      logger,
      now: () => NOW,
      interactionTokenSealer: sealer,
      quotaLedger: ledger,
    });
    buildGuildRuntime({
      scope: scopeB,
      instance: t.scopes.instance(),
      config,
      discord: new FakeDiscord({ guildId: GUILD_B, botHighestRolePosition: 100 }),
      client,
      logger,
      now: () => NOW,
      interactionTokenSealer: sealer,
      quotaLedger: ledger,
    });
    expect(seen.calls).toHaveLength(2);
    // Positional, tenth argument — the defaulted `quotaLedger` parameter.
    expect(seen.calls[0]?.[9]).toBe(ledger);
    expect(seen.calls[1]?.[9]).toBe(ledger);
    // One ledger: a key marked exhausted through guild A's service is
    // skipped by guild B's chain, which reads the same instance.
    const resetAt = NOW + 3_600_000;
    (seen.calls[0]?.[9] as QuotaLedger).markExhausted('key_a', resetAt);
    expect((seen.calls[1]?.[9] as QuotaLedger).exhaustedUntil('key_a', NOW)).toBe(resetAt);
  });
});
