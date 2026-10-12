import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'discord.js';
import { pino } from 'pino';
import { parseConfig, parseGuildId } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { guildRepo } from '@bananasaurs/storage';
import type * as assistantServiceModule from '../assistant/service.js';
import type * as assistantJobModule from '../jobs/assistant.js';
import type * as resourceFetcherModule from '../assistant/resource-fetcher.js';
import type { InstanceSettingsStore } from '../settings/instance-settings-store.js';
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

const invokeDeps = vi.hoisted(() => ({ seen: [] as unknown[] }));

vi.mock('../jobs/assistant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof assistantJobModule>();
  return {
    ...actual,
    assistantInvokeHandler: (deps: Parameters<typeof actual.assistantInvokeHandler>[0]) => {
      invokeDeps.seen.push(deps);
      return actual.assistantInvokeHandler(deps);
    },
  };
});

// The real ReviewedResourceFetcher class runs in production wiring; only the
// network edges (DNS and the pinned HTTPS request) are test doubles, so no
// socket opens. Production passes neither, so the doubles apply by default.
const net = vi.hoisted(() => ({
  resolved: [] as string[],
  requested: [] as string[],
  timeouts: [] as number[],
  respond: undefined as
    | undefined
    | ((url: URL) => {
        status: number;
        headers: Record<string, string>;
        chunks: Uint8Array[];
      }),
}));

vi.mock('../assistant/resource-fetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof resourceFetcherModule>();
  class DoubledFetcher extends actual.ReviewedResourceFetcher {
    constructor(options: ConstructorParameters<typeof actual.ReviewedResourceFetcher>[0] = {}) {
      super({
        ...options,
        resolve: (host) => {
          net.resolved.push(host);
          return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
        },
        request: (url, _address, timeoutMs) => {
          net.requested.push(url.href);
          net.timeouts.push(timeoutMs);
          const r = net.respond?.(url) ?? { status: 404, headers: {}, chunks: [] };
          return Promise.resolve({
            status: r.status,
            headers: r.headers,
            body: (async function* () {
              await Promise.resolve();
              yield* r.chunks;
            })(),
          });
        },
      });
    }
  }
  return { ...actual, ReviewedResourceFetcher: DoubledFetcher };
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
  invokeDeps.seen.length = 0;
  net.resolved.length = 0;
  net.requested.length = 0;
  net.timeouts.length = 0;
  net.respond = undefined;
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

const ATTACHMENT_KEYS = [
  'assistant.attachments.textMaxBytes',
  'assistant.attachments.textMaxChars',
  'assistant.attachments.textMaxCount',
  'assistant.attachments.imageMaxBytes',
  'assistant.attachments.imageMaxCount',
  'assistant.attachments.pdfMaxBytes',
  'assistant.attachments.pdfMaxCount',
] as const;

type InvokeDeps = {
  fetchAttachmentBytes?: (
    url: string,
    maxBytes: number,
  ) => Promise<{ ok: true; bytes: Uint8Array; mediaType: string } | { ok: false; code: string }>;
  attachmentCaps?: () => Record<string, number>;
};

const buildWithSettings = (
  values: Record<string, number>,
  requested: string[] = [],
): InvokeDeps => {
  const scopeA = t.scopes.forGuild(GUILD_A);
  guildRepo.upsertGuild(scopeA, { name: 'guild a', now: NOW });
  const settings = {
    get: ((key: string) => {
      requested.push(key);
      return values[key];
    }) as InstanceSettingsStore['get'],
    set: () => {
      throw new Error('not used in this test');
    },
    reset: () => {
      throw new Error('not used in this test');
    },
  } as InstanceSettingsStore;
  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'NOT.A.REALTOKEN',
    DISCORD_APPLICATION_ID: BOT,
    BANANASAURS_GUILD_ALLOWLIST: `${GUILD_A}`,
    BANANASAURS_OWNER_USER_ID: OWNER,
    DASHBOARD_SESSION_SECRET: 'b'.repeat(32),
  });
  invokeDeps.seen.length = 0;
  buildGuildRuntime({
    scope: scopeA,
    instance: t.scopes.instance(),
    config,
    discord: new FakeDiscord({ guildId: GUILD_A, botHighestRolePosition: 100 }),
    client,
    logger,
    now: () => NOW,
    interactionTokenSealer: createInteractionTokenSealer(),
    instanceSettings: settings,
  });
  return invokeDeps.seen[0] as InvokeDeps;
};

const DEFAULT_VALUES: Record<string, number> = {
  'assistant.attachments.textMaxBytes': 262_144,
  'assistant.attachments.textMaxChars': 24_000,
  'assistant.attachments.textMaxCount': 3,
  'assistant.attachments.imageMaxBytes': 5_242_880,
  'assistant.attachments.imageMaxCount': 4,
  'assistant.attachments.pdfMaxBytes': 10_485_760,
  'assistant.attachments.pdfMaxCount': 2,
  'resources.fetchTimeoutMs': 5_000,
};

