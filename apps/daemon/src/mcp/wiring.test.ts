import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ChannelType, Client, Collection, type Guild, type GuildMember } from 'discord.js';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  accountRepo,
  archiveRepo,
  authzRepo,
  effectRepo,
  guildRepo,
  jobRepo,
  loggingRepo,
  mcpSendRepo,
  roleRepo,
} from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { createServer, generateToken, hashPassword } from '@bananasaurs/http';
import {
  ARCHIVE_NO_TEXT_MARKER,
  ARCHIVE_PURGED_MARKER,
  GUILD_REFUSAL_MESSAGE,
} from '@bananasaurs/mcp';
import { buildDashboardApp, type DashboardAppDeps } from '../http/wiring.js';
import { registerMcpRoutes } from './wiring.js';
import { FakeDiscord } from '@bananasaurs/testkit';
import { testInstanceFor, testPortsFor } from '../../../../packages/http/src/test-support.js';

/**
 * Task 3, daemon side: `/mcp` through the real `buildDashboardApp` wiring —
 * the same `createServer` call, the same `registerRoutes` callback and the
 * same static-asset registration production uses. Per ruling M4-D7 the
 * bearer guard is called by the daemon, so the 401 proof has to live here
 * rather than in `packages/mcp`'s own tests.
 *
 * `testPortsFor`/`testInstanceFor` come in by relative path rather than the
 * `@bananasaurs/http/test-support` subpath: vitest aliases
 * `@bananasaurs/http` to the package index, so the subpath would resolve
 * under it and break. `@bananasaurs/mcp` likewise resolves through the
 * vitest source alias (see vitest.config.ts), so this test reads the
 * package's source, never its built `dist`.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PUBLIC_URL = 'https://bot.test';
const REDIRECT = 'https://client.test/cb';
/** Hard-coded, not imported: this test must not import its own oracle. */
const CHALLENGE = `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`;

let t: MigratedTestDatabase;
let clock: number;
let deps: DashboardAppDeps;
let fakeDiscord: FakeDiscord;
let app: FastifyInstance;
let dir: string;

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  trace() {},
} as never;

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;

  dir = mkdtempSync(path.join(tmpdir(), 'bananasaurs-mcp-'));
  writeFileSync(path.join(dir, 'index.html'), '<html>spa shell</html>');

  deps = {
    scopes: t.scopes,
    logger: silentLogger,
    now: () => clock,
    guildIds: [GUILD_A, GUILD_B],
    readonly: false,
    mcpPublicUrl: PUBLIC_URL,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
    distDir: dir,
    // A client that never logged in, like `ops/wiring.test.ts`: enough for
    // every test that does not exercise guild tools, which build their own
    // client with guilds injected below.
    client: new Client(buildClientOptions(() => '123456789012345678')),
    // The Discord REST port behind `send_message` (ruling M5-D11): the fake
    // the composed send tests assert against, rebuilt per test like the app.
    discord: (fakeDiscord = new FakeDiscord({ guildId: GUILD_A })),
  };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: clock });
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: clock });

  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD_A), ACCOUNT);
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD_B), ACCOUNT);
  // Seeded with `mcp.authorize` in guild A only.
  authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
    accountId: ACCOUNT,
    capability: 'mcp.authorize',
    grantedBy: 'test',
    now: clock,
  });

  app = buildDashboardApp(deps);
});

