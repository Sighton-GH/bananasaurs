import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getLiveBuffer, parseGuildId, type Capability } from '@bananasaurs/core';
import { accountRepo, authzRepo, guildRepo, runRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantRunRoutes } from './assistant-runs.js';

const GUILD = parseGuildId('111111111111111111');
const OTHER_GUILD = parseGuildId('222222222222222222');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const MEMBER = '100000000000000001';
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

const seedRun = (
  runId: string,
  over: {
    state?: 'queued' | 'running' | 'retry-wait' | 'answered' | 'refused' | 'failed';
    stage?: string;
    queuedAt?: number;
    updatedAt?: number;
  } = {},
): void => {
  const scope = t.scopes.forGuild(GUILD);
  const queuedAt = over.queuedAt ?? clock;
  runRepo.ensureRun(scope, {
    runId,
    userId: MEMBER,
    behaviourId: 'club',
    source: 'mention',
    queuedAt,
  });
  const patch: Record<string, unknown> = { updatedAt: over.updatedAt ?? queuedAt };
  if (over.state !== undefined) patch['state'] = over.state;
  if (over.stage !== undefined) patch['stage'] = over.stage;
  if (Object.keys(patch).length > 1 || over.state !== undefined || over.stage !== undefined) {
    runRepo.updateRun(scope, runId, patch as unknown as { updatedAt: number });
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
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
  };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);
  app = createServer({ deps, registerRoutes: registerAssistantRunRoutes });
});
afterEach(async () => {
  for (const runId of ['run-1', 'run-2', 'run-other', 'no-such-run']) getLiveBuffer().drop(runId);
  await app.close();
  t.close();
});