describe('guild runtime wires attachment fetching (ADR 0149)', () => {
  it('passes a CDN-pinned byte fetcher and live caps to the invoke handler', async () => {
    const requested: string[] = [];
    const deps = buildWithSettings(DEFAULT_VALUES, requested);
    expect(typeof deps.fetchAttachmentBytes).toBe('function');
    expect(typeof deps.attachmentCaps).toBe('function');
    expect(deps.attachmentCaps?.()).toEqual({
      textMaxBytes: 262_144,
      textMaxChars: 24_000,
      textMaxCount: 3,
      imageMaxBytes: 5_242_880,
      imageMaxCount: 4,
      pdfMaxBytes: 10_485_760,
      pdfMaxCount: 2,
    });
    for (const key of ATTACHMENT_KEYS) expect(requested).toContain(key);
    const refused = await deps.fetchAttachmentBytes?.('https://evil.example/x.png', 1_024);
    expect(refused?.ok).toBe(false);
    expect(net.resolved).toEqual([]);
    expect(net.requested).toEqual([]);
  });

  it('reads caps live: a changed setting shows on the next call, no restart', () => {
    const values = { ...DEFAULT_VALUES };
    const deps = buildWithSettings(values);
    expect(deps.attachmentCaps?.().imageMaxCount).toBe(4);
    values['assistant.attachments.imageMaxCount'] = 0;
    values['assistant.attachments.pdfMaxBytes'] = 1_000;
    values['assistant.attachments.textMaxChars'] = 500;
    const after = deps.attachmentCaps?.();
    expect(after?.imageMaxCount).toBe(0);
    expect(after?.pdfMaxBytes).toBe(1_000);
    expect(after?.textMaxChars).toBe(500);
  });

  it('runs the real fetcher transport: CDN host fetched, byte cap enforced per call', async () => {
    const deps = buildWithSettings(DEFAULT_VALUES);
    net.respond = () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      chunks: [new Uint8Array([1, 2, 3, 4])],
    });
    const ok = await deps.fetchAttachmentBytes?.('https://cdn.discordapp.com/a/1/x.png?ex=1', 100);
    expect(ok?.ok).toBe(true);
    expect(ok?.ok ? Array.from(ok.bytes) : []).toEqual([1, 2, 3, 4]);
    expect(ok?.ok ? ok.mediaType : '').toBe('image/png');
    expect(net.resolved).toEqual(['cdn.discordapp.com']);
    const media = await deps.fetchAttachmentBytes?.('https://media.discordapp.net/a/1/x.png', 100);
    expect(media?.ok).toBe(true);
    // The cap the job passes in is the cap the fetcher enforces.
    const small = await deps.fetchAttachmentBytes?.('https://cdn.discordapp.com/a/1/x.png', 3);
    expect(small).toEqual({ ok: false, code: 'too-large' });
  });

  it('refuses a cross-host redirect, an off-host URL and a non-443 port before any request', async () => {
    const deps = buildWithSettings(DEFAULT_VALUES);
    net.respond = (url) =>
      url.hostname === 'cdn.discordapp.com'
        ? { status: 302, headers: { location: 'https://media.discordapp.net/a.png' }, chunks: [] }
        : { status: 200, headers: { 'content-type': 'image/png' }, chunks: [new Uint8Array([1])] };
    // Even another allowlisted host is refused as a redirect target.
    const hop = await deps.fetchAttachmentBytes?.('https://cdn.discordapp.com/a/1/x.png', 100);
    expect(hop).toEqual({ ok: false, code: 'redirect' });
    expect(net.requested).toEqual(['https://cdn.discordapp.com/a/1/x.png']);
    net.respond = () => ({
      status: 302,
      headers: { location: 'https://evil.example/x.png' },
      chunks: [],
    });
    expect(await deps.fetchAttachmentBytes?.('https://cdn.discordapp.com/b.png', 100)).toEqual({
      ok: false,
      code: 'redirect',
    });
    net.requested.length = 0;
    net.resolved.length = 0;
    const port = await deps.fetchAttachmentBytes?.('https://cdn.discordapp.com:8443/c.png', 100);
    expect(port?.ok).toBe(false);
    const http = await deps.fetchAttachmentBytes?.('http://cdn.discordapp.com/d.png', 100);
    expect(http?.ok).toBe(false);
    const other = await deps.fetchAttachmentBytes?.(
      'https://cdn.discordapp.com.evil.example/e.png',
      100,
    );
    expect(other?.ok).toBe(false);
    expect(net.resolved).toEqual([]);
    expect(net.requested).toEqual([]);
  });
});

describe('attachment fetch timeout is live through the runtime', () => {
  it('passes the current resources.fetchTimeoutMs to the transport on each call', async () => {
    const values = { ...DEFAULT_VALUES };
    const deps = buildWithSettings(values);
    net.respond = () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      chunks: [new Uint8Array([1])],
    });
    await deps.fetchAttachmentBytes?.('https://cdn.discordapp.com/a/1/x.png', 100);
    values['resources.fetchTimeoutMs'] = 12_000;
    await deps.fetchAttachmentBytes?.('https://cdn.discordapp.com/a/1/x.png', 100);
    expect(net.timeouts).toEqual([5_000, 12_000]);
  });
});
