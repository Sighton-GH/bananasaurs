import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { accountRepo, authzRepo, digestRepo, guildRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantDigests } from './assistant-digests.js';

const GUILD = parseGuildId('111111111111111111');
const OTHER_GUILD = parseGuildId('222222222222222222');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const CHANNEL = '333333333333333333';

let t: MigratedTestDatabase;
let deps: HttpDeps;
let app: FastifyInstance;
let clock: number;

const cookieFrom = (header: string | string[] | undefined): string =>
  (Array.isArray(header) ? (header[0] ?? '') : (header ?? '')).split(';')[0] ?? '';
const signIn = async (): Promise<{ cookie: string; csrf: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD, guildId: GUILD },
  });
  return {
    cookie: cookieFrom(response.headers['set-cookie']),
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
};
const grant = (capability: Capability): void =>
  authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD), {
    accountId: ACCOUNT,
    capability,
    grantedBy: 'test',
    now: clock,
  });

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
  };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });
  guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: clock });
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);
  app = createServer({ deps, registerRoutes: registerAssistantDigests });
  digestRepo.putDigestOnce(t.scopes.forGuild(GUILD), {
    day: '2026-10-09',
    summary: { daySummary: 'Talked about the build night.', memoryProposals: [] },
    conversations: [{ conversationId: 'conv-1', channelId: CHANNEL, title: 'Build night' }],
    now: clock,
  });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('assistant digest routes', () => {
  it('requires audit.read for the list and one digest', async () => {
    const { cookie } = await signIn();
    for (const url of ['/api/assistant/digests', '/api/assistant/digests/2026-10-09']) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(403);
    }
  });
  it('lists newest first and reads one digest', async () => {
    digestRepo.putDigestOnce(t.scopes.forGuild(GUILD), {
      day: '2026-10-08',
      summary: { daySummary: 'Talked about the earlier meeting.', memoryProposals: [] },
      conversations: [{ conversationId: 'conv-2', channelId: CHANNEL, title: 'Earlier meeting' }],
      now: clock + 1,
    });
    const { cookie } = await signIn();
    grant('audit.read');
    const list = await app.inject({
      method: 'GET',
      url: '/api/assistant/digests',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ digests: { day: string }[] }>().digests.map((d) => d.day)).toEqual([
      '2026-10-09',
      '2026-10-08',
    ]);
    const one = await app.inject({
      method: 'GET',
      url: '/api/assistant/digests/2026-10-09',
      headers: { cookie },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json<{ digest: { daySummary: string } }>().digest.daySummary).toContain(
      'build night',
    );
  });
  it('404s a missing day, 400s a bad one, and keeps guilds apart', async () => {
    const { cookie } = await signIn();
    grant('audit.read');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/assistant/digests/2026-10-08',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/assistant/digests/today',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(400);
    digestRepo.putDigestOnce(t.scopes.forGuild(OTHER_GUILD), {
      day: '2026-10-09',
      summary: { daySummary: 'Other guild business.', memoryProposals: [] },
      conversations: [{ conversationId: 'conv-9', channelId: CHANNEL, title: 'Other' }],
      now: clock,
    });
    digestRepo.putDigestOnce(t.scopes.forGuild(OTHER_GUILD), {
      day: '2026-10-07',
      summary: { daySummary: 'Other guild only.', memoryProposals: [] },
      conversations: [{ conversationId: 'conv-10', channelId: CHANNEL, title: 'Other day' }],
      now: clock,
    });
    const one = await app.inject({
      method: 'GET',
      url: '/api/assistant/digests/2026-10-09',
      headers: { cookie },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json<{ digest: { daySummary: string } }>().digest.daySummary).toBe(
      'Talked about the build night.',
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/assistant/digests/2026-10-07',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    const list = await app.inject({
      method: 'GET',
      url: '/api/assistant/digests',
      headers: { cookie },
    });
    expect(list.json<{ digests: { day: string }[] }>().digests.map((d) => d.day)).toEqual([
      '2026-10-09',
    ]);
  });
});