afterEach(async () => {
  await app.close();
  t.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Re-implemented here so the test does not import its own oracle. */
const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'utf8').digest('base64url');

const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

const formBody = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

const authorizeQuery = (over: Record<string, string> = {}): string => {
  const params = new URLSearchParams({
    client_id: '',
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: '',
    code_challenge_method: 'S256',
    scope: 'bananasaurs:read',
    state: 'st-1',
    ...over,
  });
  return `/oauth/authorize?${params.toString()}`;
};

const hiddenInput = (html: string, name: string): string => {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no hidden input ${name} in consent page`);
  return match[1];
};

/** A real token through the full flow: register, authorize, approve, exchange. */
const mintToken = async (
  scope = 'bananasaurs:read',
  target: FastifyInstance = app,
): Promise<string> => {
  const registered = await target.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'test client', redirect_uris: [REDIRECT] },
  });
  expect(registered.statusCode).toBe(201);
  const clientId = registered.json<{ client_id: string }>().client_id;

  const verifier = generateToken();
  const page = await target.inject({
    method: 'GET',
    url: authorizeQuery({ client_id: clientId, code_challenge: s256(verifier), scope }),
  });
  expect(page.statusCode).toBe(200);
  const approval = await target.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: formHeaders,
    payload: formBody({
      requestId: hiddenInput(page.body, 'requestId'),
      nonce: hiddenInput(page.body, 'nonce'),
      username: 'owner',
      password: PASSWORD,
      decision: 'approve',
    }),
  });
  expect(approval.statusCode).toBe(302);
  const location = approval.headers.location;
  if (typeof location !== 'string') throw new Error('approve did not redirect');
  const code = new URL(location).searchParams.get('code');
  if (code === null) throw new Error('redirect carried no code');

  const exchanged = await target.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: formHeaders,
    payload: formBody({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
  expect(exchanged.statusCode).toBe(200);
  return exchanged.json<{ access_token: string }>().access_token;
};

const mcpPost = (target: FastifyInstance, body: unknown, accessToken: string | undefined) =>
  target.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
    },
    payload: JSON.stringify(body),
  });

/** Every `data:` frame of an SSE response body, parsed. */
const sseData = (body: string): unknown[] =>
  body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);

const toolsList = (accessToken: string | undefined) =>
  mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, accessToken);

describe('/mcp behind the bearer guard', () => {
  it('answers a missing header with 401 and the RFC 9728 challenge', async () => {
    const response = await app.inject({ method: 'POST', url: '/mcp' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(CHALLENGE);
    expect(response.json()).toEqual({ error: 'invalid_token' });
  });

  it('builds no per-guild health snapshot for a request that does not ask for one', async () => {
    // `healthPortFor` runs a `portsFor` and four port reads for every guild
    // in the caller's reachable set. The daemon builds one port per request,
    // before it knows which tool the request will call, so anything eager in
    // there is paid for by `tools/list`, by `search_messages`, and by a
    // token holding no read scope at all — which registers no tools and can
    // never reach `get_health`. The port's `gateway()` and `guilds()` are
    // therefore calls, not values, and this is what says so.
    let portsForCalls = 0;
    const counted = buildDashboardApp({
      ...deps,
      portsFor: (scope) => {
        portsForCalls += 1;
        return testPortsFor(scope, () => clock);
      },
    });
    try {
      const accessToken = await mintToken('bananasaurs:read', counted);

      const listed = await mcpPost(
        counted,
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        accessToken,
      );
      expect(listed.statusCode).toBe(200);
      expect(portsForCalls).toBe(0);

      // And the same port does still produce the report when asked, so this
      // is laziness and not a tool that quietly stopped reading anything.
      const health = await mcpPost(
        counted,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_health', arguments: {} },
        },
        accessToken,
      );
      expect(health.statusCode).toBe(200);
      expect(portsForCalls).toBeGreaterThan(0);
    } finally {
      await counted.close();
    }
  });

  it('answers a valid read-scope token with tools/list containing all sixteen tools', async () => {
    const accessToken = await mintToken();
    const response = await toolsList(accessToken);
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = bodies[0] as { result?: { tools?: Array<{ name: string }> } };
    const names = result.result?.tools?.map((tool) => tool.name);
    expect(names).toHaveLength(16);
    expect(names).toEqual([
      'get_health',
      'search_messages',
      'read_channel_history',
      'get_message',
      'list_channels',
      'list_threads',
      'list_roles',
      'list_members',
      'list_mod_cases',
      'get_mod_case',
      'list_audit_events',
      'get_server_overview',
      'list_jobs',
      'get_job',
      'get_member',
      'search_members',
    ]);
    expect(names).not.toContain('send_message');
  });

  it('(M6) a read-scope token calling send_message answers -32602 and never reaches the port', async () => {
    // Through the real composition with a real minted read-scope token:
    // `send_message` never registers without the send scope, so the call
    // fails as unknown-tool before any port exists to reach. Pinned here
    // because the probe verified it but no test held it.
    const accessToken = await mintToken();
    const response = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'send_message',
          arguments: {
            guildId: '111111111111111111',
            channelId: '444444444444444444',
            content: 'm6-probe-content',
            idempotencyKey: 'm6-k1',
          },
        },
      },
      accessToken,
    );
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    // The transport surfaces the unknown tool as an isError result whose
    // text carries the -32602 code — not as a top-level JSON-RPC error
    // frame — and the send port is never reached.
    const result = (bodies[0] as { result?: { isError?: boolean; content?: unknown } }).result;
    expect(result?.isError).toBe(true);
    const blocks = result?.content as ReadonlyArray<{ type: string; text: string }> | undefined;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.text).toContain('-32602');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('(ruling M4-D17) a send-only token minted through the real OAuth flow sees send_message and nothing else', async () => {
    // Through the real authorize/consent/exchange flow, not a hand-built
    // principal: this defect is invisible to a test that constructs the
    // principal itself, which is the exact shape of the three "works in
    // tests, broken in the daemon" defects this slice already found.
    //
    // Since M5 Task 4 the daemon always threads the real send port (ruling
    // M5-D11), so a send-scoped token lists exactly `send_message` — the
    // eleven read tools stay behind the read scope it does not carry.
    const accessToken = await mintToken('bananasaurs:send');
    const response = await toolsList(accessToken);
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = bodies[0] as { result?: { tools?: Array<{ name: string }> } };
    expect(result.result?.tools?.map((tool) => tool.name)).toEqual(['send_message']);
  });

  it('(ruling M4-D17) a send-only token sees no overview resource either', async () => {
    const accessToken = await mintToken('bananasaurs:send');
    const response = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 3, method: 'resources/templates/list', params: {} },
      accessToken,
    );
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    const frame = bodies[0] as { error?: { code?: number; message?: string } };
    expect(frame.error?.code).toBe(-32601);
  });

  it('advertises the overview resource template and nothing else', async () => {
    const accessToken = await mintToken();
    const response = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 3, method: 'resources/templates/list', params: {} },
      accessToken,
    );
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    expect(JSON.stringify(bodies[0])).toContain('bananasaurs://guild/{guildId}/overview');
    const result = bodies[0] as { result?: { resourceTemplates?: unknown[] } };
    expect(result.result?.resourceTemplates).toHaveLength(1);
  });

  it('(ADR 0044 obligation 1) refuses get_health once mcp.authorize is revoked everywhere', async () => {
    const accessToken = await mintToken();
    // The token stays valid; the grant goes away, so `reachableGuilds` comes
    // back empty on the next request — the same construction
    // `bearer.test.ts`'s PR-92 test uses.
    authzRepo.revokeAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
    });
    const response = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_health' } },
      accessToken,
    );
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = (bodies[0] as { result?: { isError?: boolean; content?: unknown } }).result;
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.content)).toContain(GUILD_REFUSAL_MESSAGE);
  });
});

/**
 * Slice M5 Task 4, daemon side: `send_message` through the real stack —
 * Fastify + `registerMcpRoutes` + `createMcpServer` + the real `sendPortFor`
 * over the real repositories and the fake Discord port — with tokens minted
 * through the real OAuth flow.
 *
 * What this proves that a unit test could not: that the daemon actually
 * threads the port (ruling M5-D11) rather than a test supplying it by hand,
 * that a non-allowlisted channel is refused with no Discord call, that the
 * idempotency key survives the trip, and that the audit row lands with the
 * channel and never the content.
 *
 * Setup reaches past `buildDashboardApp` in two places, both the same kind
 * of seeding the archive tests already do: the allowlist row (written the
 * way `bananasaurs mcp allow-channel` writes it, through the same
 * repository — there is no operator-socket path in this app to drive
 * instead) and dry-run off (guilds default to dry-run on, under which a
 * send records without ever calling Discord). Neither is behaviour under
 * test.
 */
describe('/mcp send_message through the real composition', () => {
  const CHANNEL = '444444444444444444';
  const OTHER_CHANNEL = '455555555555555555';
  const CATEGORY = '466666666666666666';
  const THREAD = '488888888888888888';
  const PRIVATE_THREAD = '499999999999999999';
  /** Allowlisted but in no guild's channel cache: the stale-row shape C2 is about. */
  const OUTSIDE_CHANNEL = '477777777777777777';
  /** Distinctive text: must reach Discord, must never reach the audit row. */
  const CONTENT = 'picnic-probe-send-content-that-must-never-reach-audit-zz9';

  interface SendDiscordInternals {
    guilds: { _add: (data: object) => Guild };
  }

  /**
   * The send-time guild check reads the live client's cache, so the composed
   * app's client needs guild A with its channels — injected the way the guild
   * tools tests below inject theirs. `OTHER_CHANNEL` stays unallowlisted on
   * purpose: its refusal still comes from the allowlist, not the cache.
   */
  const seedSendGuild = (): void => {
    const internals = deps.client as unknown as SendDiscordInternals;
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CATEGORY,
          guild_id: GUILD_A,
          type: ChannelType.GuildCategory,
          name: 'category',
          position: 0,
          permission_overwrites: [],
        },
        {
          id: CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 0,
          permission_overwrites: [],
          parent_id: CATEGORY,
        },
        {
          id: THREAD,
          guild_id: GUILD_A,
          parent_id: CHANNEL,
          owner_id: ACCOUNT,
          type: ChannelType.PublicThread,
          name: 'public-thread',
          position: 0,
          permission_overwrites: [],
          thread_metadata: {
            archived: false,
            auto_archive_duration: 60,
            archive_timestamp: new Date().toISOString(),
            locked: false,
          },
        },
        {
          id: PRIVATE_THREAD,
          guild_id: GUILD_A,
          parent_id: CHANNEL,
          owner_id: ACCOUNT,
          type: ChannelType.PrivateThread,
          name: 'private-thread',
          position: 0,
          permission_overwrites: [],
          thread_metadata: {
            archived: false,
            auto_archive_duration: 60,
            archive_timestamp: new Date().toISOString(),
            locked: false,
            invitable: true,
          },
        },
        {
          id: OTHER_CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'lounge',
          position: 1,
          permission_overwrites: [],
        },
      ],
      roles: [],
      members: [],
      emojis: [],
      unavailable: false,
    });
  };

  const allow = (): void => {
    seedSendGuild();
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: CHANNEL,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
  };

  const sendCall = (accessToken: string, args: Record<string, unknown>) =>
    mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_message', arguments: args },
      },
      accessToken,
    );

  const callText = (
    body: string,
  ): { readonly isError: boolean | undefined; readonly text: string } => {
    const bodies = sseData(body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = (bodies[0] as { result?: { isError?: boolean; content?: unknown } }).result;
    const blocks = result?.content as ReadonlyArray<{ type: string; text: string }> | undefined;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.type).toBe('text');
    return { isError: result?.isError, text: blocks?.[0]?.text ?? '' };
  };

  const sendArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guildId: '111111111111111111',
    channelId: CHANNEL,
    content: CONTENT,
    idempotencyKey: 'send-k1',
    ...over,
  });

  it('an allowlisted channel sends exactly once, with mentions suppressed', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');

    const found = callText((await sendCall(accessToken, sendArgs())).body);
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('Sent message');
    expect(found.text).toContain(CHANNEL);

    // Exactly one Discord call, carrying the forced-empty mentions: nothing
    // else in the tree sets `allowedMentions`, so absent would mean Discord's
    // default of parsing everything, including @everyone.
    const calls = fakeDiscord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe(GUILD_A);
    expect(calls[0]?.args[1]).toBe(CHANNEL);
    expect(calls[0]?.args[2]).toEqual({ content: CONTENT, allowedMentions: { parse: [] } });

    // The ledger row lands with the Discord message id.
    const row = mcpSendRepo.findSend(t.scopes.forGuild(GUILD_A), 'send-k1');
    expect(row?.outcome).toBe('sent');
    expect(row?.channelId).toBe(CHANNEL);
    expect(row?.messageId).toBeDefined();

    // The audit row carries the channel, the credential and the outcome —
    // never the content (rule 4).
    const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 });
    const audit = trail.find((entry) => entry.action === 'mcp.message.sent');
    expect(audit).toBeDefined();
    expect(audit?.actorType).toBe('mcp_operator');
    // Ruling M5-D10: `via` is the transport — this call arrived over HTTP on
    // the dashboard's own Fastify app — and `actor_type` is the identity.
    expect(audit?.via).toBe('http');
    expect(audit?.subjectType).toBe('channel');
    expect(audit?.subjectId).toBe(CHANNEL);
    const after = JSON.parse(audit?.after ?? '{}') as Record<string, unknown>;
    expect(after['outcome']).toBe('sent');
    expect(after['clientId']).toMatch(/^cli_/);
    expect(after['tokenId']).toMatch(/^tok_/);
    expect(audit?.actorId).toBe(after['tokenId']);
    // The absence assertion, not only the presence one.
    expect(JSON.stringify(trail)).not.toContain(CONTENT);
  });

  it('a public thread inherits its parent and audits the derived grant', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (await sendCall(accessToken, sendArgs({ channelId: THREAD, idempotencyKey: 'thread-send' })))
        .body,
    );
    expect(found.isError).not.toBe(true);
    expect(fakeDiscord.restCalls('sendMessage')[0]?.args[1]).toBe(THREAD);
    const audit = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 })
      .find((entry) => entry.action === 'mcp.message.sent');
    const after = JSON.parse(audit?.after ?? '{}') as Record<string, unknown>;
    expect(after['authorization']).toBe('derived');
    expect(after['grantedByChannelId']).toBe(CHANNEL);
  });

  it('a channel inherits an allowlisted category', async () => {
    seedSendGuild();
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: CATEGORY,
      scopeKind: 'category',
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (await sendCall(accessToken, sendArgs({ idempotencyKey: 'category-send' }))).body,
    );
    expect(found.isError).not.toBe(true);
  });

  it('a private thread never inherits its parent', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');
    const refused = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ channelId: PRIVATE_THREAD, idempotencyKey: 'private-send' }),
        )
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('private thread');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('an excluded allowlisted channel is refused and Discord is never called', async () => {
    allow();
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD_A), CHANNEL);
    const accessToken = await mintToken('bananasaurs:send');
    const refused = callText(
      (await sendCall(accessToken, sendArgs({ idempotencyKey: 'excluded-send' }))).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('not on the send allowlist');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
    expect(mcpSendRepo.findSend(t.scopes.forGuild(GUILD_A), 'excluded-send')).toBeUndefined();
  });

  it('a non-allowlisted channel is refused and Discord is never called', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');

    const refused = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ channelId: OTHER_CHANNEL, idempotencyKey: 'send-k2' }),
        )
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('not on the send allowlist');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
    expect(mcpSendRepo.findSend(t.scopes.forGuild(GUILD_A), 'send-k2')).toBeUndefined();
  });

  it('the same idempotency key twice sends once and answers the second as a replay', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');

    const first = callText((await sendCall(accessToken, sendArgs())).body);
    expect(first.isError).not.toBe(true);
    const second = callText((await sendCall(accessToken, sendArgs())).body);
    expect(second.isError).not.toBe(true);
    expect(second.text).toContain('Already sent under this idempotency key');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('an allowlisted row outside the guild is refused and Discord is never called (C2 send-time)', async () => {
    // The stale-row shape: a row written before allow-time validation (or by
    // a future path) for a channel in no guild's cache. The gateway refuses
    // with its own reason and the model hears the not-in-guild text — never
    // the allowlist text, which would point the operator at `mcp
    // allow-channel`, a command that refuses the same id — and the Discord
    // port is never reached.
    allow();
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: OUTSIDE_CHANNEL,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    const accessToken = await mintToken('bananasaurs:send');

    const refused = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ channelId: OUTSIDE_CHANNEL, idempotencyKey: 'send-outside' }),
        )
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("is not a channel this guild's bot can see");
    expect(refused.text).toContain('will not help');
    expect(refused.text).not.toContain('not on the send allowlist');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
    expect(mcpSendRepo.findSend(t.scopes.forGuild(GUILD_A), 'send-outside')).toBeUndefined();
  });
});

