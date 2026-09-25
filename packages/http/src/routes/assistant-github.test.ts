import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { accountRepo, assistantRepo, authzRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantGithubRoutes, type GithubRouteClient } from './assistant-github.js';

const GUILD = parseGuildId('111111111111111111');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';

let t: MigratedTestDatabase;
let deps: HttpDeps;
let app: FastifyInstance;
let clock: number;
let enqueued: { resourceId: string; reason: string }[];
let client: FakeClient;

class FakeGitHubError extends Error {
  readonly kind: 'not-found' | 'rate-limited' | 'network' | 'invalid-response';
  readonly resetAt?: number;
  constructor(
    kind: 'not-found' | 'rate-limited' | 'network' | 'invalid-response',
    message: string,
    resetAt?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    if (resetAt !== undefined) this.resetAt = resetAt;
  }
}

interface Summary {
  readonly name: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly fork: boolean;
  readonly archived: boolean;
  readonly private: boolean;
}

const summary = (name: string, over: Partial<Summary> = {}): Summary => ({
  name,
  description: `${name} description`,
  defaultBranch: 'main',
  fork: false,
  archived: false,
  private: false,
  ...over,
});

class FakeClient implements GithubRouteClient {
  authenticated = true;
  orgRepos: Summary[] | Error = [];
  orgTruncated = false;
  repoDetail: unknown = { defaultBranch: 'main', description: null, private: false };
  tree: unknown = { entries: [], truncated: false };
  readonly calls = { listOrgRepos: 0, getRepo: 0, listTree: 0 };

  async listOrgRepos(_owner: string): Promise<{ repos: readonly Summary[]; truncated: boolean }> {
    this.calls.listOrgRepos += 1;
    if (this.orgRepos instanceof Error) throw this.orgRepos;
    return { repos: this.orgRepos, truncated: this.orgTruncated };
  }
  async getRepo(_owner: string, _repo: string) {
    this.calls.getRepo += 1;
    if (this.repoDetail instanceof Error) throw this.repoDetail;
    return this.repoDetail as {
      defaultBranch: string;
      description: string | null;
      private: boolean;
    };
  }
  async listTree(_owner: string, _repo: string, _ref: string) {
    this.calls.listTree += 1;
    if (this.tree instanceof Error) throw this.tree;
    return this.tree as {
      entries: readonly { path: string; type: 'blob' | 'tree'; size?: number }[];
      truncated: boolean;
    };
  }
}

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

const post = (cookie: string, csrf: string, url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: { cookie, [CSRF_HEADER]: csrf }, payload });

