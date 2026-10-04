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
import { accountRepo, authzRepo, guildRepo, jobRepo } from '@bananasaurs/storage';
import { JOB_KINDS, parseGuildId } from '@bananasaurs/core';
import { CSRF_HEADER, hashPassword } from '@bananasaurs/http';
import { FakeDiscord } from '@bananasaurs/testkit';
import { testInstanceFor, testPortsFor } from '../../../../packages/http/src/test-support.js';
import { createProviderConfigStore } from '../assistant/provider-config.js';
import { buildDashboardApp } from './wiring.js';

/**
 * The `added` resource refresh through the production composition
 * (`buildDashboardApp`), not `createServer` directly: ADR 0127 says the
 * `added` enqueue deliberately carries no `oncePerBucket` — a second save
 * after the first job finished must enqueue again, because the job re-reads
 * the resource row at run time. Only a repository-level contrast test
 * guards that; this is the caller-level proof that fails if someone adds
 * `oncePerBucket` to the `added` enqueue in `wiring.ts`.
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
  dir = mkdtempSync(path.join(tmpdir(), 'bananasaurs-resource-refresh-'));
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

it('saving a resource again after its refresh job finished enqueues a second added job', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD, guildId: GUILD },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const csrf = login.json<{ csrfToken: string }>().csrfToken;
  const headers = { cookie, [CSRF_HEADER]: csrf };
  const payload = {
    id: 'res-1',
    title: 'A resource',
    url: 'https://example.com/guide',
    kind: 'website',
    enabled: true,
    reviewedAt: new Date(0).toISOString(),
  };

  expect(
    (await app.inject({ method: 'PUT', url: '/api/assistant/resources/res-1', headers, payload }))
      .statusCode,
  ).toBe(200);

  const scope = t.scopes.forGuild(GUILD);
  const claimed = jobRepo.claimNext(scope, clock);
  expect(claimed?.kind).toBe(JOB_KINDS.resourceRefresh);
  jobRepo.completeJob(scope, claimed?.jobId ?? -1, clock);

  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/assistant/resources/res-1',
        headers,
        payload: { ...payload, title: 'Edited title' },
      })
    ).statusCode,
  ).toBe(200);

  const refreshes = jobRepo
    .listJobs(scope, {})
    .filter((job) => job.kind === JOB_KINDS.resourceRefresh);
  expect(refreshes).toHaveLength(2);
  for (const job of refreshes) expect(job.dedupeKey).toBe('resource_refresh:res-1:added');
});