/**
 * Ruling M4-D18, daemon side: a repository fault behind a port leaves one
 * error log line with allowlisted fields only. The tool layer answers the
 * shared refusal and swallows the throw, and the route's `catch` only fires
 * on a transport fault — so without the port's own line the operator has no
 * trace to contradict a "guild unknown or unreachable" report.
 *
 * The fault is a dropped FTS table: rows remain while the index is gone,
 * which is the stale-after-restore shape from the brief, and
 * `archive-search.ts` rethrows `no such table` rather than answering empty.
 */
describe('a repository fault behind an mcp port leaves an operator trace', () => {
  const CHANNEL = '555555555555555555';
  const MEMBER = '666666666666666666';
  const MESSAGE = '777777777777777777';
  /** Distinctive member-written text: must appear nowhere in the log output. */
  const SECRET_CONTENT = 'picnic-probe-content-that-must-never-reach-logs-zz9';

  it('search_messages on a missing FTS index refuses, and logs once with allowlisted fields only', async () => {
    const captured: Array<{ readonly fields: unknown; readonly msg: string }> = [];
    const captureLogger = {
      info() {},
      warn() {},
      error(fields: unknown, msg: string) {
        captured.push({ fields, msg });
      },
      debug() {},
      fatal() {},
      trace() {},
    } as never;
    const logApp = buildDashboardApp({ ...deps, logger: captureLogger });
    try {
      const accessToken = await mintToken('bananasaurs:read', logApp);
      archiveRepo.enableChannel(t.scopes.forGuild(GUILD_A), {
        channelId: CHANNEL,
        attachmentPolicy: 'none',
        now: clock,
      });
      archiveRepo.upsertMessage(t.scopes.forGuild(GUILD_A), {
        messageId: MESSAGE,
        channelId: CHANNEL,
        authorId: MEMBER,
        content: SECRET_CONTENT,
        createdAt: clock,
        editedAt: undefined,
        attachments: [],
      });
      // The index is gone while the rows remain.
      t.raw.exec('DROP TABLE archive_messages_fts');

      const response = await mcpPost(
        logApp,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_messages',
            arguments: { guildId: '111111111111111111', query: 'picnic' },
          },
        },
        accessToken,
      );
      expect(response.statusCode).toBe(200);
      const bodies = sseData(response.body);
      expect(bodies.length).toBeGreaterThan(0);
      const result = (bodies[0] as { result?: { isError?: boolean; content?: unknown } }).result;
      const blocks = result?.content as ReadonlyArray<{ type: string; text: string }> | undefined;
      // The caller still gets the shared refusal, never the fault.
      expect(result?.isError).toBe(true);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0]?.text).toBe(GUILD_REFUSAL_MESSAGE);

      // ...but the operator gets exactly one error line naming the port
      // method, carrying the store's message and nothing else.
      const portLines = captured.filter((line) => line.msg === 'mcp port failed');
      expect(portLines).toHaveLength(1);
      const fields = portLines[0]?.fields as Record<string, unknown>;
      expect(fields['component']).toBe('mcp');
      expect(fields['reason']).toBe('searchMessages');
      expect(typeof fields['err']).toBe('string');
      expect(fields['err']).toContain('no such table');
      // The absence assertion, not only the presence one: no message content,
      // no token value, anywhere in what the logger received.
      const dump = JSON.stringify(captured);
      expect(dump).not.toContain(SECRET_CONTENT);
      expect(dump).not.toContain(accessToken);
      expect(dump).not.toContain(MEMBER);
    } finally {
      await logApp.close();
    }
  });
});

/**
 * Task 4b, daemon side: the two-guild test through the real stack. An account
 * reaching guilds A and B searches B and sees only B's rows; a guild the bot
 * is not in is a refusal, not an empty result — an empty result says "nothing
 * matched", a refusal says "not yours", and conflating them leaks whether a
 * guild has content.
 */