const auditRows = () =>
  effectRepo
    .tailAudit(t.scopes.forGuild(GUILD), {})
    .filter((row) => row.action === 'assistant_resource.github_imported');

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  enqueued = [];
  client = new FakeClient();
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
    githubClient: () => client,
    enqueueResourceRefresh: (_scope, resourceId, reason) => {
      enqueued.push({ resourceId, reason });
    },
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
  app = createServer({ deps, registerRoutes: registerAssistantGithubRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('github route permissions', () => {
  it('requires config.write for preview and import', async () => {
    const { cookie, csrf } = await signIn();
    expect(
      (
        await post(cookie, csrf, '/api/assistant/github/preview', {
          url: 'https://github.com/acme',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await post(cookie, csrf, '/api/assistant/github/import', { url: 'https://github.com/acme' }))
        .statusCode,
    ).toBe(403);
  });

  it('answers 503 while no GitHub client is wired', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const bare = createServer({
      deps: { ...deps, githubClient: undefined },
      registerRoutes: registerAssistantGithubRoutes,
    });
    try {
      const response = await bare.inject({
        method: 'POST',
        url: '/api/assistant/github/preview',
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: { url: 'https://github.com/acme' },
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe('POST /api/assistant/github/preview', () => {
  beforeEach(() => grant('config.write'));

  it('previews a repo: target, auth state and the selected file list', async () => {
    const { cookie, csrf } = await signIn();
    client.tree = {
      entries: [
        { path: 'README.md', type: 'blob', size: 120 },
        { path: 'docs/guide.md', type: 'blob', size: 120 },
        { path: 'src/app.js', type: 'blob', size: 120 },
      ],
      truncated: false,
    };
    const response = await post(cookie, csrf, '/api/assistant/github/preview', {
      url: 'https://github.com/acme/widget',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      target: { kind: 'repo', owner: 'acme', repo: 'widget', branch: 'main' },
      authenticated: true,
      files: ['README.md', 'docs/guide.md'],
    });
    expect(client.calls.listTree).toBe(1);
    expect(response.body.toLowerCase()).not.toContain('authorization');
  });

  it('previews a repo without a token: README only, no tree listing', async () => {
    client.authenticated = false;
    const { cookie, csrf } = await signIn();
    const response = await post(cookie, csrf, '/api/assistant/github/preview', {
      url: 'https://github.com/acme/widget',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      target: { kind: 'repo', owner: 'acme', repo: 'widget', branch: 'main' },
      authenticated: false,
      files: ['README.md'],
    });
    expect(client.calls.listTree).toBe(0);
  });

  it('previews an org: public repos with flags, private ones excluded', async () => {
    const { cookie, csrf } = await signIn();
    client.orgRepos = [
      summary('widget', { description: 'Does things' }),
      summary('forked', { fork: true }),
      summary('secret', { private: true }),
    ];
    const response = await post(cookie, csrf, '/api/assistant/github/preview', {
      url: 'https://github.com/acme',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      target: { kind: 'org', owner: 'acme' },
      authenticated: true,
      repos: [
        { name: 'widget', description: 'Does things', fork: false, archived: false },
        { name: 'forked', description: 'forked description', fork: true, archived: false },
      ],
      truncated: false,
    });
  });

  it('marks a truncated org list', async () => {
    const { cookie, csrf } = await signIn();
    client.orgRepos = Array.from({ length: 501 }, (_, i) => summary(`repo-${String(i)}`));
    client.orgTruncated = true;
    const response = await post(cookie, csrf, '/api/assistant/github/preview', {
      url: 'https://github.com/acme',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ repos: unknown[]; truncated: boolean }>();
    expect(body.repos).toHaveLength(500);
    expect(body.truncated).toBe(true);
  });

  it('surfaces a non-truncated client list as truncated false', async () => {
    const { cookie, csrf } = await signIn();
    client.orgRepos = [summary('widget')];
    client.orgTruncated = false;
    const response = await post(cookie, csrf, '/api/assistant/github/preview', {
      url: 'https://github.com/acme',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ truncated: false });
  });

  it('answers 400 not-github for unparseable URLs', async () => {
    const { cookie, csrf } = await signIn();
    for (const url of ['not a url', 'https://example.com/acme']) {
      const response = await post(cookie, csrf, '/api/assistant/github/preview', { url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'not-github' });
    }
    expect(client.calls.listOrgRepos).toBe(0);
    expect(client.calls.getRepo).toBe(0);
  });

  it('maps a missing repo to 404', async () => {
    const { cookie, csrf } = await signIn();
    client.repoDetail = new FakeGitHubError('not-found', 'GitHub returned 404 for this URL.');
    const response = await post(cookie, csrf, '/api/assistant/github/preview', {
      url: 'https://github.com/acme/missing',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not-found' });
  });

  it('maps rate limits to 429 with resetAt', async () => {
    const { cookie, csrf } = await signIn();
    client.orgRepos = new FakeGitHubError(
      'rate-limited',
      'GitHub rate limit reached.',
      1_893_456_000_000,
    );
    const response = await post(cookie, csrf, '/api/assistant/github/preview', {
      url: 'https://github.com/acme',
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: 'rate-limited', resetAt: 1_893_456_000_000 });
  });
});

describe('POST /api/assistant/github/import', () => {
  beforeEach(() => grant('config.write'));

  it('imports an org with selected repos, enqueues a refresh for each, audits counts only', async () => {
    const { cookie, csrf } = await signIn();
    client.orgRepos = [summary('widget'), summary('gadget'), summary('forked', { fork: true })];
    const response = await post(cookie, csrf, '/api/assistant/github/import', {
      url: 'https://github.com/acme',
      repos: ['widget', 'gadget'],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ created: 3 });

    const resources = assistantRepo.listResources(t.scopes.forGuild(GUILD));
    const org = resources.find((r) => r.kind === 'github-org');
    expect(org).toMatchObject({
      id: 'gh-acme',
      title: 'acme',
      url: 'https://github.com/acme',
      enabled: true,
      meta: { owner: 'acme' },
    });
    const children = resources.filter((r) => r.parentId === org?.id);
    expect(children.map((c) => c.title).sort()).toEqual(['acme/gadget', 'acme/widget']);
    expect(children[0]).toMatchObject({
      kind: 'github-repo',
      enabled: true,
      meta: { owner: 'acme', repo: 'gadget', branch: 'main' },
    });
    expect(children[0]?.meta).not.toHaveProperty('autoDiscovered');
    expect(enqueued).toEqual([
      { resourceId: 'gh-acme', reason: 'added' },
      { resourceId: 'gh-acme-widget', reason: 'added' },
      { resourceId: 'gh-acme-gadget', reason: 'added' },
    ]);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.after as string)).toEqual({ kind: 'org', created: 3 });
    const serialised = JSON.stringify(rows[0]);
    expect(serialised).not.toContain('widget');
    expect(serialised).not.toContain('github.com');
    expect(serialised.toLowerCase()).not.toContain('authorization');
    expect(response.body.toLowerCase()).not.toContain('authorization');
  });

  it('stores the forks/archived toggles and the include globs', async () => {
    const { cookie, csrf } = await signIn();
    client.orgRepos = [summary('forked', { fork: true }), summary('old', { archived: true })];
    const response = await post(cookie, csrf, '/api/assistant/github/import', {
      url: 'https://github.com/acme',
      includeForks: true,
      includeArchived: true,
      include: ['docs/**'],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ created: 3 });
    const resources = assistantRepo.listResources(t.scopes.forGuild(GUILD));
    expect(resources.find((r) => r.kind === 'github-org')?.meta).toEqual({
      owner: 'acme',
      includeForks: true,
      includeArchived: true,
    });
    for (const child of resources.filter((r) => r.kind === 'github-repo')) {
      expect(child.meta).toMatchObject({ include: ['docs/**'] });
    }
  });

  it('imports a single repo with the default branch from getRepo', async () => {
    const { cookie, csrf } = await signIn();
    const response = await post(cookie, csrf, '/api/assistant/github/import', {
      url: 'https://github.com/acme/widget',
      include: ['README.md'],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ created: 1 });
    const resources = assistantRepo.listResources(t.scopes.forGuild(GUILD));
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      id: 'gh-acme-widget',
      kind: 'github-repo',
      title: 'acme/widget',
      url: 'https://github.com/acme/widget',
      meta: { owner: 'acme', repo: 'widget', branch: 'main', include: ['README.md'] },
    });
    expect(enqueued).toEqual([{ resourceId: 'gh-acme-widget', reason: 'added' }]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'assistant_resource.github_imported' });
    expect(JSON.parse(rows[0]?.after as string)).toEqual({ kind: 'repo', created: 1 });
  });

  it('answers 400 not-github and creates nothing', async () => {
    const { cookie, csrf } = await signIn();
    const response = await post(cookie, csrf, '/api/assistant/github/import', {
      url: 'https://example.com/acme',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'not-github' });
    expect(assistantRepo.listResources(t.scopes.forGuild(GUILD))).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('maps a missing repo to 404 and a rate limit to 429 with resetAt', async () => {
    const { cookie, csrf } = await signIn();
    client.repoDetail = new FakeGitHubError('not-found', 'GitHub returned 404 for this URL.');
    const missing = await post(cookie, csrf, '/api/assistant/github/import', {
      url: 'https://github.com/acme/missing',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not-found' });

    client.repoDetail = new FakeGitHubError('rate-limited', 'GitHub rate limit reached.');
    const limited = await post(cookie, csrf, '/api/assistant/github/import', {
      url: 'https://github.com/acme/widget',
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate-limited' });
    expect(assistantRepo.listResources(t.scopes.forGuild(GUILD))).toHaveLength(0);
  });

  it('rejects invalid bodies', async () => {
    const { cookie, csrf } = await signIn();
    const response = await post(cookie, csrf, '/api/assistant/github/import', {
      url: 'https://github.com/acme',
      repos: 'widget',
    });
    expect(response.statusCode).toBe(400);
    expect(auditRows()).toHaveLength(0);
  });
});
