import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'discord.js';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { CSRF_HEADER, hashPassword } from '@bananasaurs/http';
import { FakeDiscord } from '@bananasaurs/testkit';
import { testInstanceFor, testPortsFor } from '../../../../packages/http/src/test-support.js';
import { createProviderConfigStore } from '../assistant/provider-config.js';
import { buildDashboardApp } from './wiring.js';

/**
 * The provider store through the production composition (`buildDashboardApp`),
 * not `createServer` directly: the 2026-09-23 audit found `buildDashboardApp`
 * rebuilt its deps field by field and dropped the store, so every dashboard
 * save answered 503 while the route tests — which inject the store into
 * `createServer` — stayed green.
 */
const GUILD = parseGuildId('111111111111111111');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
let t: MigratedTestDatabase;
let app: FastifyInstance;
let dir: string;
const clock = 1_700_000_000_000;

beforeEach(async () => {
  t = openMigratedTestDatabase();
  dir = mkdtempSync(path.join(tmpdir(), 'bananasaurs-provider-'));
  writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'g', now: clock });
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);
  for (const capability of ['config.read', 'config.write'] as const)
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD), {
      accountId: ACCOUNT,
      capability,
      grantedBy: 'test',
      now: clock,
    });
  app = buildDashboardApp({
    scopes: t.scopes,
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    now: () => clock,
    guildIds: [GUILD],
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
    distDir: dir,
    client: new Client(buildClientOptions(() => '123456789012345678')),
    discord: new FakeDiscord({ guildId: GUILD }),
    assistantProviderConfig: createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32), 'file'),
  });
});
afterEach(async () => {
  await app.close();
  t.close();
  rmSync(dir, { recursive: true, force: true });
});

it('saves the provider through the production app and reads it back without the key', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD, guildId: GUILD },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const csrf = login.json<{ csrfToken: string }>().csrfToken;
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/assistant/provider',
    headers: { cookie, [CSRF_HEADER]: csrf },
    payload: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'raw-key-never-echoed',
      enabled: true,
      costClass: 'free',
    },
  });
  expect(saved.statusCode).toBe(200);
  const read = await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } });
  expect(read.json<{ aiStatus: unknown }>().aiStatus).toMatchObject({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    enabled: true,
    keyConfigured: true,
    keyReadable: true,
    costClass: 'free',
    secretSource: 'file',
  });
  expect(read.body + saved.body).not.toContain('raw-key-never-echoed');
  const audit = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {});
  const row = audit.find((r) => r.action === 'assistant_provider.saved');
  expect(row).toBeDefined();
  expect(JSON.stringify(audit)).not.toContain('raw-key-never-echoed');
  const after: unknown = typeof row?.after === 'string' ? JSON.parse(row.after) : row?.after;
  expect(after).toMatchObject({ provider: 'gemini', costClass: 'free', keyReplaced: true });
});