describe('/mcp archive tools across two guilds', () => {
  const GUILD_C = parseGuildId('333333333333333333');
  const CHANNEL = '555555555555555555';
  const MEMBER = '666666666666666666';
  const MESSAGE_A = '777777777777777777';
  const MESSAGE_B = '888888888888888888';

  const seedArchive = (): void => {
    for (const guild of [GUILD_A, GUILD_B] as const) {
      archiveRepo.enableChannel(t.scopes.forGuild(guild), {
        channelId: CHANNEL,
        attachmentPolicy: 'none',
        now: clock,
      });
    }
    archiveRepo.upsertMessage(t.scopes.forGuild(GUILD_A), {
      messageId: MESSAGE_A,
      channelId: CHANNEL,
      authorId: MEMBER,
      content: 'alpha plans for the guild A picnic',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(t.scopes.forGuild(GUILD_B), {
      messageId: MESSAGE_B,
      channelId: CHANNEL,
      authorId: MEMBER,
      content: 'beta plans for the guild B picnic',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
  };

  const mcpCall = (accessToken: string, name: string, args: Record<string, unknown>) =>
    mcpPost(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      accessToken,
    );

  const callText = (
    body: string,
  ): { readonly isError: boolean | undefined; readonly text: string } => {
    const bodies = sseData(body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = (bodies[0] as { result?: { isError?: boolean; content?: unknown } }).result;
    const blocks = result?.content as ReadonlyArray<{ type: string; text: string }> | undefined;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.type).toBe('text');
    return { isError: result?.isError, text: blocks?.[0]?.text ?? '' };
  };

  it('search_messages for guild B returns only guild B rows', async () => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_B), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    seedArchive();
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'search_messages', {
          guildId: '222222222222222222',
          query: 'picnic',
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('beta plans');
    expect(found.text).not.toContain('alpha plans');

    // Same channel id, other guild's row is invisible even by exact query.
    const cross = callText(
      (
        await mcpCall(accessToken, 'search_messages', {
          guildId: '222222222222222222',
          query: 'alpha',
        })
      ).body,
    );
    expect(cross.isError).not.toBe(true);
    expect(cross.text).toContain('0 matches');

    // get_message is guild-partitioned too: A's id through B is not-found,
    // answered plainly — never A's content.
    const missing = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '222222222222222222',
          messageId: MESSAGE_A,
        })
      ).body,
    );
    expect(missing.isError).not.toBe(true);
    expect(missing.text).not.toContain('alpha plans');

    // read_channel_history for B's channel shows B's row only.
    const history = callText(
      (
        await mcpCall(accessToken, 'read_channel_history', {
          guildId: '222222222222222222',
          channelId: CHANNEL,
        })
      ).body,
    );
    expect(history.isError).not.toBe(true);
    expect(history.text).toContain('beta plans');
    expect(history.text).not.toContain('alpha plans');
  });

  it(`read_channel_history with authorId 'bot' returns only the bot's messages`, async () => {
    // Through the real composition: the tool maps 'bot' to the live client's
    // user id, and the repository narrows to that author. Seeded the way the
    // neighbouring tests seed — through the storage repo, never a fake port.
    const BOT = '999999999999999999';
    // The client is shared by the whole file: restore the previous user so
    // later tests do not depend on this one having run first.
    const sharedClient = deps.client as unknown as { user: { id: string } | null };
    const prevUser = sharedClient.user;
    sharedClient.user = { id: BOT };
    try {
    const scope = t.scopes.forGuild(GUILD_A);
    archiveRepo.enableChannel(scope, {
      channelId: CHANNEL,
      attachmentPolicy: 'none',
      now: clock,
    });
    archiveRepo.upsertMessage(scope, {
      messageId: '711111111111111111',
      channelId: CHANNEL,
      authorId: BOT,
      content: 'bot says alpha picnic reminder',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scope, {
      messageId: '722222222222222222',
      channelId: CHANNEL,
      authorId: MEMBER,
      content: 'member says alpha picnic plans',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    const accessToken = await mintToken();

    const botOnly = callText(
      (
        await mcpCall(accessToken, 'read_channel_history', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          authorId: 'bot',
        })
      ).body,
    );
    expect(botOnly.isError).not.toBe(true);
    expect(botOnly.text).toContain('bot says alpha picnic reminder');
    expect(botOnly.text).not.toContain('member says alpha picnic plans');

    // Without the author filter both messages read back.
    const all = callText(
      (
        await mcpCall(accessToken, 'read_channel_history', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
        })
      ).body,
    );
    expect(all.isError).not.toBe(true);
    expect(all.text).toContain('bot says alpha picnic reminder');
    expect(all.text).toContain('member says alpha picnic plans');
    } finally {
      sharedClient.user = prevUser;
    }
  });

  it("read_channel_history rolls a forum's posts up under the forum id (M1)", async () => {
    const FORUM = '599999999999999999';
    const POST_A = '911111111111111111';
    const POST_B = '922222222222222222';
    (deps.client as unknown as { guilds: { _add: (data: object) => unknown } }).guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: FORUM,
          guild_id: GUILD_A,
          type: ChannelType.GuildForum,
          name: 'forum',
          position: 0,
          permission_overwrites: [],
        },
      ],
      roles: [{ id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false }],
      members: [],
      emojis: [],
      unavailable: false,
    });
    const scopeA = t.scopes.forGuild(GUILD_A);
    archiveRepo.enableChannel(scopeA, { channelId: FORUM, attachmentPolicy: 'none', now: clock });
    archiveRepo.upsertMessage(scopeA, {
      messageId: POST_A,
      channelId: FORUM,
      threadId: '933333333333333333',
      authorId: MEMBER,
      content: 'forum post alpha',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scopeA, {
      messageId: POST_B,
      channelId: FORUM,
      threadId: '944444444444444444',
      authorId: MEMBER,
      content: 'forum post beta',
      createdAt: clock + 1,
      editedAt: undefined,
      attachments: [],
    });
    const accessToken = await mintToken();
    const found = callText(
      (
        await mcpCall(accessToken, 'read_channel_history', {
          guildId: '111111111111111111',
          channelId: FORUM,
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('forum post alpha');
    expect(found.text).toContain('forum post beta');
  });

  it('a guild the bot is not in is a refusal, never an empty result', async () => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_B), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    seedArchive();
    const accessToken = await mintToken();

    const refused = callText(
      (
        await mcpCall(accessToken, 'search_messages', {
          guildId: GUILD_C,
          query: 'picnic',
        })
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(GUILD_REFUSAL_MESSAGE);

    // The distinction the test exists for: a reachable guild with no match
    // answers ok with a count, not a refusal.
    const empty = callText(
      (
        await mcpCall(accessToken, 'search_messages', {
          guildId: '222222222222222222',
          query: 'zucchini-no-match-anywhere',
        })
      ).body,
    );
    expect(empty.isError).not.toBe(true);
    expect(empty.text).toContain('0 matches');
    expect(empty.text).not.toBe(GUILD_REFUSAL_MESSAGE);
  });

  it('(ruling M4-D8) a really-purged message is a tombstone, an attachment-only one is not', async () => {
    // Through the real repository, not a fake port. Both markers depend on
    // `contentPurgedAt !== undefined`, and both rows carry `content: null` —
    // so the only thing separating "purged under retention" from "never had
    // text" is that `archiveRepo`'s row constructor normalises SQL `null` to
    // `undefined`. The fix-wave tail put a projection between that
    // constructor and the renderer (`toMcpArchiveMessage` in `wiring.ts`),
    // and a `null` surviving it would label every attachment-only message as
    // purged. Nothing else on the branch crosses that boundary with a real
    // row, which is why this test drives the daemon rather than a stub.
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_B), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    seedArchive();
    const scope = t.scopes.forGuild(GUILD_B);

    // An attachment-only message: content null from the start, never purged.
    const ATTACHMENT_ONLY = '333333333333333333';
    archiveRepo.upsertMessage(scope, {
      messageId: ATTACHMENT_ONLY,
      channelId: CHANNEL,
      authorId: MEMBER,
      content: undefined,
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });

    // MESSAGE_B, purged for real: deleted, then past the default retention
    // window, then `expireContent` — the same path the retention job runs.
    expect(archiveRepo.recordDelete(scope, { messageId: MESSAGE_B, deletedAt: clock })).toBe(
      'recorded',
    );
    const afterRetention = clock + archiveRepo.ARCHIVE_DEFAULT_RETENTION_MS + 1;
    expect(archiveRepo.expireContent(scope, afterRetention)).toBe(1);

    const accessToken = await mintToken();

    const purged = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '222222222222222222',
          messageId: MESSAGE_B,
        })
      ).body,
    );
    expect(purged.isError).not.toBe(true);
    expect(purged.text).toContain(ARCHIVE_PURGED_MARKER);
    expect(purged.text).not.toContain(ARCHIVE_NO_TEXT_MARKER);
    // The content is gone, not merely unlabelled.
    expect(purged.text).not.toContain('beta plans');

    const noText = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '222222222222222222',
          messageId: ATTACHMENT_ONLY,
        })
      ).body,
    );
    expect(noText.isError).not.toBe(true);
    expect(noText.text).toContain(ARCHIVE_NO_TEXT_MARKER);
    expect(noText.text).not.toContain(ARCHIVE_PURGED_MARKER);
  });
});