describe('assistant run routes', () => {
  it('requires audit.read for the list, the detail and the events', async () => {
    const { cookie } = await signIn();
    for (const url of [
      '/api/assistant/runs',
      '/api/assistant/runs/run-1',
      '/api/assistant/runs/run-1/events',
    ]) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(403);
    }
  });

  it('serves live answer and thinking with config.read for an in-guild run', async () => {
    const { cookie } = await signIn();
    grant('audit.read');
    seedRun('run-1');
    grant('config.read');
    getLiveBuffer().append('run-1', 'hello Sam L', 'why this answer');
    const ok = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-1/live',
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ answer: 'hello Sam L', thinking: 'why this answer' });
  });

  it('marks live text as never cached', async () => {
    const { cookie } = await signIn();
    grant('audit.read');
    seedRun('run-1');
    getLiveBuffer().append('run-1', 'hello Sam L', 'why this answer');
    const ok = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-1/live',
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('withholds live thinking without config.read while returning the answer', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    seedRun('run-1');
    const thinkingText = 'Private thinking for Sam L';
    getLiveBuffer().append('run-1', 'hello Sam L', thinkingText);
    const without = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-1/live',
      headers: { cookie },
    });
    expect(without.statusCode).toBe(200);
    expect(without.body).not.toContain(thinkingText);
    expect(without.json()).toEqual({ answer: 'hello Sam L', thinking: '' });

    grant('config.read');
    const withGrant = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-1/live',
      headers: { cookie },
    });
    expect(withGrant.statusCode).toBe(200);
    expect(withGrant.body).toContain(thinkingText);
    expect(withGrant.json()).toEqual({ answer: 'hello Sam L', thinking: thinkingText });
  });

  it('live text needs audit.read before checking whether the run exists', async () => {
    const { cookie } = await signIn();
    seedRun('run-2');
    getLiveBuffer().append('run-2', 'hello', 'private thinking');
    for (const runId of ['run-2', 'no-such-run']) {
      const denied = await app.inject({
        method: 'GET',
        url: `/api/assistant/runs/${runId}/live`,
        headers: { cookie },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('private thinking');
    }
  });

  it('live text requires a signed-in session', async () => {
    seedRun('run-1');
    getLiveBuffer().append('run-1', 'hello', 'private thinking');
    const denied = await app.inject({ method: 'GET', url: '/api/assistant/runs/run-1/live' });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain('private thinking');
  });

  it('hides live text belonging to a run in another guild', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: clock });
    runRepo.ensureRun(t.scopes.forGuild(OTHER_GUILD), {
      runId: 'run-other',
      userId: MEMBER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: clock,
    });
    getLiveBuffer().append('run-other', 'other guild answer', 'other guild thinking');
    const other = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-other/live',
      headers: { cookie },
    });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ error: 'not-found' });
    expect(other.body).not.toContain('other guild');
  });

  it('answers 404 for an unknown run even if live text exists', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    getLiveBuffer().append('no-such-run', 'orphan answer', 'orphan thinking');
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/no-such-run/live',
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: 'not-found' });
    expect(unknown.body).not.toContain('orphan');
  });

  it('returns empty live sides before streaming and after drop', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    seedRun('run-1');
    for (const dropped of [false, true]) {
      if (dropped) {
        getLiveBuffer().append('run-1', 'answer', 'thinking');
        getLiveBuffer().drop('run-1');
      }
      const response = await app.inject({
        method: 'GET',
        url: '/api/assistant/runs/run-1/live',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ answer: '', thinking: '' });
    }
  });

  it('lists only active runs with ?active=1 and drops a run answered after updateRun', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    seedRun('run-queued', { state: 'queued', stage: 'queued', queuedAt: clock });
    seedRun('run-running', { state: 'running', stage: 'starting', queuedAt: clock + 1 });
    seedRun('run-retry', { state: 'retry-wait', stage: 'retry-wait', queuedAt: clock + 2 });
    seedRun('run-done', { state: 'answered', stage: 'done', queuedAt: clock + 3 });
    const active = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs?active=1',
      headers: { cookie },
    });
    expect(active.statusCode).toBe(200);
    const ids = active.json<{ runs: { runId: string }[] }>().runs.map((r) => r.runId);
    expect(ids).toContain('run-queued');
    expect(ids).toContain('run-running');
    expect(ids).toContain('run-retry');
    expect(ids).not.toContain('run-done');

    runRepo.updateRun(t.scopes.forGuild(GUILD), 'run-running', {
      state: 'answered',
      stage: 'done',
      updatedAt: clock + 10,
    });
    const after = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs?active=1',
      headers: { cookie },
    });
    expect(after.json<{ runs: { runId: string }[] }>().runs.map((r) => r.runId)).not.toContain(
      'run-running',
    );
  });

  it('labels the later of two queued runs as Queued (1 ahead)', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    seedRun('run-early', { state: 'queued', stage: 'queued', queuedAt: clock });
    seedRun('run-late', {
      state: 'queued',
      stage: 'queued',
      queuedAt: clock + 1000,
      updatedAt: clock + 1000,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs?active=1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const runs = response.json<{ runs: { runId: string; label: string }[] }>().runs;
    expect(runs.find((r) => r.runId === 'run-late')?.label).toBe('Queued (1 ahead)');
    expect(runs.find((r) => r.runId === 'run-early')?.label).toBe('Queued');
  });

  it('labels a running model-call run as Asking with position and count', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-model',
      userId: MEMBER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: clock,
    });
    runRepo.updateRun(scope, 'run-model', {
      state: 'running',
      stage: 'calling-model',
      updatedAt: clock,
    });
    runRepo.appendRunEvent(scope, 'run-model', clock, {
      kind: 'model-call',
      position: 0,
      of: 2,
      provider: 'openrouter',
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      keyId: 'key-1',
      round: 0,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-model',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ run: { label: string } }>().run.label).toBe(
      'Asking nemotron-3-ultra-550b-a55b:free (model 1 of 2)',
    );
  });

  it('returns only events after the given sequence number', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-seq',
      userId: MEMBER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: clock,
    });
    runRepo.appendRunEvent(scope, 'run-seq', clock, { kind: 'queued', via: 'mention' });
    runRepo.appendRunEvent(scope, 'run-seq', clock, {
      kind: 'started',
      attempt: 1,
      queueWaitMs: 5,
    });
    runRepo.appendRunEvent(scope, 'run-seq', clock, {
      kind: 'tool-call',
      round: 0,
      tool: 'search_messages',
    });
    runRepo.appendRunEvent(scope, 'run-seq', clock, {
      kind: 'tool-result',
      round: 0,
      tool: 'search_messages',
      ok: true,
      ms: 3,
      resultChars: 10,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-seq/events?after=2',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ events: { seq: number }[] }>().events.map((e) => e.seq)).toEqual([3, 4]);
  });

  it('strips providerMessage without config.read and keeps it with the grant', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    runRepo.ensureRun(scope, {
      runId: 'run-secret',
      userId: MEMBER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: clock,
    });
    runRepo.appendRunEvent(scope, 'run-secret', clock, {
      kind: 'model-result',
      provider: 'openrouter',
      model: 'm',
      keyId: 'key-1',
      ok: false,
      ms: 5,
      providerMessage: 'no endpoints for model',
    });
    const without = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-secret/events',
      headers: { cookie },
    });
    expect(without.statusCode).toBe(200);
    expect(JSON.stringify(without.json())).not.toContain('providerMessage');

    grant('config.read');
    const withGrant = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-secret/events',
      headers: { cookie },
    });
    expect(withGrant.statusCode).toBe(200);
    expect(
      withGrant.json<{ events: { event: { providerMessage?: string } }[] }>().events[0]?.event
        .providerMessage,
    ).toBe('no endpoints for model');
  });

  it('answers 404 for a run seeded in another guild', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: clock });
    runRepo.ensureRun(t.scopes.forGuild(OTHER_GUILD), {
      runId: 'run-other',
      userId: MEMBER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: clock,
    });
    const detail = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-other',
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ error: 'not-found' });
    const events = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/run-other/events',
      headers: { cookie },
    });
    expect(events.statusCode).toBe(404);
  });

  it('answers 400 for a bad query', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs?limit=0',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for an unknown run id', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/runs/nope',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not-found' });
  });
});
