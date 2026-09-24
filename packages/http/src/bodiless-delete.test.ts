import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { createServer, type HttpDeps } from './server.js';
import { hashPassword } from './secrets.js';
import { testInstanceFor, testPortsFor } from './test-support.js';
import { registerOpsWriteRoutes } from './routes/ops-write.js';

const GUILD = parseGuildId('111111111111111111');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const CSRF = 'x-bananasaurs-csrf';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const grant = (capabilities: readonly Capability[]): void => {
  const scope = t.scopes.forGuild(GUILD);
  for (const capability of capabilities) {
    authzRepo.grantAccountCapability(scope, {
      accountId: ACCOUNT,
      capability,
      grantedBy: 'test',
      now: clock,
    });
  }
};

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock, { instanceScope: t.scopes.instance() }),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
  };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });

  const instance = t.scopes.instance();
  accountRepo.createAccount(instance, {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);

  app = createServer({ deps, registerRoutes: registerOpsWriteRoutes });
});

afterEach(async () => {
  await app.close();
  t.close();
});

const cookieFrom = (header: string | string[] | undefined): string => {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return raw.split(';')[0] ?? '';
};

const signIn = async (): Promise<{ cookie: string; csrf: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD },
  });
  const body: { csrfToken: string } = response.json();
  return { cookie: cookieFrom(response.headers['set-cookie']), csrf: body.csrfToken };
};

describe('bodiless DELETE with a JSON content-type', () => {
  it('a bodiless DELETE labelled application/json reaches the route', async () => {
    const { cookie, csrf } = await signIn();
    grant(['accounts.manage']);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/accounts/nobody',
      headers: { cookie, [CSRF]: csrf, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(404); // the route ran: no-such-account
    expect(res.json()).toEqual({ error: 'no-such-account' });
  });

  it('a Fastify 4xx is not flattened to 500', async () => {
    const { cookie, csrf } = await signIn();
    grant(['accounts.manage']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/reauth',
      headers: { cookie, [CSRF]: csrf, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('FST_ERR_CTP_INVALID_JSON_BODY');
  });
});