describe('/mcp jobs tools across two guilds', () => {
  const mcpCall = (accessToken: string, name: string, args: Record<string, unknown>) =>
    mcpPost(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      accessToken,
    );

  const callText = (
    body: string,
  ): { readonly isError: boolean | undefined; readonly text: string } => {
    const bodies = sseData(body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = (bodies[0] as { result?: { isError?: boolean; content?: unknown } }).result;
    const blocks = result?.content as ReadonlyArray<{ type: string; text: string }> | undefined;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.type).toBe('text');
    return { isError: result?.isError, text: blocks?.[0]?.text ?? '' };
  };

  /** One failed job per guild through the real ops ports, returning both ids. */
  const seedFailedJobs = (): { readonly jobA: number; readonly jobB: number } => {
    const enqueuedA = jobRepo.enqueue(t.scopes.forGuild(GUILD_A), {
      kind: 'reconcile_guild',
      payload: '{}',
      dedupeKey: 'mcp-jobs-test-a',
      now: clock,
    });
    const enqueuedB = jobRepo.enqueue(t.scopes.forGuild(GUILD_B), {
      kind: 'reconcile_guild',
      payload: '{}',
      dedupeKey: 'mcp-jobs-test-b',
      now: clock,
    });
    expect(enqueuedA.jobId).toBeDefined();
    expect(enqueuedB.jobId).toBeDefined();
    const jobA = enqueuedA.jobId as number;
    const jobB = enqueuedB.jobId as number;
    jobRepo.failJob(t.scopes.forGuild(GUILD_A), jobA, 'alpha failure marker', clock, {
      permanent: true,
    });
    jobRepo.failJob(t.scopes.forGuild(GUILD_B), jobB, 'beta failure marker', clock, {
      permanent: true,
    });
    return { jobA, jobB };
  };

  it('list_jobs for guild A returns only guild A jobs', async () => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_B), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    seedFailedJobs();
    const accessToken = await mintToken();

    const found = callText(
      (await mcpCall(accessToken, 'list_jobs', { guildId: '111111111111111111' })).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('alpha failure marker');
    expect(found.text).not.toContain('beta failure marker');
  });

  it('get_job is guild-partitioned too: guild B job id through guild A is not found', async () => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_B), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    const { jobA, jobB } = seedFailedJobs();
    const accessToken = await mintToken();

    const own = callText(
      (await mcpCall(accessToken, 'get_job', { guildId: '111111111111111111', jobId: jobA })).body,
    );
    expect(own.isError).not.toBe(true);
    expect(own.text).toContain('alpha failure marker');

    // B's id through A answers ok with a null job — never B's error text.
    const cross = callText(
      (await mcpCall(accessToken, 'get_job', { guildId: '111111111111111111', jobId: jobB })).body,
    );
    expect(cross.isError).not.toBe(true);
    expect(cross.text).toContain('not found');
    expect(cross.text).not.toContain('beta failure marker');
  });
});

describe('/mcp with MCP_PUBLIC_URL unset', () => {
  it('answers 404 on /mcp while the SPA fallback still serves unknown paths', async () => {
    const bare = buildDashboardApp({ ...deps, mcpPublicUrl: undefined });
    try {
      const accessToken = await mintToken();
      // Even an authenticated request finds no MCP surface: the 404 comes
      // from the route's own opt-in check, not from the bearer guard.
      const mcp = await mcpPost(bare, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, accessToken);
      expect(mcp.statusCode).toBe(404);

      // Ruling PR-130: this 200 proves the static handler was registered, so
      // the 404 above cannot pass for the wrong reason (no fallback would
      // 404 the unknown path too).
      const spa = await bare.inject({ method: 'GET', url: '/definitely-not-a-route' });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toBe('<html>spa shell</html>');
    } finally {
      await bare.close();
    }
  });
});

/**
 * Task 5, daemon side: the three Discord-cache tools through the real stack —
 * Fastify + `registerMcpRoutes` + `createMcpServer` + the real `guildPortFor`
 * — against a fake discord.js guild built the way
 * `apps/daemon/src/ops/wiring.test.ts` builds one (a real `Client` that never
 * logged in, guilds injected through `guilds._add`).
 *
 * The load-bearing assertion is the `list_members` one: the member sitting in
 * `members.cache` must NOT come back, only the two the stubbed `members.list`
 * returns. That is ruling M4-D10 — the 50-entry `GuildMemberManager` cap
 * (`packages/discord/src/client.ts`) would otherwise silently truncate the
 * club's 210 members, so the port is a paginated REST fetch with
 * `cache: false`, never a cache read.
 */
describe('/mcp guild tools over a fake discord.js guild', () => {
  const BOT = '123456789012345678';
  const CATEGORY = '311111111111111111';
  const PLANNING = '322222222222222222';
  const LOUNGE = '333333333333333333';
  const ROLE_MANAGED = '344444444444444444';
  const ROLE_PLAIN = '355555555555555555';
  const CACHED_MEMBER = '366666666666666666';
  const PUBLIC_THREAD = '388888888888888888';
  const PRIVATE_THREAD = '399999999999999999';
  const REST_MEMBER_A = '377777777777777777';
  const REST_MEMBER_B = '388888888888888888';

  interface DiscordInternals {
    guilds: { _add: (data: object) => Guild };
    users: { _add: (data: object) => unknown };
  }
  const internals = (c: Client): DiscordInternals => c as unknown as DiscordInternals;

  /** A member shaped like the real thing, for the stubbed `members.list`. */
  const restMember = (id: string, username: string): GuildMember =>
    ({
      id,
      user: { id, username },
      displayName: `${username}-display`,
      // The real `GuildMemberRoleManager.cache` unconditionally inserts the
      // guild-id (@everyone) role first
      // (`node_modules/discord.js/src/managers/GuildMemberRoleManager.js`),
      // so the fake carries it too — the port must drop it, matching the
      // `list_roles` rule that hides `@everyone`.
      roles: {
        cache: new Collection([
          [GUILD_A, undefined],
          [ROLE_MANAGED, undefined],
        ]),
      },
      joinedAt: new Date('2024-05-01T00:00:00.000Z'),
    }) as unknown as GuildMember;

  const buildDiscordClient = (): {
    client: Client;
    memberListCalls: unknown[];
  } => {
    const client = new Client(buildClientOptions(() => BOT));
    const mutable = client as unknown as { user: unknown };
    mutable.user = internals(client).users._add({
      id: BOT,
      username: 'bananasaurs',
      discriminator: '0',
    });
    internals(client).guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CATEGORY,
          guild_id: GUILD_A,
          type: ChannelType.GuildCategory,
          name: 'club',
          position: 0,
          permission_overwrites: [],
        },
        {
          id: PLANNING,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 1,
          parent_id: CATEGORY,
          topic: 'plan the picnic',
          permission_overwrites: [],
        },
        {
          id: PUBLIC_THREAD,
          guild_id: GUILD_A,
          type: ChannelType.GuildPublicThread,
          name: 'public-thread',
          parent_id: PLANNING,
          thread_metadata: {
            archived: false,
            auto_archive_duration: 60,
            archive_timestamp: '2026-09-01T00:00:00.000Z',
            locked: false,
          },
        },
        {
          id: PRIVATE_THREAD,
          guild_id: GUILD_A,
          type: ChannelType.GuildPrivateThread,
          name: 'private-thread',
          parent_id: PLANNING,
          thread_metadata: {
            archived: false,
            auto_archive_duration: 60,
            archive_timestamp: '2026-09-01T00:00:00.000Z',
            locked: false,
          },
        },
        {
          id: LOUNGE,
          guild_id: GUILD_A,
          type: ChannelType.GuildVoice,
          name: 'lounge',
          position: 2,
          permission_overwrites: [],
        },
      ],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: ROLE_MANAGED,
          name: 'organizer',
          position: 3,
          permissions: '0',
          managed: false,
          color: 0,
        },
        { id: ROLE_PLAIN, name: 'member', position: 1, permissions: '0', managed: false, color: 0 },
      ],
      members: [
        {
          user: { id: CACHED_MEMBER, username: 'cached-una', discriminator: '0' },
          roles: [ROLE_PLAIN],
          joined_at: '2024-01-01T00:00:00.000Z',
        },
      ],
      emojis: [],
      unavailable: false,
    });
    const memberListCalls: unknown[] = [];
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('fake guild did not land in the cache');
    guild.members.list = async (options?: unknown) => {
      memberListCalls.push(options);
      return new Collection([
        [REST_MEMBER_A, restMember(REST_MEMBER_A, 'rest-ana')],
        [REST_MEMBER_B, restMember(REST_MEMBER_B, 'rest-bo')],
      ]);
    };
    return { client, memberListCalls };
  };

  /** The same `createServer` call production uses, with the fake client. */
  const buildGuildApp = (
    discordClient: Client,
    discord: FakeDiscord = new FakeDiscord({ guildId: GUILD_A }),
  ): FastifyInstance =>
    createServer({
      deps: { ...deps, mcpPublicUrl: PUBLIC_URL },
      registerRoutes: (instance, _guard, routeDeps) => {
        // A port that is never called by the guild tools pinned here — but
        // required (ruling M5-D11), so it is threaded even so.
        registerMcpRoutes(instance, routeDeps, discordClient, discord);
      },
    });

  const guildCall = (
    target: FastifyInstance,
    accessToken: string,
    name: string,
    args: Record<string, unknown>,
  ) =>
    target.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

  const callText = (
    body: string,
  ): { readonly isError: boolean | undefined; readonly text: string } => {
    const bodies = sseData(body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = (bodies[0] as { result?: { isError?: boolean; content?: unknown } }).result;
    const blocks = result?.content as ReadonlyArray<{ type: string; text: string }> | undefined;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.type).toBe('text');
    return { isError: result?.isError, text: blocks?.[0]?.text ?? '' };
  };

  const seedStorage = (): void => {
    archiveRepo.enableChannel(t.scopes.forGuild(GUILD_A), {
      channelId: PLANNING,
      attachmentPolicy: 'none',
      now: clock,
    });
    roleRepo.allowlistRole(t.scopes.forGuild(GUILD_A), ROLE_MANAGED);
  };

  it('list_members calls members.list, not members.cache', async () => {
    seedStorage();
    const { client: discordClient, memberListCalls } = buildDiscordClient();
    const guildApp = buildGuildApp(discordClient);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await guildCall(guildApp, accessToken, 'list_members', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      // The two the stubbed REST fetch returned come back; the member sitting
      // in the 50-entry cache does not — a cache read would answer the
      // opposite set, which is exactly the silent truncation M4-D10 forbids.
      expect(found.text).toContain('rest-ana');
      expect(found.text).toContain('rest-bo');
      expect(found.text).not.toContain('cached-una');
      // The @everyone guild-id role the manager inserts into every member's
      // cache is dropped by the port, matching `list_roles`: the members'
      // role ids name only the real role, never the guild id.
      const membersData = JSON.parse(found.text.split('\n')[2] ?? '') as {
        members: Array<{ roleIds: readonly string[] }>;
      };
      expect(membersData.members.flatMap((m) => m.roleIds)).toContain(ROLE_MANAGED);
      // Paginated REST fetch, not a cache read: `cache: false` pinned on the
      // exact options object the port passed to discord.js.
      expect(memberListCalls).toHaveLength(1);
      const options = memberListCalls[0] as Record<string, unknown>;
      expect(options['cache']).toBe(false);
      expect(options['limit']).toBe(25);
    } finally {
      await guildApp.close();
    }
  });

  it('list_channels marks archive scope from storage', async () => {
    seedStorage();
    const { client: discordClient } = buildDiscordClient();
    const guildApp = buildGuildApp(discordClient);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await guildCall(guildApp, accessToken, 'list_channels', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('planning');
      expect(found.text).toContain('lounge');
      expect(found.text).toContain('club');
      // Both archive states render as JSON booleans, so a port that always
      // answered one way would fail.
      const channelsData = JSON.parse(found.text.split('\n')[2] ?? '') as {
        channels: Array<{ archive: boolean }>;
      };
      expect(channelsData.channels.map((c) => c.archive)).toContain(true);
      expect(channelsData.channels.map((c) => c.archive)).toContain(false);
    } finally {
      await guildApp.close();
    }
  });

  it('list_threads returns public threads and never private ones (B4)', async () => {
    seedStorage();
    const { client: discordClient } = buildDiscordClient();
    const guildApp = buildGuildApp(discordClient);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await guildCall(guildApp, accessToken, 'list_threads', {
            guildId: '111111111111111111',
            channelId: PLANNING,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain(PUBLIC_THREAD);
      expect(found.text).not.toContain(PRIVATE_THREAD);
      expect(found.text).not.toContain('private-thread');
    } finally {
      await guildApp.close();
    }
  });

  it('list_threads with includeArchived pages the REST port, not the cache (S4)', async () => {
    seedStorage();
    const ARCHIVED_THREAD = '400000000000000001';
    const { client: discordClient } = buildDiscordClient();
    // The archived thread is not in any cache — the default sweeper evicts
    // archived threads — so only a port that asks Discord can return it.
    class ArchivedThreadDiscord extends FakeDiscord {
      restListCalls = 0;
      override async listPublicThreads(
        _guildId: string,
        _channelId: string,
      ): Promise<readonly { id: string; name: string; isPrivate: boolean; archived: boolean }[]> {
        this.restListCalls += 1;
        return [
          { id: PUBLIC_THREAD, name: 'public thread', isPrivate: false, archived: false },
          { id: ARCHIVED_THREAD, name: 'archived thread', isPrivate: false, archived: true },
        ];
      }
    }
    const discord = new ArchivedThreadDiscord({ guildId: GUILD_A });
    const guildApp = buildGuildApp(discordClient, discord);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await guildCall(guildApp, accessToken, 'list_threads', {
            guildId: '111111111111111111',
            channelId: PLANNING,
            includeArchived: true,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(discord.restListCalls).toBe(1);
      expect(found.text).toContain(ARCHIVED_THREAD);
      expect(found.text).toContain(PUBLIC_THREAD);
      expect(found.text).not.toContain(PRIVATE_THREAD);
    } finally {
      await guildApp.close();
    }
  });

  it('list_roles reports managed-by-Bananasaurs and excludes @everyone', async () => {
    seedStorage();
    const { client: discordClient } = buildDiscordClient();
    const guildApp = buildGuildApp(discordClient);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await guildCall(guildApp, accessToken, 'list_roles', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('organizer');
      expect(found.text).toContain('member');
      // Both managed states render as JSON booleans, so a port that always
      // answered one way would fail.
      const rolesData = JSON.parse(found.text.split('\n')[2] ?? '') as {
        roles: Array<{ managedByBananasaurs: boolean }>;
      };
      expect(rolesData.roles.map((r) => r.managedByBananasaurs)).toContain(true);
      expect(rolesData.roles.map((r) => r.managedByBananasaurs)).toContain(false);
      // The header names the exclusion honestly; no *row* carries the
      // @everyone name — the port dropped the guild-id role upstream.
      expect(found.text).toContain('@everyone excluded');
      expect(found.text).not.toContain('message: @everyone');
    } finally {
      await guildApp.close();
    }
  });

  it('production wiring serves list_channels: buildDashboardApp with a client returns data', async () => {
    seedStorage();
    const { client: discordClient } = buildDiscordClient();
    // The real composition — `index.ts` hands its live client to
    // `startDashboardApi`, which hands it to `buildDashboardApp`, which hands
    // it to `registerMcpRoutes`. Before the M4-D12 threading this call
    // refused with the shared message because no client ever arrived.
    const composed = buildDashboardApp({ ...deps, client: discordClient });
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await guildCall(composed, accessToken, 'list_channels', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('planning');
      expect(found.text).toContain('lounge');
    } finally {
      await composed.close();
    }
  });

  it('a guild missing from the cache is a refusal, not a throw', async () => {
    seedStorage();
    const { client: discordClient } = buildDiscordClient();
    const guildApp = buildGuildApp(discordClient);
    try {
      // Guild B is reachable (grant added) but the bot never READY'd it here,
      // so no guild object sits in the cache — the same answer as having left.
      authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_B), {
        accountId: ACCOUNT,
        capability: 'mcp.authorize',
        grantedBy: 'test',
        now: clock,
      });
      const accessToken = await mintToken();
      const refused = callText(
        (
          await guildCall(guildApp, accessToken, 'list_channels', {
            guildId: '222222222222222222',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(GUILD_REFUSAL_MESSAGE);
    } finally {
      await guildApp.close();
    }
  });
});

/**
 * `get_member` / `search_members` page past 1,000 through the real stack —
 * Fastify + `registerMcpRoutes` + `createMcpServer` + the real
 * `membersPortFor` — against a fake discord.js guild whose `members.list`
 * serves scripted pages.
 *
 * The load-bearing assertions are the `after` cursors and the call count: a
 * port that read `members.cache` would make no `members.list` call at all,
 * and one that stopped at the first page would answer 1,000 of 2,300.
 */
describe('/mcp member tools page past 1000', () => {
  const ROLE = '344444444444444444';

  /** A member shaped like the real thing, for the stubbed `members.list`. */
  const pagedMember = (id: string): GuildMember =>
    ({
      id,
      user: { id, username: `user-${id.slice(-4)}` },
      displayName: `User ${id.slice(-6)}`,
      nickname: null,
      roles: { cache: new Collection([[ROLE, undefined]]) },
      joinedAt: new Date('2024-05-01T00:00:00.000Z'),
    }) as unknown as GuildMember;

  /** 18-digit ids: same length, so lexicographic order is numeric order. */
  const pageIdOf = (n: number): string => String(400000000000000000n + BigInt(n));

  const buildPagedClient = (): {
    client: Client;
    calls: unknown[];
    serve: (sizes: number[]) => void;
  } => {
    const client = new Client(buildClientOptions(() => '123456789012345678'));
    (client as unknown as { guilds: { _add: (data: object) => Guild } }).guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [],
      roles: [],
      members: [],
      emojis: [],
      unavailable: false,
    });
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('fake guild did not land in the cache');
    const calls: unknown[] = [];
    let made = 0;
    const serve = (sizes: number[]): void => {
      guild.members.list = async (options?: unknown) => {
        calls.push(options);
        const size = sizes[calls.length - 1] ?? 1000;
        const members: GuildMember[] = [];
        for (let i = 0; i < size; i += 1) {
          made += 1;
          members.push(pagedMember(pageIdOf(made)));
        }
        return new Collection(members.map((m) => [m.id, m] as const));
      };
    };
    return { client, calls, serve };
  };

  const buildGuildApp = (discordClient: Client): FastifyInstance =>
    createServer({
      deps: { ...deps, mcpPublicUrl: PUBLIC_URL },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, discordClient, fakeDiscord);
      },
    });

  const memberCall = (
    target: FastifyInstance,
    accessToken: string,
    args: Record<string, unknown>,
  ) =>
    target.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_members', arguments: args },
      }),
    });

  const callText = (
    body: string,
  ): { readonly isError: boolean | undefined; readonly text: string } => {
    const bodies = sseData(body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = (bodies[0] as { result?: { isError?: boolean; content?: unknown } }).result;
    const blocks = result?.content as ReadonlyArray<{ type: string; text: string }> | undefined;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.type).toBe('text');
    return { isError: result?.isError, text: blocks?.[0]?.text ?? '' };
  };

  it('pages 1000, 1000, then 300 into 2,300 members with the right after cursors', async () => {
    const { client: discordClient, calls, serve } = buildPagedClient();
    serve([1000, 1000, 300]);
    const guildApp = buildGuildApp(discordClient);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (await memberCall(guildApp, accessToken, { guildId: '111111111111111111' })).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('2300 members match');
      expect(found.text).not.toContain('capped at 5,000');
      expect(calls).toHaveLength(3);
      expect(calls[0]).toMatchObject({ limit: 1000, cache: false });
      expect(calls[0] as Record<string, unknown>).not.toHaveProperty('after');
      // Page ids run made = 1..2300: page one ends at id #1000, page two at #2000.
      expect(calls[1]).toMatchObject({ limit: 1000, cache: false, after: pageIdOf(1000) });
      expect(calls[2]).toMatchObject({ limit: 1000, cache: false, after: pageIdOf(2000) });
    } finally {
      await guildApp.close();
    }
  });

  it('five full pages plus a 1-member probe stops at 5,000 truncated:true', async () => {
    const { client: discordClient, calls, serve } = buildPagedClient();
    serve([1000, 1000, 1000, 1000, 1000, 1]);
    const guildApp = buildGuildApp(discordClient);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (await memberCall(guildApp, accessToken, { guildId: '111111111111111111' })).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('5000 members match');
      expect(found.text).toContain('member listing was capped at 5,000');
      expect(calls).toHaveLength(6);
      for (const options of calls.slice(0, 5)) {
        expect(options).toMatchObject({ limit: 1000, cache: false });
      }
      // The probe is one row past the 5,000th id.
      expect(calls[5]).toMatchObject({ limit: 1, cache: false, after: pageIdOf(5000) });
    } finally {
      await guildApp.close();
    }
  });

  it('five full pages plus an empty probe stops at 5,000 truncated:false', async () => {
    const { client: discordClient, calls, serve } = buildPagedClient();
    serve([1000, 1000, 1000, 1000, 1000, 0]);
    const guildApp = buildGuildApp(discordClient);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (await memberCall(guildApp, accessToken, { guildId: '111111111111111111' })).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('5000 members match');
      expect(found.text).not.toContain('member listing was capped at 5,000');
      expect(calls).toHaveLength(6);
      expect(calls[5]).toMatchObject({ limit: 1, cache: false, after: pageIdOf(5000) });
    } finally {
      await guildApp.close();
    }
  });
});

describe('/mcp read logging (ADR 0050)', () => {
  const CHANNEL = '555555555555555555';
  const MEMBER = '666666666666666666';

  interface CapturedLine {
    readonly level: string;
    readonly fields: Record<string, unknown>;
    readonly msg: string;
  }

  /** A logger that records every line, swapped in for the silent one. */
  const recordingLogger = (): { readonly logger: never; readonly lines: CapturedLine[] } => {
    const lines: CapturedLine[] = [];
    const capture = (level: string) => (fields: Record<string, unknown>, msg: string) => {
      lines.push({ level, fields, msg });
    };
    const logger = {
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
      debug() {},
      fatal() {},
      trace() {},
    } as never;
    return { logger, lines };
  };

  const seedArchive = (): void => {
    archiveRepo.enableChannel(t.scopes.forGuild(GUILD_A), {
      channelId: CHANNEL,
      attachmentPolicy: 'none',
      now: clock,
    });
    archiveRepo.upsertMessage(t.scopes.forGuild(GUILD_A), {
      messageId: '777777777777777777',
      channelId: CHANNEL,
      authorId: MEMBER,
      content: 'alpha plans for the picnic',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
  };

  const mcpCall = (accessToken: string, name: string, args: Record<string, unknown>) =>
    mcpPost(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      accessToken,
    );

  it('a content-bearing read writes exactly one audit row with the right guild, and never the query', async () => {
    seedArchive();
    const accessToken = await mintToken();
    const response = await mcpCall(accessToken, 'search_messages', {
      guildId: String(GUILD_A),
      query: 'picnic',
    });
    expect(response.statusCode).toBe(200);

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) throw new Error('expected one audit row');
    expect(row.action).toBe('mcp.read.search_messages');
    expect(row.actorType).toBe('mcp_operator');
    expect(row.via).toBe('http');
    expect(row.actorId).toMatch(/^tok_/);
    expect(row.subjectType).toBe('guild');
    expect(row.subjectId).toBeNull();
    const after = JSON.parse(row.after ?? '{}') as Record<string, unknown>;
    expect(after['accountId']).toBe(ACCOUNT);
    expect(after['clientId']).toMatch(/^cli_/);
    expect(after['tokenId']).toBe(row.actorId);
    expect(after['resultCount']).toBe(1);
    // The privacy half (ADR 0050): the query string and the returned content
    // appear nowhere in the row — they are member content about member
    // content.
    expect(row.before).toBeNull();
    expect(row.after).not.toContain('picnic');
    expect(row.after).not.toContain('alpha plans');

    // And the second read is a second row: one read, one row, no more.
    const again = await mcpCall(accessToken, 'search_messages', {
      guildId: String(GUILD_A),
      query: 'picnic',
    });
    expect(again.statusCode).toBe(200);
    expect(effectRepo.tailAudit(t.scopes.forGuild(GUILD_A))).toHaveLength(2);
    // The other guild's trail is untouched (hard rule 2).
    expect(effectRepo.tailAudit(t.scopes.forGuild(GUILD_B))).toHaveLength(0);
  });

  it('a structural read writes no audit row and one allowlisted info line per reachable guild', async () => {
    const { logger, lines } = recordingLogger();
    const logged = buildDashboardApp({ ...deps, logger });
    try {
      const accessToken = await mintToken('bananasaurs:read', logged);
      const response = await mcpPost(
        logged,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_health', arguments: {} },
        },
        accessToken,
      );
      expect(response.statusCode).toBe(200);

      expect(effectRepo.tailAudit(t.scopes.forGuild(GUILD_A))).toHaveLength(0);
      expect(effectRepo.tailAudit(t.scopes.forGuild(GUILD_B))).toHaveLength(0);
      // The seeded account holds `mcp.authorize` in guild A only, so the
      // reachable set is exactly [A] and the fan-out is one line.
      const reads = lines.filter((line) => line.fields['action'] === 'mcp.read.get_health');
      expect(reads).toHaveLength(1);
      const guilds = reads.map((line) => line.fields['guildId']).sort();
      expect(guilds).toEqual([String(GUILD_A)]);
      for (const line of reads) {
        expect(line.fields['component']).toBe('mcp');
        expect(line.fields['accountId']).toBe(ACCOUNT);
        expect(line.fields['oauthTokenId']).toMatch(/^tok_/);
        expect(line.fields['oauthClientId']).toMatch(/^cli_/);
      }
    } finally {
      await logged.close();
    }
  });

  it('list_audit_events is audited, but never returns the rows its own reads generate', async () => {
    const accessToken = await mintToken();
    const first = await mcpCall(accessToken, 'list_audit_events', { guildId: String(GUILD_A) });
    expect(first.statusCode).toBe(200);
    expect(
      effectRepo
        .tailAudit(t.scopes.forGuild(GUILD_A))
        .filter((row) => row.action === 'mcp.read.list_audit_events'),
    ).toHaveLength(1);

    const second = await mcpCall(accessToken, 'list_audit_events', { guildId: String(GUILD_A) });
    expect(second.statusCode).toBe(200);
    // Two reads, two durable rows…
    expect(
      effectRepo
        .tailAudit(t.scopes.forGuild(GUILD_A))
        .filter((row) => row.action === 'mcp.read.list_audit_events'),
    ).toHaveLength(2);
    // …but the tool's answer excludes its own action, so watching the trail
    // through the tool does not grow it (ADR 0050).
    const bodies = sseData(second.body);
    const result = (bodies[0] as { result?: { content?: Array<{ text: string }> } }).result;
    const text = result?.content?.[0]?.text ?? '';
    expect(text).not.toContain('mcp.read.list_audit_events');
    expect(text).toContain('Audit events in guild');
  });

  /**
   * The other half of the same rule, and the reason the filter is keyed on
   * the actor rather than on the action alone: suppressing my own trail
   * reads must not suppress anyone else's. An operator who cannot see that
   * a second token has been reading the audit trail is looking at a trail
   * that lies by omission — so the string the test above requires to be
   * absent is required here to be present.
   */
  it("shows another token's reads of the trail, while still hiding the caller's own", async () => {
    const theirs = await mintToken();
    const mine = await mintToken();

    // A different token reads the trail, which writes its own row.
    expect(
      (await mcpCall(theirs, 'list_audit_events', { guildId: String(GUILD_A) })).statusCode,
    ).toBe(200);
    const afterTheirs = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD_A))
      .filter((row) => row.action === 'mcp.read.list_audit_events');
    expect(afterTheirs).toHaveLength(1);
    const theirTokenId = afterTheirs[0]?.actorId;
    expect(theirTokenId).toMatch(/^tok_/);

    // Now I read. Their row is in my answer; only mine would be filtered.
    const response = await mcpCall(mine, 'list_audit_events', { guildId: String(GUILD_A) });
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    const result = (bodies[0] as { result?: { content?: Array<{ text: string }> } }).result;
    const text = result?.content?.[0]?.text ?? '';
    expect(text).toContain('mcp.read.list_audit_events');

    // And the two reads are two distinct actors in the durable trail.
    const rows = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD_A))
      .filter((row) => row.action === 'mcp.read.list_audit_events');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.actorId)).size).toBe(2);
  });

  /**
   * ADR 0050 fails closed: a read whose audit row cannot be written is
   * refused rather than served unrecorded. The fault is the audit table
   * itself going missing — the same shape as the dropped FTS index above,
   * and the one fault that hits the recorder rather than the reader.
   *
   * Two things are asserted together, because either alone would be a
   * hazard: the member content the read had already fetched never reaches
   * the connector, and the operator gets an error line saying why. The
   * refusal the connector sees is the shared unreachable-guild message, so
   * without that line a database that cannot accept audit rows would be
   * indistinguishable from a revoked token.
   */
  it('a content read whose audit row cannot be written is refused, logged, and leaks nothing', async () => {
    const { logger, lines } = recordingLogger();
    const logged = buildDashboardApp({ ...deps, logger });
    try {
      seedArchive();
      const accessToken = await mintToken('bananasaurs:read', logged);
      // The recorder's table is gone while the archive rows remain.
      t.raw.exec('DROP TABLE audit_events');

      const response = await mcpPost(
        logged,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'get_message',
            arguments: { guildId: String(GUILD_A), messageId: '777777777777777777' },
          },
        },
        accessToken,
      );
      expect(response.statusCode).toBe(200);
      const bodies = sseData(response.body);
      const result = (
        bodies[0] as { result?: { isError?: boolean; content?: Array<{ text: string }> } }
      ).result;
      expect(result?.isError).toBe(true);
      const text = result?.content?.[0]?.text ?? '';
      expect(text).toBe(GUILD_REFUSAL_MESSAGE);
      // The read had already fetched the message before the row failed.
      expect(text).not.toContain('alpha plans');

      const failures = lines.filter(
        (line) => line.msg === 'mcp read audit write failed — read refused',
      );
      expect(failures).toHaveLength(1);
      const fields = failures[0]?.fields ?? {};
      expect(fields['component']).toBe('mcp');
      expect(fields['action']).toBe('mcp.read.get_message');
      expect(fields['guildId']).toBe(String(GUILD_A));
      expect(fields['accountId']).toBe(ACCOUNT);
      expect(fields['oauthTokenId']).toMatch(/^tok_/);
      expect(fields['err']).toBeDefined();

      // The absence assertion as well as the presence one (rule 4).
      const dump = JSON.stringify(lines);
      expect(dump).not.toContain('alpha plans');
      expect(dump).not.toContain(accessToken);
      expect(dump).not.toContain(MEMBER);
    } finally {
      await logged.close();
    }
  });
});
