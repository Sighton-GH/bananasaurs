import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ChannelType,
  Client,
  Collection,
  PermissionsBitField,
  type Guild,
  type GuildMember,
} from 'discord.js';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  accountRepo,
  archiveRepo,
  assistantRepo,
  authzRepo,
  authzStoreFor,
  channelReadRepo,
  computeDocId,
  effectRepo,
  guildRepo,
  jobRepo,
  loggingRepo,
  mcpActionsRepo,
  mcpBulkRepo,
  mcpRolePolicyRepo,
  mcpSendRepo,
  panelRepo,
  resourceCacheRepo,
  roleRepo,
  taskNudgeRepo,
  taskRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import {
  parseGuildId,
  authorize,
  DiscordApiError,
  contentHashFor,
  editManagedPanel,
  panelDefinitionSchema,
  RateLimiter,
  postManagedPanel,
  seedPanelReactions,
  type OpsPublishResult,
} from '@bananasaurs/core';
import type { Chunk, GuildId } from '@bananasaurs/core';
import { createServer, generateToken, hashPassword } from '@bananasaurs/http';
import {
  ARCHIVE_NO_TEXT_MARKER,
  ARCHIVE_PURGED_MARKER,
  GUILD_REFUSAL_MESSAGE,
  PRIVATE_THREAD_REFUSAL,
  bulkArgsHashFor,
} from '@bananasaurs/mcp';
import { buildDashboardApp, type DashboardAppDeps } from '../http/wiring.js';
import { registerMcpRoutes } from './wiring.js';
import { createInstanceSettingsStore } from '../settings/instance-settings-store.js';
import { mcpRoleGatewayFor, resetMcpRateLimiters } from './roles-gateway.js';
import { mcpBulkRoleHandler } from '../jobs/mcp-bulk-role.js';
import { FakeDiscord, BOT_USER_ID } from '@bananasaurs/testkit';
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
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
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
  // The MCP role gateway's per-guild limiters are process-wide (shared by
  // the HTTP ports and the bulk job): start every test with full buckets.
  resetMcpRateLimiters();

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

  it('lists owner task data through MCP and audits the read without title content', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    const teamId = taskRepo.createTeam(
      scope,
      { name: 'Tech', categoryId: '333333333333333333', kind: 'subteam' },
      ACTOR,
      clock,
    );
    taskRepo.createTask(
      scope,
      {
        teamId,
        title: 'Measure chassis',
        assignmentKind: 'team',
        dueAt: clock + 86400000,
        timezone: 'America/Vancouver',
        destinationId: '444444444444444444',
        createdBy: ACCOUNT,
      },
      ACTOR,
      clock,
    );
    const accessToken = await mintToken();
    const response = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_tasks', arguments: { guildId: String(GUILD_A) } },
      },
      accessToken,
    );
    expect(response.statusCode).toBe(200);
    const result = sseData(response.body)[0] as {
      result?: { isError?: boolean; content?: readonly { text: string }[] };
    };
    expect(result.result?.isError).not.toBe(true);
    expect(result.result?.content?.[0]?.text).toContain('Measure chassis');
    const row = effectRepo.tailAudit(scope).find((audit) => audit.action === 'mcp.read.list_tasks');
    expect(row).toMatchObject({ subjectType: 'guild', actorType: 'mcp_operator' });
    expect(row?.after).not.toContain('Measure chassis');
  });

  it('answers a valid read-scope token with tools/list containing all twenty-eight tools', async () => {
    const accessToken = await mintToken();
    const response = await toolsList(accessToken);
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = bodies[0] as { result?: { tools?: Array<{ name: string }> } };
    const names = result.result?.tools?.map((tool) => tool.name);
    expect(names).toHaveLength(28);
    expect(names).toEqual([
      'list_tasks',
      'get_task',
      'task_teams',
      'get_health',
      'search_messages',
      'read_channel_history',
      'get_message',
      'read_thread',
      'read_digest',
      'list_unanswered',
      'list_channels',
      'list_threads',
      'list_roles',
      'list_members',
      'list_panels',
      'get_panel',
      'list_mod_cases',
      'get_mod_case',
      'list_audit_events',
      'get_server_overview',
      'list_jobs',
      'get_job',
      'get_member',
      'search_members',
      'get_server_context',
      'search_resources',
      'open_resource',
      'list_actions',
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

  it('(ruling M4-D17) a send-only token minted through the real OAuth flow sees the send-scope tools and nothing else', async () => {
    // Through the real authorize/consent/exchange flow, not a hand-built
    // principal: this defect is invisible to a test that constructs the
    // principal itself, which is the exact shape of the three "works in
    // tests, broken in the daemon" defects this slice already found.
    //
    // Since M5 Task 4 the daemon always threads the real send port (ruling
    // M5-D11), so a send-scoped token lists `send_message` plus the six
    // thread-write tools (slice 3 Task 5), the six message-write tools
    // (Task 6), the four event tools (slice 5 Task 5), the four schedule
    // tools (slice 5 Task 3) and `undo_action`
    // (Task 7), all the same scope — the eleven
    // read tools stay behind the read scope it does not carry, and the
    // task-tracking write tools stay behind the tasks scope (ADR 0114).
    const accessToken = await mintToken('bananasaurs:send');
    const response = await toolsList(accessToken);
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = bodies[0] as { result?: { tools?: Array<{ name: string }> } };
    expect(result.result?.tools?.map((tool) => tool.name)).toEqual([
      'send_message',
      'create_thread',
      'add_thread_members',
      'remove_thread_members',
      'create_forum_post',
      'archive_thread',
      'lock_thread',
      'edit_message',
      'delete_message',
      'pin_message',
      'unpin_message',
      'add_reaction',
      'remove_reaction',
      'create_event',
      'edit_event',
      'cancel_event',
      'create_poll',
      'schedule_message',
      'edit_scheduled',
      'cancel_scheduled',
      'list_scheduled',
      'undo_action',
    ]);
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
  /** Allowlisted, but the bot role is denied SendMessages here by overwrite. */
  const NO_SEND_CHANNEL = '477777777777777779';
  const BOT_ID = '123456789012345678';
  const BOT_ROLE = '511111111111111111';
  const LOW_ROLE = '522222222222222222';
  const MEMBER_USER = '633333333333333333';
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
    // Target resolution reads the bot's live permissions, so the composed
    // app's client needs a bot user, a bot role that can post, and a bot
    // member — the same shape `ops/wiring.test.ts` injects. Deliberately not
    // Administrator: it would bypass the channel overwrite the
    // no-permission test below depends on.
    const mutable = deps.client as unknown as { user: unknown };
    mutable.user = (
      deps.client as unknown as { users: { _add: (data: object) => unknown } }
    ).users._add({ id: BOT_ID, username: 'bananasaurs', discriminator: '0' });
    const botPermissions = (
      PermissionsBitField.Flags.ViewChannel |
      PermissionsBitField.Flags.SendMessages |
      PermissionsBitField.Flags.SendMessagesInThreads
    ).toString();
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
        {
          id: NO_SEND_CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'quiet',
          position: 2,
          permission_overwrites: [
            {
              id: BOT_ROLE,
              type: 0,
              allow: '0',
              deny: String(PermissionsBitField.Flags.SendMessages),
            },
          ],
        },
      ],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 7,
          permissions: botPermissions,
          managed: true,
        },
        { id: LOW_ROLE, name: 'helpers', position: 3, permissions: '0', managed: false },
      ],
      members: [
        { user: { id: BOT_ID, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
        { user: { id: MEMBER_USER, username: 'member', discriminator: '0' }, roles: [] },
      ],
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
    // default of parsing everything, including @everyone. The reply ping is
    // off by default (ADR 0117 §5), and only policy-approved pings ride
    // along — here, none.
    const calls = fakeDiscord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe(GUILD_A);
    expect(calls[0]?.args[1]).toBe(CHANNEL);
    expect(calls[0]?.args[2]).toEqual({
      content: CONTENT,
      pingReplyAuthor: false,
      allowedMentions: { parse: [], roles: [], users: [] },
    });

    // The ledger row lands with the Discord message id.
    const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'send-k1');
    expect(row?.status).toBe('done');
    expect(row?.targetChannelId).toBe(CHANNEL);
    expect(row?.resultMessageId).toBeDefined();

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
    expect(typeof after['actionId']).toBe('string');
    expect(found.text).toContain(after['actionId']);
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

  it('a private thread inherits its parent and audits the derived grant', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ channelId: PRIVATE_THREAD, idempotencyKey: 'private-send' }),
        )
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('Sent message');
    expect(fakeDiscord.restCalls('sendMessage')[0]?.args[1]).toBe(PRIVATE_THREAD);
    const audit = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 })
      .find((entry) => entry.action === 'mcp.message.sent');
    const after = JSON.parse(audit?.after ?? '{}') as Record<string, unknown>;
    expect(after['authorization']).toBe('derived');
    expect(after['grantedByChannelId']).toBe(CHANNEL);
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
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'excluded-send')).toBeUndefined();
  });

  it('a channel under an excluded category is refused and Discord is never called', async () => {
    allow();
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD_A), CATEGORY);
    const accessToken = await mintToken('bananasaurs:send');
    const refused = callText(
      (await sendCall(accessToken, sendArgs({ idempotencyKey: 'excluded-category-send' }))).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('not on the send allowlist');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
    expect(
      mcpSendRepo.findSend(t.scopes.forGuild(GUILD_A), 'excluded-category-send'),
    ).toBeUndefined();
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
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'send-k2')).toBeUndefined();
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
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'send-outside')).toBeUndefined();
  });

  it('@everyone in content never pings, while a policy-approved role and member do', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({
            content: '@everyone hello @here',
            pingRoles: ['helpers'],
            pingUsers: [MEMBER_USER],
            idempotencyKey: 'ping-send',
          }),
        )
      ).body,
    );
    expect(found.isError).not.toBe(true);
    const calls = fakeDiscord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[2]).toMatchObject({
      allowedMentions: { parse: [], roles: [LOW_ROLE], users: [MEMBER_USER] },
    });
  });

  it('mentions typed into the text ping under the same policy, and a refused one is reported (ADR 0128)', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({
            content: `<@${MEMBER_USER}> and <@&${LOW_ROLE}>, not <@&${BOT_ROLE}> or @everyone`,
            idempotencyKey: 'text-ping-send',
          }),
        )
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('Sent message');
    expect(found.text).toContain(`role ${BOT_ROLE} (`);
    const calls = fakeDiscord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[2]).toMatchObject({
      allowedMentions: { parse: [], roles: [LOW_ROLE], users: [MEMBER_USER] },
    });
  });

  it('a reply without pingReplyAuthor records the reply with the ping off', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({
            content: `${CONTENT}-reply`,
            replyTo: '400000000000000000',
            idempotencyKey: 'reply-send',
          }),
        )
      ).body,
    );
    expect(found.isError).not.toBe(true);
    const calls = fakeDiscord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[2]).toMatchObject({
      replyTo: '400000000000000000',
      pingReplyAuthor: false,
    });
  });

  it('embeds post with the footer mapped and mentions still suppressed', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (
        await sendCall(accessToken, {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          embeds: [{ title: 'plan', description: 'picnic', footer: 'club' }],
          idempotencyKey: 'embed-send',
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    const calls = fakeDiscord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[2]).toMatchObject({
      embeds: [{ title: 'plan', description: 'picnic', footer: { text: 'club' } }],
      allowedMentions: { parse: [], roles: [], users: [] },
    });
  });

  it('a channel the bot cannot send in is refused naming the permission', async () => {
    seedSendGuild();
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: NO_SEND_CHANNEL,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
    const accessToken = await mintToken('bananasaurs:send');
    const refused = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ channelId: NO_SEND_CHANNEL, idempotencyKey: 'no-send' }),
        )
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('SendMessages');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'no-send')).toBeUndefined();
  });

  it('a pre-migration key with the old content hash replays instead of posting twice', async () => {
    allow();
    const scope = t.scopes.forGuild(GUILD_A);
    mcpActionsRepo.claimAction(scope, {
      actionId: 'legacy:send-legacy',
      idempotencyKey: 'send-legacy',
      kind: 'message.send',
      capGroup: 'message',
      argsHash: contentHashFor(CHANNEL, CONTENT),
      tokenId: 'tok_legacy',
      targetChannelId: CHANNEL,
      now: clock,
      dryRun: false,
    });
    mcpActionsRepo.completeAction(scope, 'legacy:send-legacy', {
      status: 'done',
      resultMessageId: '466666666666666667',
      now: clock,
    });
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (await sendCall(accessToken, sendArgs({ idempotencyKey: 'send-legacy' }))).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('466666666666666667');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('a replay of a failed earlier attempt says the outcome is unknown, never "sent"', async () => {
    allow();
    const scope = t.scopes.forGuild(GUILD_A);
    mcpActionsRepo.claimAction(scope, {
      actionId: 'act-failed',
      idempotencyKey: 'send-failed',
      kind: 'message.send',
      capGroup: 'message',
      argsHash: contentHashFor(CHANNEL, CONTENT),
      tokenId: 'tok_failed',
      targetChannelId: CHANNEL,
      now: clock,
      dryRun: false,
    });
    mcpActionsRepo.completeAction(scope, 'act-failed', { status: 'failed', now: clock });
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (await sendCall(accessToken, sendArgs({ idempotencyKey: 'send-failed' }))).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('outcome is unknown');
    expect(found.text).toContain('may or may not be in channel');
    expect(found.text.toLowerCase()).not.toContain('sent');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('a dry run reports what would be sent and makes no Discord call', async () => {
    allow();
    const accessToken = await mintToken('bananasaurs:send');
    const found = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ content: `${CONTENT}-dry`, dryRun: true, idempotencyKey: 'dry-send' }),
        )
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('nothing was posted');
    expect(found.text).toContain('would post');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'dry-send')?.status).toBe(
      'dry_run',
    );
  });

  it('the kill switch refuses the send with no Discord call', async () => {
    allow();
    guildRepo.setKillswitch(t.scopes.forGuild(GUILD_A), true, clock);
    const accessToken = await mintToken('bananasaurs:send');
    const refused = callText(
      (await sendCall(accessToken, sendArgs({ idempotencyKey: 'kill-send' }))).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('kill switch');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'kill-send')).toBeUndefined();
  });

  it('(Review Focus 4) a cap edited in settings takes effect on the next call with no restart', async () => {
    const store = createInstanceSettingsStore({
      instance: t.scopes.instance(),
      logger: silentLogger,
    });
    expect(store.set('mcp.cap.message', 2, 'owner', clock).ok).toBe(true);
    await app.close();
    deps = { ...deps, instanceSettings: store };
    app = buildDashboardApp(deps);
    allow();
    const accessToken = await mintToken('bananasaurs:send');

    const first = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ content: `${CONTENT}-cap-1`, idempotencyKey: 'cap-1' }),
        )
      ).body,
    );
    expect(first.isError).not.toBe(true);
    const second = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ content: `${CONTENT}-cap-2`, idempotencyKey: 'cap-2' }),
        )
      ).body,
    );
    expect(second.isError).not.toBe(true);
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(2);

    const capped = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ content: `${CONTENT}-cap-3`, idempotencyKey: 'cap-3' }),
        )
      ).body,
    );
    expect(capped.isError).toBe(true);
    expect(capped.text).toContain('budget');
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(2);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'cap-3')).toBeUndefined();

    expect(store.set('mcp.cap.message', 5, 'owner', clock).ok).toBe(true);
    const fourth = callText(
      (
        await sendCall(
          accessToken,
          sendArgs({ content: `${CONTENT}-cap-4`, idempotencyKey: 'cap-4' }),
        )
      ).body,
    );
    expect(fourth.isError).not.toBe(true);
    expect(fakeDiscord.restCalls('sendMessage')).toHaveLength(3);
  });
});

/**
 * Slice 3 Task 5, daemon side: the six thread/forum write tools through the
 * real stack — Fastify + `registerMcpRoutes` + `createMcpServer` + the real
 * thread-writes port over the real repositories and the fake Discord port —
 * with tokens minted through the real OAuth flow.
 *
 * The client here is a dedicated one, not `deps.client`: its bot user is
 * FakeDiscord's own bot id, so a thread the fake mints joins the same bot the
 * readability check reasons about — "only the bot as a member" means exactly
 * that. The bot role deliberately lacks ManageThreads: member and state edits
 * on an MCP-created thread must still pass (the bot owns it), while the same
 * edit on any other thread refuses naming the permission.
 */
describe('/mcp thread writes through the real composition', () => {
  /** FakeDiscord's own bot: a thread it mints joins this member, and nothing else. */
  const BOT = '999999999999999999';
  const OWNER = '345678901234567890';
  const MEMBER = '633333333333333333';
  /** In no cache and behind a stubbed fetch: never a guild member. */
  const STRANGER = '644444444444444444';
  const PLANNING = '555555555555555555';
  /** Same name as PLANNING on purpose: the ambiguous-name refusal. */
  const PLANNING_DUP = '555555555555555556';
  const FORUM = '566666666666666666';
  const LOUNGE = '577777777777777777';
  const BOT_ROLE = '511111111111111111';
  /** A live thread the MCP never created, under the allowlisted parent. */
  const OTHER_THREAD = '588888888888888888';
  const TAG_QUESTION = '600000000000000001';
  const TAG_ANNOUNCE = '600000000000000002';
  /** Distinctive text: must reach Discord, must never reach the audit row. */
  const FIRST_TEXT = 'thread-first-message-probe-content-that-must-never-reach-audit-zz1';

  interface ThreadDiscordInternals {
    guilds: { _add: (data: object) => Guild };
    users: { _add: (data: object) => unknown };
    channels: { _add: (data: object, guild: Guild, opts: object) => void };
  }

  const buildThreadClient = (): Client => {
    const client = new Client(buildClientOptions(() => BOT));
    const internals = client as unknown as ThreadDiscordInternals;
    const mutable = client as unknown as { user: unknown };
    mutable.user = internals.users._add({ id: BOT, username: 'bananasaurs', discriminator: '0' });
    // Deliberately no ManageThreads on the bot role: creation needs only the
    // Create*Threads bits, and ownership (not the permission) carries the
    // member/state edits on MCP-created threads below.
    const botPermissions = (
      PermissionsBitField.Flags.ViewChannel |
      PermissionsBitField.Flags.SendMessages |
      PermissionsBitField.Flags.SendMessagesInThreads |
      PermissionsBitField.Flags.CreatePublicThreads |
      PermissionsBitField.Flags.CreatePrivateThreads
    ).toString();
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: OWNER,
      channels: [
        {
          id: PLANNING,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 0,
          permission_overwrites: [],
        },
        {
          id: PLANNING_DUP,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 1,
          permission_overwrites: [],
        },
        {
          id: LOUNGE,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'lounge',
          position: 2,
          permission_overwrites: [],
        },
        {
          id: FORUM,
          guild_id: GUILD_A,
          type: ChannelType.GuildForum,
          name: 'help-desk',
          position: 3,
          permission_overwrites: [],
          available_tags: [
            { id: TAG_QUESTION, name: 'question', moderated: false },
            { id: TAG_ANNOUNCE, name: 'announcement', moderated: false },
          ],
        },
      ],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 7,
          permissions: botPermissions,
          managed: true,
        },
      ],
      members: [
        { user: { id: BOT, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
        { user: { id: MEMBER, username: 'member', discriminator: '0' }, roles: [] },
      ],
      emojis: [],
      unavailable: false,
    });
    return client;
  };

  const buildThreadApp = (client: Client, discord: FakeDiscord): FastifyInstance =>
    createServer({
      deps: {
        ...deps,
        instance: {
          ...deps.instance,
          redactedConfig: () => ({ BANANASAURS_OWNER_USER_ID: OWNER }),
        },
      },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, client, discord);
      },
    });

  const seed = (): void => {
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: PLANNING,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: LOUNGE,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: FORUM,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
  };

  /** A thread the gateway cache learns the way production learns it: after creation. */
  const injectThread = (
    client: Client,
    threadId: string,
    parentId: string,
    type: ChannelType,
    ownerId: string = BOT,
  ): void => {
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    const internals = client as unknown as ThreadDiscordInternals;
    internals.channels._add(
      {
        id: threadId,
        guild_id: GUILD_A,
        parent_id: parentId,
        owner_id: ownerId,
        type,
        name: `thread-${threadId.slice(-4)}`,
        thread_metadata: {
          archived: false,
          auto_archive_duration: 1440,
          archive_timestamp: new Date().toISOString(),
          locked: false,
        },
      },
      guild,
      {},
    );
  };

  const mcpCall = (
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

  const resultThreadIdOf = (key: string): string => {
    const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), key);
    expect(row?.resultThreadId).toBeDefined();
    if (row?.resultThreadId === undefined) throw new Error(`no thread id stored for key ${key}`);
    return row.resultThreadId;
  };

  const createArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guildId: '111111111111111111',
    channel: PLANNING,
    name: 'planning thread',
    type: 'private',
    idempotencyKey: 'thread-k1',
    ...over,
  });

  it('a private thread created via MCP is readable by read_thread with only the bot as member', async () => {
    seed();
    // ADR 0126 Task 15: the live read needs Read, inherited from the parent.
    channelReadRepo.allowRead(t.scopes.forGuild(GUILD_A), {
      channelId: PLANNING,
      scopeKind: 'channel',
      now: clock,
    });
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send bananasaurs:read');
      const created = callText(
        (
          await mcpCall(
            threadApp,
            accessToken,
            'create_thread',
            createArgs({ firstMessage: { content: FIRST_TEXT } }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      const threadId = resultThreadIdOf('thread-k1');
      expect(created.text).toContain(threadId);

      // Discord saw the creation with Discord's default: auto-archive 1440,
      // private threads non-invitable unless asked.
      const creates = discord.restCalls('createThread');
      expect(creates).toHaveLength(1);
      expect(creates[0]?.args[1]).toBe(PLANNING);
      expect(creates[0]?.args[2]).toMatchObject({
        name: 'planning thread',
        type: 'private',
        autoArchiveMinutes: 1440,
        invitable: false,
      });

      // The ledger row carries kind and cap group; the private-thread rows
      // exist; the audit names the action and never the content.
      const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'thread-k1');
      expect(row?.kind).toBe('thread.create');
      expect(row?.capGroup).toBe('structure');
      expect(row?.status).toBe('done');
      expect(mcpRolePolicyRepo.isMcpPrivateThread(t.scopes.forGuild(GUILD_A), threadId)).toBe(true);
      expect(mcpSendRepo.isChannelAllowed(t.scopes.forGuild(GUILD_A), threadId)).toBe(true);
      const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 });
      const audit = trail.find((entry) => entry.action === 'mcp.thread.create');
      expect(audit).toBeDefined();
      expect(audit?.actorType).toBe('mcp_operator');
      expect(audit?.via).toBe('http');
      expect(JSON.stringify(trail)).not.toContain(FIRST_TEXT);

      // Readable live with only the bot as a member: the owner was configured
      // but never joined, so the bot-and-owner membership path answers false
      // and only the MCP row carries this read — proven by the absence of any
      // membership check on the wire. (FakeDiscord's `sendMessage` stores no
      // content, so the live page shows the no-content marker; the content
      // reaching Discord is pinned by the `sendMessage` args assertion in the
      // firstMessage test below.)
      // Production learns the thread through the gateway; the test cache
      // learns it here, the same shape the Read check resolves.
      injectThread(client, threadId, PLANNING, ChannelType.GuildPrivateThread);
      const read = callText(
        (
          await mcpCall(threadApp, accessToken, 'read_thread', {
            guildId: '111111111111111111',
            threadId,
          })
        ).body,
      );
      expect(read.isError).not.toBe(true);
      const firstId = mcpActionsRepo.findAction(
        t.scopes.forGuild(GUILD_A),
        'thread-k1:first',
      )?.resultMessageId;
      expect(firstId).toBeDefined();
      expect(read.text).toContain(`message: ${firstId ?? ''}`);
      expect(read.text).toContain(`author: ${BOT}`);
      expect(read.text).toContain('private, read live');
      expect(discord.restCalls('isThreadMember')).toEqual([]);
    } finally {
      await threadApp.close();
    }
  }, 20_000); // an argon2-backed OAuth flow plus thread setup ran past 5s under full-suite load

  it('its allowlist row lets a follow-up send_message with threadId pass', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const created = callText(
        (await mcpCall(threadApp, accessToken, 'create_thread', createArgs())).body,
      );
      expect(created.isError).not.toBe(true);
      const threadId = resultThreadIdOf('thread-k1');
      // Production learns the thread through the gateway; the test cache
      // learns it here, the same shape `resolveChannel` reads.
      injectThread(client, threadId, PLANNING, ChannelType.GuildPrivateThread);

      const sent = callText(
        (
          await mcpCall(threadApp, accessToken, 'send_message', {
            guildId: '111111111111111111',
            channelId: PLANNING,
            threadId,
            content: 'follow-up in the new private thread',
            idempotencyKey: 'follow-k1',
          })
        ).body,
      );
      expect(sent.isError).not.toBe(true);
      expect(sent.text).toContain('Sent message');
      const sends = discord.restCalls('sendMessage');
      // This creation carried no firstMessage, so the only send is this one.
      expect(sends).toHaveLength(1);
      expect(sends[0]?.args[1]).toBe(threadId);
    } finally {
      await threadApp.close();
    }
  });

  it('a first message pings the member it mentions and reports a managed role it cannot (ADR 0128)', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const created = callText(
        (
          await mcpCall(
            threadApp,
            accessToken,
            'create_thread',
            createArgs({
              firstMessage: { content: `<@${MEMBER}> over to you, cc <@&${BOT_ROLE}>` },
            }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      expect(created.text).toContain(`role ${BOT_ROLE} (managed roles and @everyone never ping)`);
      const sends = discord.restCalls('sendMessage');
      expect(sends).toHaveLength(1);
      expect(sends[0]?.args[2]).toMatchObject({
        allowedMentions: { parse: [], roles: [], users: [MEMBER] },
      });
    } finally {
      await threadApp.close();
    }
  });

  it('a forum post pings the member its content mentions (ADR 0128)', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const posted = callText(
        (
          await mcpCall(threadApp, accessToken, 'create_forum_post', {
            guildId: '111111111111111111',
            forum: 'Help-Desk',
            title: 'club question',
            content: `<@${MEMBER}> when is the next build night?`,
            tags: ['Question'],
            idempotencyKey: 'forum-ping-k1',
          })
        ).body,
      );
      expect(posted.isError).not.toBe(true);
      const posts = discord.restCalls('createForumPost');
      expect(posts).toHaveLength(1);
      expect(posts[0]?.args[2]).toMatchObject({
        message: { allowedMentions: { parse: [], roles: [], users: [MEMBER] } },
      });
    } finally {
      await threadApp.close();
    }
  });

  it('firstMessage posts into the new thread under key <key>:first', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const created = callText(
        (
          await mcpCall(
            threadApp,
            accessToken,
            'create_thread',
            createArgs({ firstMessage: { content: FIRST_TEXT } }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      const threadId = resultThreadIdOf('thread-k1');
      expect(created.text).toContain('first message was posted');

      const sends = discord.restCalls('sendMessage');
      expect(sends).toHaveLength(1);
      expect(sends[0]?.args[1]).toBe(threadId);
      expect(sends[0]?.args[2]).toMatchObject({
        content: FIRST_TEXT,
        allowedMentions: { parse: [], roles: [], users: [] },
      });
      const first = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'thread-k1:first');
      expect(first?.kind).toBe('message.send');
      expect(first?.capGroup).toBe('message');
      expect(first?.status).toBe('done');
      expect(first?.targetChannelId).toBe(threadId);
    } finally {
      await threadApp.close();
    }
  });

  it('the kill switch refuses the creation with no Discord call', async () => {
    seed();
    guildRepo.setKillswitch(t.scopes.forGuild(GUILD_A), true, clock);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const refused = callText(
        (await mcpCall(threadApp, accessToken, 'create_thread', createArgs())).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('kill switch');
      expect(discord.restCalls('createThread')).toHaveLength(0);
      expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'thread-k1')).toBeUndefined();
    } finally {
      await threadApp.close();
    }
  });

  it('replaying the key returns the same thread id and calls Discord once', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const first = callText(
        (
          await mcpCall(
            threadApp,
            accessToken,
            'create_thread',
            createArgs({ firstMessage: { content: FIRST_TEXT } }),
          )
        ).body,
      );
      expect(first.isError).not.toBe(true);
      const threadId = resultThreadIdOf('thread-k1');
      const second = callText(
        (
          await mcpCall(
            threadApp,
            accessToken,
            'create_thread',
            createArgs({ firstMessage: { content: FIRST_TEXT } }),
          )
        ).body,
      );
      expect(second.isError).not.toBe(true);
      expect(second.text).toContain(threadId);
      expect(second.text).toContain('Already created under this idempotency key');
      expect(discord.restCalls('createThread')).toHaveLength(1);
      expect(discord.restCalls('sendMessage')).toHaveLength(1);
    } finally {
      await threadApp.close();
    }
  });

  it('undo of add-members removes them, and the ledger holds the inverse', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      expect(
        callText((await mcpCall(threadApp, accessToken, 'create_thread', createArgs())).body)
          .isError,
      ).not.toBe(true);
      const threadId = resultThreadIdOf('thread-k1');
      injectThread(client, threadId, PLANNING, ChannelType.GuildPrivateThread);

      // The bot role has no ManageThreads: this passes only because the bot
      // owns the thread it just created.
      const added = callText(
        (
          await mcpCall(threadApp, accessToken, 'add_thread_members', {
            guildId: '111111111111111111',
            threadId,
            userIds: [MEMBER],
            idempotencyKey: 'add-k1',
          })
        ).body,
      );
      expect(added.isError).not.toBe(true);
      expect(await discord.isThreadMember(GUILD_A, threadId, MEMBER)).toBe(true);
      const addRow = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'add-k1');
      expect(addRow?.kind).toBe('thread.members.add');
      expect(addRow?.capGroup).toBe('structure');
      expect(JSON.parse(addRow?.undoJson ?? '')).toEqual({ userIds: [MEMBER] });
      const addAudit = effectRepo
        .tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 })
        .find((entry) => entry.action === 'mcp.thread.members.add');
      expect(addAudit).toBeDefined();

      const removed = callText(
        (
          await mcpCall(threadApp, accessToken, 'remove_thread_members', {
            guildId: '111111111111111111',
            threadId,
            userIds: [MEMBER],
            idempotencyKey: 'remove-k1',
          })
        ).body,
      );
      expect(removed.isError).not.toBe(true);
      expect(await discord.isThreadMember(GUILD_A, threadId, MEMBER)).toBe(false);
    } finally {
      await threadApp.close();
    }
  });

  it('archive then restore works on an owned thread, and a lock still needs ManageThreads', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      expect(
        callText((await mcpCall(threadApp, accessToken, 'create_thread', createArgs())).body)
          .isError,
      ).not.toBe(true);
      const threadId = resultThreadIdOf('thread-k1');
      injectThread(client, threadId, PLANNING, ChannelType.GuildPrivateThread);

      const archived = callText(
        (
          await mcpCall(threadApp, accessToken, 'archive_thread', {
            guildId: '111111111111111111',
            threadId,
            archived: true,
            idempotencyKey: 'archive-k1',
          })
        ).body,
      );
      expect(archived.isError).not.toBe(true);
      expect(discord.threadState(threadId)).toMatchObject({ archived: true, locked: false });
      const archiveRow = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'archive-k1');
      expect(archiveRow?.kind).toBe('thread.state');
      expect(JSON.parse(archiveRow?.undoJson ?? '')).toEqual({ archived: false });

      const restored = callText(
        (
          await mcpCall(threadApp, accessToken, 'archive_thread', {
            guildId: '111111111111111111',
            threadId,
            archived: false,
            idempotencyKey: 'archive-k2',
          })
        ).body,
      );
      expect(restored.isError).not.toBe(true);
      expect(discord.threadState(threadId)).toMatchObject({ archived: false, locked: false });

      const locked = callText(
        (
          await mcpCall(threadApp, accessToken, 'lock_thread', {
            guildId: '111111111111111111',
            threadId,
            locked: true,
            idempotencyKey: 'lock-k1',
          })
        ).body,
      );
      // Discord lets a thread's owner archive it but only ManageThreads
      // locks: owning the thread never relaxes a lock, so this bot (no
      // ManageThreads) is refused before any Discord call.
      expect(locked.isError).toBe(true);
      expect(locked.text).toContain('ManageThreads');
      expect(discord.restCalls('setThreadState')).toHaveLength(2);
      expect(discord.threadState(threadId)).toMatchObject({ archived: false, locked: false });
    } finally {
      await threadApp.close();
    }
  });

  it('member and state edits on a thread the bot did not create refuse naming ManageThreads', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    discord.defineThread({ threadId: OTHER_THREAD, name: 'other', parentId: PLANNING });
    const client = buildThreadClient();
    // Owned by a member, not the bot: the manage-thread need applies in full.
    injectThread(client, OTHER_THREAD, PLANNING, ChannelType.GuildPublicThread, MEMBER);
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const refusedAdd = callText(
        (
          await mcpCall(threadApp, accessToken, 'add_thread_members', {
            guildId: '111111111111111111',
            threadId: OTHER_THREAD,
            userIds: [MEMBER],
            idempotencyKey: 'add-other',
          })
        ).body,
      );
      expect(refusedAdd.isError).toBe(true);
      expect(refusedAdd.text).toContain('ManageThreads');
      const refusedArchive = callText(
        (
          await mcpCall(threadApp, accessToken, 'archive_thread', {
            guildId: '111111111111111111',
            threadId: OTHER_THREAD,
            archived: true,
            idempotencyKey: 'archive-other',
          })
        ).body,
      );
      expect(refusedArchive.isError).toBe(true);
      expect(refusedArchive.text).toContain('ManageThreads');
      expect(discord.restCalls('addThreadMember')).toEqual([]);
      expect(discord.restCalls('setThreadState')).toEqual([]);
      expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'add-other')).toBeUndefined();
    } finally {
      await threadApp.close();
    }
  });

  it('a thread the bot opened outside the MCP still needs ManageThreads', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    discord.defineThread({ threadId: OTHER_THREAD, name: 'other', parentId: PLANNING });
    const client = buildThreadClient();
    // The bot is the cached owner (another module opened it), but no ledger
    // row says the MCP created it: ownership must not relax the need.
    injectThread(client, OTHER_THREAD, PLANNING, ChannelType.GuildPublicThread, BOT);
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const refused = callText(
        (
          await mcpCall(threadApp, accessToken, 'archive_thread', {
            guildId: '111111111111111111',
            threadId: OTHER_THREAD,
            archived: true,
            idempotencyKey: 'archive-bot-other',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('ManageThreads');
      expect(discord.restCalls('setThreadState')).toEqual([]);
    } finally {
      await threadApp.close();
    }
  });

  it('a public thread the MCP created is managed without ManageThreads', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      expect(
        callText(
          (await mcpCall(threadApp, accessToken, 'create_thread', createArgs({ type: 'public' })))
            .body,
        ).isError,
      ).not.toBe(true);
      const threadId = resultThreadIdOf('thread-k1');
      // A member-owned cache entry: only the ledger can carry ownership here.
      injectThread(client, threadId, PLANNING, ChannelType.GuildPublicThread, MEMBER);
      const archived = callText(
        (
          await mcpCall(threadApp, accessToken, 'archive_thread', {
            guildId: '111111111111111111',
            threadId,
            archived: true,
            idempotencyKey: 'archive-public',
          })
        ).body,
      );
      expect(archived.isError).not.toBe(true);
      expect(discord.restCalls('setThreadState')).toHaveLength(1);
    } finally {
      await threadApp.close();
    }
  });

  it('adding a user who is not in the guild is refused with no Discord call', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    // Discord's unknown-member answer; anything else would be a transport
    // fault and must throw rather than refuse (targets.ts owns that rule).
    guild.members.fetch = (() =>
      Promise.reject(
        Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 }),
      )) as typeof guild.members.fetch;
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      expect(
        callText((await mcpCall(threadApp, accessToken, 'create_thread', createArgs())).body)
          .isError,
      ).not.toBe(true);
      const threadId = resultThreadIdOf('thread-k1');
      injectThread(client, threadId, PLANNING, ChannelType.GuildPrivateThread);
      const refused = callText(
        (
          await mcpCall(threadApp, accessToken, 'add_thread_members', {
            guildId: '111111111111111111',
            threadId,
            userIds: [STRANGER],
            idempotencyKey: 'add-stranger',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(STRANGER);
      expect(refused.text).toContain('not a member');
      expect(discord.restCalls('addThreadMember')).toEqual([]);
      expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'add-stranger')).toBeUndefined();
    } finally {
      await threadApp.close();
    }
  });

  it('a forum post resolves names, matches tags case-insensitively, and stores both ids', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const posted = callText(
        (
          await mcpCall(threadApp, accessToken, 'create_forum_post', {
            guildId: '111111111111111111',
            forum: 'Help-Desk',
            title: 'club question',
            content: 'when is the next build night?',
            embeds: [{ title: 'plan', footer: 'club' }],
            tags: ['Question'],
            idempotencyKey: 'forum-k1',
          })
        ).body,
      );
      expect(posted.isError).not.toBe(true);
      const threadId = resultThreadIdOf('forum-k1');
      expect(posted.text).toContain(threadId);

      const posts = discord.restCalls('createForumPost');
      expect(posts).toHaveLength(1);
      expect(posts[0]?.args[1]).toBe(FORUM);
      expect(posts[0]?.args[2]).toMatchObject({
        name: 'club question',
        appliedTagIds: [TAG_QUESTION],
      });
      expect(posts[0]?.args[2]).toMatchObject({
        message: {
          content: 'when is the next build night?',
          embeds: [{ title: 'plan', footer: { text: 'club' } }],
          allowedMentions: { parse: [], roles: [], users: [] },
        },
      });
      const stored = discord.forumPost(threadId);
      expect(stored?.appliedTagIds).toEqual([TAG_QUESTION]);
      const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'forum-k1');
      expect(row?.kind).toBe('forum.post');
      expect(row?.capGroup).toBe('message');
      expect(row?.status).toBe('done');
      expect(row?.resultMessageId).toBeDefined();
      const audit = effectRepo
        .tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 })
        .find((entry) => entry.action === 'mcp.forum.post');
      expect(audit).toBeDefined();
      expect(audit?.subjectId).toBe(FORUM);
    } finally {
      await threadApp.close();
    }
  });

  it('an unknown forum tag refuses listing the available tag names', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const refused = callText(
        (
          await mcpCall(threadApp, accessToken, 'create_forum_post', {
            guildId: '111111111111111111',
            forum: FORUM,
            title: 'club question',
            content: 'when is the next build night?',
            tags: ['no-such-tag'],
            idempotencyKey: 'forum-bad-tag',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('no-such-tag');
      expect(refused.text).toContain('question');
      expect(refused.text).toContain('announcement');
      expect(discord.restCalls('createForumPost')).toEqual([]);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'forum-bad-tag'),
      ).toBeUndefined();
    } finally {
      await threadApp.close();
    }
  });

  it('create_thread in a forum refuses pointing at create_forum_post', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const refused = callText(
        (
          await mcpCall(
            threadApp,
            accessToken,
            'create_thread',
            createArgs({ channel: FORUM, idempotencyKey: 'thread-in-forum' }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('create_forum_post');
      expect(discord.restCalls('createThread')).toEqual([]);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'thread-in-forum'),
      ).toBeUndefined();
    } finally {
      await threadApp.close();
    }
  });

  it('create_forum_post in a non-forum refuses as not-a-forum', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const refused = callText(
        (
          await mcpCall(threadApp, accessToken, 'create_forum_post', {
            guildId: '111111111111111111',
            forum: PLANNING,
            title: 'club question',
            content: 'when is the next build night?',
            idempotencyKey: 'forum-not-forum',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('is not a forum');
      expect(discord.restCalls('createForumPost')).toEqual([]);
    } finally {
      await threadApp.close();
    }
  });

  it('an ambiguous channel name refuses listing the matches', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const refused = callText(
        (
          await mcpCall(
            threadApp,
            accessToken,
            'create_thread',
            createArgs({ channel: 'planning', idempotencyKey: 'thread-ambiguous' }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(PLANNING);
      expect(refused.text).toContain(PLANNING_DUP);
      expect(refused.text).toContain('Pass a channel id');
      expect(discord.restCalls('createThread')).toEqual([]);
    } finally {
      await threadApp.close();
    }
  });

  it('a dry run records without creating', async () => {
    seed();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = buildThreadClient();
    const threadApp = buildThreadApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const dry = callText(
        (
          await mcpCall(
            threadApp,
            accessToken,
            'create_thread',
            createArgs({ dryRun: true, firstMessage: { content: FIRST_TEXT } }),
          )
        ).body,
      );
      expect(dry.isError).not.toBe(true);
      expect(dry.text).toContain('Dry run is on');
      expect(discord.restCalls('createThread')).toEqual([]);
      expect(discord.restCalls('sendMessage')).toEqual([]);
      expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'thread-k1')?.status).toBe(
        'dry_run',
      );
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'thread-k1:first'),
      ).toBeUndefined();
    } finally {
      await threadApp.close();
    }
  });
});

/**
 * Task 6 Step 2, daemon side: the six message-write tools through the real
 * composition — target resolution, the protected-message guard, the live
 * authorship check, then the single `runMcpAction` pipeline each.
 *
 * The composed client's bot id is the testkit bot id, so a message
 * `defineMessage`d as authored by `BOT_USER_ID` is the bot's own and any
 * other author is a member's — the same authorship the wiring checks live.
 */
describe('/mcp message writes through the real composition', () => {
  const CHANNEL = '711111111111111111';
  const PANEL_MESSAGE = '722222222222222222';
  const ANCHOR_MESSAGE = '733333333333333333';
  const MEMBER_MESSAGE = '744444444444444444';
  const BOT_MESSAGE = '755555555555555555';
  const PIN_MESSAGE = '766666666666666666';
  const EMOJI_ID = '777777777777777777';
  const FOREIGN_EMOJI_ID = '788888888888888888';
  const MEMBER_USER = '799999999999999999';
  const BOT_ROLE = '811111111111111111';
  const TASK_ROLE = '822222222222222222';
  /** Distinctive bot-written text: must reach the undo row, never the audit row. */
  const ORIGINAL = 'picnic-probe-original-bot-text-that-must-never-reach-audit-zz9';

  interface WritesDiscordInternals {
    guilds: { _add: (data: object) => Guild };
  }

  /**
   * The message-write guild: one text channel, a bot member whose role
   * carries the given permission bits, and optionally guild emoji. The bot
   * user is the testkit bot, so `defineMessage`d bot authorship agrees with
   * the wiring's live `client.user.id` check.
   */
  const seedWritesGuild = (
    botPermissions: bigint,
    emojis: readonly { readonly id: string; readonly name: string }[] = [],
  ): void => {
    const internals = deps.client as unknown as WritesDiscordInternals;
    const mutable = deps.client as unknown as { user: unknown };
    mutable.user = (
      deps.client as unknown as { users: { _add: (data: object) => unknown } }
    ).users._add({ id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' });
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 0,
          permission_overwrites: [],
        },
      ],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 7,
          permissions: botPermissions.toString(),
          managed: true,
        },
      ],
      members: [
        {
          user: { id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' },
          roles: [BOT_ROLE],
        },
        { user: { id: MEMBER_USER, username: 'member', discriminator: '0' }, roles: [] },
      ],
      emojis: emojis.map((emoji) => ({ id: emoji.id, name: emoji.name })),
      unavailable: false,
    });
  };

  /** Base permissions: post and react, but neither pin half. */
  const BASE_PERMS =
    PermissionsBitField.Flags.ViewChannel |
    PermissionsBitField.Flags.SendMessages |
    PermissionsBitField.Flags.SendMessagesInThreads |
    PermissionsBitField.Flags.AddReactions;

  const allowWrites = (
    botPermissions: bigint = BASE_PERMS,
    emojis: readonly { readonly id: string; readonly name: string }[] = [],
  ): void => {
    seedWritesGuild(botPermissions, emojis);
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: CHANNEL,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
  };

  const writeCall = (accessToken: string, name: string, args: Record<string, unknown>) =>
    mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      accessToken,
    );

  const readCall = (
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

  const editArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guildId: '111111111111111111',
    channelId: CHANNEL,
    messageId: BOT_MESSAGE,
    content: 'edited through the mcp',
    idempotencyKey: 'write-k1',
    ...over,
  });

  /** No Discord write call of any kind — the eligibility refusal precedes every one. */
  const expectNoDiscordWrites = (): void => {
    expect(fakeDiscord.restCalls()).toHaveLength(0);
  };

  const seedPanel = (): void => {
    panelRepo.createPanel(
      t.scopes.forGuild(GUILD_A),
      panelDefinitionSchema.parse({
        panelId: 'roles',
        kind: 'adopted',
        channelId: CHANNEL,
        messageId: PANEL_MESSAGE,
        behaviour: 'toggle',
        component: 'reaction',
        options: [{ optionId: 'a', roleId: TASK_ROLE, emojiKey: 'u:1f9e0', position: 0 }],
      }),
      clock,
      [TASK_ROLE],
    );
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: PANEL_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
  };

  const seedAnchor = (): void => {
    const teamId = taskRepo.createTeam(
      t.scopes.forGuild(GUILD_A),
      { name: 'Tech', categoryId: CHANNEL, kind: 'subteam' },
      ACTOR,
      clock,
    );
    const taskId = taskRepo.createTask(
      t.scopes.forGuild(GUILD_A),
      {
        teamId,
        title: 'Project',
        assignmentKind: 'team',
        dueAt: clock + 86_400_000,
        timezone: 'America/Vancouver',
        destinationId: CHANNEL,
        createdBy: 'owner',
      },
      ACTOR,
      clock,
    );
    expect(
      taskRepo.recordTaskAnchor(t.scopes.forGuild(GUILD_A), taskId, CHANNEL, ANCHOR_MESSAGE, clock),
    ).toBe('recorded');
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: ANCHOR_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
  };

  it('a role-panel message is refused before any Discord call', async () => {
    allowWrites();
    seedPanel();
    const accessToken = await mintToken('bananasaurs:send');
    const refused = readCall(
      (
        await writeCall(
          accessToken,
          'edit_message',
          editArgs({ messageId: PANEL_MESSAGE, idempotencyKey: 'panel-edit' }),
        )
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('role-panel');
    // The protected check runs before the live authorship read: not even
    // `fetchMessageAuthor` reached Discord.
    expectNoDiscordWrites();
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'panel-edit')).toBeUndefined();
  });

  it('a task post is refused before any Discord call', async () => {
    allowWrites();
    seedAnchor();
    const accessToken = await mintToken('bananasaurs:send');
    const refused = readCall(
      (
        await writeCall(accessToken, 'delete_message', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          messageId: ANCHOR_MESSAGE,
          idempotencyKey: 'anchor-delete',
        })
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('task post');
    expectNoDiscordWrites();
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'anchor-delete')).toBeUndefined();
  });

  it("a member's message is refused with no Discord write call", async () => {
    allowWrites();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: MEMBER_MESSAGE,
      authorId: MEMBER_USER,
      content: 'a member wrote this',
    });
    const accessToken = await mintToken('bananasaurs:send');
    const refused = readCall(
      (
        await writeCall(
          accessToken,
          'edit_message',
          editArgs({ messageId: MEMBER_MESSAGE, idempotencyKey: 'member-edit' }),
        )
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('someone else');
    // The live authorship read ran (one read), but no write did.
    expect(fakeDiscord.restCalls('editMessage')).toHaveLength(0);
    expect(fakeDiscord.restCalls('deleteMessage')).toHaveLength(0);
    expect(fakeDiscord.restCalls('pinMessage')).toHaveLength(0);
    expect(fakeDiscord.restCalls('unpinMessage')).toHaveLength(0);
    expect(fakeDiscord.restCalls('createReaction')).toHaveLength(0);
    expect(fakeDiscord.restCalls('deleteOwnReaction')).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'member-edit')).toBeUndefined();
  });

  it('an edit records the previous content for undo, never in the audit row', async () => {
    allowWrites();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const accessToken = await mintToken('bananasaurs:send');
    const found = readCall((await writeCall(accessToken, 'edit_message', editArgs())).body);
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('Edited message');
    expect(fakeDiscord.restCalls('editMessage')).toHaveLength(1);

    // The undo row keeps the bot's own previous text — for `undo_action`.
    const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'write-k1');
    expect(row?.status).toBe('done');
    expect(row?.resultMessageId).toBe(BOT_MESSAGE);
    const undo = JSON.parse(row?.undoJson ?? '{}') as Record<string, unknown>;
    expect(undo['content']).toBe(ORIGINAL);
    expect(undo['embeds']).toEqual([]);

    // The edit can never ping, even when the new text carries a mention.
    const sent = fakeDiscord.restCalls('editMessage')[0]?.args[2] as {
      allowedMentions?: unknown;
    };
    expect(sent.allowedMentions).toEqual({ parse: [], roles: [], users: [] });

    // The audit row carries ids and the outcome — never either text (rule 4).
    const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 });
    const audit = trail.find((entry) => entry.action === 'mcp.message.edit');
    expect(audit).toBeDefined();
    expect(audit?.actorType).toBe('mcp_operator');
    expect(audit?.via).toBe('http');
    expect(JSON.stringify(trail)).not.toContain(ORIGINAL);
    expect(JSON.stringify(trail)).not.toContain('edited through the mcp');
  });

  it('a delete reports that it cannot be undone', async () => {
    allowWrites();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const accessToken = await mintToken('bananasaurs:send');
    const found = readCall(
      (
        await writeCall(accessToken, 'delete_message', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          messageId: BOT_MESSAGE,
          idempotencyKey: 'write-delete',
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('cannot be undone');
    expect(fakeDiscord.restCalls('deleteMessage')).toHaveLength(1);
    const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'write-delete');
    expect(row?.status).toBe('done');
    expect(row?.undoJson).toBeUndefined();
  });

  it('a pin without PinMessages and ManageMessages is refused naming both', async () => {
    allowWrites();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: PIN_MESSAGE,
      authorId: MEMBER_USER,
      content: 'pin me',
    });
    const accessToken = await mintToken('bananasaurs:send');
    const refused = readCall(
      (
        await writeCall(accessToken, 'pin_message', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          messageId: PIN_MESSAGE,
          idempotencyKey: 'pin-denied',
        })
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('PinMessages');
    expect(refused.text).toContain('ManageMessages');
    expect(fakeDiscord.restCalls('pinMessage')).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'pin-denied')).toBeUndefined();
  });

  it('a pin with only PinMessages passes, on any in-scope message', async () => {
    allowWrites(BASE_PERMS | PermissionsBitField.Flags.PinMessages);
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: PIN_MESSAGE,
      authorId: MEMBER_USER,
      content: 'pin me',
    });
    const accessToken = await mintToken('bananasaurs:send');
    const found = readCall(
      (
        await writeCall(accessToken, 'pin_message', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          messageId: PIN_MESSAGE,
          idempotencyKey: 'pin-ok',
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('Pinned message');
    expect(fakeDiscord.restCalls('pinMessage')).toHaveLength(1);
    const pinRow = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'pin-ok');
    expect(JSON.parse(pinRow?.undoJson ?? '{}')).toEqual({ op: 'unpin' });

    const unpinned = readCall(
      (
        await writeCall(accessToken, 'unpin_message', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          messageId: PIN_MESSAGE,
          idempotencyKey: 'unpin-ok',
        })
      ).body,
    );
    expect(unpinned.isError).not.toBe(true);
    expect(fakeDiscord.restCalls('unpinMessage')).toHaveLength(1);
    const unpinRow = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'unpin-ok');
    expect(JSON.parse(unpinRow?.undoJson ?? '{}')).toEqual({ op: 'pin' });
  });

  it("a foreign guild's custom emoji is refused with no Discord call", async () => {
    allowWrites(BASE_PERMS, [{ id: EMOJI_ID, name: 'party' }]);
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const accessToken = await mintToken('bananasaurs:send');
    const refused = readCall(
      (
        await writeCall(accessToken, 'add_reaction', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          messageId: BOT_MESSAGE,
          emoji: `party:${FOREIGN_EMOJI_ID}`,
          idempotencyKey: 'react-foreign',
        })
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('not usable in guild');
    expect(fakeDiscord.restCalls('createReaction')).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'react-foreign')).toBeUndefined();
  });

  it('a unicode emoji and this guild emoji react, with canonical keys', async () => {
    allowWrites(BASE_PERMS, [{ id: EMOJI_ID, name: 'party' }]);
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const accessToken = await mintToken('bananasaurs:send');
    const first = readCall(
      (
        await writeCall(accessToken, 'add_reaction', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          messageId: BOT_MESSAGE,
          emoji: '👍',
          idempotencyKey: 'react-unicode',
        })
      ).body,
    );
    expect(first.isError).not.toBe(true);
    const second = readCall(
      (
        await writeCall(accessToken, 'add_reaction', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          messageId: BOT_MESSAGE,
          emoji: 'party:777777777777777777',
          idempotencyKey: 'react-custom',
        })
      ).body,
    );
    expect(second.isError).not.toBe(true);
    const reacted = fakeDiscord.restCalls('createReaction');
    expect(reacted).toHaveLength(2);
    expect(reacted[0]?.args[2]).toBe('u:1f44d');
    expect(reacted[1]?.args[2]).toBe(`c:${EMOJI_ID}`);
    const reactRow = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'react-unicode');
    expect(JSON.parse(reactRow?.undoJson ?? '{}')).toEqual({
      op: 'remove-reaction',
      emoji: 'u:1f44d',
    });

    const removed = readCall(
      (
        await writeCall(accessToken, 'remove_reaction', {
          guildId: '111111111111111111',
          channelId: CHANNEL,
          messageId: BOT_MESSAGE,
          emoji: '👍',
          idempotencyKey: 'unreact-unicode',
        })
      ).body,
    );
    expect(removed.isError).not.toBe(true);
    expect(fakeDiscord.restCalls('deleteOwnReaction')).toHaveLength(1);
    const unreactRow = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'unreact-unicode');
    expect(JSON.parse(unreactRow?.undoJson ?? '{}')).toEqual({
      op: 'add-reaction',
      emoji: 'u:1f44d',
    });
  });

  it('a write for the other guild is refused with no Discord call', async () => {
    allowWrites();
    const accessToken = await mintToken('bananasaurs:send');
    // The token reaches guild A only (`mcp.authorize` is granted there and
    // nowhere else), so naming guild B fails the tool-layer guild gate
    // before the port — and Discord — is ever reached.
    const refused = readCall(
      (
        await writeCall(
          accessToken,
          'edit_message',
          editArgs({ guildId: '222222222222222222', idempotencyKey: 'other-guild-edit' }),
        )
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(GUILD_REFUSAL_MESSAGE);
    expectNoDiscordWrites();
    expect(
      mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_B), 'other-guild-edit'),
    ).toBeUndefined();
  });

  it('the same idempotency key twice edits once and answers the second as a replay', async () => {
    allowWrites();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const accessToken = await mintToken('bananasaurs:send');
    const first = readCall((await writeCall(accessToken, 'edit_message', editArgs())).body);
    expect(first.isError).not.toBe(true);
    const second = readCall((await writeCall(accessToken, 'edit_message', editArgs())).body);
    expect(second.isError).not.toBe(true);
    expect(second.text).toContain('Already recorded under this idempotency key');
    expect(fakeDiscord.restCalls('editMessage')).toHaveLength(1);
  });

  it('the kill switch refuses the edit with no Discord write', async () => {
    allowWrites();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    guildRepo.setKillswitch(t.scopes.forGuild(GUILD_A), true, clock);
    const accessToken = await mintToken('bananasaurs:send');
    const refused = readCall(
      (await writeCall(accessToken, 'edit_message', editArgs({ idempotencyKey: 'kill-edit' })))
        .body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('kill switch');
    expect(fakeDiscord.restCalls('editMessage')).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'kill-edit')).toBeUndefined();
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

  it('(slice 2 task 3) a reply stored through the repo renders its reply link', async () => {
    // Through the real composition: the daemon's `toMcpArchiveMessage`
    // projection must carry `replyToMessageId` for the tool layer to render
    // it — a dropped field here would read as a non-reply, never an error.
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_B), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    seedArchive();
    const REPLY = '999999999999999991';
    archiveRepo.upsertMessage(t.scopes.forGuild(GUILD_B), {
      messageId: REPLY,
      channelId: CHANNEL,
      authorId: MEMBER,
      content: 'seconding the beta plans',
      createdAt: clock + 1,
      editedAt: undefined,
      attachments: [],
      replyToMessageId: MESSAGE_B,
    });
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '222222222222222222',
          messageId: REPLY,
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain(`reply to: ${MESSAGE_B}\nseconding the beta plans`);
  });

  it('(slice 2 task 6) get_message appends live pin state and reaction counts', async () => {
    // Through the real composition: the daemon's `messageMeta` port reads
    // Discord live (the fake here), and the tool appends the metadata JSON
    // line after the envelope. The archived row and the live message share
    // ids, the way a real archived message matches its Discord original.
    // ADR 0126 Task 15: the live read needs Read, so the channel is injected
    // into the gateway cache and granted a Read row here.
    seedArchive();
    (deps.client as unknown as { guilds: { _add: (data: object) => unknown } }).guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'general',
          position: 0,
          permission_overwrites: [],
        },
      ],
      roles: [{ id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false }],
      members: [],
      emojis: [],
      unavailable: false,
    });
    channelReadRepo.allowRead(t.scopes.forGuild(GUILD_A), {
      channelId: CHANNEL,
      scopeKind: 'channel',
      now: clock,
    });
    fakeDiscord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE_A, pinned: true });
    fakeDiscord.offlineReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE_A,
      userId: MEMBER,
      emoji: 'u:1f44d',
    });
    fakeDiscord.offlineReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE_A,
      userId: MEMBER,
      emoji: 'c:777777777777777777',
    });
    fakeDiscord.offlineReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE_A,
      userId: '999999999999999999',
      emoji: 'c:777777777777777777',
    });
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '111111111111111111',
          messageId: MESSAGE_A,
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('alpha plans for the guild A picnic');
    expect(found.text).toContain(
      '{"pinned":true,"reactions":[{"emoji":"👍","count":1},{"emoji":"<:unknown:777777777777777777>","count":2}]}',
    );
  });

  it('(ADR 0126) get_message omits live pin state when Read is off, without calling Discord', async () => {
    // The live message exists and is pinned, but the channel holds no Read
    // row: the denial answers `undefined` exactly like a gone message, so
    // the archive stands alone and the live endpoint is never reached.
    seedArchive();
    (deps.client as unknown as { guilds: { _add: (data: object) => unknown } }).guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'general',
          position: 0,
          permission_overwrites: [],
        },
      ],
      roles: [{ id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false }],
      members: [],
      emojis: [],
      unavailable: false,
    });
    fakeDiscord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE_A, pinned: true });
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '111111111111111111',
          messageId: MESSAGE_A,
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('alpha plans for the guild A picnic');
    expect(found.text).not.toContain('"pinned"');
    expect(fakeDiscord.restCalls('fetchMessageMeta')).toEqual([]);
  });

  it('N6: a messageMeta Read denial records one ids-only line', async () => {
    seedArchive();
    (deps.client as unknown as { guilds: { _add: (data: object) => unknown } }).guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'general',
          position: 0,
          permission_overwrites: [],
        },
      ],
      roles: [{ id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false }],
      members: [],
      emojis: [],
      unavailable: false,
    });
    fakeDiscord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE_A, pinned: true });
    const lines: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const capture = (fields: Record<string, unknown>, msg: string): void => {
      lines.push({ fields, msg });
    };
    const logger = {
      info: capture,
      warn: capture,
      error: capture,
      debug() {},
      fatal() {},
      trace() {},
    } as never;
    const logged = buildDashboardApp({ ...deps, logger });
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await mcpPost(
            logged,
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'get_message',
                arguments: { guildId: '111111111111111111', messageId: MESSAGE_A },
              },
            },
            accessToken,
          )
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('alpha plans for the guild A picnic');
      expect(found.text).not.toContain('"pinned"');

      const denials = lines.filter((line) => line.msg === 'mcp messageMeta read denied');
      expect(denials).toHaveLength(1);
      expect(denials[0]?.fields).toMatchObject({
        guildId: GUILD_A,
        channelId: CHANNEL,
        purpose: 'read',
        reason: 'not-granted',
      });
      expect(JSON.stringify(denials[0])).not.toContain('alpha plans');
    } finally {
      await logged.close();
    }
  });

  it('(ADR 0126) get_message for a message in a No-access thread answers like an unknown id', async () => {
    // ADR 0126 M6 supersedes the Task 15 pin-state assertion: a thread
    // excluded on its own hides its rows entirely — `findMessage` answers
    // `undefined` exactly like an unknown id, so neither the message text
    // nor live pin state shows, and the live endpoint is never reached.
    const THREAD = '488888888888888888';
    const THREAD_MESSAGE = '489999999999999999';
    seedArchive();
    (deps.client as unknown as { guilds: { _add: (data: object) => unknown } }).guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'general',
          position: 0,
          permission_overwrites: [],
        },
        {
          id: THREAD,
          guild_id: GUILD_A,
          type: ChannelType.GuildPublicThread,
          name: 'plans-thread',
          parent_id: CHANNEL,
          position: 0,
          permission_overwrites: [],
          thread_metadata: {
            archived: false,
            auto_archive_duration: 60,
            archive_timestamp: '2026-09-01T00:00:00.000Z',
            locked: false,
          },
        },
      ],
      roles: [{ id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false }],
      members: [],
      emojis: [],
      unavailable: false,
    });
    channelReadRepo.allowRead(t.scopes.forGuild(GUILD_A), {
      channelId: CHANNEL,
      scopeKind: 'channel',
      now: clock,
    });
    archiveRepo.upsertMessage(t.scopes.forGuild(GUILD_A), {
      messageId: THREAD_MESSAGE,
      channelId: CHANNEL,
      threadId: THREAD,
      authorId: MEMBER,
      content: 'thread plans for the guild A picnic',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD_A), THREAD);
    fakeDiscord.defineMessage({ channelId: THREAD, messageId: THREAD_MESSAGE, pinned: true });
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '111111111111111111',
          messageId: THREAD_MESSAGE,
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toBe(`No archived message ${THREAD_MESSAGE} in guild 111111111111111111.`);
    expect(found.text).not.toContain('thread plans for the guild A picnic');
    expect(found.text).not.toContain('"pinned"');
    expect(fakeDiscord.restCalls('fetchMessageMeta')).toEqual([]);
  });

  it('(slice 2 task 6) get_message answers the archive alone when Discord no longer has it', async () => {
    // The review-focus case: the message is archived but gone live (the
    // fake was never told about it, mirroring the adapter's 404 fold), and
    // the call still returns the archive answer — metadata omitted, no
    // refusal.
    seedArchive();
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '111111111111111111',
          messageId: MESSAGE_A,
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('alpha plans for the guild A picnic');
    expect(found.text).not.toContain('"pinned"');
  });

  it('(slice 2 task 6) get_message answers the archive alone when the live read throws', async () => {
    // A Discord fault (here a 429) behind `messageMeta` is routine, not a
    // refusal: one operator trace line, and the archive answer without the
    // metadata line.
    seedArchive();
    fakeDiscord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE_A });
    fakeDiscord.failNext('fetchMessageMeta', FakeDiscord.rateLimited());
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '111111111111111111',
          messageId: MESSAGE_A,
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('alpha plans for the guild A picnic');
    expect(found.text).not.toContain('"pinned"');
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

describe('/mcp get_server_context across two guilds', () => {
  /**
   * Slice 2 Task 1, daemon side: `get_server_context` through the real stack
   * — Fastify + `registerMcpRoutes` + `createMcpServer` + the real
   * `contextPortFor` over the real repositories — with a token minted through
   * the real OAuth flow. The load-bearing assertion is guild isolation: the
   * stored card for A never answers for B, and vice versa.
   *
   * The app is rebuilt with the instance's redacted config carrying the club
   * time zone (`testInstanceFor` redacts to `{}`), the way production's
   * `redactedConfig` carries the real `BANANASAURS_TIME_ZONE`.
   */
  const zonedApp = (): FastifyInstance =>
    buildDashboardApp({
      ...deps,
      instance: {
        ...deps.instance,
        redactedConfig: () => ({ BANANASAURS_TIME_ZONE: 'America/Vancouver' }),
      },
    });

  const mcpCallOn = (
    target: FastifyInstance,
    accessToken: string,
    name: string,
    args: Record<string, unknown>,
  ) =>
    mcpPost(
      target,
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

  it('returns the stored server card for guild A only', async () => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_B), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    assistantRepo.putServerCard(
      t.scopes.forGuild(GUILD_A),
      'Guild A server card: alpha clubhouse rules.',
      clock,
    );
    assistantRepo.putServerCard(
      t.scopes.forGuild(GUILD_B),
      'Guild B server card: beta clubhouse rules.',
      clock,
    );
    const zoned = zonedApp();
    try {
      const accessToken = await mintToken('bananasaurs:read', zoned);

      const own = callText(
        (
          await mcpCallOn(zoned, accessToken, 'get_server_context', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(own.isError).not.toBe(true);
      expect(own.text).toContain('time zone America/Vancouver');
      expect(own.text).toContain('alpha clubhouse rules');
      expect(own.text).not.toContain('beta clubhouse rules');
      expect(own.text).toContain('Enabled assistant skills:');

      // B's card through B answers B's text — never A's.
      const other = callText(
        (
          await mcpCallOn(zoned, accessToken, 'get_server_context', {
            guildId: '222222222222222222',
          })
        ).body,
      );
      expect(other.isError).not.toBe(true);
      expect(other.text).toContain('beta clubhouse rules');
      expect(other.text).not.toContain('alpha clubhouse rules');
    } finally {
      await zoned.close();
    }
  });
});

/**
 * Slice 2 Task 2, daemon side: `search_resources` and `open_resource`
 * through the real stack — Fastify + `registerMcpRoutes` + `createMcpServer`
 * + the real `resourcesPortFor` over the real repositories — with a token
 * minted through the real OAuth flow.
 *
 * Seeded through the storage repositories, never a fake port: an enabled
 * resource with cached chunks, a disabled resource with cached chunks (its
 * text must stay invisible even to an exact query), an enabled resource
 * with no cache (the dashboard pointer, never a fetch), and a second
 * guild's cache proving cross-guild isolation.
 */
describe('/mcp resource tools across two guilds', () => {
  const seedResource = (
    guild: typeof GUILD_A,
    input: {
      readonly id: string;
      readonly title: string;
      readonly url: string;
      readonly enabled: boolean;
    },
  ): void => {
    assistantRepo.putResource(t.scopes.forGuild(guild), {
      id: input.id,
      guildId: guild,
      title: input.title,
      url: input.url,
      kind: 'website',
      enabled: input.enabled,
      reviewedAt: new Date(clock).toISOString(),
    });
  };

  const seedCached = (
    guild: typeof GUILD_A,
    resourceId: string,
    url: string,
    chunks: readonly Chunk[],
  ): void => {
    const scope = t.scopes.forGuild(guild);
    const docId = computeDocId(url);
    resourceCacheRepo.upsertDocument(scope, {
      resourceId,
      docId,
      url,
      path: '/guide',
      title: `${resourceId} doc`,
      contentHash: `hash-${resourceId}`,
      fetchedAt: clock,
      bytes: 100,
      status: 'ok',
    });
    resourceCacheRepo.replaceChunks(scope, docId, resourceId, chunks);
  };

  const chunk = (ordinal: number, text: string): Chunk => ({
    ordinal,
    headingPath: `Guide › Part ${String(ordinal)}`,
    lineStart: ordinal + 1,
    lineEnd: ordinal + 1,
    text,
  });

  const seedAll = (): void => {
    seedResource(GUILD_A, {
      id: 'handbook',
      title: 'Alpha handbook',
      url: 'https://example.com/alpha-handbook',
      enabled: true,
    });
    seedCached(GUILD_A, 'handbook', 'https://example.com/alpha-handbook', [
      chunk(0, 'the alphahandbookword rota for the alpha clubhouse'),
    ]);
    // Disabled but cached: search must not find it, open must not see it.
    seedResource(GUILD_A, {
      id: 'off',
      title: 'Disabled notes',
      url: 'https://example.com/off-notes',
      enabled: false,
    });
    seedCached(GUILD_A, 'off', 'https://example.com/off-notes', [
      chunk(0, 'the offkeywordword rota nobody should read over mcp'),
    ]);
    // Enabled but never fetched: the dashboard pointer, never a refresh.
    seedResource(GUILD_A, {
      id: 'empty',
      title: 'Empty guide',
      url: 'https://example.com/empty-guide',
      enabled: true,
    });
    seedResource(GUILD_B, {
      id: 'beta-guide',
      title: 'Beta guide',
      url: 'https://example.com/beta-guide',
      enabled: true,
    });
    seedCached(GUILD_B, 'beta-guide', 'https://example.com/beta-guide', [
      chunk(0, 'the betaguideword rota for the beta clubhouse'),
    ]);
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

  const grantB = (): void => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_B), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
  };

  it('search_resources finds the enabled cache but never the disabled one', async () => {
    grantB();
    seedAll();
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'search_resources', {
          guildId: '111111111111111111',
          query: 'alphahandbookword',
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('alphahandbookword');
    expect(found.text).toContain('Alpha handbook');

    // An exact query for the disabled resource's distinctive word finds
    // nothing: the daemon scopes the search to the enabled ids.
    const hidden = callText(
      (
        await mcpCall(accessToken, 'search_resources', {
          guildId: '111111111111111111',
          query: 'offkeywordword',
        })
      ).body,
    );
    expect(hidden.isError).not.toBe(true);
    expect(hidden.text).toContain('0 matches');
    expect(hidden.text).not.toContain('offkeywordword');
  });

  it('open_resource refuses a disabled id without reading chunks, and points at the dashboard when unfetched (never fetching)', async () => {
    grantB();
    seedAll();
    const accessToken = await mintToken();

    const refused = callText(
      (
        await mcpCall(accessToken, 'open_resource', {
          guildId: '111111111111111111',
          resourceId: 'off',
        })
      ).body,
    );
    expect(refused.isError).not.toBe(true);
    expect(refused.text).toContain('No enabled resource with id "off".');
    expect(refused.text).not.toContain('offkeywordword');

    const pending = callText(
      (
        await mcpCall(accessToken, 'open_resource', {
          guildId: '111111111111111111',
          resourceId: 'empty',
        })
      ).body,
    );
    expect(pending.isError).not.toBe(true);
    expect(pending.text).toContain(
      'This resource has not been fetched yet; the owner can refresh it in the dashboard.',
    );
    // Cache only: nothing was fetched, so nothing new is cached afterwards.
    expect(resourceCacheRepo.listDocuments(t.scopes.forGuild(GUILD_A), 'empty')).toHaveLength(0);
  });

  it("open_resource reads the enabled cache, and guild B's cache is invisible to guild A", async () => {
    grantB();
    seedAll();
    const accessToken = await mintToken();

    const own = callText(
      (
        await mcpCall(accessToken, 'open_resource', {
          guildId: '111111111111111111',
          resourceId: 'handbook',
        })
      ).body,
    );
    expect(own.isError).not.toBe(true);
    expect(own.text).toContain('Alpha handbook');
    expect(own.text).toContain('https://example.com/alpha-handbook');
    expect(own.text).toContain('alphahandbookword');
    expect(own.text).not.toContain('betaguideword');

    // Guild B's resource id through guild A is unknown — never B's text.
    const cross = callText(
      (
        await mcpCall(accessToken, 'open_resource', {
          guildId: '111111111111111111',
          resourceId: 'beta-guide',
        })
      ).body,
    );
    expect(cross.isError).not.toBe(true);
    expect(cross.text).toContain('No enabled resource with id "beta-guide".');
    expect(cross.text).not.toContain('betaguideword');

    // Same channel of proof for search: B's distinctive word finds nothing
    // through A, but answers through B.
    const crossSearch = callText(
      (
        await mcpCall(accessToken, 'search_resources', {
          guildId: '111111111111111111',
          query: 'betaguideword',
        })
      ).body,
    );
    expect(crossSearch.isError).not.toBe(true);
    expect(crossSearch.text).toContain('0 matches');
    expect(crossSearch.text).not.toContain('betaguideword');

    const home = callText(
      (
        await mcpCall(accessToken, 'search_resources', {
          guildId: '222222222222222222',
          query: 'betaguideword',
        })
      ).body,
    );
    expect(home.isError).not.toBe(true);
    expect(home.text).toContain('betaguideword');
    expect(home.text).not.toContain('alphahandbookword');
  });
});

/**
 * Task 9 (ADR 0126): every MCP read of archived messages hides No-access
 * channels — the logging exclusions — while paused (Archive off) channels
 * stay visible, and `list_channels` omits No-access channels.
 */
describe('/mcp archive reads obey No access', () => {
  const CH_OK = '611111111111111111';
  const CH_NOACCESS = '622222222222222222';
  const CH_PAUSED = '633333333333333333';
  const MEMBER = '666666666666666666';
  const MSG_OK = '711111111111111111';
  const MSG_NOACCESS = '722222222222222222';
  const MSG_PAUSED = '733333333333333333';
  const UNKNOWN_MSG = '799999999999999999';

  const seedNoAccessWorld = (): void => {
    (deps.client as unknown as { guilds: { _add: (data: object) => unknown } }).guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CH_OK,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'open-planning',
          position: 0,
          permission_overwrites: [],
        },
        {
          id: CH_NOACCESS,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'sealed-vault',
          position: 1,
          permission_overwrites: [],
        },
        {
          id: CH_PAUSED,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'paused-lounge',
          position: 2,
          permission_overwrites: [],
        },
      ],
      roles: [{ id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false }],
      members: [],
      emojis: [],
      unavailable: false,
    });
    const scope = t.scopes.forGuild(GUILD_A);
    for (const channelId of [CH_OK, CH_NOACCESS, CH_PAUSED] as const) {
      archiveRepo.enableChannel(scope, { channelId, attachmentPolicy: 'none', now: clock });
    }
    archiveRepo.upsertMessage(scope, {
      messageId: MSG_OK,
      channelId: CH_OK,
      authorId: MEMBER,
      content: 'alpha picnic plans for everyone',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scope, {
      messageId: MSG_NOACCESS,
      channelId: CH_NOACCESS,
      authorId: MEMBER,
      content: 'bravo secret picnic plans for the vault',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scope, {
      messageId: MSG_PAUSED,
      channelId: CH_PAUSED,
      authorId: MEMBER,
      content: 'charlie picnic plans while paused',
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    loggingRepo.excludeChannel(scope, CH_NOACCESS);
    archiveRepo.pauseChannel(scope, CH_PAUSED);
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

  it('get_message for a message in a No-access channel answers exactly like an unknown id', async () => {
    seedNoAccessWorld();
    const accessToken = await mintToken();

    const denied = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '111111111111111111',
          messageId: MSG_NOACCESS,
        })
      ).body,
    );
    const unknown = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '111111111111111111',
          messageId: UNKNOWN_MSG,
        })
      ).body,
    );
    expect(denied.isError).not.toBe(true);
    expect(unknown.isError).not.toBe(true);
    // No oracle: the two answers are identical modulo the echoed id.
    expect(denied.text.replace(MSG_NOACCESS, 'X')).toBe(unknown.text.replace(UNKNOWN_MSG, 'X'));
    expect(denied.text).toContain('No archived message');
    expect(denied.text).not.toContain('bravo secret');
  });

  it('search_messages omits a No-access channel and keeps a paused one', async () => {
    seedNoAccessWorld();
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'search_messages', {
          guildId: '111111111111111111',
          query: 'picnic',
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    // FTS highlights the match as `[picnic]`, so the assertions pin the
    // words around it rather than the unmarked query text.
    expect(found.text).toContain('alpha');
    expect(found.text).toContain('charlie');
    expect(found.text).not.toContain('bravo secret');
  });

  it('read_channel_history for a No-access channel answers empty', async () => {
    seedNoAccessWorld();
    const accessToken = await mintToken();

    const history = callText(
      (
        await mcpCall(accessToken, 'read_channel_history', {
          guildId: '111111111111111111',
          channelId: CH_NOACCESS,
        })
      ).body,
    );
    expect(history.isError).not.toBe(true);
    expect(history.text).toContain('showing 0 messages');
    expect(history.text).not.toContain('bravo secret');
  });

  it('list_channels omits a No-access channel', async () => {
    seedNoAccessWorld();
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'list_channels', {
          guildId: '111111111111111111',
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('open-planning');
    expect(found.text).toContain('paused-lounge');
    expect(found.text).not.toContain('sealed-vault');
  });
});

/**
 * M6: thread messages are archived under the parent's channel_id with
 * thread_id set, so every channel-level No-access filter misses a thread
 * excluded on its own. Each archived read must also drop rows whose
 * threadId is No access.
 */
describe('/mcp archive reads hide a thread excluded on its own', () => {
  const PARENT = '644444444444444444';
  const THREAD_HIDDEN = '655555555555555555';
  const THREAD_SHOWN = '666666666666666666';
  const FORUM = '677777777777777777';
  const FORUM_HIDDEN = '688888888888888888';
  const FORUM_SHOWN = '699999999999999999';
  const MEMBER = '611111111111111112';
  const MSG_PARENT = '744444444444444444';
  const MSG_HIDDEN = '755555555555555555';
  const MSG_SHOWN = '766666666666666666';
  const MSG_FORUM_HIDDEN = '777777777777777771';
  const MSG_FORUM_SHOWN = '788888888888888881';
  const UNKNOWN_MSG = '799999999999999999';

  const threadMetadata = {
    archived: false,
    auto_archive_duration: 1440,
    archive_timestamp: '2026-09-01T00:00:00.000Z',
    locked: false,
  };

  const seedThreadWorld = (): void => {
    (deps.client as unknown as { guilds: { _add: (data: object) => unknown } }).guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: PARENT,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'thread-parent',
          position: 10,
          permission_overwrites: [],
        },
        {
          id: THREAD_HIDDEN,
          guild_id: GUILD_A,
          type: ChannelType.GuildPublicThread,
          name: 'hidden-thread',
          parent_id: PARENT,
          thread_metadata: threadMetadata,
        },
        {
          id: THREAD_SHOWN,
          guild_id: GUILD_A,
          type: ChannelType.GuildPublicThread,
          name: 'shown-thread',
          parent_id: PARENT,
          thread_metadata: threadMetadata,
        },
        {
          id: FORUM,
          guild_id: GUILD_A,
          type: ChannelType.GuildForum,
          name: 'help-forum',
          position: 11,
          permission_overwrites: [],
        },
        {
          id: FORUM_HIDDEN,
          guild_id: GUILD_A,
          type: ChannelType.GuildPublicThread,
          name: 'hidden-post',
          parent_id: FORUM,
          thread_metadata: threadMetadata,
        },
        {
          id: FORUM_SHOWN,
          guild_id: GUILD_A,
          type: ChannelType.GuildPublicThread,
          name: 'shown-post',
          parent_id: FORUM,
          thread_metadata: threadMetadata,
        },
      ],
      roles: [{ id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false }],
      members: [],
      emojis: [],
      unavailable: false,
    });
    const scope = t.scopes.forGuild(GUILD_A);
    for (const channelId of [PARENT, FORUM] as const) {
      archiveRepo.enableChannel(scope, { channelId, attachmentPolicy: 'none', now: clock });
    }
    const upsert = (
      messageId: string,
      channelId: string,
      content: string,
      threadId?: string,
    ): void => {
      archiveRepo.upsertMessage(scope, {
        messageId,
        channelId,
        ...(threadId === undefined ? {} : { threadId }),
        authorId: MEMBER,
        content,
        createdAt: clock,
        editedAt: undefined,
        attachments: [],
      });
    };
    upsert(MSG_PARENT, PARENT, 'quince parent commons');
    upsert(MSG_HIDDEN, PARENT, 'quince hidden tango', THREAD_HIDDEN);
    upsert(MSG_SHOWN, PARENT, 'quince shown sierra', THREAD_SHOWN);
    upsert(MSG_FORUM_HIDDEN, FORUM, 'quince forum hidden tango', FORUM_HIDDEN);
    upsert(MSG_FORUM_SHOWN, FORUM, 'quince forum shown sierra', FORUM_SHOWN);
    loggingRepo.excludeChannel(scope, THREAD_HIDDEN);
    loggingRepo.excludeChannel(scope, FORUM_HIDDEN);
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

  it('search_messages omits the excluded thread while keeping its sibling', async () => {
    seedThreadWorld();
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'search_messages', {
          guildId: '111111111111111111',
          query: 'quince',
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('parent commons');
    expect(found.text).toContain('shown sierra');
    expect(found.text).not.toContain('hidden tango');
  });

  it('get_message for a message in the excluded thread answers exactly like an unknown id', async () => {
    seedThreadWorld();
    const accessToken = await mintToken();

    const denied = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '111111111111111111',
          messageId: MSG_HIDDEN,
        })
      ).body,
    );
    const unknown = callText(
      (
        await mcpCall(accessToken, 'get_message', {
          guildId: '111111111111111111',
          messageId: UNKNOWN_MSG,
        })
      ).body,
    );
    expect(denied.isError).not.toBe(true);
    expect(unknown.isError).not.toBe(true);
    expect(denied.text.replace(MSG_HIDDEN, 'X')).toBe(unknown.text.replace(UNKNOWN_MSG, 'X'));
    expect(denied.text).toContain('No archived message');
    expect(denied.text).not.toContain('hidden tango');
  });

  it("read_channel_history on the forum omits the excluded post's rows", async () => {
    seedThreadWorld();
    const accessToken = await mintToken();

    const history = callText(
      (
        await mcpCall(accessToken, 'read_channel_history', {
          guildId: '111111111111111111',
          channelId: FORUM,
        })
      ).body,
    );
    expect(history.isError).not.toBe(true);
    expect(history.text).toContain('shown sierra');
    expect(history.text).not.toContain('hidden tango');
  });

  it('N5 search: the total equals the visible count from SQL, not the shown count', async () => {
    seedThreadWorld();
    const accessToken = await mintToken();

    const found = callText(
      (
        await mcpCall(accessToken, 'search_messages', {
          guildId: '111111111111111111',
          query: 'quince',
          limit: 1,
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    // Three visible matches (parent commons, shown sierra, forum shown
    // sierra); the limit cuts the page, never the total.
    const [head] = found.text.split('\n');
    expect(head).toBe('Archive search in guild 111111111111111111: 3 matches (showing 1).');
  });

  it("N5 history: the page stays full-length when an excluded post's rows interleave", async () => {
    seedThreadWorld();
    const scope = t.scopes.forGuild(GUILD_A);
    const extra = (messageId: string, threadId: string, content: string): void => {
      archiveRepo.upsertMessage(scope, {
        messageId,
        channelId: FORUM,
        threadId,
        authorId: MEMBER,
        content,
        createdAt: clock,
        editedAt: undefined,
        attachments: [],
      });
    };
    extra('790000000000000001', FORUM_SHOWN, 'quince forum new sierra');
    extra('789000000000000001', FORUM_HIDDEN, 'quince forum mid tango');
    extra('780000000000000001', FORUM_SHOWN, 'quince forum old sierra');
    const accessToken = await mintToken();

    const history = callText(
      (
        await mcpCall(accessToken, 'read_channel_history', {
          guildId: '111111111111111111',
          channelId: FORUM,
          limit: 2,
        })
      ).body,
    );
    expect(history.isError).not.toBe(true);
    const [head] = history.text.split('\n');
    expect(head).toContain('showing 2 messages');
    expect(history.text).toContain('new sierra');
    expect(history.text).toContain('shown sierra');
    expect(history.text).not.toContain('mid tango');
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

  it('get_member lastMessageAt skips No-access channels and threads', async () => {
    // ADR 0126 Task 15 follow-up: per-author last-post times must not count
    // messages in No-access channels or threads — only the visible message's
    // time answers.
    seedStorage();
    const scopeA = t.scopes.forGuild(GUILD_A);
    const VISIBLE_AT = clock - 3000;
    const THREAD_AT = clock - 2000;
    const HIDDEN_AT = clock - 1000;
    const HIDDEN_CHANNEL = '477777777777777777';
    // An archived-then-excluded channel: the rows stay, the reads stop
    // seeing them.
    archiveRepo.enableChannel(scopeA, {
      channelId: HIDDEN_CHANNEL,
      attachmentPolicy: 'none',
      now: clock,
    });
    archiveRepo.upsertMessage(scopeA, {
      messageId: '511111111111111111',
      channelId: PLANNING,
      authorId: REST_MEMBER_A,
      content: 'visible plans',
      createdAt: VISIBLE_AT,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scopeA, {
      messageId: '522222222222222222',
      channelId: PLANNING,
      threadId: PUBLIC_THREAD,
      authorId: REST_MEMBER_A,
      content: 'thread plans',
      createdAt: THREAD_AT,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scopeA, {
      messageId: '533333333333333333',
      channelId: HIDDEN_CHANNEL,
      authorId: REST_MEMBER_A,
      content: 'hidden plans',
      createdAt: HIDDEN_AT,
      editedAt: undefined,
      attachments: [],
    });
    loggingRepo.excludeChannel(scopeA, PUBLIC_THREAD);
    loggingRepo.excludeChannel(scopeA, HIDDEN_CHANNEL);
    const { client: discordClient } = buildDiscordClient();
    const guildApp = buildGuildApp(discordClient);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await guildCall(guildApp, accessToken, 'get_member', {
            guildId: '111111111111111111',
            member: REST_MEMBER_A,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain(new Date(VISIBLE_AT).toISOString());
      expect(found.text).not.toContain(new Date(THREAD_AT).toISOString());
      expect(found.text).not.toContain(new Date(HIDDEN_AT).toISOString());
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

/**
 * Slice 2 Task 4, daemon side: `read_thread` and shared private threads
 * through the real stack — Fastify + `registerMcpRoutes` + `createMcpServer`
 * + the real `threadsPortFor` and `guildPortFor` — with a token minted
 * through the real OAuth flow.
 *
 * The app is rebuilt with the instance's redacted config carrying the owner
 * id (`testInstanceFor` redacts to `{}`), the way production's
 * `redactedConfig` carries the real `BANANASAURS_OWNER_USER_ID`, and with a
 * discord.js client whose user is the bot and whose guild cache holds one
 * public and three private threads. Live thread content comes from the
 * `FakeDiscord` behind the daemon's `DiscordPort`, exactly as production's
 * REST port serves it.
 *
 * The load-bearing assertions are ADR 0112's two rules: a private thread
 * reads live only when bot AND owner are both members (bot-only and
 * owner-only both refuse with the exact text), and a private read never
 * writes an `archive_messages` row.
 */
describe('/mcp read_thread and shared private threads', () => {
  const BOT = '123456789012345678';
  const OWNER = '345678901234567890';
  const MEMBER = '666666666666666666';
  const PLANNING = '322222222222222222';
  const PUBLIC_THREAD = '388888888888888888';
  const SHARED_PRIVATE = '399999999999999999';
  const BOT_ONLY_PRIVATE = '400000000000000001';
  const OWNER_ONLY_PRIVATE = '400000000000000002';
  const ARCHIVED_SHARED_PRIVATE = '400000000000000003';
  const LIVE_MESSAGE = '911111111111111111';
  const ARCHIVE_MESSAGE = '922222222222222222';
  const B_PUBLIC_THREAD = '411111111111111111';
  const B_PARENT = '422222222222222222';
  const SWEPT_PUBLIC = '433333333333333333';
  const B_SWEPT = '444444444444444444';
  const SWEPT_TEXT = 'swept archived thread plans gamma';
  const LIVE_TEXT = 'live secret plans discussed in the shared private thread alpha';
  const ARCHIVE_TEXT = 'archived public thread plans beta';

  interface ThreadDiscordInternals {
    guilds: { _add: (data: object) => Guild };
    users: { _add: (data: object) => unknown };
  }

  const threadChannel = (
    id: string,
    type: ChannelType,
    name: string,
    guildId: GuildId = GUILD_A,
    parentId: string = PLANNING,
    archived = false,
  ): object => ({
    id,
    guild_id: guildId,
    type,
    name,
    parent_id: parentId,
    thread_metadata: {
      archived,
      auto_archive_duration: 60,
      archive_timestamp: '2026-09-01T00:00:00.000Z',
      locked: false,
    },
  });

  const buildThreadClient = (): Client => {
    const client = new Client(buildClientOptions(() => BOT));
    const internals = client as unknown as ThreadDiscordInternals;
    const mutable = client as unknown as { user: unknown };
    mutable.user = internals.users._add({ id: BOT, username: 'bananasaurs', discriminator: '0' });
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: OWNER,
      channels: [
        {
          id: PLANNING,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 1,
          permission_overwrites: [],
        },
        threadChannel(PUBLIC_THREAD, ChannelType.GuildPublicThread, 'public-thread'),
        threadChannel(SHARED_PRIVATE, ChannelType.GuildPrivateThread, 'shared-private'),
        threadChannel(BOT_ONLY_PRIVATE, ChannelType.GuildPrivateThread, 'bot-only-private'),
        threadChannel(OWNER_ONLY_PRIVATE, ChannelType.GuildPrivateThread, 'owner-only-private'),
        threadChannel(
          ARCHIVED_SHARED_PRIVATE,
          ChannelType.GuildPrivateThread,
          'archived-shared-private',
          GUILD_A,
          PLANNING,
          true,
        ),
      ],
      roles: [],
      members: [],
      emojis: [],
      unavailable: false,
    });
    // A second guild in the same cache with its own real thread: a thread id
    // from here must never answer through guild A.
    internals.guilds._add({
      id: GUILD_B,
      name: 'guild b',
      owner_id: OWNER,
      channels: [
        {
          id: B_PARENT,
          guild_id: GUILD_B,
          type: ChannelType.GuildText,
          name: 'planning-b',
          position: 1,
          permission_overwrites: [],
        },
        threadChannel(
          B_PUBLIC_THREAD,
          ChannelType.GuildPublicThread,
          'b-public-thread',
          GUILD_B,
          B_PARENT,
        ),
      ],
      roles: [],
      members: [],
      emojis: [],
      unavailable: false,
    });
    return client;
  };

  /** The composed app with the owner id configured and thread memberships set. */
  const buildThreadApp = (discord: FakeDiscord, logger = deps.logger): FastifyInstance => {
    const client = buildThreadClient();
    return createServer({
      deps: {
        ...deps,
        logger,
        instance: {
          ...deps.instance,
          redactedConfig: () => ({ BANANASAURS_OWNER_USER_ID: OWNER }),
        },
      },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, client, discord);
      },
    });
  };

  const seedThreads = (discord: FakeDiscord): void => {
    archiveRepo.enableChannel(t.scopes.forGuild(GUILD_A), {
      channelId: PLANNING,
      attachmentPolicy: 'none',
      now: clock,
    });
    // ADR 0126: live thread reads need Read — the shared parent carries it,
    // so the live tests below read; the Read-off test removes it again.
    channelReadRepo.allowRead(t.scopes.forGuild(GUILD_A), {
      channelId: PLANNING,
      scopeKind: 'channel',
      now: clock,
    });
    archiveRepo.upsertMessage(t.scopes.forGuild(GUILD_A), {
      messageId: ARCHIVE_MESSAGE,
      channelId: PLANNING,
      threadId: PUBLIC_THREAD,
      authorId: MEMBER,
      content: ARCHIVE_TEXT,
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    discord.defineMessage({
      channelId: SHARED_PRIVATE,
      messageId: LIVE_MESSAGE,
      authorId: MEMBER,
      content: LIVE_TEXT,
    });
    discord.addThreadMember(SHARED_PRIVATE, BOT);
    discord.addThreadMember(SHARED_PRIVATE, OWNER);
    discord.addThreadMember(BOT_ONLY_PRIVATE, BOT);
    discord.addThreadMember(OWNER_ONLY_PRIVATE, OWNER);
    discord.addThreadMember(ARCHIVED_SHARED_PRIVATE, BOT);
    discord.addThreadMember(ARCHIVED_SHARED_PRIVATE, OWNER);
    // Swept from the gateway cache (not in `buildThreadClient`), but known
    // to the discord double: the REST fallback resolves these.
    archiveRepo.upsertMessage(t.scopes.forGuild(GUILD_A), {
      messageId: '933333333333333333',
      channelId: PLANNING,
      threadId: SWEPT_PUBLIC,
      authorId: MEMBER,
      content: SWEPT_TEXT,
      createdAt: clock,
      editedAt: undefined,
      attachments: [],
    });
    discord.defineThread({ threadId: SWEPT_PUBLIC, name: 'swept-plans', parentId: PLANNING });
    discord.defineThread({
      threadId: B_SWEPT,
      name: 'b-swept-thread',
      parentId: B_PARENT,
      guildId: GUILD_B,
    });
  };

  const threadCall = (
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
        params: { name: 'read_thread', arguments: args },
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

  it('reads a public thread from the archive', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: PUBLIC_THREAD,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain(ARCHIVE_TEXT);
      expect(found.text).toContain('public-thread');
      expect(found.text).not.toContain('private, read live');
      expect(found.text).not.toContain(LIVE_TEXT);
    } finally {
      await threadApp.close();
    }
  });

  it('an excluded thread reads from the archive as empty', async () => {
    // ADR 0126 Task 15 follow-up: No access on the thread itself hides the
    // thread itself — `threadInfo` answers undefined, so `read_thread`
    // answers exactly like an unknown thread, leaking neither rows nor the
    // thread's name.
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD_A), PUBLIC_THREAD);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: PUBLIC_THREAD,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toBe(`No thread ${PUBLIC_THREAD} in this guild.`);
      expect(found.text).not.toContain(ARCHIVE_TEXT);
      expect(found.text).not.toContain('public-thread');
    } finally {
      await threadApp.close();
    }
  });

  it('a No-access thread answers exactly like an unknown thread, leaking no name', async () => {
    // ADR 0126 Task 15 follow-up: `threadInfo` must not hand the thread's
    // name to `read_thread` when the thread is No access — on itself, its
    // parent or its category. The answer is the unknown-thread text.
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const readThread = async (threadId: string) =>
        callText(
          (
            await threadCall(threadApp, accessToken, {
              guildId: '111111111111111111',
              threadId,
            })
          ).body,
        );
      const unknown = await readThread('455555555555555555');
      expect(unknown.isError).not.toBe(true);
      expect(unknown.text).toContain('No thread 455555555555555555 in this guild.');
      const scopeA = t.scopes.forGuild(GUILD_A);
      // Own-id exclusion.
      loggingRepo.excludeChannel(scopeA, PUBLIC_THREAD);
      const ownDenied = await readThread(PUBLIC_THREAD);
      expect(ownDenied.isError).not.toBe(true);
      expect(ownDenied.text.replaceAll(PUBLIC_THREAD, 'X')).toBe(
        unknown.text.replaceAll('455555555555555555', 'X'),
      );
      expect(ownDenied.text).not.toContain('public-thread');
      // Parent exclusion hides the thread the same way.
      loggingRepo.unexcludeChannel(scopeA, PUBLIC_THREAD);
      loggingRepo.excludeChannel(scopeA, PLANNING);
      const parentDenied = await readThread(PUBLIC_THREAD);
      expect(parentDenied.isError).not.toBe(true);
      expect(parentDenied.text.replaceAll(PUBLIC_THREAD, 'X')).toBe(
        unknown.text.replaceAll('455555555555555555', 'X'),
      );
      expect(parentDenied.text).not.toContain('public-thread');
    } finally {
      await threadApp.close();
    }
  });

  it('a live private read with Read off on the parent answers empty', async () => {
    // ADR 0126 Task 15: a live thread read is a live Discord fetch, so it
    // needs Read — inherited from the parent for a private thread. With the
    // parent row removed the shared thread reads as empty, and Discord's
    // live endpoint is never reached.
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    expect(channelReadRepo.disallowRead(t.scopes.forGuild(GUILD_A), PLANNING, 'channel')).toBe(
      'removed',
    );
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: SHARED_PRIVATE,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('showing 0 messages');
      expect(found.text).not.toContain(LIVE_TEXT);
      expect(discord.restCalls('fetchChannelMessages')).toEqual([]);
    } finally {
      await threadApp.close();
    }
  });

  it('N6: a liveThreadMessages Read denial records one ids-only line', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    expect(channelReadRepo.disallowRead(t.scopes.forGuild(GUILD_A), PLANNING, 'channel')).toBe(
      'removed',
    );
    const lines: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const capture = (fields: Record<string, unknown>, msg: string): void => {
      lines.push({ fields, msg });
    };
    const logger = {
      info: capture,
      warn: capture,
      error: capture,
      debug() {},
      fatal() {},
      trace() {},
    } as never;
    const threadApp = buildThreadApp(discord, logger);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: SHARED_PRIVATE,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('showing 0 messages');
      expect(found.text).not.toContain(LIVE_TEXT);
      expect(discord.restCalls('fetchChannelMessages')).toEqual([]);

      const denials = lines.filter((line) => line.msg === 'mcp liveThreadMessages read denied');
      expect(denials).toHaveLength(1);
      expect(denials[0]?.fields).toMatchObject({
        guildId: GUILD_A,
        channelId: SHARED_PRIVATE,
        purpose: 'read',
        reason: 'not-granted',
      });
      expect(JSON.stringify(denials[0])).not.toContain(LIVE_TEXT);
    } finally {
      await threadApp.close();
    }
  });

  it('answers an unknown thread id as not-a-thread', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: '800000000000000099',
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toBe('No thread 800000000000000099 in this guild.');
    } finally {
      await threadApp.close();
    }
  });

  it('a guild B thread id through guild A answers not-found with no membership or message calls', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      // B's thread is real and in the same cache — but the call names guild
      // A, so it answers exactly like an unknown id: no cross-guild oracle,
      // and the live membership/message endpoints are never reached.
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: B_PUBLIC_THREAD,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toBe(`No thread ${B_PUBLIC_THREAD} in this guild.`);
      expect(discord.restCalls('isThreadMember')).toEqual([]);
      expect(discord.restCalls('fetchChannelMessages')).toEqual([]);
    } finally {
      await threadApp.close();
    }
  });

  it('reads a shared private thread live', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: SHARED_PRIVATE,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain(LIVE_TEXT);
      expect(found.text).toContain('private, read live');
      expect(found.text).not.toContain(ARCHIVE_TEXT);
    } finally {
      await threadApp.close();
    }
  });

  it('a shared private thread reads newest-first and pages backwards without overlap', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    // Two older live messages under the newest seed: oldest, middle, newest.
    const OLDER = '900000000000000010';
    const MIDDLE = '900000000000000011';
    const OLDER_TEXT = 'older live plans in the shared private thread';
    const MIDDLE_TEXT = 'middle live plans in the shared private thread';
    discord.defineMessage({
      channelId: SHARED_PRIVATE,
      messageId: OLDER,
      authorId: MEMBER,
      content: OLDER_TEXT,
    });
    discord.defineMessage({
      channelId: SHARED_PRIVATE,
      messageId: MIDDLE,
      authorId: MEMBER,
      content: MIDDLE_TEXT,
    });
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const page1 = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: SHARED_PRIVATE,
            limit: 2,
          })
        ).body,
      );
      expect(page1.isError).not.toBe(true);
      expect(page1.text).toContain('(newest first)');
      // Newest first: the newest id renders before the middle one, and the
      // oldest page is not on this page.
      expect(page1.text.indexOf(LIVE_MESSAGE)).toBeLessThan(page1.text.indexOf(MIDDLE));
      expect(page1.text).toContain(LIVE_TEXT);
      expect(page1.text).toContain(MIDDLE_TEXT);
      expect(page1.text).not.toContain(OLDER_TEXT);
      // Paging with the last shown id reads the next older page, no overlap.
      const page2 = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: SHARED_PRIVATE,
            beforeMessageId: MIDDLE,
            limit: 2,
          })
        ).body,
      );
      expect(page2.isError).not.toBe(true);
      expect(page2.text).toContain(OLDER_TEXT);
      expect(page2.text).not.toContain(LIVE_TEXT);
      expect(page2.text).not.toContain(MIDDLE_TEXT);
    } finally {
      await threadApp.close();
    }
  });

  it('bot-only membership is not enough, and neither is owner-only', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      // The bot sits in the thread but the owner does not: refused, and the
      // refusal names the fix rather than the membership state.
      const botOnly = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: BOT_ONLY_PRIVATE,
          })
        ).body,
      );
      expect(botOnly.isError).toBe(true);
      expect(botOnly.text).toBe(PRIVATE_THREAD_REFUSAL);
      // The mirror: the owner sits in the thread but the bot does not.
      const ownerOnly = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: OWNER_ONLY_PRIVATE,
          })
        ).body,
      );
      expect(ownerOnly.isError).toBe(true);
      expect(ownerOnly.text).toBe(PRIVATE_THREAD_REFUSAL);
    } finally {
      await threadApp.close();
    }
  });

  it('a private read writes no archive rows', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: SHARED_PRIVATE,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain(LIVE_TEXT);
      // The live message was served but never stored: no row by its id, and
      // no rows under the private thread at all.
      const scope = t.scopes.forGuild(GUILD_A);
      expect(archiveRepo.findMessage(scope, LIVE_MESSAGE)).toBeUndefined();
      expect(archiveRepo.listChannelHistory(scope, { channelId: SHARED_PRIVATE })).toEqual([]);
      // The archive itself is untouched: the public thread still reads one row.
      expect(archiveRepo.listChannelHistory(scope, { channelId: PUBLIC_THREAD })).toHaveLength(1);
    } finally {
      await threadApp.close();
    }
  });

  it('list_threads includes the shared private thread marked private, not the bot-only one', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const response = await threadApp.inject({
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
          params: {
            name: 'list_threads',
            arguments: { guildId: '111111111111111111', channelId: PLANNING },
          },
        }),
      });
      const found = callText(response.body);
      expect(found.isError).not.toBe(true);
      const data = JSON.parse(found.text.split('\n')[2] ?? '') as {
        threads: Array<{ id: string; private: boolean }>;
      };
      const byId = new Map(data.threads.map((thread) => [thread.id, thread.private] as const));
      expect(byId.get(PUBLIC_THREAD)).toBe(false);
      expect(byId.get(SHARED_PRIVATE)).toBe(true);
      // A private thread with only the bot is not listed at all.
      expect(byId.has(BOT_ONLY_PRIVATE)).toBe(false);
      expect(byId.has(OWNER_ONLY_PRIVATE)).toBe(false);
      expect(found.text).not.toContain('bot-only-private');
    } finally {
      await threadApp.close();
    }
  });

  it('an archived shared private thread lists only with includeArchived', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      // Default listing hides it, the way archived public threads hide.
      const active = listedPrivateById(
        (
          await listThreadsCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            channelId: PLANNING,
          })
        ).body,
      );
      expect(active.has(ARCHIVED_SHARED_PRIVATE)).toBe(false);
      expect(active.get(SHARED_PRIVATE)).toBe(true);
      // Asked for archived threads, it lists marked archived and private.
      const archived = callText(
        (
          await listThreadsCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            channelId: PLANNING,
            includeArchived: true,
          })
        ).body,
      );
      expect(archived.isError).not.toBe(true);
      const data = JSON.parse(archived.text.split('\n')[2] ?? '') as {
        threads: Array<{ id: string; archived: boolean; private: boolean }>;
      };
      const row = data.threads.find((thread) => thread.id === ARCHIVED_SHARED_PRIVATE);
      expect(row).toMatchObject({ archived: true, private: true });
    } finally {
      await threadApp.close();
    }
  });

  it('reads a swept archived thread from the archive via the REST fallback', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      // SWEPT_PUBLIC is in no cache — the sweeper evicted it — but the
      // discord double knows it, so the fallback resolves the thread and
      // the archive rows still read.
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: SWEPT_PUBLIC,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain(SWEPT_TEXT);
      expect(found.text).toContain('swept-plans');
      expect(discord.restCalls('fetchThreadInfo')).toHaveLength(1);
    } finally {
      await threadApp.close();
    }
  });

  it('a swept guild B thread id through guild A answers not-found via the fallback', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      // The fallback ran — one fetchThreadInfo call — but the fetched
      // channel belongs to guild B, so the answer is not-found and the
      // membership/message endpoints are never reached.
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: B_SWEPT,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toBe(`No thread ${B_SWEPT} in this guild.`);
      expect(discord.restCalls('fetchThreadInfo')).toHaveLength(1);
      expect(discord.restCalls('isThreadMember')).toEqual([]);
      expect(discord.restCalls('fetchChannelMessages')).toEqual([]);
    } finally {
      await threadApp.close();
    }
  });

  it('refuses a private thread when no owner id is configured', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    // `testInstanceFor` redacts to `{}`: without the owner id the check
    // fails closed, even with both memberships present.
    const client = buildThreadClient();
    const unconfigured = createServer({
      deps,
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, client, discord);
      },
    });
    try {
      // The token is minted on the dashboard app (this one registers no
      // OAuth routes); bearer validation is app-independent, the way the
      // guild-tools tests reuse a token across apps.
      const accessToken = await mintToken();
      const found = callText(
        (
          await threadCall(unconfigured, accessToken, {
            guildId: '111111111111111111',
            threadId: SHARED_PRIVATE,
          })
        ).body,
      );
      expect(found.isError).toBe(true);
      expect(found.text).toBe(PRIVATE_THREAD_REFUSAL);
    } finally {
      await unconfigured.close();
    }
  });

  const listThreadsCall = (
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
        params: { name: 'list_threads', arguments: args },
      }),
    });

  const listedPrivateById = (body: string): Map<string, boolean> => {
    const found = callText(body);
    expect(found.isError).not.toBe(true);
    const data = JSON.parse(found.text.split('\n')[2] ?? '') as {
      threads: Array<{ id: string; private: boolean }>;
    };
    return new Map(data.threads.map((thread) => [thread.id, thread.private] as const));
  };

  it('a throwing membership check refuses the read and unlists the thread (fail closed)', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    // The membership endpoint is down: both memberships are recorded, but
    // the check cannot confirm them — so the thread refuses and unlists
    // rather than serving on a guess.
    discord.failAlways('isThreadMember', new DiscordApiError(500, undefined, 'discord is on fire'));
    const threadApp = buildThreadApp(discord);
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await threadCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            threadId: SHARED_PRIVATE,
          })
        ).body,
      );
      expect(found.isError).toBe(true);
      expect(found.text).toBe(PRIVATE_THREAD_REFUSAL);
      const byId = listedPrivateById(
        (
          await listThreadsCall(threadApp, accessToken, {
            guildId: '111111111111111111',
            channelId: PLANNING,
          })
        ).body,
      );
      expect(byId.has(SHARED_PRIVATE)).toBe(false);
      expect(byId.get(PUBLIC_THREAD)).toBe(false);
    } finally {
      await threadApp.close();
    }
  });

  it('an unset owner id unlists the shared thread too', async () => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedThreads(discord);
    const client = buildThreadClient();
    const unconfigured = createServer({
      deps,
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, client, discord);
      },
    });
    try {
      const accessToken = await mintToken();
      const byId = listedPrivateById(
        (
          await listThreadsCall(unconfigured, accessToken, {
            guildId: '111111111111111111',
            channelId: PLANNING,
          })
        ).body,
      );
      expect(byId.has(SHARED_PRIVATE)).toBe(false);
      expect(byId.get(PUBLIC_THREAD)).toBe(false);
    } finally {
      await unconfigured.close();
    }
  });
});

/**
 * Slice 2, Task 5, daemon side: `read_digest` and `list_unanswered` through
 * the real composition — the real repositories over a migrated test database
 * and a fake discord.js guild for channel/role names. The token is minted on
 * the dashboard app; bearer validation is app-independent, the way the
 * guild-tools tests reuse a token across apps.
 */
describe('/mcp digest tools over real storage', () => {
  const CATEGORY = '411111111111111111';
  const HELP_CHANNEL = '422222222222222222';
  const GENERAL = '433333333333333333';
  const NOT_ENABLED = '444444444444444444';
  const HELP_ROLE = '455555555555555555';
  const ASKER = '466666666666666666';
  const HELPER = '477777777777777777';
  const THREAD = '488888888888888888';

  interface DigestDiscordInternals {
    guilds: { _add: (data: object) => Guild };
  }
  const digestInternals = (c: Client): DigestDiscordInternals =>
    c as unknown as DigestDiscordInternals;

  const buildDigestClient = (): Client => {
    const client = new Client(buildClientOptions(() => '123456789012345678'));
    digestInternals(client).guilds._add({
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
          id: HELP_CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'help',
          position: 1,
          parent_id: CATEGORY,
          permission_overwrites: [],
        },
        {
          id: GENERAL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'general',
          position: 2,
          parent_id: CATEGORY,
          permission_overwrites: [],
        },
        {
          id: NOT_ENABLED,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'offtopic',
          position: 3,
          permission_overwrites: [],
        },
      ],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        { id: HELP_ROLE, name: 'help', position: 1, permissions: '0', managed: false, color: 0 },
      ],
      members: [],
      emojis: [],
      unavailable: false,
    });
    return client;
  };

  const buildDigestApp = (discordClient: Client): FastifyInstance =>
    createServer({
      deps: { ...deps, mcpPublicUrl: PUBLIC_URL },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(
          instance,
          routeDeps,
          discordClient,
          new FakeDiscord({ guildId: GUILD_A }),
        );
      },
    });

  const digestCall = (
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

  const seedDigest = (now: number): void => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    for (const channelId of [HELP_CHANNEL, GENERAL] as const) {
      archiveRepo.enableChannel(scopeA, { channelId, attachmentPolicy: 'none', now: clock });
    }
    const seed = (input: {
      messageId: string;
      channelId: string;
      authorId?: string;
      content: string;
      createdAt: number;
      mentionedRoleIds?: readonly string[];
      replyToMessageId?: string;
      threadId?: string;
    }): void => {
      archiveRepo.upsertMessage(scopeA, {
        messageId: input.messageId,
        channelId: input.channelId,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        authorId: input.authorId ?? ASKER,
        content: input.content,
        createdAt: input.createdAt,
        editedAt: undefined,
        attachments: [],
        ...(input.replyToMessageId !== undefined
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
        ...(input.mentionedRoleIds !== undefined
          ? { mentionedRoleIds: input.mentionedRoleIds }
          : {}),
      });
    };
    seed({
      messageId: '511111111111111111',
      channelId: HELP_CHANNEL,
      content: 'first digest message in help',
      createdAt: now - 30 * 60_000,
    });
    seed({
      messageId: '522222222222222222',
      channelId: GENERAL,
      content: 'second digest message in general',
      createdAt: now - 20 * 60_000,
    });
    seed({
      messageId: '533333333333333333',
      channelId: HELP_CHANNEL,
      content: 'thread follow-up under help',
      createdAt: now - 10 * 60_000,
      threadId: THREAD,
    });
    seed({
      messageId: '544444444444444444',
      channelId: HELP_CHANNEL,
      content: 'open help question about wiring',
      createdAt: now - 13 * 3_600_000,
      mentionedRoleIds: [HELP_ROLE],
    });
    seed({
      messageId: '555555555555555555',
      channelId: HELP_CHANNEL,
      content: 'answered help question about wiring',
      createdAt: now - 14 * 3_600_000,
      mentionedRoleIds: [HELP_ROLE],
    });
    seed({
      messageId: '566666666666666666',
      channelId: HELP_CHANNEL,
      authorId: HELPER,
      content: 'the answer to the answered question',
      createdAt: now - 13 * 3_600_000 + 60_000,
      replyToMessageId: '555555555555555555',
    });
    seed({
      messageId: '577777777777777777',
      channelId: HELP_CHANNEL,
      content: 'thread-answered help question about wiring',
      createdAt: now - 15 * 3_600_000,
      mentionedRoleIds: [HELP_ROLE],
    });
    seed({
      messageId: '588888888888888888',
      channelId: HELP_CHANNEL,
      authorId: HELPER,
      content: 'the answer inside the thread',
      createdAt: now - 14 * 3_600_000 + 60_000,
      threadId: '577777777777777777',
    });
    // Same channel id, other guild: invisible to guild A's digest either way.
    const scopeB = t.scopes.forGuild(GUILD_B);
    archiveRepo.enableChannel(scopeB, {
      channelId: HELP_CHANNEL,
      attachmentPolicy: 'none',
      now: clock,
    });
    archiveRepo.upsertMessage(scopeB, {
      messageId: '599999999999999999',
      channelId: HELP_CHANNEL,
      authorId: ASKER,
      content: 'guild B digest secret',
      createdAt: now - 5 * 60_000,
      editedAt: undefined,
      attachments: [],
    });
  };

  it('read_digest by channel ids returns guild A rows only, oldest first', async () => {
    const now = clock;
    seedDigest(now);
    const digestApp = buildDigestApp(buildDigestClient());
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await digestCall(digestApp, accessToken, 'read_digest', {
            guildId: '111111111111111111',
            channels: [HELP_CHANNEL],
            since: 0,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('first digest message in help');
      expect(found.text).toContain('thread follow-up under help');
      expect(found.text).not.toContain('guild B digest secret');
      const [head] = found.text.split('\n');
      expect(head).toContain('1 channels');
    } finally {
      await digestApp.close();
    }
  });

  it('read_digest by category name covers its archive-enabled channels, and a cursor continues', async () => {
    const now = clock;
    seedDigest(now);
    const digestApp = buildDigestApp(buildDigestClient());
    try {
      const accessToken = await mintToken();
      // A channel outside the archive reads as dropped, never as an error.
      const narrowed = callText(
        (
          await digestCall(digestApp, accessToken, 'read_digest', {
            guildId: '111111111111111111',
            channels: [HELP_CHANNEL, NOT_ENABLED],
            since: 0,
          })
        ).body,
      );
      expect(narrowed.isError).not.toBe(true);
      expect(narrowed.text).toContain('first digest message in help');
      expect(narrowed.text).not.toContain('guild B digest secret');

      const page1 = callText(
        (
          await digestCall(digestApp, accessToken, 'read_digest', {
            guildId: '111111111111111111',
            category: 'club',
            since: 0,
            limit: 1,
          })
        ).body,
      );
      expect(page1.isError).not.toBe(true);
      expect(page1.text).toContain('2 channels');
      const cursor = page1.text.match(/Next cursor: (\S+)/)?.[1];
      expect(cursor).toBeDefined();
      const page2 = callText(
        (
          await digestCall(digestApp, accessToken, 'read_digest', {
            guildId: '111111111111111111',
            category: 'club',
            since: 0,
            limit: 1,
            cursor,
          })
        ).body,
      );
      expect(page2.isError).not.toBe(true);
      expect(page2.text).not.toBe(page1.text);
    } finally {
      await digestApp.close();
    }
  });

  it('list_unanswered returns the open @help question with a link, nothing answered', async () => {
    const now = clock;
    seedDigest(now);
    const digestApp = buildDigestApp(buildDigestClient());
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await digestCall(digestApp, accessToken, 'list_unanswered', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('open help question about wiring');
      expect(found.text).toContain(
        `https://discord.com/channels/111111111111111111/${HELP_CHANNEL}/544444444444444444`,
      );
      expect(found.text).not.toContain('answered help question');
      expect(found.text).not.toContain('thread-answered help question');
      expect(found.text).not.toContain('guild B digest secret');
    } finally {
      await digestApp.close();
    }
  });

  it('read_digest at limit 1000 over 1001 rows emits a cursor that reaches the last row', async () => {
    // The probe row: the tool asks storage for limit + 1, so storage must
    // answer 1001 rows here — clamping the probe away would silently drop
    // the cursor at exactly the public max.
    const scopeA = t.scopes.forGuild(GUILD_A);
    archiveRepo.enableChannel(scopeA, {
      channelId: HELP_CHANNEL,
      attachmentPolicy: 'none',
      now: clock,
    });
    const base = 700000000000000000n;
    for (let i = 1; i <= 1001; i += 1) {
      archiveRepo.upsertMessage(scopeA, {
        messageId: String(base + BigInt(i)),
        channelId: HELP_CHANNEL,
        authorId: ASKER,
        content: `bulk message ${String(i)}`,
        createdAt: clock + i,
        editedAt: undefined,
        attachments: [],
      });
    }
    const digestApp = buildDigestApp(buildDigestClient());
    try {
      const accessToken = await mintToken();
      const page1 = callText(
        (
          await digestCall(digestApp, accessToken, 'read_digest', {
            guildId: '111111111111111111',
            channels: [HELP_CHANNEL],
            since: 0,
            limit: 1000,
          })
        ).body,
      );
      expect(page1.isError).not.toBe(true);
      const [head1] = page1.text.split('\n');
      expect(head1).toContain('showing 1000 messages');
      const cursor = page1.text.match(/Next cursor: (\S+)/)?.[1];
      expect(cursor).toBeDefined();
      const page2 = callText(
        (
          await digestCall(digestApp, accessToken, 'read_digest', {
            guildId: '111111111111111111',
            channels: [HELP_CHANNEL],
            since: 0,
            limit: 1000,
            cursor,
          })
        ).body,
      );
      expect(page2.isError).not.toBe(true);
      const [head2] = page2.text.split('\n');
      expect(head2).toContain('showing 1 message');
      expect(page2.text).not.toContain('Next cursor');
      expect(page2.text).toContain('bulk message 1001');
    } finally {
      await digestApp.close();
    }
  });

  it('read_digest drops rows of an excluded thread in an allowed channel', async () => {
    // ADR 0126 Task 15: the thread follow-up lives under HELP_CHANNEL, which
    // stays visible — but the thread itself is No access, so its row never
    // reaches the digest while the channel's own rows still do.
    const now = clock;
    seedDigest(now);
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD_A), THREAD);
    const digestApp = buildDigestApp(buildDigestClient());
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await digestCall(digestApp, accessToken, 'read_digest', {
            guildId: '111111111111111111',
            channels: [HELP_CHANNEL],
            since: 0,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('first digest message in help');
      expect(found.text).not.toContain('thread follow-up under help');
    } finally {
      await digestApp.close();
    }
  });

  it('N5 digest: an excluded thread row inside the fetched window still emits a cursor', async () => {
    // Oldest first past `since`: two visible rows, a hidden thread row, then
    // two more visible rows. With limit 2 the probe row lands on the hidden
    // one — filtering after the SQL limit would eat it and silently cut the
    // digest instead of emitting the cursor.
    const now = clock;
    seedDigest(now);
    const scopeA = t.scopes.forGuild(GUILD_A);
    const seed = (
      messageId: string,
      content: string,
      createdAt: number,
      threadId?: string,
    ): void => {
      archiveRepo.upsertMessage(scopeA, {
        messageId,
        channelId: HELP_CHANNEL,
        ...(threadId === undefined ? {} : { threadId }),
        authorId: ASKER,
        content,
        createdAt,
        editedAt: undefined,
        attachments: [],
      });
    };
    seed('545555555555555555', 'thread middle message in help', now - 20 * 60_000, THREAD);
    seed('546666666666666666', 'later visible help one', now - 15 * 60_000);
    seed('547777777777777777', 'latest visible help two', now - 5 * 60_000);
    loggingRepo.excludeChannel(scopeA, THREAD);
    const digestApp = buildDigestApp(buildDigestClient());
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await digestCall(digestApp, accessToken, 'read_digest', {
            guildId: '111111111111111111',
            channels: [HELP_CHANNEL],
            since: now - 60 * 60_000,
            limit: 2,
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('first digest message in help');
      expect(found.text).toContain('Next cursor');
      expect(found.text).not.toContain('thread middle message');
    } finally {
      await digestApp.close();
    }
  });

  it('list_unanswered drops a mention in a No-access channel', async () => {
    // ADR 0126 Task 15: `list_unanswered` takes no channel argument, so the
    // port is the only gate — a mention in the excluded channel is not an
    // open question the MCP may see, while the help channel's own question
    // still answers.
    const now = clock;
    seedDigest(now);
    archiveRepo.upsertMessage(t.scopes.forGuild(GUILD_A), {
      messageId: '589999999999999999',
      channelId: GENERAL,
      authorId: ASKER,
      content: 'sealed help question about wiring',
      createdAt: now - 13 * 3_600_000,
      editedAt: undefined,
      attachments: [],
      mentionedRoleIds: [HELP_ROLE],
    });
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD_A), GENERAL);
    const digestApp = buildDigestApp(buildDigestClient());
    try {
      const accessToken = await mintToken();
      const found = callText(
        (
          await digestCall(digestApp, accessToken, 'list_unanswered', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain('open help question about wiring');
      expect(found.text).not.toContain('sealed help question about wiring');
    } finally {
      await digestApp.close();
    }
  });
});

/** Network transport smoke: a separate SDK client connects to the daemon's actual HTTP listener. */
it('simulated AI MCP client uses HTTP for task reads, completion, and fail-closed approval', async () => {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const scope = t.scopes.forGuild(GUILD_A);
  const categoryId = '999999999999999999';
  const destinationId = '333333333333333333';
  (deps.client as unknown as { guilds: { _add: (data: object) => unknown } }).guilds._add({
    id: GUILD_A,
    name: 'simulated guild',
    owner_id: '345678901234567890',
    channels: [
      {
        id: categoryId,
        guild_id: GUILD_A,
        type: ChannelType.GuildCategory,
        name: 'tech',
        position: 0,
        permission_overwrites: [],
      },
      {
        id: destinationId,
        guild_id: GUILD_A,
        type: ChannelType.GuildText,
        name: 'tasks',
        parent_id: categoryId,
        position: 0,
        permission_overwrites: [],
      },
    ],
    roles: [{ id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false }],
    members: [],
    emojis: [],
    unavailable: false,
  });
  // Channel permissions: the edit below re-verifies the destination, which
  // lives under this category, so the fixture grants Write there.
  mcpSendRepo.allowChannel(scope, {
    channelId: categoryId,
    scopeKind: 'category',
    addedByAccountId: ACCOUNT,
    now: clock,
  });
  const teamId = taskRepo.createTeam(
    scope,
    { name: 'Tech', categoryId, kind: 'subteam' },
    ACTOR,
    clock,
  );
  const taskId = taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Inspect suspension',
      assignmentKind: 'team',
      dueAt: clock + 86400000,
      timezone: 'America/Vancouver',
      destinationId,
      createdBy: ACCOUNT,
    },
    ACTOR,
    clock,
  );
  const multiId = taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Shared measurement',
      assignmentKind: 'individual',
      assigneeIds: ['666666666666666666', '777777777777777777'],
      dueAt: clock + 86400000,
      timezone: 'America/Vancouver',
      destinationId,
      createdBy: ACCOUNT,
    },
    ACTOR,
    clock,
  );
  const read = await mintToken('bananasaurs:read');
  const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const connect = async (token: string) => {
    const client = new McpClient({ name: 'simulated-ai-agent', version: '1.0.0' });
    // The SDK's own transport declaration disagrees with its Transport interface
    // under exactOptionalPropertyTypes (sessionId: string | undefined vs string).
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport as Parameters<typeof client.connect>[0]);
    return client;
  };
  const reader = await connect(read);
  const writer = await connect(send);
  try {
    const readNames = (await reader.listTools()).tools.map((tool) => tool.name);
    const sendNames = (await writer.listTools()).tools.map((tool) => tool.name);
    expect(readNames).toContain('list_tasks');
    expect(readNames).toContain('get_task');
    expect(readNames).toContain('task_teams');
    expect(readNames).not.toContain('update_task');
    expect(sendNames).toContain('update_task');
    expect(sendNames).toContain('list_tasks');
    const list = await reader.callTool({ name: 'list_tasks', arguments: { guildId: GUILD_A } });
    expect(list.isError).not.toBe(true);
    expect(JSON.stringify(list.content)).toContain('Inspect suspension');
    const details = await reader.callTool({
      name: 'get_task',
      arguments: { guildId: GUILD_A, taskId },
    });
    expect(details.isError).not.toBe(true);
    expect(JSON.stringify(details.content)).toContain(taskId);
    const quiet = await writer.callTool({
      name: 'task_settings',
      arguments: {
        action: 'set_quiet_hours',
        guildId: GUILD_A,
        startMinute: 60,
        endMinute: 480,
        timezone: 'America/Vancouver',
      },
    });
    expect(quiet.isError).not.toBe(true);
    const teams = await reader.callTool({
      name: 'task_teams',
      arguments: { action: 'list', guildId: GUILD_A },
    });
    expect(teams.isError).not.toBe(true);
    expect(JSON.stringify(teams.content)).toContain('Tech');
    const child = await writer.callTool({
      name: 'task_steps',
      arguments: {
        action: 'add',
        guildId: GUILD_A,
        taskId,
        expectedVersion: 1,
        title: 'Check dampers',
        dueAt: clock + 3600000,
      },
    });
    expect(child.isError).not.toBe(true);
    const report = await writer.callTool({
      name: 'task_progress',
      arguments: {
        action: 'record',
        guildId: GUILD_A,
        taskId,
        body: 'Measurements recorded',
        requestId: '00000000-0000-4000-8000-000000000001',
      },
    });
    expect(report.isError).not.toBe(true);
    const reminder = await writer.callTool({
      name: 'task_reminders',
      arguments: { action: 'add', guildId: GUILD_A, taskId, at: clock + 3600000 },
    });
    expect(reminder.isError).not.toBe(true);
    const slots = await reader.callTool({
      name: 'get_task',
      arguments: { guildId: GUILD_A, taskId },
    });
    expect(slots.isError).not.toBe(true);
    expect(JSON.stringify(slots.content)).toContain('custom:');
    fakeDiscord.defineMember('666666666666666666');
    fakeDiscord.defineMember('777777777777777777');
    for (const discordUserId of ['666666666666666666', '777777777777777777']) {
      const added = await writer.callTool({
        name: 'task_teams',
        arguments: {
          action: 'add_member',
          guildId: GUILD_A,
          teamId,
          discordUserId,
          kind: 'member',
        },
      });
      expect(added.isError).not.toBe(true);
    }
    const multiEdit = await writer.callTool({
      name: 'update_task',
      arguments: {
        action: 'edit',
        guildId: GUILD_A,
        taskId: multiId,
        expectedVersion: 1,
        title: 'Shared measurement, revised',
        priority: 'normal',
        assignmentKind: 'individual',
        assigneeIds: ['666666666666666666', '777777777777777777'],
        dueAt: clock + 86400000,
        timezone: 'America/Vancouver',
        destinationId,
      },
    });
    expect(multiEdit.isError).not.toBe(true);
    expect(JSON.stringify(multiEdit.content)).toContain('(version 2)');
    expect(taskRepo.listTaskAssignees(scope, multiId)).toHaveLength(2);
    const concurrentId = taskRepo.createTask(
      scope,
      {
        teamId,
        title: 'Concurrent completion',
        assignmentKind: 'team',
        dueAt: clock + 86400000,
        timezone: 'America/Vancouver',
        destinationId,
        createdBy: ACCOUNT,
      },
      ACTOR,
      clock,
    );
    const contenders = await Promise.all(
      Array.from({ length: 8 }, () =>
        writer.callTool({
          name: 'update_task',
          arguments: {
            action: 'request_completion',
            guildId: GUILD_A,
            taskId: concurrentId,
            expectedVersion: 1,
          },
        }),
      ),
    );
    expect(contenders.filter((result) => result.isError !== true)).toHaveLength(1);
    expect(taskRepo.getTask(scope, concurrentId)).toMatchObject({
      status: 'awaiting_approval',
      version: 2,
    });
    // recordReport bumps the version when it moves the task to in_progress, so the completion request uses the live version.
    const liveVersion = taskRepo.getTask(scope, taskId)!.version;
    const completion = await writer.callTool({
      name: 'update_task',
      arguments: {
        action: 'request_completion',
        guildId: GUILD_A,
        taskId,
        expectedVersion: liveVersion,
      },
    });
    expect(completion.isError).not.toBe(true);
    expect(taskRepo.getTask(scope, taskId)?.status).toBe('awaiting_approval');
    const replay = await writer.callTool({
      name: 'update_task',
      arguments: {
        action: 'request_completion',
        guildId: GUILD_A,
        taskId,
        expectedVersion: liveVersion,
      },
    });
    expect(replay.isError).toBe(true);
    const awaitingVersion = taskRepo.getTask(scope, taskId)!.version;
    const approval = await writer.callTool({
      name: 'update_task',
      arguments: {
        action: 'approve_completion',
        guildId: GUILD_A,
        taskId,
        expectedVersion: awaitingVersion,
      },
    });
    expect(approval.isError).not.toBe(true);
    expect(JSON.stringify(approval.content)).toContain('Approved task');
    expect(taskRepo.getTask(scope, taskId)?.status).toBe('done');
  } finally {
    await reader.close();
    await writer.close();
  }
});

/**
 * Task 9: the owner's MCP client can do everything the task system supports.
 * Through the real composition (Fastify + bearer guard + per-request server +
 * real ports over the real repositories and FakeDiscord), with tokens minted
 * through the real OAuth flow.
 */
describe('MCP task admin full surface (owner-only)', () => {
  const CATEGORY = '999999999999999999';
  const SECOND_CATEGORY = '577777777777777777';
  const DEST = '333333333333333333';
  const DEST_TWO = '344444444444444444';
  const LEAD_ROLE = '611111111111111111';
  const MEMBER_ROLE = '622222222222222222';
  const PRESIDENT_ROLE = '633333333333333333';
  const MEMBER_A = '666666666666666666';
  const MEMBER_B = '777777777777777777';
  const MEMBER_ACCOUNT = 'acct_0123456789abcdef0123456789abcdea';

  const seedTaskWorld = (): void => {
    (deps.client as unknown as { guilds: { _add: (data: object) => unknown } }).guilds._add({
      id: GUILD_A,
      name: 'task guild',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CATEGORY,
          guild_id: GUILD_A,
          type: ChannelType.GuildCategory,
          name: 'teams',
          position: 0,
          permission_overwrites: [],
        },
        {
          id: SECOND_CATEGORY,
          guild_id: GUILD_A,
          type: ChannelType.GuildCategory,
          name: 'exec',
          position: 1,
          permission_overwrites: [],
        },
        {
          id: DEST,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'tasks',
          parent_id: CATEGORY,
          position: 0,
          permission_overwrites: [],
        },
        {
          id: DEST_TWO,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'tasks-two',
          parent_id: CATEGORY,
          position: 1,
          permission_overwrites: [],
        },
      ],
      roles: [{ id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false }],
      members: [],
      emojis: [],
      unavailable: false,
    });
    fakeDiscord.defineRole({ id: LEAD_ROLE });
    fakeDiscord.defineRole({ id: MEMBER_ROLE });
    fakeDiscord.defineRole({ id: PRESIDENT_ROLE });
    fakeDiscord.defineMember(MEMBER_A);
    fakeDiscord.defineMember(MEMBER_B);
    // Channel permissions: every destination in this block lives under
    // CATEGORY, so the shared fixture grants Write there — the task-admin
    // Write gates keep their meaning and only the refusal tests below
    // remove it.
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: CATEGORY,
      scopeKind: 'category',
      addedByAccountId: ACCOUNT,
      now: clock,
    });
  };

  const gid = (): string => String(GUILD_A);
  const due = (): number => clock + 86400000;
  let createTaskRequestCount = 0;

  const call = (accessToken: string, name: string, args: Record<string, unknown>) =>
    mcpPost(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      accessToken,
    );

  const text = (body: string): { readonly isError: boolean | undefined; readonly text: string } => {
    const bodies = sseData(body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = (bodies[0] as { result?: { isError?: boolean; content?: unknown } }).result;
    const blocks = result?.content as ReadonlyArray<{ type: string; text: string }> | undefined;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.type).toBe('text');
    return { isError: result?.isError, text: blocks?.[0]?.text ?? '' };
  };

  const teamArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guildId: gid(),
    name: 'Tech',
    categoryId: CATEGORY,
    kind: 'subteam',
    ...over,
  });

  const createTeam = async (token: string, over: Record<string, unknown> = {}): Promise<string> => {
    const found = text(
      (await call(token, 'task_teams', { action: 'create', ...teamArgs(over) })).body,
    );
    expect(found.isError).not.toBe(true);
    const id = /Created team (\S+)\./.exec(found.text)?.[1];
    if (!id) throw new Error(`no team id in: ${found.text}`);
    return id;
  };

  const createTeamTask = async (
    token: string,
    teamId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> => {
    // A fresh request id per call: sharing one would name the same task twice.
    createTaskRequestCount += 1;
    const found = text(
      (
        await call(token, 'create_task', {
          guildId: gid(),
          teamId,
          title: 'Club task',
          assignmentKind: 'team',
          dueAt: due(),
          timezone: 'America/Vancouver',
          destinationId: DEST,
          requestId: `test-create-request-${createTaskRequestCount}`,
          ...over,
        })
      ).body,
    );
    expect(found.isError).not.toBe(true);
    const id = /Created task (\S+) \(version 1\)\./.exec(found.text)?.[1];
    if (!id) throw new Error(`no task id in: ${found.text}`);
    return id;
  };

  /** A real token for a non-owner account through the full OAuth flow. */
  const mintTokenFor = async (
    username: string,
    password: string,
    scope = 'bananasaurs:send',
  ): Promise<string> => {
    const registered = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'test client', redirect_uris: [REDIRECT] },
    });
    expect(registered.statusCode).toBe(201);
    const clientId = registered.json<{ client_id: string }>().client_id;
    const verifier = generateToken();
    const page = await app.inject({
      method: 'GET',
      url: authorizeQuery({ client_id: clientId, code_challenge: s256(verifier), scope }),
    });
    expect(page.statusCode).toBe(200);
    const approval = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody({
        requestId: hiddenInput(page.body, 'requestId'),
        nonce: hiddenInput(page.body, 'nonce'),
        username,
        password,
        decision: 'approve',
      }),
    });
    expect(approval.statusCode).toBe(302);
    const location = approval.headers.location;
    if (typeof location !== 'string') throw new Error('approve did not redirect');
    const code = new URL(location).searchParams.get('code');
    if (code === null) throw new Error('redirect carried no code');
    const exchanged = await app.inject({
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

  it('advertises every write tool to the owner and none of the task tools to a non-owner', async () => {
    seedTaskWorld();
    // The task-tracking writes need the tasks scope on top of ownership
    // (ADR 0114): send alone no longer shows them.
    const ownerSend = await mintToken('bananasaurs:send bananasaurs:tasks');
    const listed = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      ownerSend,
    );
    const names = (
      sseData(listed.body)[0] as { result?: { tools?: Array<{ name: string }> } }
    ).result?.tools?.map((tool) => tool.name);
    expect(names).toContain('update_task');
    expect(names).toContain('task_reminders');
    expect(names).toContain('task_progress');
    expect(names).toContain('task_settings');
    expect(names).toContain('create_task');
    expect(names).toContain('delete_task');
    expect(names).toContain('task_steps');
    expect(names).not.toContain('list_tasks');

    accountRepo.createAccount(t.scopes.instance(), {
      accountId: MEMBER_ACCOUNT,
      username: 'member',
      passwordHash: await hashPassword('member-pass'),
      isOwner: false,
      now: clock,
    });
    accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD_A), MEMBER_ACCOUNT);
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: MEMBER_ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    const memberSend = await mintTokenFor('member', 'member-pass', 'bananasaurs:send');
    const memberListed = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      memberSend,
    );
    expect(
      (
        sseData(memberListed.body)[0] as { result?: { tools?: Array<{ name: string }> } }
      ).result?.tools?.map((tool) => tool.name),
    ).toEqual([
      'send_message',
      'create_thread',
      'add_thread_members',
      'remove_thread_members',
      'create_forum_post',
      'archive_thread',
      'lock_thread',
      'edit_message',
      'delete_message',
      'pin_message',
      'unpin_message',
      'add_reaction',
      'remove_reaction',
      'create_event',
      'edit_event',
      'cancel_event',
      'create_poll',
      'schedule_message',
      'edit_scheduled',
      'cancel_scheduled',
      'list_scheduled',
      'undo_action',
    ]);

    // The port still rechecks per call: a non-owner token that names a hidden
    // tool is refused, never executed.
    const refused = text((await call(memberSend, 'task_teams', teamArgs())).body);
    expect(refused.isError).toBe(true);
    const refusedDeleteTask = text(
      (
        await call(memberSend, 'delete_task', {
          guildId: gid(),
          taskId: '00000000-0000-4000-8000-000000000000',
          expectedVersion: 1,
        })
      ).body,
    );
    expect(refusedDeleteTask.isError).toBe(true);
    const refusedDeleteReport = text(
      (
        await call(memberSend, 'task_progress', {
          action: 'delete_report',
          guildId: gid(),
          taskId: '00000000-0000-4000-8000-000000000000',
          reportId: 'report-1',
        })
      ).body,
    );
    expect(refusedDeleteReport.isError).toBe(true);

    const memberRead = await mintTokenFor('member', 'member-pass', 'bananasaurs:read');
    const readRefused = text((await call(memberRead, 'list_tasks', { guildId: gid() })).body);
    expect(readRefused.isError).toBe(true);
  });

  it('a non-owner with tasks.manage gets the task tools in that guild only, and revoking binds the next call (ADR 0130)', async () => {
    seedTaskWorld();
    accountRepo.createAccount(t.scopes.instance(), {
      accountId: MEMBER_ACCOUNT,
      username: 'manager',
      passwordHash: await hashPassword('manager-pass'),
      isOwner: false,
      now: clock,
    });
    for (const guild of [GUILD_A, GUILD_B] as const) {
      accountRepo.grantGuildAccess(t.scopes.forGuild(guild), MEMBER_ACCOUNT);
    }
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: MEMBER_ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    // Without tasks.manage anywhere: no task tools at all.
    const before = await mintTokenFor(
      'manager',
      'manager-pass',
      'bananasaurs:send bananasaurs:tasks',
    );
    const listNames = async (token: string): Promise<string[] | undefined> =>
      (
        sseData(
          (await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, token))
            .body,
        )[0] as { result?: { tools?: Array<{ name: string }> } }
      ).result?.tools?.map((tool) => tool.name);
    expect(await listNames(before)).not.toContain('task_teams');
    expect(await listNames(before)).not.toContain('list_tasks');

    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: MEMBER_ACCOUNT,
      capability: 'tasks.manage',
      grantedBy: 'test',
      now: clock,
    });
    const token = await mintTokenFor(
      'manager',
      'manager-pass',
      'bananasaurs:read bananasaurs:send bananasaurs:tasks',
    );
    const names = await listNames(token);
    expect(names).toContain('task_teams');
    expect(names).toContain('create_task');
    expect(names).toContain('list_tasks');

    const teamId = await createTeam(token);
    const read = text((await call(token, 'list_tasks', { guildId: gid() })).body);
    expect(read.isError).not.toBe(true);

    // A grant in guild A never reaches guild B.
    const otherGuild = text(
      (
        await call(token, 'task_teams', {
          action: 'create',
          ...teamArgs({ guildId: String(GUILD_B) }),
        })
      ).body,
    );
    expect(otherGuild.isError).toBe(true);
    const otherRead = text((await call(token, 'list_tasks', { guildId: String(GUILD_B) })).body);
    expect(otherRead.isError).toBe(true);

    authzRepo.revokeAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: MEMBER_ACCOUNT,
      capability: 'tasks.manage',
    });
    const revoked = text(
      (await call(token, 'task_teams', { action: 'delete', guildId: gid(), teamId })).body,
    );
    expect(revoked.isError).toBe(true);
    expect(taskRepo.listTeams(t.scopes.forGuild(GUILD_A))).toHaveLength(1);
    const revokedRead = text((await call(token, 'list_tasks', { guildId: gid() })).body);
    expect(revokedRead.isError).toBe(true);
  });

  it('task results follow the guild switch live: off names the dashboard switch, on says posted', async () => {
    seedTaskWorld();
    await app.close();
    app = buildDashboardApp({ ...deps, taskPostsDryRun: false });
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const teamId = await createTeam(send);
    const create = async (requestId: string) =>
      text(
        (
          await call(send, 'create_task', {
            guildId: gid(),
            teamId,
            title: `Posts ${requestId}`,
            assignmentKind: 'team',
            dueAt: due(),
            timezone: 'America/Vancouver',
            destinationId: DEST,
            requestId,
          })
        ).body,
      );
    const off = await create('posts-off-1');
    expect(off.isError).not.toBe(true);
    expect(off.text).toContain('task posts are off for this server');
    expect(off.text).toContain("Task posts switch on the dashboard's Tasks page");
    expect(off.text).not.toContain('TASK_NUDGE_SEND_ENABLED');

    guildRepo.setTaskPostsEnabled(t.scopes.forGuild(GUILD_A), true, clock);
    const on = await create('posts-on-1');
    expect(on.text).toContain(
      'Task posts are on: the announcement is posted to Discord within a minute.',
    );
    const taskId = /Created task (\S+) \(version 1\)\./.exec(on.text)?.[1];
    if (!taskId) throw new Error(`no task id in: ${on.text}`);
    const requested = text(
      (
        await call(send, 'update_task', {
          action: 'request_completion',
          guildId: gid(),
          taskId,
          expectedVersion: 1,
        })
      ).body,
    );
    expect(requested.text).toContain(
      'Task posts are on: the approval request is posted to Discord within a minute.',
    );
  });

  it('task results name BANANASAURS_DRY_RUN when dry run overrides an on switch', async () => {
    seedTaskWorld();
    guildRepo.setTaskPostsEnabled(t.scopes.forGuild(GUILD_A), true, clock);
    await app.close();
    app = buildDashboardApp({ ...deps, taskPostsDryRun: true });
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const teamId = await createTeam(send);
    const created = text(
      (
        await call(send, 'create_task', {
          guildId: gid(),
          teamId,
          title: 'Dry run',
          assignmentKind: 'team',
          dueAt: due(),
          timezone: 'America/Vancouver',
          destinationId: DEST,
          requestId: 'dry-run-1',
        })
      ).body,
    );
    expect(created.isError).not.toBe(true);
    expect(created.text).toContain('BANANASAURS_DRY_RUN=0');
  });

  it('get_health says held by dry run when the switch is on but the install holds posts back', async () => {
    guildRepo.setTaskPostsEnabled(t.scopes.forGuild(GUILD_A), true, clock);
    await app.close();
    app = buildDashboardApp({ ...deps, taskPostsDryRun: true });
    const read = await mintToken();
    const held = text((await call(read, 'get_health', {})).body);
    expect(held.isError).not.toBe(true);
    expect(held.text.split('\n')).toContain(
      '  task posts on, held by dry run (BANANASAURS_DRY_RUN)',
    );

    await app.close();
    app = buildDashboardApp({ ...deps, taskPostsDryRun: false });
    const readAgain = await mintToken();
    const on = text((await call(readAgain, 'get_health', {})).body);
    expect(on.isError).not.toBe(true);
    expect(on.text.split('\n')).toContain('  task posts on');
  });

  it('create (multi-assignee) → edit → request → approve ends done with mcp_operator audit', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const scope = t.scopes.forGuild(GUILD_A);
    const teamId = await createTeam(send);
    for (const discordUserId of [MEMBER_A, MEMBER_B]) {
      const added = text(
        (
          await call(send, 'task_teams', {
            action: 'add_member',
            guildId: gid(),
            teamId,
            discordUserId,
            kind: 'member',
          })
        ).body,
      );
      expect(added.isError).not.toBe(true);
    }
    const created = text(
      (
        await call(send, 'create_task', {
          guildId: gid(),
          teamId,
          title: 'Shared measurement',
          assignmentKind: 'individual',
          assigneeIds: [MEMBER_A, MEMBER_B],
          dueAt: due(),
          timezone: 'America/Vancouver',
          destinationId: DEST,
          requestId: 'shared-measurement-1',
        })
      ).body,
    );
    expect(created.isError).not.toBe(true);
    // Default test deps: dry run (absent = on), so the dry-run wording.
    expect(created.text).toContain('Nothing was posted to Discord');
    expect(created.text).toContain('BANANASAURS_DRY_RUN');
    const taskId = /Created task (\S+) \(version 1\)\./.exec(created.text)?.[1];
    if (!taskId) throw new Error(`no task id in: ${created.text}`);
    expect(taskRepo.listTaskAssignees(scope, taskId)).toEqual(
      expect.arrayContaining([MEMBER_A, MEMBER_B]),
    );

    // Multi-assignee edits are allowed over MCP: the assignee list is required.
    const edited = text(
      (
        await call(send, 'update_task', {
          action: 'edit',
          guildId: gid(),
          taskId,
          expectedVersion: 1,
          title: 'Shared measurement, revised',
          assignmentKind: 'individual',
          assigneeIds: [MEMBER_A, MEMBER_B],
          dueAt: due(),
          timezone: 'America/Vancouver',
          destinationId: DEST,
        })
      ).body,
    );
    expect(edited.isError).not.toBe(true);
    expect(edited.text).toContain('(version 2)');

    const requested = text(
      (
        await call(send, 'update_task', {
          action: 'request_completion',
          guildId: gid(),
          taskId,
          expectedVersion: 2,
        })
      ).body,
    );
    expect(requested.isError).not.toBe(true);
    expect(requested.text).toContain('awaiting approval (version 3)');
    expect(requested.text).toContain('Nothing was posted to Discord');

    const approved = text(
      (
        await call(send, 'update_task', {
          action: 'approve_completion',
          guildId: gid(),
          taskId,
          expectedVersion: 3,
        })
      ).body,
    );
    expect(approved.isError).not.toBe(true);
    expect(approved.text).toContain('Approved task');
    expect(approved.text).toContain('(version 4)');
    expect(taskRepo.getTask(scope, taskId)).toMatchObject({ status: 'done', version: 4 });

    const trail = effectRepo.tailAudit(scope).filter((row) => row.actorType === 'mcp_operator');
    for (const action of [
      'task.member_added',
      'task.created',
      'task.edited',
      'task.completion_requested',
      'task.approved',
    ]) {
      const row = trail.find((entry) => entry.action === action);
      expect(row).toBeDefined();
      expect(row).toMatchObject({ actorId: ACCOUNT, via: 'http' });
    }
  });

  it('reject returns an awaiting task to in_progress', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const scope = t.scopes.forGuild(GUILD_A);
    const teamId = await createTeam(send);
    const taskId = await createTeamTask(send, teamId);
    expect(
      text(
        (
          await call(send, 'update_task', {
            action: 'request_completion',
            guildId: gid(),
            taskId,
            expectedVersion: 1,
          })
        ).body,
      ).isError,
    ).not.toBe(true);
    const rejected = text(
      (
        await call(send, 'update_task', {
          action: 'reject_completion',
          guildId: gid(),
          taskId,
          expectedVersion: 2,
        })
      ).body,
    );
    expect(rejected.isError).not.toBe(true);
    expect(rejected.text).toContain('(version 3)');
    expect(taskRepo.getTask(scope, taskId)?.status).toBe('in_progress');

    const parked = text(
      (
        await call(send, 'update_task', {
          action: 'set_status',
          guildId: gid(),
          taskId,
          expectedVersion: 3,
          status: 'not_started',
        })
      ).body,
    );
    expect(parked.isError).not.toBe(true);
    expect(taskRepo.getTask(scope, taskId)).toMatchObject({ status: 'not_started', version: 4 });
  });

  it('archive hides from list_tasks and includeArchived shows it again', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const read = await mintToken('bananasaurs:read');
    const scope = t.scopes.forGuild(GUILD_A);
    const teamId = await createTeam(send);
    const taskId = await createTeamTask(send, teamId, { title: 'Archive me' });
    const archived = text(
      (
        await call(send, 'update_task', {
          action: 'archive',
          guildId: gid(),
          taskId,
          expectedVersion: 1,
        })
      ).body,
    );
    expect(archived.isError).not.toBe(true);
    expect(archived.text).toContain('(version 2)');

    const hidden = text((await call(read, 'list_tasks', { guildId: gid() })).body);
    expect(hidden.isError).not.toBe(true);
    expect(hidden.text).not.toContain('Archive me');

    const shown = text(
      (await call(read, 'list_tasks', { guildId: gid(), includeArchived: true })).body,
    );
    expect(shown.isError).not.toBe(true);
    expect(shown.text).toContain('Archive me');

    const details = text((await call(read, 'get_task', { guildId: gid(), taskId })).body);
    expect(details.isError).not.toBe(true);
    expect(
      (JSON.parse(details.text.split('\n\n')[0] ?? '') as Record<string, unknown>)['archived'],
    ).toBe(true);

    const restored = text(
      (
        await call(send, 'update_task', {
          action: 'unarchive',
          guildId: gid(),
          taskId,
          expectedVersion: 2,
        })
      ).body,
    );
    expect(restored.isError).not.toBe(true);
    expect(taskRepo.getTask(scope, taskId)?.archivedAt).toBeNull();
  });

  it('task_progress record twice with one requestId writes one report', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const scope = t.scopes.forGuild(GUILD_A);
    const teamId = await createTeam(send);
    const taskId = await createTeamTask(send, teamId);
    const requestId = '00000000-0000-4000-8000-000000000007';
    const first = text(
      (
        await call(send, 'task_progress', {
          action: 'record',
          guildId: gid(),
          taskId,
          body: 'Measured',
          requestId,
        })
      ).body,
    );
    expect(first.isError).not.toBe(true);
    const second = text(
      (
        await call(send, 'task_progress', {
          action: 'record',
          guildId: gid(),
          taskId,
          body: 'Measured',
          requestId,
        })
      ).body,
    );
    expect(second.isError).not.toBe(true);
    expect(second.text).toBe('Already recorded.');
    expect(taskRepo.listReports(scope, taskId)).toHaveLength(1);
  });

  it('create_task twice with one requestId makes one task and one announce slot', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const scope = t.scopes.forGuild(GUILD_A);
    const teamId = await createTeam(send);
    const args = {
      guildId: gid(),
      teamId,
      title: 'Club task',
      assignmentKind: 'team',
      dueAt: due(),
      timezone: 'America/Vancouver',
      destinationId: DEST,
      requestId: 'idempotent-create-1',
    };
    const first = text((await call(send, 'create_task', args)).body);
    expect(first.isError).not.toBe(true);
    const taskId = /Created task (\S+) \(version 1\)\./.exec(first.text)?.[1];
    if (!taskId) throw new Error(`no task id in: ${first.text}`);
    const second = text((await call(send, 'create_task', args)).body);
    expect(second.isError).not.toBe(true);
    expect(second.text).toContain(taskId);
    expect(second.text).toContain('nothing new was scheduled');
    expect(taskRepo.listTasks(scope)).toHaveLength(1);
    expect(
      taskNudgeRepo.slotsForTask(scope, taskId).filter((slot) => slot.kind === 'announce'),
    ).toHaveLength(1);
  });

  it('delete_task removes the task with CAS; task_progress delete_report removes one update', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const scope = t.scopes.forGuild(GUILD_A);
    const teamId = await createTeam(send);
    const taskId = await createTeamTask(send, teamId);
    const recorded = text(
      (
        await call(send, 'task_progress', {
          action: 'record',
          guildId: gid(),
          taskId,
          body: 'Measured',
          requestId: '00000000-0000-4000-8000-000000000009',
        })
      ).body,
    );
    expect(recorded.isError).not.toBe(true);
    // A stale version is refused and the task survives.
    const stale = text(
      (
        await call(send, 'delete_task', {
          guildId: gid(),
          taskId,
          expectedVersion: 99,
        })
      ).body,
    );
    expect(stale.isError).toBe(true);
    expect(taskRepo.getTask(scope, taskId)).toBeDefined();
    const reportId = taskRepo.listReports(scope, taskId)[0]?.reportId;
    if (!reportId) throw new Error('no report recorded');
    const deletedReport = text(
      (
        await call(send, 'task_progress', {
          action: 'delete_report',
          guildId: gid(),
          taskId,
          reportId,
        })
      ).body,
    );
    expect(deletedReport.isError).not.toBe(true);
    expect(taskRepo.listReports(scope, taskId)).toHaveLength(0);
    const missingReport = text(
      (
        await call(send, 'task_progress', {
          action: 'delete_report',
          guildId: gid(),
          taskId,
          reportId,
        })
      ).body,
    );
    expect(missingReport.isError).toBe(true);
    const version = taskRepo.getTask(scope, taskId)?.version ?? 0;
    const deleted = text(
      (
        await call(send, 'delete_task', {
          guildId: gid(),
          taskId,
          expectedVersion: version,
        })
      ).body,
    );
    expect(deleted.isError).not.toBe(true);
    expect(taskRepo.getTask(scope, taskId)).toBeUndefined();
    expect(taskRepo.listTasks(scope)).toHaveLength(0);
  });

  it('task_steps complete with a stale version is refused', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const teamId = await createTeam(send);
    const taskId = await createTeamTask(send, teamId);
    const appended = text(
      (
        await call(send, 'task_steps', {
          action: 'add',
          guildId: gid(),
          taskId,
          expectedVersion: 1,
          title: 'Check dampers',
          dueAt: clock + 3600000,
        })
      ).body,
    );
    expect(appended.isError).not.toBe(true);
    expect(appended.text).toContain('(version 2)');
    const childId = /Appended dated child (\S+) to task/.exec(appended.text)?.[1];
    if (!childId) throw new Error(`no child id in: ${appended.text}`);

    const renamed = text(
      (
        await call(send, 'task_steps', {
          action: 'edit',
          guildId: gid(),
          taskId,
          expectedVersion: 2,
          childId,
          title: 'Check dampers and springs',
          dueAt: clock + 3600000,
        })
      ).body,
    );
    expect(renamed.isError).not.toBe(true);
    expect(renamed.text).toContain('(version 3)');

    const stale = text(
      (
        await call(send, 'task_steps', {
          action: 'complete',
          guildId: gid(),
          taskId,
          expectedVersion: 2,
          childId,
        })
      ).body,
    );
    expect(stale.isError).toBe(true);

    const done = text(
      (
        await call(send, 'task_steps', {
          action: 'complete',
          guildId: gid(),
          taskId,
          expectedVersion: 3,
          childId,
        })
      ).body,
    );
    expect(done.isError).not.toBe(true);
    expect(done.text).toContain('(version 4)');

    const appendedTwo = text(
      (
        await call(send, 'task_steps', {
          action: 'add',
          guildId: gid(),
          taskId,
          expectedVersion: 4,
          title: 'Torque check',
          dueAt: clock + 3600000,
        })
      ).body,
    );
    const childTwo = /Appended dated child (\S+) to task/.exec(appendedTwo.text)?.[1];
    if (!childTwo) throw new Error(`no child id in: ${appendedTwo.text}`);
    const deleted = text(
      (
        await call(send, 'task_steps', {
          action: 'delete',
          guildId: gid(),
          taskId,
          expectedVersion: 5,
          childId: childTwo,
        })
      ).body,
    );
    expect(deleted.isError).not.toBe(true);
    expect(deleted.text).toContain('(version 6)');
  });

  it('update_task edit to a new channel is refused once the task was announced', async () => {
    seedTaskWorld();
    // The shared harness stub resolves only DEST; this variant app resolves
    // one more channel in the same category, so a destination move passes
    // live verification and reaches the anchor check.
    const portsFor: DashboardAppDeps['portsFor'] = (scope) => {
      const base = testPortsFor(scope, () => clock);
      return {
        ...base,
        inspectTaskChannel: (channelId) =>
          channelId === DEST_TWO
            ? Promise.resolve({
                channelId,
                kind: 'channel' as const,
                parentId: CATEGORY,
                categoryId: CATEGORY,
              })
            : base.inspectTaskChannel(channelId),
      };
    };
    const anchoredApp = buildDashboardApp({ ...deps, portsFor });
    try {
      const send = await mintToken(
        'bananasaurs:read bananasaurs:send bananasaurs:tasks',
        anchoredApp,
      );
      const teamId = await createTeam(send);
      const taskId = await createTeamTask(send, teamId);
      expect(
        taskRepo.recordTaskAnchor(
          t.scopes.forGuild(GUILD_A),
          taskId,
          DEST,
          '955555555555555555',
          clock,
        ),
      ).toBe('recorded');
      const moved = text(
        (
          await mcpPost(
            anchoredApp,
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'update_task',
                arguments: {
                  action: 'edit',
                  guildId: gid(),
                  taskId,
                  expectedVersion: 1,
                  title: 'Club task',
                  assignmentKind: 'team',
                  dueAt: due(),
                  timezone: 'America/Vancouver',
                  destinationId: DEST_TWO,
                },
              },
            },
            send,
          )
        ).body,
      );
      expect(moved.isError).toBe(true);
      expect(moved.text).toContain('its channel cannot change');
      expect(taskRepo.getTask(t.scopes.forGuild(GUILD_A), taskId)?.destinationId).toBe(DEST);
    } finally {
      await anchoredApp.close();
    }
  });

  it('task_steps complete is refused when the team category no longer resolves', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const scope = t.scopes.forGuild(GUILD_A);
    // Seeded straight through the repository: this category was never
    // injected into the gateway cache, so the live team check fails exactly
    // as if the category had been deleted after the task was created.
    const teamId = taskRepo.createTeam(
      scope,
      { name: 'Gone', categoryId: '588888888888888888', kind: 'subteam' },
      ACTOR,
      clock,
    );
    const taskId = taskRepo.createTask(
      scope,
      {
        teamId,
        title: 'Orphan',
        assignmentKind: 'team',
        dueAt: due(),
        timezone: 'America/Vancouver',
        destinationId: DEST,
        createdBy: ACCOUNT,
      },
      ACTOR,
      clock,
    );
    const added = taskRepo.changeChild(
      scope,
      taskId,
      1,
      { kind: 'add', title: 'Step', dueAt: clock + 3600000 },
      ACTOR,
      clock,
    );
    expect(added?.version).toBe(2);
    if (!added) throw new Error('child was not added');
    const refused = text(
      (
        await call(send, 'task_steps', {
          action: 'complete',
          guildId: gid(),
          taskId,
          expectedVersion: 2,
          childId: added.childId,
        })
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(taskRepo.getTask(scope, taskId)).toMatchObject({ version: 2 });
  });

  it('task_teams delete with tasks is refused; an empty team deletes', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const teamId = await createTeam(send);
    await createTeamTask(send, teamId);
    const refused = text(
      (await call(send, 'task_teams', { action: 'delete', guildId: gid(), teamId })).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Archive or move its tasks first');

    const second = await createTeam(send, { name: 'Empty', categoryId: SECOND_CATEGORY });
    const deleted = text(
      (await call(send, 'task_teams', { action: 'delete', guildId: gid(), teamId: second })).body,
    );
    expect(deleted.isError).not.toBe(true);
    expect(deleted.text).toContain(`Deleted team ${second}.`);
  });

  it('task_reminders cancel on a pending custom reminder succeeds, then refuses', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const read = await mintToken('bananasaurs:read');
    const scope = t.scopes.forGuild(GUILD_A);
    const teamId = await createTeam(send);
    const at = clock + 3600000;
    const taskId = await createTeamTask(send, teamId, { extraReminderAt: [clock + 7200000] });
    const added = text(
      (await call(send, 'task_reminders', { action: 'add', guildId: gid(), taskId, at })).body,
    );
    expect(added.isError).not.toBe(true);

    const listed = text((await call(read, 'get_task', { guildId: gid(), taskId })).body);
    expect(listed.isError).not.toBe(true);
    expect(listed.text).toContain(`custom:${taskId}:${at}`);

    const slotId = `custom:${taskId}:${at}`;
    const cancelled = text(
      (
        await call(send, 'task_reminders', {
          action: 'cancel',
          guildId: gid(),
          taskId,
          slotId,
        })
      ).body,
    );
    expect(cancelled.isError).not.toBe(true);

    const again = text(
      (
        await call(send, 'task_reminders', {
          action: 'cancel',
          guildId: gid(),
          taskId,
          slotId,
        })
      ).body,
    );
    expect(again.isError).toBe(true);
    expect(again.text).toContain('Only a pending custom reminder can be cancelled.');

    const trail = effectRepo.tailAudit(scope).filter((row) => row.actorType === 'mcp_operator');
    expect(trail.some((row) => row.action === 'task.reminder_added')).toBe(true);
    expect(trail.some((row) => row.action === 'task.reminder_cancelled')).toBe(true);

    const past = text(
      (
        await call(send, 'task_reminders', {
          action: 'add',
          guildId: gid(),
          taskId,
          at: clock - 1000,
        })
      ).body,
    );
    expect(past.isError).toBe(true);
  });

  it('task_teams list returns the member role id, members, president and quiet hours', async () => {
    seedTaskWorld();
    fakeDiscord.defineMember(MEMBER_A, [LEAD_ROLE]);
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const read = await mintToken('bananasaurs:read');
    const teamId = await createTeam(send, { leadRoleId: LEAD_ROLE, memberRoleId: MEMBER_ROLE });
    const president = text(
      (
        await call(send, 'task_settings', {
          action: 'set_president_role',
          guildId: gid(),
          roleId: PRESIDENT_ROLE,
        })
      ).body,
    );
    expect(president.isError).not.toBe(true);
    const lead = text(
      (
        await call(send, 'task_teams', {
          action: 'add_member',
          guildId: gid(),
          teamId,
          discordUserId: MEMBER_A,
          kind: 'lead',
        })
      ).body,
    );
    expect(lead.isError).not.toBe(true);

    const found = text((await call(read, 'task_teams', { action: 'list', guildId: gid() })).body);
    expect(found.isError).not.toBe(true);
    const parsed = JSON.parse(found.text) as {
      teams: Array<Record<string, unknown>>;
      presidentRoleId: string | null;
      quietHours: Record<string, unknown>;
    };
    expect(parsed.teams).toHaveLength(1);
    expect(parsed.teams[0]).toMatchObject({
      teamId,
      name: 'Tech',
      categoryId: CATEGORY,
      leadRoleId: LEAD_ROLE,
      memberRoleId: MEMBER_ROLE,
    });
    expect(JSON.stringify(parsed.teams[0])).toContain(MEMBER_A);
    expect(parsed.presidentRoleId).toBe(PRESIDENT_ROLE);
    expect(parsed.quietHours).toMatchObject({ timezone: 'America/Los_Angeles' });

    const configured = text(
      (
        await call(send, 'task_teams', {
          action: 'configure',
          guildId: gid(),
          teamId,
          memberRoleId: null,
        })
      ).body,
    );
    expect(configured.isError).not.toBe(true);
    const removed = text(
      (
        await call(send, 'task_teams', {
          action: 'remove_member',
          guildId: gid(),
          teamId,
          discordUserId: MEMBER_A,
        })
      ).body,
    );
    expect(removed.isError).not.toBe(true);
    const cleared = text(
      (await call(send, 'task_settings', { action: 'clear_president_role', guildId: gid() })).body,
    );
    expect(cleared.isError).not.toBe(true);
    const deleted = text(
      (await call(send, 'task_teams', { action: 'delete', guildId: gid(), teamId })).body,
    );
    expect(deleted.isError).not.toBe(true);
  });

  it('a duplicate category is refused with the team text', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    await createTeam(send);
    const duplicate = text(
      (await call(send, 'task_teams', { action: 'create', ...teamArgs() })).body,
    );
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toContain('That category already has a team.');
  });

  it('create_task to a destination without Write is refused', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    const teamId = await createTeam(send);
    expect(mcpSendRepo.disallowChannel(t.scopes.forGuild(GUILD_A), CATEGORY, 'category')).toBe(
      'removed',
    );
    const refused = text(
      (
        await call(send, 'create_task', {
          guildId: gid(),
          teamId,
          title: 'Club task',
          assignmentKind: 'team',
          dueAt: due(),
          timezone: 'America/Vancouver',
          destinationId: DEST,
          requestId: 'no-write-destination-1',
        })
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(taskRepo.listTasks(t.scopes.forGuild(GUILD_A))).toHaveLength(0);
  });

  it('task_teams create with an announcement channel without Write is refused', async () => {
    seedTaskWorld();
    const send = await mintToken('bananasaurs:read bananasaurs:send bananasaurs:tasks');
    expect(mcpSendRepo.disallowChannel(t.scopes.forGuild(GUILD_A), CATEGORY, 'category')).toBe(
      'removed',
    );
    const refused = text(
      (
        await call(send, 'task_teams', {
          action: 'create',
          ...teamArgs({ announcementChannelId: DEST }),
        })
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(taskRepo.listTeams(t.scopes.forGuild(GUILD_A))).toHaveLength(0);
  });
});

/**
 * Slice 3 Task 7, daemon side: `undo_action` and `list_actions` through the
 * real stack — Fastify + `registerMcpRoutes` + `createMcpServer` + the real
 * `actionsPortFor` over the real repositories and the fake Discord port —
 * with tokens minted through the real OAuth flow.
 *
 * Seeded ledger rows go straight through `mcpActionsRepo.claimAction` /
 * `completeAction` (like the pre-migration test above): the undo_json
 * shapes under test are exactly what Tasks 5–6 wrote, and seeding them
 * directly is what lets the missing-state and malformed cases exist at all.
 * The edit round-trip goes through the real `edit_message` tool first, so
 * the stored undo is read back, never re-typed. The composed client's bot
 * id is the testkit bot id, matching the message-writes describe above.
 */
describe('/mcp undo_action and list_actions through the real composition', () => {
  const CHANNEL = '911111111111111111';
  const BOT_MESSAGE = '922222222222222222';
  const MEMBER = '933333333333333333';
  const THREAD = '944444444444444444';
  const BOT_ROLE = '955555555555555555';
  /** Distinctive bot-written text: must reach the undo row, never the audit row or the list. */
  const ORIGINAL = 'undo-probe-original-bot-text-that-must-never-reach-audit-zz7';
  const GID = '111111111111111111';

  interface UndoDiscordInternals {
    guilds: { _add: (data: object) => Guild };
  }

  const seedUndoGuild = (): void => {
    const internals = deps.client as unknown as UndoDiscordInternals;
    const mutable = deps.client as unknown as { user: unknown };
    mutable.user = (
      deps.client as unknown as { users: { _add: (data: object) => unknown } }
    ).users._add({ id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' });
    const botPermissions = (
      PermissionsBitField.Flags.ViewChannel |
      PermissionsBitField.Flags.SendMessages |
      PermissionsBitField.Flags.SendMessagesInThreads |
      PermissionsBitField.Flags.AddReactions |
      // The undo re-resolves its target live (whole-branch review), so the
      // bot needs every inverse's permission: pin for pin/unpin, and
      // ManageThreads for thread inverses on a thread the MCP did not create.
      PermissionsBitField.Flags.PinMessages |
      PermissionsBitField.Flags.ManageThreads
    ).toString();
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 0,
          permission_overwrites: [],
        },
      ],
      threads: [
        {
          id: THREAD,
          guild_id: GUILD_A,
          parent_id: CHANNEL,
          owner_id: MEMBER,
          type: ChannelType.PublicThread,
          name: 'undo-thread',
          thread_metadata: {
            archived: false,
            auto_archive_duration: 1440,
            archive_timestamp: new Date().toISOString(),
            locked: false,
          },
        },
      ],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 7,
          permissions: botPermissions,
          managed: true,
        },
      ],
      members: [
        {
          user: { id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' },
          roles: [BOT_ROLE],
        },
        { user: { id: MEMBER, username: 'member', discriminator: '0' }, roles: [] },
      ],
      emojis: [],
      unavailable: false,
    });
  };

  const allow = (): void => {
    seedUndoGuild();
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: CHANNEL,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
  };

  const undoCall = (accessToken: string, name: string, args: Record<string, unknown>) =>
    mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
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

  type SeedCap = 'message' | 'edit' | 'structure' | 'pin_react' | 'member_role';

  /** One completed ledger row, exactly as a forward write leaves it. */
  const seedAction = (input: {
    readonly actionId: string;
    readonly kind: string;
    readonly capGroup: SeedCap;
    readonly targetChannelId?: string | undefined;
    readonly resultMessageId?: string | undefined;
    readonly resultThreadId?: string | undefined;
    readonly undoJson?: string | undefined;
    readonly dryRun?: boolean | undefined;
    readonly failed?: boolean | undefined;
    readonly claimOnly?: boolean | undefined;
  }): string => {
    const scope = t.scopes.forGuild(GUILD_A);
    mcpActionsRepo.claimAction(scope, {
      actionId: input.actionId,
      idempotencyKey: `key-${input.actionId}`,
      kind: input.kind,
      capGroup: input.capGroup,
      argsHash: `hash-${input.actionId}`,
      tokenId: 'tok_test',
      ...(input.targetChannelId !== undefined ? { targetChannelId: input.targetChannelId } : {}),
      now: clock,
      dryRun: input.dryRun ?? false,
    });
    if (input.claimOnly !== true && input.dryRun !== true) {
      mcpActionsRepo.completeAction(scope, input.actionId, {
        status: input.failed === true ? 'failed' : 'done',
        ...(input.resultMessageId !== undefined ? { resultMessageId: input.resultMessageId } : {}),
        ...(input.resultThreadId !== undefined ? { resultThreadId: input.resultThreadId } : {}),
        ...(input.undoJson !== undefined ? { undoJson: input.undoJson } : {}),
        now: clock,
      });
    }
    return input.actionId;
  };

  const seedActionB = (actionId: string): void => {
    const scope = t.scopes.forGuild(GUILD_B);
    mcpActionsRepo.claimAction(scope, {
      actionId,
      idempotencyKey: `key-${actionId}`,
      kind: 'message.pin',
      capGroup: 'pin_react',
      argsHash: `hash-${actionId}`,
      tokenId: 'tok_test',
      targetChannelId: CHANNEL,
      now: clock,
      dryRun: false,
    });
    mcpActionsRepo.completeAction(scope, actionId, {
      status: 'done',
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ op: 'unpin' }),
      now: clock,
    });
  };

  it('an edit undoes end-to-end: the stored text returns, mentions stay off, the row is marked', async () => {
    allow();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const send = await mintToken('bananasaurs:send');
    const edited = callText(
      (
        await undoCall(send, 'edit_message', {
          guildId: GID,
          channelId: CHANNEL,
          messageId: BOT_MESSAGE,
          content: 'edited-through-undo-probe-zz7',
          idempotencyKey: 'undo-edit-k1',
        })
      ).body,
    );
    expect(edited.isError).not.toBe(true);
    const scope = t.scopes.forGuild(GUILD_A);
    const row = mcpActionsRepo.findAction(scope, 'undo-edit-k1');
    expect(row?.kind).toBe('message.edit');
    if (row === undefined) throw new Error('forward edit left no ledger row');

    const undone = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: row.actionId })).body,
    );
    expect(undone.isError).not.toBe(true);
    expect(undone.text).toContain(row.actionId);
    expect(undone.text).toContain('message.edit');

    // The inverse ran over FakeDiscord with the stored previous text — and
    // the undo edit keeps the same empty mentions as a forward edit.
    const edits = fakeDiscord.restCalls('editMessage');
    expect(edits).toHaveLength(2);
    expect((edits[1]?.args[2] as { content?: unknown }).content).toBe(ORIGINAL);
    expect((edits[1]?.args[2] as { allowedMentions?: unknown }).allowedMentions).toEqual({
      parse: [],
      roles: [],
      users: [],
    });

    // The original is marked with the undo's id, and the undo ran under the
    // derived key with the inverse kind.
    const reread = mcpActionsRepo.findActionById(scope, row.actionId);
    expect(reread?.undoneByActionId).toBeDefined();
    const undoRow = mcpActionsRepo.findAction(scope, `undo:${row.actionId}`);
    expect(undoRow?.actionId).toBe(reread?.undoneByActionId);
    expect(undoRow?.kind).toBe('message.edit');

    // The audit trail names the inverse action, never either text (rule 4).
    const trail = effectRepo.tailAudit(scope, { limit: 50 });
    expect(trail.filter((entry) => entry.action === 'mcp.message.edit')).toHaveLength(2);
    expect(JSON.stringify(trail)).not.toContain(ORIGINAL);
    expect(JSON.stringify(trail)).not.toContain('edited-through-undo-probe-zz7');
  });

  it('every reversible kind undoes over FakeDiscord with its row marked', async () => {
    allow();
    // The message inverses address a live message: the fake throws
    // unknown-message for anything it was never told about, like Discord.
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    fakeDiscord.defineThread({ threadId: THREAD, parentId: CHANNEL });
    fakeDiscord.addThreadMember(THREAD, MEMBER);
    const send = await mintToken('bananasaurs:send');
    const scope = t.scopes.forGuild(GUILD_A);
    const cases: ReadonlyArray<{
      readonly actionId: string;
      readonly kind: string;
      readonly capGroup: SeedCap;
      readonly undoJson: string;
    }> = [
      {
        actionId: 'undo-pin',
        kind: 'message.pin',
        capGroup: 'pin_react',
        undoJson: JSON.stringify({ op: 'unpin' }),
      },
      {
        actionId: 'undo-unpin',
        kind: 'message.unpin',
        capGroup: 'pin_react',
        undoJson: JSON.stringify({ op: 'pin' }),
      },
      {
        actionId: 'undo-react-add',
        kind: 'reaction.add',
        capGroup: 'pin_react',
        undoJson: JSON.stringify({ op: 'remove-reaction', emoji: '👍' }),
      },
      {
        actionId: 'undo-react-remove',
        kind: 'reaction.remove',
        capGroup: 'pin_react',
        undoJson: JSON.stringify({ op: 'add-reaction', emoji: '👍' }),
      },
      {
        actionId: 'undo-members-add',
        kind: 'thread.members.add',
        capGroup: 'structure',
        undoJson: JSON.stringify({ userIds: [MEMBER] }),
      },
      {
        actionId: 'undo-state',
        kind: 'thread.state',
        capGroup: 'structure',
        undoJson: JSON.stringify({ archived: false }),
      },
    ];
    for (const entry of cases) {
      seedAction({
        actionId: entry.actionId,
        kind: entry.kind,
        capGroup: entry.capGroup,
        targetChannelId: entry.kind.startsWith('thread.') ? THREAD : CHANNEL,
        ...(entry.kind.startsWith('thread.') ? {} : { resultMessageId: BOT_MESSAGE }),
        undoJson: entry.undoJson,
      });
      const found = callText(
        (await undoCall(send, 'undo_action', { guildId: GID, actionId: entry.actionId })).body,
      );
      expect(found.isError).not.toBe(true);
      expect(found.text).toContain(entry.kind);
      expect(mcpActionsRepo.findActionById(scope, entry.actionId)?.undoneByActionId).toBeDefined();
    }
    expect(fakeDiscord.restCalls('unpinMessage')).toHaveLength(1);
    expect(fakeDiscord.restCalls('pinMessage')).toHaveLength(1);
    expect(fakeDiscord.restCalls('deleteOwnReaction')).toHaveLength(1);
    expect(fakeDiscord.restCalls('createReaction')).toHaveLength(1);
    expect(fakeDiscord.restCalls('removeThreadMember')).toHaveLength(1);
    expect(await fakeDiscord.isThreadMember(GUILD_A, THREAD, MEMBER)).toBe(false);
    expect(fakeDiscord.restCalls('setThreadState')).toHaveLength(1);
    expect(fakeDiscord.threadState(THREAD)).toMatchObject({ archived: false });
  });

  it('a replayed undo answers already undone with the undo action id', async () => {
    allow();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const send = await mintToken('bananasaurs:send');
    const scope = t.scopes.forGuild(GUILD_A);
    seedAction({
      actionId: 'undo-replay',
      kind: 'message.pin',
      capGroup: 'pin_react',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ op: 'unpin' }),
    });
    const first = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-replay' })).body,
    );
    expect(first.isError).not.toBe(true);
    const undoId = mcpActionsRepo.findActionById(scope, 'undo-replay')?.undoneByActionId;
    expect(undoId).toBeDefined();
    const second = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-replay' })).body,
    );
    expect(second.isError).toBe(true);
    expect(second.text).toContain('already undone');
    expect(second.text).toContain(undoId ?? '');
    expect(fakeDiscord.restCalls('unpinMessage')).toHaveLength(1);
  });

  it("undo of another guild's action is not found", async () => {
    allow();
    seedActionB('undo-foreign');
    const send = await mintToken('bananasaurs:send');
    const refused = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-foreign' })).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('No MCP action undo-foreign');
    expect(fakeDiscord.restCalls()).toHaveLength(0);
  });

  it('a dry-run, failed or still-claimed action refuses with a distinct text', async () => {
    allow();
    const send = await mintToken('bananasaurs:send');
    seedAction({
      actionId: 'undo-dry',
      kind: 'message.pin',
      capGroup: 'pin_react',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      dryRun: true,
    });
    seedAction({
      actionId: 'undo-failed',
      kind: 'message.pin',
      capGroup: 'pin_react',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      failed: true,
    });
    seedAction({
      actionId: 'undo-claimed',
      kind: 'message.pin',
      capGroup: 'pin_react',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      claimOnly: true,
    });
    const dry = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-dry' })).body,
    );
    expect(dry.isError).toBe(true);
    expect(dry.text).toContain('was a dry run');
    const failed = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-failed' })).body,
    );
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('failed with an unknown result');
    const claimed = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-claimed' })).body,
    );
    expect(claimed.isError).toBe(true);
    expect(claimed.text).toContain('has not completed yet');
    expect(new Set([dry.text, failed.text, claimed.text]).size).toBe(3);
    expect(fakeDiscord.restCalls()).toHaveLength(0);
  });

  it('kinds with no inverse, missing state and unreadable state cannot be undone', async () => {
    allow();
    const send = await mintToken('bananasaurs:send');
    const kinds: ReadonlyArray<{
      readonly actionId: string;
      readonly kind: string;
      readonly cap: SeedCap;
    }> = [
      { actionId: 'undo-send', kind: 'message.send', cap: 'message' },
      { actionId: 'undo-delete', kind: 'message.delete', cap: 'edit' },
      { actionId: 'undo-create', kind: 'thread.create', cap: 'structure' },
      { actionId: 'undo-forum', kind: 'forum.post', cap: 'message' },
      { actionId: 'undo-remove', kind: 'thread.members.remove', cap: 'structure' },
    ];
    for (const entry of kinds) {
      seedAction({
        actionId: entry.actionId,
        kind: entry.kind,
        capGroup: entry.cap,
        targetChannelId: CHANNEL,
        resultMessageId: BOT_MESSAGE,
      });
    }
    // A reversible kind whose row recorded no previous state (Task 6 leaves
    // `thread.state` without undo_json when the previous state was unknown).
    seedAction({
      actionId: 'undo-state-bare',
      kind: 'thread.state',
      capGroup: 'structure',
      targetChannelId: THREAD,
    });
    // A row whose undo_json fails its kind's schema is never guessed at.
    seedAction({
      actionId: 'undo-malformed',
      kind: 'message.edit',
      capGroup: 'edit',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: '{oops',
    });
    seedAction({
      actionId: 'undo-wrong-shape',
      kind: 'message.edit',
      capGroup: 'edit',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ op: 'unpin' }),
    });
    for (const actionId of [
      ...kinds.map((entry) => entry.actionId),
      'undo-state-bare',
      'undo-malformed',
      'undo-wrong-shape',
    ]) {
      const refused = callText(
        (await undoCall(send, 'undo_action', { guildId: GID, actionId })).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('cannot be undone');
    }
    expect(fakeDiscord.restCalls()).toHaveLength(0);
  });

  it('list_actions shows kinds, statuses, ids and undoable flags — never content, only this guild', async () => {
    allow();
    const scopeA = t.scopes.forGuild(GUILD_A);
    seedAction({
      actionId: 'list-edit',
      kind: 'message.edit',
      capGroup: 'edit',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ content: ORIGINAL, embeds: [] }),
    });
    seedAction({
      actionId: 'list-send',
      kind: 'message.send',
      capGroup: 'message',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
    });
    seedActionB('list-foreign');
    const read = await mintToken('bananasaurs:read bananasaurs:send');
    const found = callText((await undoCall(read, 'list_actions', { guildId: GID })).body);
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('list-edit | message.edit | done');
    expect(found.text).toContain(`target ${CHANNEL}`);
    expect(found.text).toContain(`message ${BOT_MESSAGE}`);
    expect(found.text).toContain('undoable yes');
    expect(found.text).toContain('list-send | message.send | done');
    expect(found.text).toContain('undoable no');
    // The bot's own previous text lives in the undo row and must never
    // reach the listing; neither does the other guild's row.
    expect(found.text).not.toContain(ORIGINAL);
    expect(found.text).not.toContain('list-foreign');
    // A structural read: no audit row, only the allowlisted log line.
    expect(
      effectRepo.tailAudit(scopeA).some((entry) => entry.action === 'mcp.read.list_actions'),
    ).toBe(false);

    const other = callText(
      (await undoCall(read, 'list_actions', { guildId: '222222222222222222' })).body,
    );
    expect(other.isError).toBe(true);
    expect(other.text).toBe(GUILD_REFUSAL_MESSAGE);
  });

  it('an undo while dry run is on records without changing and stays undoable', async () => {
    seedUndoGuild();
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: CHANNEL,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    const send = await mintToken('bananasaurs:send');
    const scope = t.scopes.forGuild(GUILD_A);
    seedAction({
      actionId: 'undo-dryrun-guild',
      kind: 'message.pin',
      capGroup: 'pin_react',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ op: 'unpin' }),
    });
    const found = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-dryrun-guild' })).body,
    );
    expect(found.isError).not.toBe(true);
    expect(found.text).toContain('Dry run');
    expect(fakeDiscord.restCalls('unpinMessage')).toHaveLength(0);
    expect(
      mcpActionsRepo.findActionById(scope, 'undo-dryrun-guild')?.undoneByActionId,
    ).toBeUndefined();
  });

  it('a dry-run undo never blocks the real one: dry run off, the undo runs and marks', async () => {
    // Whole-branch review: the dry-run row used to sit on `undo:<id>`, the
    // real undo replayed it, marked the original undone, and restored nothing.
    seedUndoGuild();
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: CHANNEL,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const send = await mintToken('bananasaurs:send');
    const scope = t.scopes.forGuild(GUILD_A);
    seedAction({
      actionId: 'undo-dry-then-real',
      kind: 'message.pin',
      capGroup: 'pin_react',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ op: 'unpin' }),
    });
    const dry = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-dry-then-real' })).body,
    );
    expect(dry.text).toContain('Dry run');
    guildRepo.setDryRun(scope, false, clock);
    const real = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-dry-then-real' })).body,
    );
    expect(real.isError).not.toBe(true);
    expect(real.text).toContain('Undid');
    expect(fakeDiscord.restCalls('unpinMessage')).toHaveLength(1);
    const marked = mcpActionsRepo.findActionById(scope, 'undo-dry-then-real')?.undoneByActionId;
    expect(marked).toBeDefined();
    expect(mcpActionsRepo.findActionById(scope, marked ?? '')?.status).toBe('done');
  });

  it('a failed undo retried with the same action id runs again and only then marks', async () => {
    allow();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const send = await mintToken('bananasaurs:send');
    const scope = t.scopes.forGuild(GUILD_A);
    seedAction({
      actionId: 'undo-fail-then-retry',
      kind: 'message.pin',
      capGroup: 'pin_react',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ op: 'unpin' }),
    });
    fakeDiscord.failNext('unpinMessage', new DiscordApiError(500, undefined, 'discord is on fire'));
    const failed = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-fail-then-retry' }))
        .body,
    );
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('unknown result');
    expect(
      mcpActionsRepo.findActionById(scope, 'undo-fail-then-retry')?.undoneByActionId,
    ).toBeUndefined();
    const retried = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-fail-then-retry' }))
        .body,
    );
    expect(retried.isError).not.toBe(true);
    expect(fakeDiscord.restCalls('unpinMessage')).toHaveLength(2);
    const marked = mcpActionsRepo.findActionById(scope, 'undo-fail-then-retry')?.undoneByActionId;
    expect(mcpActionsRepo.findActionById(scope, marked ?? '')?.status).toBe('done');
  });

  it('an edit undo restores rich embeds only, with authorable fields only', async () => {
    allow();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const send = await mintToken('bananasaurs:send');
    seedAction({
      actionId: 'undo-embeds',
      kind: 'message.edit',
      capGroup: 'edit',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({
        content: ORIGINAL,
        embeds: [
          {
            type: 'rich',
            title: 'Agenda',
            color: 3447003,
            fields: [{ name: 'When', value: 'Friday', inline: true }],
            footer: { text: 'club', proxy_icon_url: 'https://media.example/x.png' },
          },
          { type: 'link', url: 'https://example.com', provider: { name: 'example' } },
        ],
      }),
    });
    const undone = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-embeds' })).body,
    );
    expect(undone.isError).not.toBe(true);
    const body = fakeDiscord.restCalls('editMessage')[0]?.args[2] as { embeds?: unknown };
    expect(body.embeds).toEqual([
      {
        title: 'Agenda',
        color: 3447003,
        fields: [{ name: 'When', value: 'Friday', inline: true }],
        footer: { text: 'club' },
      },
    ]);
  });

  it('an undo stranded at claimed by a crash is retried once its claim is stale', async () => {
    allow();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const send = await mintToken('bananasaurs:send');
    const scope = t.scopes.forGuild(GUILD_A);
    seedAction({
      actionId: 'undo-stranded',
      kind: 'message.pin',
      capGroup: 'pin_react',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ op: 'unpin' }),
    });
    // The crashed undo: claimed eleven minutes ago, never completed.
    mcpActionsRepo.claimAction(scope, {
      actionId: 'undo-crashed',
      idempotencyKey: 'undo:undo-stranded',
      kind: 'message.unpin',
      capGroup: 'pin_react',
      argsHash: 'hash-crashed',
      tokenId: 'tok_test',
      targetChannelId: CHANNEL,
      now: clock - 11 * 60 * 1000,
      dryRun: false,
    });
    const undone = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-stranded' })).body,
    );
    expect(undone.isError).not.toBe(true);
    expect(fakeDiscord.restCalls('unpinMessage')).toHaveLength(1);
    const marked = mcpActionsRepo.findActionById(scope, 'undo-stranded')?.undoneByActionId;
    expect(marked).toBeDefined();
    expect(marked).not.toBe('undo-crashed');
  });

  it('an undo whose channel left send scope refuses with no Discord call', async () => {
    seedUndoGuild();
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
    // No allowlist row for CHANNEL: the forward pin was allowed, the undo is not.
    const send = await mintToken('bananasaurs:send');
    seedAction({
      actionId: 'undo-out-of-scope',
      kind: 'message.pin',
      capGroup: 'pin_react',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ op: 'unpin' }),
    });
    const refused = callText(
      (await undoCall(send, 'undo_action', { guildId: GID, actionId: 'undo-out-of-scope' })).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('no longer one this connector may write to');
    expect(fakeDiscord.restCalls()).toHaveLength(0);
    expect(
      mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'undo:undo-out-of-scope'),
    ).toBeUndefined();
  });

  it('a send+roles token undoes a message edit end-to-end', async () => {
    allow();
    fakeDiscord.defineMessage({
      channelId: CHANNEL,
      messageId: BOT_MESSAGE,
      authorId: BOT_USER_ID,
      content: ORIGINAL,
    });
    const both = await mintToken('bananasaurs:send bananasaurs:roles');
    const edited = callText(
      (
        await undoCall(both, 'edit_message', {
          guildId: GID,
          channelId: CHANNEL,
          messageId: BOT_MESSAGE,
          content: 'edited-by-both-scope-probe-zz7',
          idempotencyKey: 'undo-both-k1',
        })
      ).body,
    );
    expect(edited.isError).not.toBe(true);
    const scope = t.scopes.forGuild(GUILD_A);
    const row = mcpActionsRepo.findAction(scope, 'undo-both-k1');
    if (row === undefined) throw new Error('forward edit left no ledger row');

    const undone = callText(
      (await undoCall(both, 'undo_action', { guildId: GID, actionId: row.actionId })).body,
    );
    expect(undone.isError).not.toBe(true);
    expect(undone.text).toContain('message.edit');
    expect(mcpActionsRepo.findActionById(scope, row.actionId)?.undoneByActionId).toBeDefined();
  });

  it('list_actions lists every kind but never offers an out-of-scope kind as undoable', async () => {
    allow();
    seedAction({
      actionId: 'list-scope-edit',
      kind: 'message.edit',
      capGroup: 'edit',
      targetChannelId: CHANNEL,
      resultMessageId: BOT_MESSAGE,
      undoJson: JSON.stringify({ content: ORIGINAL, embeds: [] }),
    });
    seedAction({
      actionId: 'list-scope-grant',
      kind: 'role.grant',
      capGroup: 'member_role',
      undoJson: JSON.stringify({ op: 'remove-role' }),
    });

    const send = await mintToken('bananasaurs:read bananasaurs:send');
    const sendList = callText((await undoCall(send, 'list_actions', { guildId: GID })).body);
    expect(sendList.isError).not.toBe(true);
    // Both rows are listed, but only the message row is offered as undoable.
    expect(sendList.text).toContain('list-scope-edit');
    expect(sendList.text).toContain('list-scope-grant');
    const sendLines = sendList.text.split('\n');
    expect(sendLines.find((line) => line.startsWith('list-scope-edit'))).toContain('undoable yes');
    expect(sendLines.find((line) => line.startsWith('list-scope-grant'))).toContain('undoable no');

    const roles = await mintToken('bananasaurs:read bananasaurs:roles');
    const rolesList = callText((await undoCall(roles, 'list_actions', { guildId: GID })).body);
    expect(rolesList.isError).not.toBe(true);
    const rolesLines = rolesList.text.split('\n');
    expect(rolesLines.find((line) => line.startsWith('list-scope-edit'))).toContain('undoable no');
    expect(rolesLines.find((line) => line.startsWith('list-scope-grant'))).toContain(
      'undoable yes',
    );
  });
});

describe('/mcp grant_role and remove_role through the real composition', () => {
  const OWNER = '345678901234567890';
  const MEMBER = '633333333333333333';
  const MEMBER2 = '634444444444444444';
  const LOW_ROLE = '522222222222222222';
  const HIGH_ROLE = '533333333333333333';
  const DANGEROUS_ROLE = '566666666666666666';
  const UNLISTED_ROLE = '577777777777777777';
  const BOT_ROLE = '511111111111111111';
  /** Distinctive names: must never reach an audit row, which carries ids only. */
  const MEMBER_NAME = 'SammyZZ MemberQ';
  const ROLE_NAME = 'helpersZZ';
  const GID = '111111111111111111';

  interface RoleDiscordInternals {
    guilds: { _add: (data: object) => Guild };
    users: { _add: (data: object) => unknown };
  }

  const buildRoleClient = (): Client => {
    const client = new Client(buildClientOptions(() => BOT_USER_ID));
    const internals = client as unknown as RoleDiscordInternals;
    const mutable = client as unknown as { user: unknown };
    mutable.user = internals.users._add({
      id: BOT_USER_ID,
      username: 'bananasaurs',
      discriminator: '0',
    });
    const botPermissions = (
      PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages
    ).toString();
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: OWNER,
      channels: [],
      // Distinct raw positions: discord.js computes Role.position from their
      // ordering, so the comments name the order each role lands in. The bot
      // sits at 10; HIGH_ROLE at 12 is above it, the rest below.
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        { id: DANGEROUS_ROLE, name: 'floor-watch', position: 2, permissions: '0' },
        { id: UNLISTED_ROLE, name: 'lurkers', position: 3, permissions: '0' },
        { id: LOW_ROLE, name: ROLE_NAME, position: 4, permissions: '0' },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 10,
          permissions: botPermissions,
          managed: true,
        },
        { id: HIGH_ROLE, name: 'admins', position: 12, permissions: '0' },
      ],
      members: [
        {
          user: { id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' },
          roles: [BOT_ROLE],
        },
        { user: { id: OWNER, username: 'owner', discriminator: '0' }, roles: [] },
        { user: { id: MEMBER, username: 'samwise', discriminator: '0' }, roles: [] },
        { user: { id: MEMBER2, username: 'sam2', discriminator: '0' }, roles: [] },
      ],
      emojis: [],
      unavailable: false,
    });
    return client;
  };

  /** Serves the tool's member resolution: one short page, then the loop stops. */
  const serveMembers = (client: Client): void => {
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('fake guild did not land in the cache');
    const profiles = [
      { id: OWNER, username: 'owner', displayName: 'Owner' },
      { id: MEMBER, username: 'samwise', displayName: MEMBER_NAME },
      { id: MEMBER2, username: 'sam2', displayName: 'Sam the second' },
    ];
    guild.members.list = async () => {
      const members = profiles.map(
        (profile) =>
          ({
            id: profile.id,
            user: { id: profile.id, username: profile.username },
            displayName: profile.displayName,
            nickname: null,
            roles: { cache: new Collection() },
            joinedAt: new Date('2024-05-01T00:00:00.000Z'),
          }) as unknown as GuildMember,
      );
      return new Collection(members.map((member) => [member.id, member] as const));
    };
  };

  const buildRoleApp = (client: Client, discord: FakeDiscord): FastifyInstance =>
    createServer({
      deps: { ...deps },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, client, discord);
      },
    });

  const seedDiscord = (discord: FakeDiscord): void => {
    discord.defineRole({ id: LOW_ROLE, name: ROLE_NAME, position: 4 });
    discord.defineRole({ id: HIGH_ROLE, name: 'admins', position: 2 });
    discord.defineRole({ id: DANGEROUS_ROLE, name: 'floor-watch', position: 2 });
    discord.defineRole({ id: UNLISTED_ROLE, name: 'lurkers', position: 3 });
    discord.defineMember(MEMBER, []);
    discord.defineMember(MEMBER2, []);
    discord.defineMember(OWNER, [], true);
  };

  const seedRoleScope = (input: { mutate?: boolean; allowlisted?: string[] } = {}): void => {
    const scope = t.scopes.forGuild(GUILD_A);
    guildRepo.setDryRun(scope, false, clock);
    if (input.mutate !== false) {
      authzRepo.grantAccountCapability(scope, {
        accountId: ACCOUNT,
        capability: 'roles.mutate',
        grantedBy: 'test',
        now: clock,
      });
    }
    for (const roleId of input.allowlisted ?? [LOW_ROLE, HIGH_ROLE, DANGEROUS_ROLE]) {
      roleRepo.allowlistRole(scope, roleId);
    }
  };

  const roleCall = (
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

  const grantArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guildId: GID,
    member: MEMBER,
    role: LOW_ROLE,
    idempotencyKey: 'grant-k1',
    ...over,
  });

  const effectBatches = (): { batch_id: string; source: string; actor_type: string }[] =>
    t.raw.prepare('SELECT batch_id, source, actor_type FROM effect_batches').all() as {
      batch_id: string;
      source: string;
      actor_type: string;
    }[];

  const roleEffectsCount = (): number =>
    (t.raw.prepare('SELECT COUNT(*) AS n FROM role_effects').get() as { n: number }).n;

  it('a grant runs end-to-end: Discord, ledger, batch, effect and audit rows', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const granted = callText(
        (await roleCall(roleApp, accessToken, 'grant_role', grantArgs())).body,
      );
      expect(granted.isError).not.toBe(true);
      expect(granted.text).toContain('Granted');
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);

      // One ledger row: the role kind in the member_role cap group, done, with
      // the remove-role inverse and no channel target.
      const scope = t.scopes.forGuild(GUILD_A);
      const row = mcpActionsRepo.findAction(scope, 'grant-k1');
      expect(row).toMatchObject({ kind: 'role.grant', capGroup: 'member_role', status: 'done' });
      expect(row?.targetChannelId).toBeUndefined();
      expect(row?.undoJson).toBe(JSON.stringify({ op: 'remove-role' }));
      if (row === undefined) throw new Error('grant left no ledger row');

      // One batch row: source mcp, actor mcp_operator, batch id = the action id.
      expect(effectBatches()).toEqual([
        { batch_id: row.actionId, source: 'mcp', actor_type: 'mcp_operator' },
      ]);

      // One effect row: the grant, applied, under that batch.
      expect(
        t.raw.prepare('SELECT batch_id, user_id, role_id, action, state FROM role_effects').all(),
      ).toEqual([
        {
          batch_id: row.actionId,
          user_id: MEMBER,
          role_id: LOW_ROLE,
          action: 'grant',
          state: 'applied',
        },
      ]);

      // The audit row is mcp_operator, naming the grant and the before/after —
      // ids only, never the member's name or anything with content in it.
      const trail = effectRepo.tailAudit(scope, { limit: 25 });
      const audit = trail.find((entry) => entry.action === 'role.grant');
      expect(audit).toMatchObject({ actorType: 'mcp_operator', via: 'http', actorId: ACCOUNT });
      expect(JSON.stringify(trail)).not.toContain(MEMBER_NAME);
      expect(JSON.stringify(trail)).not.toContain(ROLE_NAME);
    } finally {
      await roleApp.close();
    }
  });

  it('a removal runs end-to-end and records the add-role inverse', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    discord.defineMember(MEMBER, [LOW_ROLE]);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const removed = callText(
        (
          await roleCall(
            roleApp,
            accessToken,
            'remove_role',
            grantArgs({ idempotencyKey: 'remove-k1' }),
          )
        ).body,
      );
      expect(removed.isError).not.toBe(true);
      expect(removed.text).toContain('Removed');
      expect(discord.memberRoles(MEMBER)).not.toContain(LOW_ROLE);

      const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'remove-k1');
      expect(row).toMatchObject({ kind: 'role.remove', capGroup: 'member_role', status: 'done' });
      expect(row?.undoJson).toBe(JSON.stringify({ op: 'add-role' }));
      const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 });
      const audit = trail.find((entry) => entry.action === 'role.revoke');
      expect(audit).toMatchObject({ actorType: 'mcp_operator', actorId: ACCOUNT });
    } finally {
      await roleApp.close();
    }
  });

  it('a grant by member and role name resolves both', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const granted = callText(
        (
          await roleCall(
            roleApp,
            accessToken,
            'grant_role',
            grantArgs({ member: MEMBER_NAME, role: ROLE_NAME, idempotencyKey: 'grant-name-k1' }),
          )
        ).body,
      );
      expect(granted.isError).not.toBe(true);
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
    } finally {
      await roleApp.close();
    }
  });

  it('floor is live: a role that gains ManageRoles between calls is refused with no Discord call', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      expect(
        callText((await roleCall(roleApp, accessToken, 'grant_role', grantArgs())).body).isError,
      ).not.toBe(true);
      const callsAfterGrant = discord.restCalls().length;
      expect(discord.restCalls('addRole')).toHaveLength(1);

      // Between calls the role gains a dangerous permission in the live cache.
      const cached = client.guilds.cache.get(GUILD_A)?.roles.cache.get(LOW_ROLE) as unknown as {
        permissions: PermissionsBitField;
      };
      if (cached === undefined) throw new Error('test setup: role missing from cache');
      cached.permissions = new PermissionsBitField(PermissionsBitField.Flags.ManageRoles);

      const refused = callText(
        (
          await roleCall(
            roleApp,
            accessToken,
            'grant_role',
            grantArgs({ member: MEMBER2, idempotencyKey: 'grant-floor-k1' }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('dangerous');
      // Refused before any Discord call: the REST log is exactly what the
      // first grant left, and the second grant added one addRole short of it.
      expect(discord.restCalls()).toHaveLength(callsAfterGrant);
      expect(discord.restCalls('addRole')).toHaveLength(1);
      expect(discord.memberRoles(MEMBER2)).not.toContain(LOW_ROLE);
    } finally {
      await roleApp.close();
    }
  });

  it('an account without roles.mutate is refused, with no role_effects row and no effect_batches row', async () => {
    seedRoleScope({ mutate: false });
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = callText(
        (await roleCall(roleApp, accessToken, 'grant_role', grantArgs())).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('roles.mutate');
      expect(discord.restCalls('addRole')).toHaveLength(0);
      expect(roleEffectsCount()).toBe(0);
      expect(effectBatches()).toEqual([]);
    } finally {
      await roleApp.close();
    }
  });

  it('a role not in managed_roles is refused, naming the allowlist', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = callText(
        (
          await roleCall(
            roleApp,
            accessToken,
            'grant_role',
            grantArgs({ role: UNLISTED_ROLE, idempotencyKey: 'grant-unlisted-k1' }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('not on the bot');
      expect(refused.text).toContain('allowlist');
      expect(discord.restCalls('addRole')).toHaveLength(0);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'grant-unlisted-k1'),
      ).toBeUndefined();
    } finally {
      await roleApp.close();
    }
  });

  it('the guild owner as target is protected', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = callText(
        (
          await roleCall(
            roleApp,
            accessToken,
            'grant_role',
            grantArgs({ member: OWNER, idempotencyKey: 'grant-owner-k1' }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('guild owner');
      expect(discord.restCalls('addRole')).toHaveLength(0);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'grant-owner-k1'),
      ).toBeUndefined();
    } finally {
      await roleApp.close();
    }
  });

  it('an above-bot role on the allowlist names the policy reason', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = callText(
        (
          await roleCall(
            roleApp,
            accessToken,
            'grant_role',
            grantArgs({ role: HIGH_ROLE, idempotencyKey: 'grant-high-k1' }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('above the bot');
      expect(discord.restCalls('addRole')).toHaveLength(0);
    } finally {
      await roleApp.close();
    }
  });

  it('the two-guild gate refuses the other guild with no Discord call', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = callText(
        (
          await roleCall(
            roleApp,
            accessToken,
            'grant_role',
            grantArgs({ guildId: '222222222222222222', idempotencyKey: 'grant-foreign-k1' }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(GUILD_REFUSAL_MESSAGE);
      expect(discord.restCalls()).toHaveLength(0);
    } finally {
      await roleApp.close();
    }
  });

  it('replaying the key answers the same action with one Discord call', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const first = callText(
        (await roleCall(roleApp, accessToken, 'grant_role', grantArgs())).body,
      );
      expect(first.isError).not.toBe(true);
      const second = callText(
        (await roleCall(roleApp, accessToken, 'grant_role', grantArgs())).body,
      );
      expect(second.isError).not.toBe(true);
      expect(second.text).toContain('Already recorded under this idempotency key');
      expect(discord.restCalls('addRole')).toHaveLength(1);
    } finally {
      await roleApp.close();
    }
  });

  it('the kill switch refuses with no Discord call and no ledger row', async () => {
    seedRoleScope();
    guildRepo.setKillswitch(t.scopes.forGuild(GUILD_A), true, clock);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const send = await mintToken('bananasaurs:roles');
      const refused = callText((await roleCall(roleApp, send, 'grant_role', grantArgs())).body);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('kill switch');
      expect(discord.restCalls('addRole')).toHaveLength(0);
      expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'grant-k1')).toBeUndefined();
    } finally {
      await roleApp.close();
    }
  });

  it('undo of a grant removes the role and marks the original', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const roles = await mintToken('bananasaurs:roles');
      expect(
        callText((await roleCall(roleApp, roles, 'grant_role', grantArgs())).body).isError,
      ).not.toBe(true);
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
      const scope = t.scopes.forGuild(GUILD_A);
      const row = mcpActionsRepo.findAction(scope, 'grant-k1');
      if (row === undefined) throw new Error('grant left no ledger row');

      const undone = callText(
        (await roleCall(roleApp, roles, 'undo_action', { guildId: GID, actionId: row.actionId }))
          .body,
      );
      expect(undone.isError).not.toBe(true);
      expect(undone.text).toContain('role.grant');
      expect(discord.memberRoles(MEMBER)).not.toContain(LOW_ROLE);
      expect(discord.restCalls('removeRole')).toHaveLength(1);

      const reread = mcpActionsRepo.findActionById(scope, row.actionId);
      expect(reread?.undoneByActionId).toBeDefined();
      const undoRow = mcpActionsRepo.findAction(scope, `undo:${row.actionId}`);
      expect(undoRow?.actionId).toBe(reread?.undoneByActionId);
      expect(undoRow).toMatchObject({ kind: 'role.remove', capGroup: 'member_role' });
      expect(undoRow?.targetChannelId).toBeUndefined();
    } finally {
      await roleApp.close();
    }
  });

  it('undo of a removal re-adds the role and marks the original', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    discord.defineMember(MEMBER, [LOW_ROLE]);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const roles = await mintToken('bananasaurs:roles');
      expect(
        callText(
          (
            await roleCall(
              roleApp,
              roles,
              'remove_role',
              grantArgs({ idempotencyKey: 'remove-k1' }),
            )
          ).body,
        ).isError,
      ).not.toBe(true);
      expect(discord.memberRoles(MEMBER)).not.toContain(LOW_ROLE);
      const scope = t.scopes.forGuild(GUILD_A);
      const row = mcpActionsRepo.findAction(scope, 'remove-k1');
      if (row === undefined) throw new Error('removal left no ledger row');

      const undone = callText(
        (await roleCall(roleApp, roles, 'undo_action', { guildId: GID, actionId: row.actionId }))
          .body,
      );
      expect(undone.isError).not.toBe(true);
      expect(undone.text).toContain('role.remove');
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
      expect(discord.restCalls('addRole')).toHaveLength(1);
      expect(mcpActionsRepo.findActionById(scope, row.actionId)?.undoneByActionId).toBeDefined();
    } finally {
      await roleApp.close();
    }
  });

  it('a skipped grant completes as already-had and is not undoable', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    discord.defineMember(MEMBER, [LOW_ROLE]);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const roles = await mintToken('bananasaurs:roles');
      const granted = callText((await roleCall(roleApp, roles, 'grant_role', grantArgs())).body);
      expect(granted.isError).not.toBe(true);
      expect(granted.text).toContain('already had');
      expect(discord.restCalls('addRole')).toHaveLength(0);

      const scope = t.scopes.forGuild(GUILD_A);
      const row = mcpActionsRepo.findAction(scope, 'grant-k1');
      expect(row?.status).toBe('done');
      expect(row?.undoJson).toBeUndefined();

      const undone = callText(
        (
          await roleCall(roleApp, roles, 'undo_action', {
            guildId: GID,
            actionId: row?.actionId ?? '',
          })
        ).body,
      );
      expect(undone.isError).toBe(true);
      expect(undone.text).toContain('cannot be undone');
    } finally {
      await roleApp.close();
    }
  });

  it('an undo re-checks live: a floor change after the grant refuses the undo', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const roles = await mintToken('bananasaurs:roles');
      expect(
        callText((await roleCall(roleApp, roles, 'grant_role', grantArgs())).body).isError,
      ).not.toBe(true);
      const scope = t.scopes.forGuild(GUILD_A);
      const row = mcpActionsRepo.findAction(scope, 'grant-k1');
      if (row === undefined) throw new Error('grant left no ledger row');

      const cached = client.guilds.cache.get(GUILD_A)?.roles.cache.get(LOW_ROLE) as unknown as {
        permissions: PermissionsBitField;
      };
      if (cached === undefined) throw new Error('test setup: role missing from cache');
      cached.permissions = new PermissionsBitField(PermissionsBitField.Flags.ManageRoles);

      const refused = callText(
        (await roleCall(roleApp, roles, 'undo_action', { guildId: GID, actionId: row.actionId }))
          .body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('dangerous');
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
      expect(discord.restCalls('removeRole')).toHaveLength(0);
      expect(mcpActionsRepo.findActionById(scope, row.actionId)?.undoneByActionId).toBeUndefined();
    } finally {
      await roleApp.close();
    }
  });

  it('a send-only token cannot undo a role grant: refused, the role still held, nothing marked', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const roles = await mintToken('bananasaurs:roles');
      const send = await mintToken('bananasaurs:send');
      expect(
        callText((await roleCall(roleApp, roles, 'grant_role', grantArgs())).body).isError,
      ).not.toBe(true);
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
      const scope = t.scopes.forGuild(GUILD_A);
      const row = mcpActionsRepo.findAction(scope, 'grant-k1');
      if (row === undefined) throw new Error('grant left no ledger row');

      const refused = callText(
        (await roleCall(roleApp, send, 'undo_action', { guildId: GID, actionId: row.actionId }))
          .body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('bananasaurs:roles');
      // Nothing changed: the role is still held, no inverse ran, the row is
      // still undoable, and no undo row was claimed.
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
      expect(discord.restCalls('removeRole')).toHaveLength(0);
      expect(mcpActionsRepo.findActionById(scope, row.actionId)?.undoneByActionId).toBeUndefined();
      expect(mcpActionsRepo.findAction(scope, `undo:${row.actionId}`)).toBeUndefined();
    } finally {
      await roleApp.close();
    }
  });

  it('a roles-only token cannot undo a message edit: refused before any target read', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const roles = await mintToken('bananasaurs:roles');
      const scope = t.scopes.forGuild(GUILD_A);
      mcpActionsRepo.claimAction(scope, {
        actionId: 'scope-edit-1',
        idempotencyKey: 'scope-edit-k1',
        kind: 'message.edit',
        capGroup: 'edit',
        argsHash: 'hash-scope-edit-1',
        tokenId: 'tok_test',
        targetChannelId: '911111111111111111',
        now: clock,
        dryRun: false,
      });
      mcpActionsRepo.completeAction(scope, 'scope-edit-1', {
        status: 'done',
        resultMessageId: '922222222222222222',
        undoJson: JSON.stringify({ content: 'prior text', embeds: [] }),
        now: clock,
      });

      const refused = callText(
        (await roleCall(roleApp, roles, 'undo_action', { guildId: GID, actionId: 'scope-edit-1' }))
          .body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('bananasaurs:send');
      expect(discord.restCalls('editMessage')).toHaveLength(0);
      expect(
        mcpActionsRepo.findActionById(scope, 'scope-edit-1')?.undoneByActionId,
      ).toBeUndefined();
    } finally {
      await roleApp.close();
    }
  });

  it('a send+roles token undoes a role grant end-to-end', async () => {
    seedRoleScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedDiscord(discord);
    const client = buildRoleClient();
    serveMembers(client);
    const roleApp = buildRoleApp(client, discord);
    try {
      const both = await mintToken('bananasaurs:send bananasaurs:roles');
      expect(
        callText((await roleCall(roleApp, both, 'grant_role', grantArgs())).body).isError,
      ).not.toBe(true);
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
      const scope = t.scopes.forGuild(GUILD_A);
      const row = mcpActionsRepo.findAction(scope, 'grant-k1');
      if (row === undefined) throw new Error('grant left no ledger row');

      const undone = callText(
        (await roleCall(roleApp, both, 'undo_action', { guildId: GID, actionId: row.actionId }))
          .body,
      );
      expect(undone.isError).not.toBe(true);
      expect(undone.text).toContain('role.grant');
      expect(discord.memberRoles(MEMBER)).not.toContain(LOW_ROLE);
      expect(mcpActionsRepo.findActionById(scope, row.actionId)?.undoneByActionId).toBeDefined();
    } finally {
      await roleApp.close();
    }
  });
});
/**
 * Slice 4 Task 4, daemon side: `bulk_role_change` through the real stack —
 * Fastify + `registerMcpRoutes` + `createMcpServer` + the real
 * `bulkRolesPortFor` over the real repositories and the fake Discord port —
 * with tokens minted through the real OAuth flow, and the durable
 * `mcp.bulk_role` job driven through the real MCP gateway.
 *
 * What this proves: a preview stores the row (token hashed, 10-minute
 * expiry) and writes no ledger row; a confirm checks guild, single use,
 * expiry and the args hash with a distinct refusal each, then claims one
 * `role.bulk` row and enqueues the job; the job walks the previewed set —
 * never a fresh query — through the gateway with per-member outcomes; the
 * `member_role` cap counts members; and the token reaches neither an audit
 * row nor any other stored row.
 */
describe('/mcp bulk_role_change through the real composition', () => {
  const OWNER = '345678901234567890';
  const MEMBER = '633333333333333333';
  const MEMBER2 = '634444444444444444';
  const MEMBER3 = '635555555555555555';
  const LOW_ROLE = '522222222222222222';
  const OTHER_ROLE = '544444444444444444';
  const BOT_ROLE = '511111111111111111';
  const GID = '111111111111111111';
  /** Distinctive names: must never reach an audit row, which carries ids only. */
  const MEMBER_NAME = 'SammyZZ MemberQ';
  const ROLE_NAME = 'helpersZZ';

  interface BulkDiscordInternals {
    guilds: { _add: (data: object) => Guild };
    users: { _add: (data: object) => unknown };
  }

  const buildBulkClient = (): Client => {
    const client = new Client(buildClientOptions(() => BOT_USER_ID));
    const internals = client as unknown as BulkDiscordInternals;
    const mutable = client as unknown as { user: unknown };
    mutable.user = internals.users._add({
      id: BOT_USER_ID,
      username: 'bananasaurs',
      discriminator: '0',
    });
    const botPermissions = (
      PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages
    ).toString();
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: OWNER,
      channels: [],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        { id: OTHER_ROLE, name: 'ushers', position: 2, permissions: '0' },
        { id: LOW_ROLE, name: ROLE_NAME, position: 4, permissions: '0' },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 10,
          permissions: botPermissions,
          managed: true,
        },
      ],
      members: [
        {
          user: { id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' },
          roles: [BOT_ROLE],
        },
        { user: { id: OWNER, username: 'owner', discriminator: '0' }, roles: [] },
        { user: { id: MEMBER, username: 'samwise', discriminator: '0' }, roles: [] },
        { user: { id: MEMBER2, username: 'sam2', discriminator: '0' }, roles: [] },
      ],
      emojis: [],
      unavailable: false,
    });
    return client;
  };

  /** Serves the tool's member resolution: one short page, then the loop stops. */
  const serveBulkMembers = (client: Client): void => {
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('fake guild did not land in the cache');
    const profiles = [
      { id: OWNER, username: 'owner', displayName: 'Owner' },
      { id: MEMBER, username: 'samwise', displayName: MEMBER_NAME },
      { id: MEMBER2, username: 'sam2', displayName: 'Sam the second' },
    ];
    guild.members.list = async () => {
      const members = profiles.map(
        (profile) =>
          ({
            id: profile.id,
            user: { id: profile.id, username: profile.username },
            displayName: profile.displayName,
            nickname: null,
            roles: { cache: new Collection() },
            joinedAt: new Date('2024-05-01T00:00:00.000Z'),
          }) as unknown as GuildMember,
      );
      return new Collection(members.map((member) => [member.id, member] as const));
    };
  };

  const buildBulkApp = (
    client: Client,
    discord: FakeDiscord,
    logger: DashboardAppDeps['logger'] = deps.logger,
  ): FastifyInstance =>
    createServer({
      deps: { ...deps, logger },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, client, discord);
      },
    });

  const seedBulkDiscord = (discord: FakeDiscord): void => {
    discord.defineRole({ id: LOW_ROLE, name: ROLE_NAME, position: 4 });
    discord.defineRole({ id: OTHER_ROLE, name: 'ushers', position: 3 });
    discord.defineMember(MEMBER, []);
    discord.defineMember(MEMBER2, []);
    discord.defineMember(MEMBER3, []);
    discord.defineMember(OWNER, [], true);
  };

  const seedBulkScope = (): void => {
    const scope = t.scopes.forGuild(GUILD_A);
    guildRepo.setDryRun(scope, false, clock);
    authzRepo.grantAccountCapability(scope, {
      accountId: ACCOUNT,
      capability: 'roles.mutate',
      grantedBy: 'test',
      now: clock,
    });
    roleRepo.allowlistRole(scope, LOW_ROLE);
    roleRepo.allowlistRole(scope, OTHER_ROLE);
  };

  const bulkCall = (
    target: FastifyInstance,
    accessToken: string,
    toolName: string,
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
        params: { name: toolName, arguments: args },
      }),
    });

  const bulkText = (
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

  const previewArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guildId: GID,
    action: 'add',
    role: LOW_ROLE,
    members: [MEMBER, MEMBER2],
    idempotencyKey: 'bulk-preview-k1',
    ...over,
  });

  const extractToken = (text: string): string => {
    const match = /confirmToken "([0-9a-f]{32})"/.exec(text);
    if (match?.[1] === undefined) throw new Error('preview answer carried no token');
    return match[1];
  };

  const extractJobId = (text: string): number => {
    const match = /job (\d+) is applying/.exec(text);
    if (match?.[1] === undefined) throw new Error('confirm answer carried no job id');
    return Number(match[1]);
  };

  /**
   * Drives the durable job the way the per-guild worker does: the handler
   * from `runtime/guild.ts`'s registration, over the real MCP gateway and
   * the test's fakes, with a capturing logger for the per-member outcomes.
   */
  const runBulkJob = async (
    client: Client,
    discord: FakeDiscord,
    input: { previewId: string; actionId: string; jobId: number; cursor?: string | null },
  ): Promise<{
    readonly lines: string[];
    readonly saved: (string | null)[];
    readonly logged: { readonly fields: unknown; readonly msg: string }[];
  }> => {
    const scope = t.scopes.forGuild(GUILD_A);
    const lines: string[] = [];
    const saved: (string | null)[] = [];
    const logged: { readonly fields: unknown; readonly msg: string }[] = [];
    const logger = {
      info: (fields: unknown, message: string) => {
        lines.push(message);
        logged.push({ fields, msg: message });
      },
      warn: (fields: unknown, message: string) => {
        lines.push(message);
        logged.push({ fields, msg: message });
      },
      error: (fields: unknown, message: string) => {
        lines.push(message);
        logged.push({ fields, msg: message });
      },
    } as never;
    await mcpBulkRoleHandler({
      scope,
      logger,
      now: () => clock,
      gateway: mcpRoleGatewayFor(
        {
          authz: authzStoreFor(scope),
          rateLimiter: new RateLimiter(1000),
          logger,
          now: () => clock,
        },
        client,
        discord,
        scope,
      ),
      authorizeAccount: (accountId) => {
        const result = authorize(
          {
            store: authzStoreFor(scope),
            guildId: GUILD_A,
            actor: { type: 'dashboard', id: accountId, roleIds: [] },
          },
          'roles.mutate',
        );
        return result.ok ? result.value : undefined;
      },
      findPreview: (previewId) => mcpBulkRepo.findPreviewById(scope, previewId),
    }).run(
      {
        guildId: GID,
        previewId: input.previewId,
        actionId: input.actionId,
        accountId: ACCOUNT,
      },
      {
        jobId: input.jobId,
        attempts: 1,
        cursor: input.cursor ?? null,
        saveCursor: (cursor) => {
          saved.push(cursor);
        },
      },
    );
    return { lines, saved, logged };
  };

  const storedTrail = (): string => {
    const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 100 });
    const actions = t.raw
      .prepare('SELECT action_id, kind, args_hash, token_id FROM mcp_actions')
      .all();
    const jobs = t.raw.prepare('SELECT kind, payload FROM jobs').all();
    return JSON.stringify({ trail, actions, jobs });
  };

  it('a preview stores the row and renders count, names, token and expiry, with no ledger row', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const preview = bulkText(
        (await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body,
      );
      expect(preview.isError).not.toBe(true);
      expect(preview.text).toContain('2 members');
      expect(preview.text).toContain(MEMBER_NAME);
      expect(preview.text).toContain('Sam the second');
      const token = extractToken(preview.text);
      const scope = t.scopes.forGuild(GUILD_A);
      const stored = mcpBulkRepo.findPreviewByToken(scope, token);
      expect(stored).toMatchObject({
        actionKind: 'add',
        roleId: LOW_ROLE,
        memberIds: [MEMBER, MEMBER2],
      });
      expect(stored?.expiresAt).toBeGreaterThan(clock);
      expect(stored?.consumedAt).toBeUndefined();
      // A preview writes no mcp_actions row.
      expect(mcpActionsRepo.findAction(scope, 'bulk-preview-k1')).toBeUndefined();
      // The token reaches neither an audit row nor any other stored row.
      expect(storedTrail()).not.toContain(token);
      expect(storedTrail()).not.toContain(MEMBER_NAME);
      expect(storedTrail()).not.toContain(ROLE_NAME);
    } finally {
      await bulkApp.close();
    }
  });

  it('a confirm consumes the preview, claims role.bulk and enqueues mcp.bulk_role', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const confirmed = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-confirm-k1' }),
          )
        ).body,
      );
      expect(confirmed.isError).not.toBe(true);
      expect(confirmed.text).toContain('get_job');
      const jobId = extractJobId(confirmed.text);
      const scope = t.scopes.forGuild(GUILD_A);
      const stored = mcpBulkRepo.findPreviewByToken(scope, token);
      expect(stored?.consumedAt).toBe(clock);
      expect(stored?.jobId).toBe(jobId);
      if (stored === undefined) throw new Error('confirm left no preview row');
      const row = mcpActionsRepo.findAction(scope, 'bulk-confirm-k1');
      expect(row).toMatchObject({ kind: 'role.bulk', capGroup: 'member_role', status: 'done' });
      if (row === undefined) throw new Error('confirm left no ledger row');
      expect(confirmed.text).toContain(row.actionId);
      // One batch row: source mcp, batch id = the action id.
      expect(
        t.raw
          .prepare('SELECT batch_id, source FROM effect_batches WHERE batch_id = ?')
          .get(row.actionId),
      ).toEqual({ batch_id: row.actionId, source: 'mcp' });
      // One job row: the bulk kind, carrying preview and action ids — never the token.
      const job = jobRepo.findJob(scope, jobId);
      expect(job?.kind).toBe('mcp.bulk_role');
      expect(job?.payload).toContain(stored.previewId);
      expect(job?.payload).toContain(row.actionId);
      expect(job?.payload).not.toContain(token);
    } finally {
      await bulkApp.close();
    }
  });

  it('a same-key retry after a successful confirm replays with the original job id', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const scope = t.scopes.forGuild(GUILD_A);
      const confirmed = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-retry-k1' }),
          )
        ).body,
      );
      expect(confirmed.isError).not.toBe(true);
      const jobId = extractJobId(confirmed.text);
      const jobsAfterConfirm = jobRepo.listJobs(scope, {}).length;

      // The answer was lost: the same confirm runs again with the same key.
      const replayed = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-retry-k1' }),
          )
        ).body,
      );
      expect(replayed.isError).not.toBe(true);
      // The original job id, from the preview — not a fresh job.
      expect(extractJobId(replayed.text)).toBe(jobId);
      expect(jobRepo.listJobs(scope, {}).length).toBe(jobsAfterConfirm);
      // Still one ledger row for the key: the retry replayed it.
      expect(mcpActionsRepo.findAction(scope, 'bulk-retry-k1')?.status).toBe('done');
    } finally {
      await bulkApp.close();
    }
  });

  it('a different key after a successful confirm is preview-used', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const confirmed = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-used-k1' }),
          )
        ).body,
      );
      expect(confirmed.isError).not.toBe(true);

      const refused = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-used-k2' }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('already used');
      // The failed retry claimed a row but consumed nothing new: the preview
      // still names the first confirm's job.
      const scope = t.scopes.forGuild(GUILD_A);
      expect(mcpBulkRepo.findPreviewByToken(scope, token)?.jobId).toBe(
        extractJobId(confirmed.text),
      );
    } finally {
      await bulkApp.close();
    }
  });

  it('the job applies the previewed set through the gateway, with per-member outcomes', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const confirmed = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-confirm-k1' }),
          )
        ).body,
      );
      const jobId = extractJobId(confirmed.text);
      const scope = t.scopes.forGuild(GUILD_A);
      const stored = mcpBulkRepo.findPreviewByToken(scope, token);
      if (stored === undefined) throw new Error('confirm left no preview row');
      const row = mcpActionsRepo.findAction(scope, 'bulk-confirm-k1');
      if (row === undefined) throw new Error('confirm left no ledger row');
      const { lines } = await runBulkJob(client, discord, {
        previewId: stored.previewId,
        actionId: row.actionId,
        jobId,
      });
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
      expect(discord.memberRoles(MEMBER2)).toContain(LOW_ROLE);
      expect(lines.join('\n')).toContain('2/2 applied');
      // One effect row per member, under the confirm's batch.
      expect(
        t.raw.prepare('SELECT user_id, role_id, action, state FROM role_effects').all(),
      ).toEqual([
        { user_id: MEMBER, role_id: LOW_ROLE, action: 'grant', state: 'applied' },
        { user_id: MEMBER2, role_id: LOW_ROLE, action: 'grant', state: 'applied' },
      ]);
      // The audit trail names ids and the bulk reason — never a name or the token.
      const trail = effectRepo.tailAudit(scope, { limit: 25 });
      expect(trail.filter((entry) => entry.action === 'role.grant')).toHaveLength(2);
      expect(storedTrail()).not.toContain(token);
      expect(storedTrail()).not.toContain(MEMBER_NAME);
      expect(storedTrail()).not.toContain(ROLE_NAME);
    } finally {
      await bulkApp.close();
    }
  });

  it('the token reaches no log line across preview, confirm and the job', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const captured: { readonly fields: unknown; readonly msg: string }[] = [];
    const captureLogger = {
      info(fields: unknown, msg: string) {
        captured.push({ fields, msg });
      },
      warn(fields: unknown, msg: string) {
        captured.push({ fields, msg });
      },
      error(fields: unknown, msg: string) {
        captured.push({ fields, msg });
      },
      debug() {},
      fatal() {},
      trace() {},
    } as never;
    const bulkApp = buildBulkApp(client, discord, captureLogger);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const confirmed = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-confirm-k1' }),
          )
        ).body,
      );
      expect(confirmed.isError).not.toBe(true);
      const jobId = extractJobId(confirmed.text);
      const scope = t.scopes.forGuild(GUILD_A);
      const stored = mcpBulkRepo.findPreviewByToken(scope, token);
      if (stored === undefined) throw new Error('confirm left no preview row');
      const row = mcpActionsRepo.findAction(scope, 'bulk-confirm-k1');
      if (row === undefined) throw new Error('confirm left no ledger row');
      const { logged } = await runBulkJob(client, discord, {
        previewId: stored.previewId,
        actionId: row.actionId,
        jobId,
      });
      // The token authenticates the confirm: it must reach neither the HTTP
      // layer's log lines nor the job's, fields and messages alike — and
      // neither do member display names, which live in responses only.
      const dump = JSON.stringify({ captured, logged });
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(MEMBER_NAME);
    } finally {
      await bulkApp.close();
    }
  });

  it('the job applies the previewed set even after membership changed', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const confirmed = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-confirm-k1' }),
          )
        ).body,
      );
      const jobId = extractJobId(confirmed.text);
      const scope = t.scopes.forGuild(GUILD_A);
      const stored = mcpBulkRepo.findPreviewByToken(scope, token);
      if (stored === undefined) throw new Error('confirm left no preview row');
      const row = mcpActionsRepo.findAction(scope, 'bulk-confirm-k1');
      if (row === undefined) throw new Error('confirm left no ledger row');
      // After the preview: MEMBER already holds the role (a grant behind the
      // job's back), and MEMBER3 appeared in Discord (never previewed).
      discord.defineMember(MEMBER, [LOW_ROLE]);
      const { lines } = await runBulkJob(client, discord, {
        previewId: stored.previewId,
        actionId: row.actionId,
        jobId,
      });
      expect(discord.memberRoles(MEMBER2)).toContain(LOW_ROLE);
      // MEMBER3 was never in the previewed set: the job never re-resolves.
      expect(discord.memberRoles(MEMBER3)).not.toContain(LOW_ROLE);
      expect(lines.join('\n')).toContain(`${MEMBER}:already-had`);
      expect(lines.join('\n')).toContain('1/2 applied');
    } finally {
      await bulkApp.close();
    }
  });

  it('a selector preview confirms and applies without re-listing at confirm', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const args = previewArgs({ members: undefined, selector: {} });
      const preview = bulkText(
        (await bulkCall(bulkApp, accessToken, 'bulk_role_change', args)).body,
      );
      expect(preview.isError).not.toBe(true);
      // The stub listing holds three members: the selector matches all three.
      expect(preview.text).toContain('3 members');
      const token = extractToken(preview.text);
      const confirmed = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({
              members: undefined,
              selector: {},
              confirmToken: token,
              idempotencyKey: 'bulk-selector-k1',
            }),
          )
        ).body,
      );
      expect(confirmed.isError).not.toBe(true);
      const jobId = extractJobId(confirmed.text);
      const scope = t.scopes.forGuild(GUILD_A);
      const stored = mcpBulkRepo.findPreviewByToken(scope, token);
      if (stored === undefined) throw new Error('confirm left no preview row');
      expect(stored.memberIds).toHaveLength(3);
      const row = mcpActionsRepo.findAction(scope, 'bulk-selector-k1');
      if (row === undefined) throw new Error('confirm left no ledger row');
      await runBulkJob(client, discord, {
        previewId: stored.previewId,
        actionId: row.actionId,
        jobId,
      });
      // The owner is protected: refused per member, while the others apply.
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
      expect(discord.memberRoles(MEMBER2)).toContain(LOW_ROLE);
    } finally {
      await bulkApp.close();
    }
  });

  it('a tampered argument at confirm is args-changed, with no new row and no job', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const jobsBefore = jobRepo.listJobs(t.scopes.forGuild(GUILD_A), {}).length;
      const refused = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({
              members: [MEMBER],
              confirmToken: token,
              idempotencyKey: 'bulk-tampered-k1',
            }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('do not match the preview');
      expect(refused.text).not.toContain(token);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'bulk-tampered-k1'),
      ).toBeUndefined();
      expect(jobRepo.listJobs(t.scopes.forGuild(GUILD_A), {}).length).toBe(jobsBefore);
      expect(discord.memberRoles(MEMBER)).not.toContain(LOW_ROLE);
    } finally {
      await bulkApp.close();
    }
  });

  it('an expired token is preview-expired', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      const token = 'tok-expired-zz0000000000000001';
      mcpBulkRepo.createPreview(scope, {
        previewId: 'preview-expired',
        token,
        actionKind: 'add',
        roleId: LOW_ROLE,
        argsHash: bulkArgsHashFor({ action: 'add', roleId: LOW_ROLE, members: [MEMBER] }),
        memberIds: [MEMBER],
        createdAt: clock - 700_000,
        expiresAt: clock - 100_000,
      });
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({
              members: [MEMBER],
              confirmToken: token,
              idempotencyKey: 'bulk-expired-k1',
            }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('expired');
      expect(refused.text).not.toContain(token);
      expect(mcpActionsRepo.findAction(scope, 'bulk-expired-k1')).toBeUndefined();
    } finally {
      await bulkApp.close();
    }
  });

  it('a reused token is preview-used', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const first = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-reuse-k1' }),
          )
        ).body,
      );
      expect(first.isError).not.toBe(true);
      const second = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-reuse-k2' }),
          )
        ).body,
      );
      expect(second.isError).toBe(true);
      expect(second.text).toContain('already used');
      expect(second.text).not.toContain(token);
      // A reused token under a new key refuses before the pipeline: no ledger
      // row, so no job and no cap weight.
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'bulk-reuse-k2'),
      ).toBeUndefined();
    } finally {
      await bulkApp.close();
    }
  });

  it('a confirm that loses the consume race leaves no runnable bulk job', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const previewId = mcpBulkRepo.findPreviewByToken(scope, token)?.previewId;
      if (previewId === undefined) throw new Error('preview was not stored');
      // The race, made deterministic: the role is out of the cache, so the
      // confirm's live pre-check awaits a role fetch. While it waits, another
      // confirm wins the single-use consume, and the role is back in the
      // cache for the grant policy — this confirm passes every pre-check and
      // only `consumePreview` inside `execute` can stop it.
      const guild = client.guilds.cache.get(GUILD_A);
      const role = guild?.roles.cache.get(LOW_ROLE);
      if (guild === undefined || role === undefined) throw new Error('role not cached');
      guild.roles.cache.delete(LOW_ROLE);
      const fetchRoles = discord.fetchRoles.bind(discord);
      discord.fetchRoles = async (guildId) => {
        mcpBulkRepo.consumePreview(scope, previewId, 987654, clock);
        guild.roles.cache.set(LOW_ROLE, role);
        return fetchRoles(guildId);
      };
      const loser = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-race-k1' }),
          )
        ).body,
      );
      expect(loser.isError).toBe(true);
      expect(loser.text).toContain('already used');
      const bulkJobs = jobRepo
        .listJobs(scope, { limit: 100 })
        .filter((job) => job.kind === 'mcp.bulk_role');
      // The loser enqueued before its consume failed; that job is cancelled,
      // never left queued to run.
      expect(bulkJobs.length).toBeGreaterThan(0);
      expect(bulkJobs.filter((job) => job.state === 'queued')).toHaveLength(0);
    } finally {
      await bulkApp.close();
    }
  });

  it("another guild's token is unknown", async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const scopeB = t.scopes.forGuild(GUILD_B);
      const token = 'tok-foreign-zz0000000000000001';
      mcpBulkRepo.createPreview(scopeB, {
        previewId: 'preview-foreign',
        token,
        actionKind: 'add',
        roleId: LOW_ROLE,
        argsHash: bulkArgsHashFor({ action: 'add', roleId: LOW_ROLE, members: [MEMBER] }),
        memberIds: [MEMBER],
        createdAt: clock,
        expiresAt: clock + 600_000,
      });
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({
              members: [MEMBER],
              confirmToken: token,
              idempotencyKey: 'bulk-foreign-k1',
            }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('No bulk preview matches that token');
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'bulk-foreign-k1'),
      ).toBeUndefined();
    } finally {
      await bulkApp.close();
    }
  });

  it('a dry-run confirm records without a job and leaves the preview usable', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      const scope = t.scopes.forGuild(GUILD_A);
      const jobsBefore = jobRepo.listJobs(scope, {}).length;
      const dry = bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-dry-k1', dryRun: true }),
          )
        ).body,
      );
      expect(dry.isError).not.toBe(true);
      expect(dry.text).toContain('Dry run');
      expect(dry.text).not.toContain('get_job');
      expect(jobRepo.listJobs(scope, {}).length).toBe(jobsBefore);
      expect(mcpBulkRepo.findPreviewByToken(scope, token)?.consumedAt).toBeUndefined();
      expect(discord.memberRoles(MEMBER)).not.toContain(LOW_ROLE);
    } finally {
      await bulkApp.close();
    }
  });

  it('undo_action on role.bulk answers that it cannot be undone', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const token = extractToken(
        bulkText((await bulkCall(bulkApp, accessToken, 'bulk_role_change', previewArgs())).body)
          .text,
      );
      bulkText(
        (
          await bulkCall(
            bulkApp,
            accessToken,
            'bulk_role_change',
            previewArgs({ confirmToken: token, idempotencyKey: 'bulk-undo-k1' }),
          )
        ).body,
      );
      const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'bulk-undo-k1');
      if (row === undefined) throw new Error('confirm left no ledger row');
      const undone = bulkText(
        (
          await bulkCall(bulkApp, accessToken, 'undo_action', {
            guildId: GID,
            actionId: row.actionId,
          })
        ).body,
      );
      expect(undone.isError).toBe(true);
      expect(undone.text).toContain('opposite bulk change');
    } finally {
      await bulkApp.close();
    }
  });

  it('the cap counts members: 100 previewed plus 901 singles refuse the next grant', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      mcpBulkRepo.createPreview(scope, {
        previewId: 'preview-cap',
        token: 'tok-cap-zz0000000000000001',
        actionKind: 'add',
        roleId: LOW_ROLE,
        argsHash: 'args-cap',
        memberIds: Array.from({ length: 100 }, (_, i) => `6${String(10000000000000000 + i)}`),
        createdAt: clock,
        expiresAt: clock + 600_000,
      });
      expect(mcpBulkRepo.consumePreview(scope, 'preview-cap', 7, clock)).toBe(true);
      mcpActionsRepo.claimAction(scope, {
        actionId: 'act-cap-bulk',
        idempotencyKey: 'k-cap-bulk',
        kind: 'role.bulk',
        capGroup: 'member_role',
        argsHash: 'args-cap',
        tokenId: 'tok_testtoken',
        now: clock,
        dryRun: false,
      });
      for (let i = 0; i < 901; i += 1) {
        mcpActionsRepo.claimAction(scope, {
          actionId: `act-cap-single-${String(i)}`,
          idempotencyKey: `k-cap-single-${String(i)}`,
          kind: 'role.grant',
          capGroup: 'member_role',
          argsHash: `h-cap-single-${String(i)}`,
          tokenId: 'tok_testtoken',
          now: clock,
          dryRun: false,
        });
      }
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = bulkText(
        (
          await bulkCall(bulkApp, accessToken, 'grant_role', {
            guildId: GID,
            member: MEMBER,
            role: LOW_ROLE,
            idempotencyKey: 'grant-capped-k1',
          })
        ).body,
      );
      // 901 singles minus the bulk row plus its 100 members = 1000: full.
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('member-role budget');
      expect(discord.memberRoles(MEMBER)).not.toContain(LOW_ROLE);
      expect(discord.restCalls('addRole')).toHaveLength(0);
    } finally {
      await bulkApp.close();
    }
  });

  it('the cap still admits a grant at 899 singles plus the 100-member bulk', async () => {
    seedBulkScope();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedBulkDiscord(discord);
    const client = buildBulkClient();
    serveBulkMembers(client);
    const bulkApp = buildBulkApp(client, discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      mcpBulkRepo.createPreview(scope, {
        previewId: 'preview-cap-ok',
        token: 'tok-cap-ok-zz000000000001',
        actionKind: 'add',
        roleId: LOW_ROLE,
        argsHash: 'args-cap-ok',
        memberIds: Array.from({ length: 100 }, (_, i) => `6${String(10000000000000000 + i)}`),
        createdAt: clock,
        expiresAt: clock + 600_000,
      });
      expect(mcpBulkRepo.consumePreview(scope, 'preview-cap-ok', 7, clock)).toBe(true);
      mcpActionsRepo.claimAction(scope, {
        actionId: 'act-cap-ok-bulk',
        idempotencyKey: 'k-cap-ok-bulk',
        kind: 'role.bulk',
        capGroup: 'member_role',
        argsHash: 'args-cap-ok',
        tokenId: 'tok_testtoken',
        now: clock,
        dryRun: false,
      });
      for (let i = 0; i < 899; i += 1) {
        mcpActionsRepo.claimAction(scope, {
          actionId: `act-cap-ok-single-${String(i)}`,
          idempotencyKey: `k-cap-ok-single-${String(i)}`,
          kind: 'role.grant',
          capGroup: 'member_role',
          argsHash: `h-cap-ok-single-${String(i)}`,
          tokenId: 'tok_testtoken',
          now: clock,
          dryRun: false,
        });
      }
      const accessToken = await mintToken('bananasaurs:roles');
      const granted = bulkText(
        (
          await bulkCall(bulkApp, accessToken, 'grant_role', {
            guildId: GID,
            member: MEMBER,
            role: LOW_ROLE,
            idempotencyKey: 'grant-ok-k1',
          })
        ).body,
      );
      // 899 singles minus the bulk row plus its 100 members = 999: one more fits.
      expect(granted.isError).not.toBe(true);
      expect(discord.memberRoles(MEMBER)).toContain(LOW_ROLE);
    } finally {
      await bulkApp.close();
    }
  });
});
/**
 * Slice 4 Task 5, daemon side: `create_role` and `edit_role` through the
 * real stack — Fastify + `registerMcpRoutes` + `createMcpServer` + the real
 * `roleAdminPortFor` over the real repositories and the fake Discord port —
 * with tokens minted through the real OAuth flow.
 *
 * What this proves: a created role always carries permissions `"0"` and
 * lands directly below the bot; both tools enforce `roles.mutate`; the grant
 * policy and the floor refuse before any Discord call; an edit restores
 * through `undo_action`; a creation never does; and neither the audit row
 * nor the tool answer carries a role name.
 */
describe('/mcp create_role and edit_role through the real composition', () => {
  const BOT_ROLE = '511111111111111111';
  const LOW_ROLE = '522222222222222222';
  const ABOVE_ROLE = '533333333333333333';
  const MANAGED_ROLE = '555555555555555555';
  const DANGEROUS_ROLE = '566666666666666666';
  const GHOST_ROLE = '599999999999999999';
  const GID = '111111111111111111';
  /** Distinctive role name: must reach Discord, must never reach the audit row or an answer. */
  const SENTINEL = 'SentinelRoleNamezz9';
  /** Distinct raw positions: discord.js computes `Role.position` from their ordering. */
  const BOT_TOP_RAW = 10;

  interface RoleDiscordInternals {
    guilds: { _add: (data: object) => Guild };
  }

  const seedRoleGuild = (): void => {
    const internals = deps.client as unknown as RoleDiscordInternals;
    const mutable = deps.client as unknown as { user: unknown };
    mutable.user = (
      deps.client as unknown as { users: { _add: (data: object) => unknown } }
    ).users._add({ id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' });
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: MANAGED_ROLE,
          name: 'integration',
          position: 1,
          permissions: '0',
          managed: true,
          color: 0,
          mentionable: false,
        },
        {
          id: DANGEROUS_ROLE,
          name: 'janitors',
          position: 2,
          permissions: String(PermissionsBitField.Flags.ManageRoles),
          color: 0,
          mentionable: false,
        },
        {
          id: LOW_ROLE,
          name: 'helpers',
          position: 4,
          permissions: '0',
          color: 0,
          mentionable: false,
        },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: BOT_TOP_RAW,
          permissions: (
            PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages
          ).toString(),
          managed: true,
          color: 0,
          mentionable: false,
        },
        {
          id: ABOVE_ROLE,
          name: 'admins',
          position: BOT_TOP_RAW + 2,
          permissions: '0',
          color: 0,
          mentionable: false,
        },
      ],
      members: [
        {
          user: { id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' },
          roles: [BOT_ROLE],
        },
      ],
      emojis: [],
      unavailable: false,
    });
    for (const role of [LOW_ROLE, ABOVE_ROLE, MANAGED_ROLE, DANGEROUS_ROLE]) {
      fakeDiscord.defineRole({
        id: role,
        name: role === LOW_ROLE ? 'helpers' : `role-${role}`,
        position: 2,
        managed: role === MANAGED_ROLE,
      });
    }
  };

  const allow = (): void => {
    seedRoleGuild();
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
  };

  const grantMutate = (): void => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: ACCOUNT,
      capability: 'roles.mutate',
      grantedBy: 'test',
      now: clock,
    });
  };

  const roleCall = (accessToken: string, name: string, args: Record<string, unknown>) =>
    mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
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

  /** The bot's live top position, the same cache read the port uses. */
  const botTop = (): number => {
    const top = deps.client.guilds.cache.get(GUILD_A)?.members.me?.roles.highest.position;
    if (top === undefined) throw new Error('test setup: bot top missing from cache');
    return top;
  };

  const createArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guildId: GID,
    name: SENTINEL,
    idempotencyKey: 'create-k1',
    ...over,
  });

  it('creates with no permissions, below the bot, and names the allowlisting step', async () => {
    allow();
    grantMutate();
    const roles = await mintToken('bananasaurs:roles');

    const created = callText((await roleCall(roles, 'create_role', createArgs())).body);
    expect(created.isError).not.toBe(true);
    expect(created.text).toContain('no permissions');
    expect(created.text).toContain('allowlist');

    // The REST input carries no permissions key at all: the adapter always
    // sends `'0'`, so no permission bit can travel.
    const creates = fakeDiscord.restCalls('createRole');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args[0]).toBe(GUILD_A);
    expect(creates[0]?.args[1]).toMatchObject({ name: SENTINEL });
    expect('permissions' in (creates[0]?.args[1] as Record<string, unknown>)).toBe(false);

    // The created role reads back with permissions `"0"`, positioned
    // directly below the bot's live top — create first, move second.
    const fetched = await fakeDiscord.fetchRoles(GUILD_A);
    const role = fetched.find((entry) => entry.name === SENTINEL);
    expect(role?.permissions).toBe('0');
    expect(role?.position).toBe(botTop() - 1);
    expect(fakeDiscord.restCalls().map((call) => call.method)).toEqual([
      'createRole',
      'setRolePosition',
      'fetchRoles',
    ]);

    // The ledger row lands with no undo: a creation is not undoable.
    const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'create-k1');
    expect(row?.kind).toBe('role.create');
    expect(row?.status).toBe('done');
    expect(row?.targetChannelId).toBeUndefined();
    expect(row?.undoJson).toBeUndefined();

    // The audit row holds ids and the outcome — never the role name.
    const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 });
    const audit = trail.find((entry) => entry.action === 'mcp.role.create');
    expect(audit).toBeDefined();
    expect(audit?.actorType).toBe('mcp_operator');
    expect(JSON.stringify(audit)).not.toContain(SENTINEL);

    // The MCP never inserts into `managed_roles`: the new role is not on the
    // bot's role allowlist until an operator allowlists it.
    expect(role?.id).toBeDefined();
    expect(roleRepo.isAllowlisted(t.scopes.forGuild(GUILD_A), role?.id ?? '')).toBe(false);
  });

  it('replays a creation under its key with one createRole call', async () => {
    allow();
    grantMutate();
    const roles = await mintToken('bananasaurs:roles');

    const first = callText((await roleCall(roles, 'create_role', createArgs())).body);
    expect(first.isError).not.toBe(true);
    const second = callText((await roleCall(roles, 'create_role', createArgs())).body);
    expect(second.isError).not.toBe(true);
    expect(second.text).toContain('Already recorded');
    expect(fakeDiscord.restCalls('createRole')).toHaveLength(1);
    expect(fakeDiscord.restCalls('setRolePosition')).toHaveLength(1);
  });

  it('an account without roles.mutate is refused with no Discord call and no row', async () => {
    allow();
    const roles = await mintToken('bananasaurs:roles');

    const refusedCreate = callText((await roleCall(roles, 'create_role', createArgs())).body);
    expect(refusedCreate.isError).toBe(true);
    expect(refusedCreate.text).toContain('roles.mutate');
    const refusedEdit = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: LOW_ROLE,
          name: 'renamed',
          idempotencyKey: 'edit-denied',
        })
      ).body,
    );
    expect(refusedEdit.isError).toBe(true);
    expect(refusedEdit.text).toContain('roles.mutate');
    expect(fakeDiscord.restCalls()).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'create-k1')).toBeUndefined();
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'edit-denied')).toBeUndefined();
  });

  it('editing a dangerous or above-bot role is refused with no Discord call and no row', async () => {
    allow();
    grantMutate();
    // Allowlisted in `managed_roles`, so the refusal comes from the grant
    // policy and the floor — not from the allowlist check under test below.
    for (const roleId of [DANGEROUS_ROLE, ABOVE_ROLE, MANAGED_ROLE]) {
      roleRepo.allowlistRole(t.scopes.forGuild(GUILD_A), roleId);
    }
    const roles = await mintToken('bananasaurs:roles');

    const dangerous = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: DANGEROUS_ROLE,
          name: 'renamed',
          idempotencyKey: 'edit-dangerous',
        })
      ).body,
    );
    expect(dangerous.isError).toBe(true);
    expect(dangerous.text).toContain('dangerous');
    expect(dangerous.text).toContain(DANGEROUS_ROLE);

    const above = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: ABOVE_ROLE,
          name: 'renamed',
          idempotencyKey: 'edit-above',
        })
      ).body,
    );
    expect(above.isError).toBe(true);
    expect(above.text).toContain('above');

    const managed = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: MANAGED_ROLE,
          name: 'renamed',
          idempotencyKey: 'edit-managed',
        })
      ).body,
    );
    expect(managed.isError).toBe(true);

    expect(fakeDiscord.restCalls('editRole')).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'edit-dangerous')).toBeUndefined();
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'edit-above')).toBeUndefined();
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'edit-managed')).toBeUndefined();
  });

  it('an unknown role and a traversal-shaped ref are refused with no Discord call', async () => {
    allow();
    grantMutate();
    const roles = await mintToken('bananasaurs:roles');

    const ghost = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: GHOST_ROLE,
          name: 'renamed',
          idempotencyKey: 'edit-ghost',
        })
      ).body,
    );
    expect(ghost.isError).toBe(true);
    expect(fakeDiscord.restCalls('editRole')).toHaveLength(0);

    const traversal = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: '../../etc/passwd',
          name: 'renamed',
          idempotencyKey: 'edit-traversal',
        })
      ).body,
    );
    expect(traversal.isError).toBe(true);
    expect(traversal.text).not.toContain('..');
    expect(fakeDiscord.restCalls('editRole')).toHaveLength(0);
  });

  it('an edit of a role missing from managed_roles is refused with no Discord call', async () => {
    allow();
    grantMutate();
    const roles = await mintToken('bananasaurs:roles');

    // LOW_ROLE is below the bot and passes the grant policy and the floor —
    // the only thing missing is the `managed_roles` row.
    expect(roleRepo.isAllowlisted(t.scopes.forGuild(GUILD_A), LOW_ROLE)).toBe(false);
    const refused = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: LOW_ROLE,
          name: 'renamed',
          idempotencyKey: 'edit-unlisted',
        })
      ).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(LOW_ROLE);
    expect(refused.text).toContain('allowlist');
    expect(fakeDiscord.restCalls('editRole')).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'edit-unlisted')).toBeUndefined();
  });

  it('edits by name, restores through undo_action, and marks the original', async () => {
    allow();
    grantMutate();
    roleRepo.allowlistRole(t.scopes.forGuild(GUILD_A), LOW_ROLE);
    const roles = await mintToken('bananasaurs:roles');

    const edited = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: 'helpers',
          color: 0x12_34_56,
          mentionable: true,
          idempotencyKey: 'edit-k1',
        })
      ).body,
    );
    expect(edited.isError).not.toBe(true);
    expect(edited.text).toContain(LOW_ROLE);

    // Only the given fields moved in FakeDiscord; the row holds the role id
    // and exactly those fields' previous values.
    expect(fakeDiscord.restCalls('editRole')).toHaveLength(1);
    // The PATCH carries only the given fields: no name was asked for, so none is sent.
    const patch = fakeDiscord.restCalls('editRole')[0]?.args[2] as Record<string, unknown>;
    expect(patch).toEqual({ color: 0x12_34_56, mentionable: true });
    const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'edit-k1');
    expect(row?.kind).toBe('role.edit');
    expect(JSON.parse(row?.undoJson ?? '')).toEqual({
      roleId: LOW_ROLE,
      previous: { color: 0, mentionable: false },
    });
    const editAudit = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 })
      .find((entry) => entry.action === 'mcp.role.edit');
    expect(editAudit).toBeDefined();
    expect(JSON.stringify(editAudit)).not.toContain('helpers');

    const undone = callText(
      (await roleCall(roles, 'undo_action', { guildId: GID, actionId: row?.actionId ?? '' })).body,
    );
    expect(undone.isError).not.toBe(true);
    expect(undone.text).toContain('role.edit');
    expect(fakeDiscord.restCalls('editRole')).toHaveLength(2);
    expect(fakeDiscord.roleDetails(LOW_ROLE)).toMatchObject({ color: 0, mentionable: false });

    const reread = mcpActionsRepo.findActionById(t.scopes.forGuild(GUILD_A), row?.actionId ?? '');
    expect(reread?.undoneByActionId).toBeDefined();

    const again = callText(
      (await roleCall(roles, 'undo_action', { guildId: GID, actionId: row?.actionId ?? '' })).body,
    );
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already undone');
    expect(fakeDiscord.restCalls('editRole')).toHaveLength(2);
  });

  it('a failed move after creation fails naming the created role id', async () => {
    allow();
    grantMutate();
    const roles = await mintToken('bananasaurs:roles');
    fakeDiscord.failNext(
      'setRolePosition',
      new DiscordApiError(500, undefined, 'discord is on fire'),
    );
    const failed = callText((await roleCall(roles, 'create_role', createArgs())).body);
    expect(failed.isError).toBe(true);
    expect(fakeDiscord.restCalls('createRole')).toHaveLength(1);
    // The role exists in Discord now; the failure text must name it so an operator can find it.
    const newRoles = (await fakeDiscord.fetchRoles(GUILD_A)).filter(
      (role) => role.permissions === '0' && role.id !== GUILD_A,
    );
    const createdId = newRoles.map((role) => role.id).find((id) => failed.text.includes(id));
    expect(createdId).toBeDefined();
  });

  it('a creation is not undoable', async () => {
    allow();
    grantMutate();
    // Both scopes: a roles-only token would refuse on the kind's scope
    // before ever reaching the not-undoable answer under test.
    const roles = await mintToken('bananasaurs:send bananasaurs:roles');

    const created = callText((await roleCall(roles, 'create_role', createArgs())).body);
    expect(created.isError).not.toBe(true);
    const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'create-k1');
    expect(row).toBeDefined();

    const undone = callText(
      (await roleCall(roles, 'undo_action', { guildId: GID, actionId: row?.actionId ?? '' })).body,
    );
    expect(undone.isError).toBe(true);
    expect(undone.text).toContain('cannot be undone');
    expect(undone.text).toContain('role.create');
  });

  it('an undo of an edit whose role left managed_roles since is refused', async () => {
    allow();
    grantMutate();
    const scope = t.scopes.forGuild(GUILD_A);
    roleRepo.allowlistRole(scope, LOW_ROLE);
    const roles = await mintToken('bananasaurs:roles');

    const edited = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: LOW_ROLE,
          color: 0x12_34_56,
          idempotencyKey: 'edit-unlisted-undo',
        })
      ).body,
    );
    expect(edited.isError).not.toBe(true);
    const row = mcpActionsRepo.findAction(scope, 'edit-unlisted-undo');
    if (row === undefined) throw new Error('edit left no ledger row');

    // An operator removes the role from `managed_roles` after the edit.
    // No `role_effects` row references it (edits never claim one), so the
    // delete is clean.
    t.raw
      .prepare('DELETE FROM managed_roles WHERE guild_id = ? AND role_id = ?')
      .run(String(GUILD_A), LOW_ROLE);
    expect(roleRepo.isAllowlisted(scope, LOW_ROLE)).toBe(false);

    const refused = callText(
      (await roleCall(roles, 'undo_action', { guildId: GID, actionId: row.actionId })).body,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('allowlist');
    expect(refused.text).toContain(LOW_ROLE);
    // The stored values were not restored: only the forward edit ran.
    expect(fakeDiscord.restCalls('editRole')).toHaveLength(1);
    expect(mcpActionsRepo.findActionById(scope, row.actionId)?.undoneByActionId).toBeUndefined();
  });

  it('a role.edit undo refused by the floor speaks of the role, never a channel', async () => {
    allow();
    grantMutate();
    const scope = t.scopes.forGuild(GUILD_A);
    roleRepo.allowlistRole(scope, LOW_ROLE);
    const roles = await mintToken('bananasaurs:roles');

    const edited = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: LOW_ROLE,
          color: 0x12_34_56,
          idempotencyKey: 'edit-floor-undo',
        })
      ).body,
    );
    expect(edited.isError).not.toBe(true);
    const row = mcpActionsRepo.findAction(scope, 'edit-floor-undo');
    if (row === undefined) throw new Error('edit left no ledger row');

    // Between calls the role gains a dangerous permission in the live cache.
    const cached = deps.client.guilds.cache.get(GUILD_A)?.roles.cache.get(LOW_ROLE) as unknown as {
      permissions: PermissionsBitField;
    };
    if (cached === undefined) throw new Error('test setup: role missing from cache');
    cached.permissions = new PermissionsBitField(PermissionsBitField.Flags.ManageRoles);

    const refused = callText(
      (await roleCall(roles, 'undo_action', { guildId: GID, actionId: row.actionId })).body,
    );
    expect(refused.isError).toBe(true);
    // `role-unavailable`: the role's cause and the grant policy — never the
    // channel/send-scope words `target-unavailable` carries.
    expect(refused.text).toContain('dangerous permission');
    expect(refused.text).toContain('grant policy');
    expect(refused.text).not.toContain('channel or thread');
    expect(fakeDiscord.restCalls('editRole')).toHaveLength(1);
    expect(mcpActionsRepo.findActionById(scope, row.actionId)?.undoneByActionId).toBeUndefined();
  });

  it('the kill switch refuses both tools with no Discord call and no row', async () => {
    allow();
    grantMutate();
    roleRepo.allowlistRole(t.scopes.forGuild(GUILD_A), LOW_ROLE);
    guildRepo.setKillswitch(t.scopes.forGuild(GUILD_A), true, clock);
    const roles = await mintToken('bananasaurs:roles');

    const refusedCreate = callText((await roleCall(roles, 'create_role', createArgs())).body);
    expect(refusedCreate.isError).toBe(true);
    expect(refusedCreate.text).toContain('kill switch');
    const refusedEdit = callText(
      (
        await roleCall(roles, 'edit_role', {
          guildId: GID,
          role: LOW_ROLE,
          name: 'renamed',
          idempotencyKey: 'edit-killed',
        })
      ).body,
    );
    expect(refusedEdit.isError).toBe(true);
    expect(refusedEdit.text).toContain('kill switch');
    expect(fakeDiscord.restCalls()).toHaveLength(0);
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'create-k1')).toBeUndefined();
    expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'edit-killed')).toBeUndefined();
  });
});
/**
 * Slice 4 Task 6b, daemon side: `list_panels` / `get_panel` reads and
 * `create_panel` / `edit_panel` / `delete_panel` writes through the real
 * stack — Fastify + `registerMcpRoutes` + `createMcpServer` + the real
 * panels port over the real repositories and the fake Discord port — with
 * tokens minted through the real OAuth flow.
 *
 * What this proves: every option role passes the grant policy and the floor
 * before any write (a dangerous role refuses with no role created, no
 * `managed_roles` row, no panel row and no Discord call); a `{create}`
 * option mints a zero-permission role below the bot, allowlists it and
 * posts the panel; `roles.mutate` gates all three writes; an edit adds an
 * option and republishes while a channel move refuses; a reorder names the
 * kept options only with added ones last, and naming an added id refuses as
 * a bad reorder; allowlist grant mode refuses `{create}` options before any
 * Discord call; a failure after a mint names every minted role id; a delete
 * removes the message and the rows but keeps the roles; panel messages stay
 * protected from `edit_message` / `delete_message`; a replay posts once; and
 * the kill switch refuses all three writes.
 */
describe('/mcp panel tools through the real composition', () => {
  const CHANNEL = '444444444444444444';
  const OTHER_CHANNEL = '455555555555555555';
  const LOW_ROLE = '522222222222222222';
  const LOW_ROLE_2 = '524444444444444444';
  const LOW_ROLE_3 = '525555555555555555';
  const HIGH_ROLE = '533333333333333333';
  const DANGEROUS_ROLE = '566666666666666666';
  const BOT_ROLE = '511111111111111111';
  const OWNER = '345678901234567890';
  const GID = '111111111111111111';
  /** Distinctive names: must reach Discord, must never reach an audit row. */
  const ROLE_NAME = 'helpersZZ';
  const FRESH_NAME = 'FreshPanelRolezz9';
  const TITLE = 'Pick a role zz9';

  interface PanelDiscordInternals {
    guilds: { _add: (data: object) => Guild };
    users: { _add: (data: object) => unknown };
  }

  const seedPanelGuild = (): void => {
    const internals = deps.client as unknown as PanelDiscordInternals;
    const mutable = deps.client as unknown as { user: unknown };
    mutable.user = (
      deps.client as unknown as { users: { _add: (data: object) => unknown } }
    ).users._add({ id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' });
    const botPermissions = (
      PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages
    ).toString();
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: OWNER,
      channels: [
        {
          id: CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 0,
          permission_overwrites: [],
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
      // Distinct raw positions: discord.js computes Role.position from their
      // ordering. The bot sits above LOW_ROLE and below HIGH_ROLE; the
      // dangerous role sits below the bot but carries ManageRoles.
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: DANGEROUS_ROLE,
          name: 'floor-watch',
          position: 2,
          permissions: String(PermissionsBitField.Flags.ManageRoles),
        },
        { id: LOW_ROLE, name: ROLE_NAME, position: 4, permissions: '0' },
        { id: LOW_ROLE_2, name: 'ushers', position: 5, permissions: '0' },
        { id: LOW_ROLE_3, name: 'greeters', position: 6, permissions: '0' },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 10,
          permissions: botPermissions,
          managed: true,
        },
        { id: HIGH_ROLE, name: 'admins', position: 12, permissions: '0' },
      ],
      members: [
        {
          user: { id: BOT_USER_ID, username: 'bananasaurs', discriminator: '0' },
          roles: [BOT_ROLE],
        },
        { user: { id: OWNER, username: 'owner', discriminator: '0' }, roles: [] },
      ],
      emojis: [],
      unavailable: false,
    });
  };

  const seedPanelDiscord = (discord: FakeDiscord): void => {
    for (const roleId of [LOW_ROLE, LOW_ROLE_2, LOW_ROLE_3, HIGH_ROLE, DANGEROUS_ROLE]) {
      discord.defineRole({ id: roleId, name: `role-${roleId}`, position: 2 });
    }
  };

  const allowPanel = (input: { mutate?: boolean } = {}): void => {
    seedPanelGuild();
    const scope = t.scopes.forGuild(GUILD_A);
    guildRepo.setDryRun(scope, false, clock);
    mcpSendRepo.allowChannel(scope, {
      channelId: CHANNEL,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    if (input.mutate !== false) {
      authzRepo.grantAccountCapability(scope, {
        accountId: ACCOUNT,
        capability: 'roles.mutate',
        grantedBy: 'test',
        now: clock,
      });
    }
  };

  /**
   * The suite's `portsFor` with working panel publish doubles: the shared
   * `testPortsFor` throws for `publishPanel` / `unpublishPanel` (they need a
   * real Discord client), so this wraps it with the real core publish
   * functions over the fake Discord port — the same calls production's ops
   * wiring makes, against the same storage.
   */
  const buildPanelApp = (discord: FakeDiscord): FastifyInstance =>
    createServer({
      deps: {
        ...deps,
        portsFor: (scope: GuildScope) => {
          const ports = testPortsFor(scope, () => clock);
          return {
            ...ports,
            publishPanel: async (panelId: string): Promise<OpsPublishResult> => {
              const panel = panelRepo.findPanel(scope, panelId);
              if (panel === undefined) throw new Error(`no panel ${panelId}`);
              const publishDeps = {
                guildId: scope.guildId,
                discord,
                logger: silentLogger,
                setPanelMessage: (id: string, messageId: string) =>
                  panelRepo.setPanelMessage(scope, id, messageId, clock),
              };
              let action: OpsPublishResult['action'];
              if (panel.messageId === undefined) {
                await postManagedPanel(panel, publishDeps);
                action = 'posted';
              } else {
                await editManagedPanel(panel, publishDeps);
                action = 'edited';
              }
              const posted = panelRepo.findPanel(scope, panelId);
              const seed =
                posted?.messageId === undefined
                  ? { seeded: 0, failed: [] as { emojiKey: string; error: string }[] }
                  : await seedPanelReactions(posted, {
                      guildId: scope.guildId,
                      discord,
                      logger: silentLogger,
                    });
              return {
                action,
                messageId: posted?.messageId,
                reactionsSeeded: seed.seeded,
                reactionsFailed: seed.failed,
              };
            },
            unpublishPanel: async (panelId: string): Promise<void> => {
              const panel = panelRepo.findPanel(scope, panelId);
              if (panel === undefined) throw new Error(`no panel ${panelId}`);
              if (panel.kind === 'managed' && panel.messageId !== undefined) {
                try {
                  await discord.deleteMessage(
                    scope.guildId,
                    { channelId: panel.channelId, messageId: panel.messageId },
                    `panel delete ${panelId}`,
                  );
                } catch (err) {
                  if (!(err instanceof DiscordApiError && err.isGone)) throw err;
                }
              }
              panelRepo.deletePanel(scope, panelId);
            },
          };
        },
      },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, deps.client, discord);
      },
    });

  const panelCall = (
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

  const createArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guildId: GID,
    channel: CHANNEL,
    title: TITLE,
    behaviour: 'toggle',
    component: 'button',
    options: [{ role: LOW_ROLE, label: 'Helpers' }],
    idempotencyKey: 'panel-k1',
    ...over,
  });

  /** The bot's live top position, the same cache read the port uses. */
  const botTop = (): number => {
    const top = deps.client.guilds.cache.get(GUILD_A)?.members.me?.roles.highest.position;
    if (top === undefined) throw new Error('test setup: bot top missing from cache');
    return top;
  };

  const panelsOf = (): string[] =>
    panelRepo.listPanels(t.scopes.forGuild(GUILD_A)).map((panel) => panel.panelId);

  /** Allowlist grant mode: a fresh role can never be on the grant allowlist. */
  const seedAllowlistGrantMode = (): void => {
    t.raw
      .prepare(
        `INSERT INTO mcp_role_policy (guild_id, grant_mode, ping_mode, updated_at) VALUES ('${GUILD_A}', 'allowlist', 'below-bot', ${String(clock)})`,
      )
      .run();
  };

  const managedRolesCount = (): number =>
    (t.raw.prepare('SELECT COUNT(*) AS n FROM managed_roles').get() as { n: number }).n;

  const discordRoleCount = async (discord: FakeDiscord): Promise<number> =>
    (await discord.fetchRoles(GUILD_A)).length;

  it('a dangerous role in the options is refused before any write', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = callText(
        (
          await panelCall(
            panelApp,
            accessToken,
            'create_panel',
            createArgs({
              options: [{ role: DANGEROUS_ROLE, label: 'Janitors' }],
              idempotencyKey: 'panel-dangerous-k1',
            }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('dangerous');
      // The refusal names the grant-policy cause, not the role: a panel
      // names several option roles and the outcome carries no single id.
      expect(refused.text).toContain('grant policy');
      // Refused before any write: no role created, no `managed_roles` row,
      // no panel row, no Discord call.
      expect(discord.restCalls()).toHaveLength(0);
      expect(roleRepo.isAllowlisted(t.scopes.forGuild(GUILD_A), DANGEROUS_ROLE)).toBe(false);
      expect(panelsOf()).toEqual([]);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'panel-dangerous-k1'),
      ).toBeUndefined();
    } finally {
      await panelApp.close();
    }
  });

  it('a new role created through a panel option is zero-permission, allowlisted and posted', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const roles = await mintToken('bananasaurs:roles');
      const created = callText(
        (
          await panelCall(
            panelApp,
            roles,
            'create_panel',
            createArgs({
              options: [{ role: { create: { name: FRESH_NAME } }, label: 'Fresh faces' }],
              idempotencyKey: 'panel-fresh-k1',
            }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      expect(created.text).toContain('Created panel mcp-');

      // Zero permissions: the REST input carries no permissions key at all,
      // and the role reads back with permissions `"0"`, directly below the bot.
      const creates = discord.restCalls('createRole');
      expect(creates).toHaveLength(1);
      expect(creates[0]?.args[1]).toMatchObject({ name: FRESH_NAME });
      expect('permissions' in (creates[0]?.args[1] as Record<string, unknown>)).toBe(false);
      const fetched = await discord.fetchRoles(GUILD_A);
      const role = fetched.find((entry) => entry.name === FRESH_NAME);
      expect(role?.permissions).toBe('0');
      expect(role?.position).toBe(botTop() - 1);
      if (role === undefined) throw new Error('panel left no created role');

      // Allowlisted and used: the panel's only option names the new role, the
      // panel is posted, and exactly one message went out.
      expect(roleRepo.isAllowlisted(t.scopes.forGuild(GUILD_A), role.id)).toBe(true);
      const stored = panelRepo.findPanel(t.scopes.forGuild(GUILD_A), panelsOf()[0] ?? '');
      expect(stored?.options.map((option) => option.roleId)).toEqual([role.id]);
      expect(stored?.messageId).toBeDefined();
      expect(discord.restCalls('sendMessage')).toHaveLength(1);
      expect(created.text).toContain(stored?.messageId ?? 'missing-message');

      // The audit trail carries ids and the outcome — never the role name or
      // the option label.
      const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 });
      expect(trail.some((entry) => entry.action === 'mcp.panel.create')).toBe(true);
      expect(JSON.stringify(trail)).not.toContain(FRESH_NAME);
      expect(JSON.stringify(trail)).not.toContain('Fresh faces');

      // The reads see it: `list_panels` names the panel, `get_panel` shows
      // the option's role id and label but never the role name.
      const read = await mintToken('bananasaurs:read');
      const listed = callText(
        (await panelCall(panelApp, read, 'list_panels', { guildId: GID })).body,
      );
      expect(listed.isError).not.toBe(true);
      expect(listed.text).toContain(stored?.panelId ?? 'missing-panel');
      expect(listed.text).toContain(TITLE);
      const shown = callText(
        (await panelCall(panelApp, read, 'get_panel', { guildId: GID, panelId: stored?.panelId }))
          .body,
      );
      expect(shown.isError).not.toBe(true);
      expect(shown.text).toContain(role.id);
      expect(shown.text).toContain('Fresh faces');
      expect(shown.text).not.toContain(FRESH_NAME);
    } finally {
      await panelApp.close();
    }
  });

  it('an existing below-bot role is allowlisted and used', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      expect(roleRepo.isAllowlisted(scope, LOW_ROLE)).toBe(false);
      const accessToken = await mintToken('bananasaurs:roles');
      const created = callText(
        (await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body,
      );
      expect(created.isError).not.toBe(true);
      expect(roleRepo.isAllowlisted(scope, LOW_ROLE)).toBe(true);
      const stored = panelRepo.findPanel(scope, panelsOf()[0] ?? '');
      expect(stored?.options.map((option) => option.roleId)).toEqual([LOW_ROLE]);
      expect(stored?.messageId).toBeDefined();
      expect(discord.restCalls('sendMessage')).toHaveLength(1);
    } finally {
      await panelApp.close();
    }
  });

  it('an above-bot role is refused with no Discord call and no rows', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = callText(
        (
          await panelCall(
            panelApp,
            accessToken,
            'create_panel',
            createArgs({
              options: [{ role: HIGH_ROLE, label: 'Admins' }],
              idempotencyKey: 'panel-high-k1',
            }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('above');
      expect(refused.text).toContain('grant policy');
      expect(discord.restCalls()).toHaveLength(0);
      expect(panelsOf()).toEqual([]);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'panel-high-k1'),
      ).toBeUndefined();
    } finally {
      await panelApp.close();
    }
  });

  it('an account without roles.mutate is refused with no Discord call and no row', async () => {
    allowPanel({ mutate: false });
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = callText(
        (await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('roles.mutate');
      expect(discord.restCalls()).toHaveLength(0);
      expect(panelsOf()).toEqual([]);
      expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'panel-k1')).toBeUndefined();
    } finally {
      await panelApp.close();
    }
  });

  it('edit_panel adds an option and republishes the message', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      const accessToken = await mintToken('bananasaurs:roles');
      const created = callText(
        (await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body,
      );
      expect(created.isError).not.toBe(true);
      const panelId = panelsOf()[0];
      if (panelId === undefined) throw new Error('create left no panel');
      const before = panelRepo.findPanel(scope, panelId)?.messageId;
      expect(before).toBeDefined();

      const edited = callText(
        (
          await panelCall(panelApp, accessToken, 'edit_panel', {
            guildId: GID,
            panelId,
            addOptions: [{ role: LOW_ROLE_2, label: 'Ushers' }],
            idempotencyKey: 'panel-edit-k1',
          })
        ).body,
      );
      expect(edited.isError).not.toBe(true);
      expect(edited.text).toContain(`Edited panel ${panelId}`);
      // Republished in place: one send, one edit, same message id, both roles.
      expect(discord.restCalls('sendMessage')).toHaveLength(1);
      expect(discord.restCalls('editMessage')).toHaveLength(1);
      const stored = panelRepo.findPanel(scope, panelId);
      expect(stored?.messageId).toBe(before);
      expect(stored?.options.map((option) => option.roleId)).toEqual([LOW_ROLE, LOW_ROLE_2]);
      expect(roleRepo.isAllowlisted(scope, LOW_ROLE_2)).toBe(true);
      const row = mcpActionsRepo.findAction(scope, 'panel-edit-k1');
      expect(row).toMatchObject({ kind: 'panel.edit', capGroup: 'structure', status: 'done' });
    } finally {
      await panelApp.close();
    }
  });

  it('edit_panel adds a role and reorders the kept options, with the added one last', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      const accessToken = await mintToken('bananasaurs:roles');
      const created = callText(
        (
          await panelCall(
            panelApp,
            accessToken,
            'create_panel',
            createArgs({
              options: [
                { role: LOW_ROLE, label: 'Helpers' },
                { role: LOW_ROLE_2, label: 'Ushers' },
              ],
              idempotencyKey: 'panel-reorder-create',
            }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      const panelId = panelsOf()[0];
      if (panelId === undefined) throw new Error('create left no panel');

      // A reorder names the kept options only; the added role lands last.
      const edited = callText(
        (
          await panelCall(panelApp, accessToken, 'edit_panel', {
            guildId: GID,
            panelId,
            addOptions: [{ role: LOW_ROLE_3, label: 'Greeters' }],
            reorder: [LOW_ROLE_2, LOW_ROLE],
            idempotencyKey: 'panel-reorder-edit',
          })
        ).body,
      );
      expect(edited.isError).not.toBe(true);
      expect(edited.text).toContain(`Edited panel ${panelId}`);
      const stored = panelRepo.findPanel(scope, panelId);
      expect(stored?.options.map((option) => option.roleId)).toEqual([
        LOW_ROLE_2,
        LOW_ROLE,
        LOW_ROLE_3,
      ]);
      // Republished in place: one send, one edit.
      expect(discord.restCalls('sendMessage')).toHaveLength(1);
      expect(discord.restCalls('editMessage')).toHaveLength(1);
      const row = mcpActionsRepo.findAction(scope, 'panel-reorder-edit');
      expect(row).toMatchObject({ kind: 'panel.edit', capGroup: 'structure', status: 'done' });
    } finally {
      await panelApp.close();
    }
  });

  it('a reorder naming an added id is refused as a bad reorder', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      const accessToken = await mintToken('bananasaurs:roles');
      expect(
        callText((await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body)
          .isError,
      ).not.toBe(true);
      const panelId = panelsOf()[0];
      if (panelId === undefined) throw new Error('create left no panel');
      const optionsBefore = panelRepo
        .findPanel(scope, panelId)
        ?.options.map((option) => option.roleId);
      discord.resetCalls();

      const refused = callText(
        (
          await panelCall(panelApp, accessToken, 'edit_panel', {
            guildId: GID,
            panelId,
            addOptions: [{ role: LOW_ROLE_2, label: 'Ushers' }],
            reorder: [LOW_ROLE, LOW_ROLE_2],
            idempotencyKey: 'panel-bad-reorder-k1',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      // The reorder refusal names the panel's current options (after
      // removals) and says added options go at the end.
      expect(refused.text).toContain('current options');
      expect(refused.text).toContain('after removals');
      expect(refused.text).toContain('go at the end');
      // Refused before any write: the options are unchanged, nothing posted.
      expect(panelRepo.findPanel(scope, panelId)?.options.map((option) => option.roleId)).toEqual(
        optionsBefore,
      );
      expect(discord.restCalls('sendMessage')).toHaveLength(0);
      expect(discord.restCalls('editMessage')).toHaveLength(0);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'panel-bad-reorder-k1'),
      ).toBeUndefined();
    } finally {
      await panelApp.close();
    }
  });

  it('allowlist grant mode refuses a {create} option before any Discord call', async () => {
    allowPanel();
    seedAllowlistGrantMode();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const rolesBefore = await discordRoleCount(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const refused = callText(
        (
          await panelCall(
            panelApp,
            accessToken,
            'create_panel',
            createArgs({
              options: [{ role: { create: { name: FRESH_NAME } }, label: 'Fresh faces' }],
              idempotencyKey: 'panel-allowlist-create',
            }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('allowlist');
      expect(refused.text).toContain('create_role');
      // Refused before any write or Discord call: no role minted, no
      // `managed_roles` row, no panel row, no post.
      expect(discord.restCalls('createRole')).toHaveLength(0);
      expect(await discordRoleCount(discord)).toBe(rolesBefore);
      expect(managedRolesCount()).toBe(0);
      expect(panelsOf()).toEqual([]);
      expect(discord.restCalls('sendMessage')).toHaveLength(0);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'panel-allowlist-create'),
      ).toBeUndefined();
    } finally {
      await panelApp.close();
    }
  });

  it('allowlist grant mode refuses an edit adding a {create} option with no new role', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      const accessToken = await mintToken('bananasaurs:roles');
      expect(
        callText((await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body)
          .isError,
      ).not.toBe(true);
      const panelId = panelsOf()[0];
      if (panelId === undefined) throw new Error('create left no panel');
      const optionsBefore = panelRepo
        .findPanel(scope, panelId)
        ?.options.map((option) => option.roleId);
      const rolesBefore = await discordRoleCount(discord);
      discord.resetCalls();
      seedAllowlistGrantMode();

      const refused = callText(
        (
          await panelCall(panelApp, accessToken, 'edit_panel', {
            guildId: GID,
            panelId,
            addOptions: [{ role: { create: { name: FRESH_NAME } }, label: 'Fresh faces' }],
            idempotencyKey: 'panel-allowlist-edit',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('allowlist');
      expect(refused.text).toContain('create_role');
      // No role minted, the panel unchanged, nothing republished.
      expect(discord.restCalls('createRole')).toHaveLength(0);
      expect(await discordRoleCount(discord)).toBe(rolesBefore);
      expect(panelRepo.findPanel(scope, panelId)?.options.map((option) => option.roleId)).toEqual(
        optionsBefore,
      );
      expect(discord.restCalls('sendMessage')).toHaveLength(0);
      expect(discord.restCalls('editMessage')).toHaveLength(0);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'panel-allowlist-edit'),
      ).toBeUndefined();
    } finally {
      await panelApp.close();
    }
  });

  it('a second mint failing names the first minted role and leaves no panel', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    // The second `createRole` throws; the first mint already exists in
    // Discord, so the failure must name it.
    const innerCreate = discord.createRole.bind(discord);
    let createCalls = 0;
    discord.createRole = async (...args: Parameters<FakeDiscord['createRole']>) => {
      createCalls += 1;
      if (createCalls === 2) throw new Error('boom-second-mint');
      return innerCreate(...args);
    };
    const panelApp = buildPanelApp(discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const failed = callText(
        (
          await panelCall(
            panelApp,
            accessToken,
            'create_panel',
            createArgs({
              options: [
                { role: { create: { name: 'MintAzz9' } }, label: 'First mint' },
                { role: { create: { name: 'MintBzz9' } }, label: 'Second mint' },
              ],
              idempotencyKey: 'panel-mint-fail-k1',
            }),
          )
        ).body,
      );
      expect(failed.isError).toBe(true);
      const minted = (await discord.fetchRoles(GUILD_A)).find((role) => role.name === 'MintAzz9');
      expect(minted).toBeDefined();
      expect(failed.text).toContain(minted?.id ?? 'missing-mint');
      expect(panelsOf()).toEqual([]);
    } finally {
      await panelApp.close();
    }
  });

  it('a publish failing after a mint names the minted role', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    discord.failNext('sendMessage', FakeDiscord.rateLimited());
    const panelApp = buildPanelApp(discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const failed = callText(
        (
          await panelCall(
            panelApp,
            accessToken,
            'create_panel',
            createArgs({
              options: [{ role: { create: { name: FRESH_NAME } }, label: 'Fresh faces' }],
              idempotencyKey: 'panel-publish-fail-k1',
            }),
          )
        ).body,
      );
      expect(failed.isError).toBe(true);
      const minted = (await discord.fetchRoles(GUILD_A)).find((role) => role.name === FRESH_NAME);
      expect(minted).toBeDefined();
      expect(failed.text).toContain(minted?.id ?? 'missing-mint');
    } finally {
      await panelApp.close();
    }
  });

  it('a channel change is refused with no Discord call and no row', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      expect(
        callText((await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body)
          .isError,
      ).not.toBe(true);
      const panelId = panelsOf()[0];
      if (panelId === undefined) throw new Error('create left no panel');
      discord.resetCalls();

      const refused = callText(
        (
          await panelCall(panelApp, accessToken, 'edit_panel', {
            guildId: GID,
            panelId,
            channel: OTHER_CHANNEL,
            title: 'Moved panel',
            idempotencyKey: 'panel-move-k1',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('immutable');
      expect(discord.restCalls()).toHaveLength(0);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'panel-move-k1'),
      ).toBeUndefined();
    } finally {
      await panelApp.close();
    }
  });

  it('delete_panel removes the message and the rows, and the roles stay', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      const accessToken = await mintToken('bananasaurs:roles');
      expect(
        callText((await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body)
          .isError,
      ).not.toBe(true);
      const panelId = panelsOf()[0];
      if (panelId === undefined) throw new Error('create left no panel');

      const deleted = callText(
        (
          await panelCall(panelApp, accessToken, 'delete_panel', {
            guildId: GID,
            panelId,
            idempotencyKey: 'panel-del-k1',
          })
        ).body,
      );
      expect(deleted.isError).not.toBe(true);
      expect(deleted.text).toContain(`Deleted panel ${panelId}`);
      expect(discord.restCalls('deleteMessage')).toHaveLength(1);
      expect(panelRepo.findPanel(scope, panelId)).toBeUndefined();
      expect(panelsOf()).toEqual([]);
      // The roles stay allowlisted: deleting a panel revokes nothing.
      expect(roleRepo.isAllowlisted(scope, LOW_ROLE)).toBe(true);
      const row = mcpActionsRepo.findAction(scope, 'panel-del-k1');
      expect(row).toMatchObject({ kind: 'panel.delete', capGroup: 'structure', status: 'done' });
    } finally {
      await panelApp.close();
    }
  });

  it('edit_message and delete_message on the posted panel message stay refused', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      const roles = await mintToken('bananasaurs:roles');
      const send = await mintToken('bananasaurs:send');
      expect(
        callText((await panelCall(panelApp, roles, 'create_panel', createArgs())).body).isError,
      ).not.toBe(true);
      const messageId = panelRepo.findPanel(scope, panelsOf()[0] ?? '')?.messageId;
      if (messageId === undefined) throw new Error('create left no posted message');

      const editRefused = callText(
        (
          await panelCall(panelApp, send, 'edit_message', {
            guildId: GID,
            channelId: CHANNEL,
            messageId,
            content: 'hijacked panel text',
            idempotencyKey: 'prot-edit-k1',
          })
        ).body,
      );
      expect(editRefused.isError).toBe(true);
      expect(editRefused.text).toContain('role-panel');

      const deleteRefused = callText(
        (
          await panelCall(panelApp, send, 'delete_message', {
            guildId: GID,
            channelId: CHANNEL,
            messageId,
            idempotencyKey: 'prot-del-k1',
          })
        ).body,
      );
      expect(deleteRefused.isError).toBe(true);
      expect(deleteRefused.text).toContain('role-panel');

      expect(discord.restCalls('editMessage')).toHaveLength(0);
      expect(discord.restCalls('deleteMessage')).toHaveLength(0);
    } finally {
      await panelApp.close();
    }
  });

  it('replaying the key answers the same panel with one post', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const accessToken = await mintToken('bananasaurs:roles');
      const first = callText(
        (await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body,
      );
      expect(first.isError).not.toBe(true);
      const second = callText(
        (await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body,
      );
      expect(second.isError).not.toBe(true);
      expect(second.text).toContain('Already recorded under this idempotency key');
      // One panel row and one Discord post across both calls.
      expect(panelsOf()).toHaveLength(1);
      expect(discord.restCalls('sendMessage')).toHaveLength(1);
    } finally {
      await panelApp.close();
    }
  });

  it('the kill switch refuses all three write tools with no Discord call and no rows', async () => {
    allowPanel();
    const discord = new FakeDiscord({ guildId: GUILD_A });
    seedPanelDiscord(discord);
    const panelApp = buildPanelApp(discord);
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      const accessToken = await mintToken('bananasaurs:roles');
      expect(
        callText((await panelCall(panelApp, accessToken, 'create_panel', createArgs())).body)
          .isError,
      ).not.toBe(true);
      const panelId = panelsOf()[0];
      if (panelId === undefined) throw new Error('create left no panel');
      guildRepo.setKillswitch(scope, true, clock);
      discord.resetCalls();

      const refusedCreate = callText(
        (
          await panelCall(
            panelApp,
            accessToken,
            'create_panel',
            createArgs({ idempotencyKey: 'panel-ks-create' }),
          )
        ).body,
      );
      expect(refusedCreate.isError).toBe(true);
      expect(refusedCreate.text).toContain('kill switch');
      const refusedEdit = callText(
        (
          await panelCall(panelApp, accessToken, 'edit_panel', {
            guildId: GID,
            panelId,
            title: 'Blocked edit',
            idempotencyKey: 'panel-ks-edit',
          })
        ).body,
      );
      expect(refusedEdit.isError).toBe(true);
      expect(refusedEdit.text).toContain('kill switch');
      const refusedDelete = callText(
        (
          await panelCall(panelApp, accessToken, 'delete_panel', {
            guildId: GID,
            panelId,
            idempotencyKey: 'panel-ks-del',
          })
        ).body,
      );
      expect(refusedDelete.isError).toBe(true);
      expect(refusedDelete.text).toContain('kill switch');

      expect(discord.restCalls()).toHaveLength(0);
      expect(mcpActionsRepo.findAction(scope, 'panel-ks-create')).toBeUndefined();
      expect(mcpActionsRepo.findAction(scope, 'panel-ks-edit')).toBeUndefined();
      expect(mcpActionsRepo.findAction(scope, 'panel-ks-del')).toBeUndefined();
    } finally {
      await panelApp.close();
    }
  });
});

/**
 * Slice 5 Task 5, daemon side: the four event/poll tools through the real
 * stack — Fastify + `registerMcpRoutes` + `createMcpServer` + the real
 * event-writes port over the real repositories and the fake Discord port —
 * with tokens minted through the real OAuth flow.
 *
 * The client carries a voice channel, a stage channel and a text channel.
 * The bot role holds ManageEvents guild-wide in the main client; a second
 * client without it proves the permission refusal names the permission.
 * Times are fixed far-future ISO strings: the tool layer checks
 * start-in-future against the real clock, while the daemon's clock stays at
 * `clock`.
 */
describe('/mcp event writes through the real composition', () => {
  const BOT = '123456789012345678';
  const OWNER = '345678901234567890';
  const BOT_ROLE = '511111111111111111';
  const VOICE = '522222222222222222';
  const STAGE = '533333333333333333';
  const TEXT = '544444444444444444';
  const START = '2030-06-01T18:00:00.000Z';
  const END = '2030-06-01T20:00:00.000Z';
  /** Distinctive text: must reach Discord, must never reach the audit row. */
  const EVENT_NAME = 'event-name-probe-that-must-never-reach-audit-zz1';
  const POLL_QUESTION = 'poll-question-probe-that-must-never-reach-audit-zz2';

  interface EventDiscordInternals {
    guilds: { _add: (data: object) => Guild };
    users: { _add: (data: object) => unknown };
  }

  const buildEventClient = (withManageEvents: boolean): Client => {
    const client = new Client(buildClientOptions(() => BOT));
    const internals = client as unknown as EventDiscordInternals;
    const mutable = client as unknown as { user: unknown };
    mutable.user = internals.users._add({ id: BOT, username: 'bananasaurs', discriminator: '0' });
    let botPermissions =
      PermissionsBitField.Flags.ViewChannel |
      PermissionsBitField.Flags.SendMessages |
      PermissionsBitField.Flags.SendMessagesInThreads;
    if (withManageEvents) botPermissions |= PermissionsBitField.Flags.ManageEvents;
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: OWNER,
      channels: [
        {
          id: VOICE,
          guild_id: GUILD_A,
          type: ChannelType.GuildVoice,
          name: 'lounge-voice',
          position: 0,
          permission_overwrites: [],
        },
        {
          id: STAGE,
          guild_id: GUILD_A,
          type: ChannelType.GuildStageVoice,
          name: 'town-hall',
          position: 1,
          permission_overwrites: [],
        },
        {
          id: TEXT,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 2,
          permission_overwrites: [],
        },
      ],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 7,
          permissions: botPermissions.toString(),
          managed: true,
        },
      ],
      members: [
        { user: { id: BOT, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
      ],
      emojis: [],
      unavailable: false,
    });
    return client;
  };

  const buildEventApp = (client: Client, discord: FakeDiscord): FastifyInstance =>
    createServer({
      deps: { ...deps, mcpPublicUrl: PUBLIC_URL },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, client, discord);
      },
    });

  const allowEventChannel = (channelId: string): void => {
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
  };

  const eventCall = (
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

  const createdEventIdOf = (text: string): string => {
    const match = /Created event (\d+) in guild/.exec(text);
    expect(match?.[1]).toBeDefined();
    return match?.[1] as string;
  };

  const createVoiceArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guildId: '111111111111111111',
    name: EVENT_NAME,
    description: 'Monthly build night',
    startAt: START,
    endAt: END,
    location: 'voice',
    channel: VOICE,
    idempotencyKey: 'event-k1',
    ...over,
  });

  it('a voice event in an allowlisted voice channel creates through the port; the audit row holds no name', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const found = callText(
        (await eventCall(eventApp, accessToken, 'create_event', createVoiceArgs())).body,
      );
      expect(found.isError).not.toBe(true);
      const eventId = createdEventIdOf(found.text);
      expect(found.text).toContain('cancel_event');

      const calls = discord.restCalls('createScheduledEvent');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0]).toBe(GUILD_A);
      expect(calls[0]?.args[1]).toMatchObject({
        name: EVENT_NAME,
        startAt: Date.parse(START),
        endAt: Date.parse(END),
        location: { kind: 'voice', channelId: VOICE },
      });

      const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'event-k1');
      expect(row?.status).toBe('done');
      expect(row?.kind).toBe('event.create');
      expect(row?.capGroup).toBe('structure');
      expect(row?.targetChannelId).toBe(VOICE);

      const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 });
      const audit = trail.find((entry) => entry.action === 'mcp.event.create');
      expect(audit).toBeDefined();
      expect(audit?.subjectId).toBe(VOICE);
      expect(JSON.stringify(trail)).not.toContain(EVENT_NAME);
      expect(found.text).toContain(eventId);
    } finally {
      await eventApp.close();
    }
  });

  it('a voice channel outside send scope is refused with no port call', async () => {
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const refused = callText(
        (await eventCall(eventApp, accessToken, 'create_event', createVoiceArgs())).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('not on the send allowlist');
      expect(discord.restCalls('createScheduledEvent')).toHaveLength(0);
      expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'event-k1')).toBeUndefined();
    } finally {
      await eventApp.close();
    }
  });

  it('a text channel passed as an event channel is refused as not voice-or-stage', async () => {
    allowEventChannel(TEXT);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const refused = callText(
        (
          await eventCall(
            eventApp,
            accessToken,
            'create_event',
            createVoiceArgs({ channel: TEXT, idempotencyKey: 'event-text-channel' }),
          )
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('not a voice or stage channel');
      expect(discord.restCalls('createScheduledEvent')).toHaveLength(0);
    } finally {
      await eventApp.close();
    }
  });

  it('missing ManageEvents is refused naming the permission', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(false), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const refused = callText(
        (await eventCall(eventApp, accessToken, 'create_event', createVoiceArgs())).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('ManageEvents');
      expect(discord.restCalls('createScheduledEvent')).toHaveLength(0);
    } finally {
      await eventApp.close();
    }
  });

  it('an external event with guild ManageEvents is created', async () => {
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const found = callText(
        (
          await eventCall(eventApp, accessToken, 'create_event', {
            guildId: '111111111111111111',
            name: EVENT_NAME,
            startAt: START,
            endAt: END,
            location: 'external',
            place: 'Community hall',
            idempotencyKey: 'event-external-k1',
          })
        ).body,
      );
      expect(found.isError).not.toBe(true);
      const calls = discord.restCalls('createScheduledEvent');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[1]).toMatchObject({
        name: EVENT_NAME,
        location: { kind: 'external', place: 'Community hall' },
      });
      const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'event-external-k1');
      expect(row?.status).toBe('done');
      expect(row?.targetChannelId).toBeUndefined();
    } finally {
      await eventApp.close();
    }
  });

  it('an external event without guild ManageEvents is refused naming the permission', async () => {
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(false), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const refused = callText(
        (
          await eventCall(eventApp, accessToken, 'create_event', {
            guildId: '111111111111111111',
            name: EVENT_NAME,
            startAt: START,
            endAt: END,
            location: 'external',
            place: 'Community hall',
            idempotencyKey: 'event-external-noperm',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('ManageEvents');
      expect(refused.text).toContain('in guild 111111111111111111');
      expect(discord.restCalls('createScheduledEvent')).toHaveLength(0);
    } finally {
      await eventApp.close();
    }
  });

  it('edit then undo_action restores the previous values and marks the original', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const created = callText(
        (await eventCall(eventApp, accessToken, 'create_event', createVoiceArgs())).body,
      );
      expect(created.isError).not.toBe(true);
      const eventId = createdEventIdOf(created.text);

      const edited = callText(
        (
          await eventCall(eventApp, accessToken, 'edit_event', {
            guildId: '111111111111111111',
            eventId,
            name: 'Build night renamed',
            idempotencyKey: 'event-edit-k1',
          })
        ).body,
      );
      expect(edited.isError).not.toBe(true);
      expect(edited.text).toContain('kept for undo');
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(1);
      const listed = await discord.listScheduledEvents(GUILD_A);
      expect(listed.find((event) => event.id === eventId)?.name).toBe('Build night renamed');

      const scope = t.scopes.forGuild(GUILD_A);
      const editRow = mcpActionsRepo.findAction(scope, 'event-edit-k1');
      expect(editRow?.kind).toBe('event.edit');
      expect(editRow?.status).toBe('done');
      const undoJson = JSON.parse(editRow?.undoJson ?? '{}') as {
        eventId?: unknown;
        previous?: unknown;
      };
      expect(undoJson.eventId).toBe(eventId);
      expect(undoJson.previous).toMatchObject({ name: EVENT_NAME });
      expect(JSON.stringify(editRow)).not.toContain('Build night renamed');

      const undone = callText(
        (
          await eventCall(eventApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: editRow?.actionId ?? '',
          })
        ).body,
      );
      expect(undone.isError).not.toBe(true);
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(2);
      const relisted = await discord.listScheduledEvents(GUILD_A);
      expect(relisted.find((event) => event.id === eventId)?.name).toBe(EVENT_NAME);
      expect(
        mcpActionsRepo.findActionById(scope, editRow?.actionId ?? '')?.undoneByActionId,
      ).toBeDefined();
      const undoRow = mcpActionsRepo.findAction(scope, `undo:${editRow?.actionId ?? ''}`);
      expect(undoRow?.kind).toBe('event.edit');

      const again = callText(
        (
          await eventCall(eventApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: editRow?.actionId ?? '',
          })
        ).body,
      );
      expect(again.isError).toBe(true);
      expect(again.text).toContain('already undone');
    } finally {
      await eventApp.close();
    }
  });

  it('an added description is cleared by undo_action when the event had none', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const created = callText(
        (
          await eventCall(
            eventApp,
            accessToken,
            'create_event',
            createVoiceArgs({ description: undefined, idempotencyKey: 'event-nodesc-setup' }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      const eventId = createdEventIdOf(created.text);

      const edited = callText(
        (
          await eventCall(eventApp, accessToken, 'edit_event', {
            guildId: '111111111111111111',
            eventId,
            description: 'A description added later',
            idempotencyKey: 'event-nodesc-edit',
          })
        ).body,
      );
      expect(edited.isError).not.toBe(true);
      expect(edited.text).toContain('kept for undo');
      const scope = t.scopes.forGuild(GUILD_A);
      const editRow = mcpActionsRepo.findAction(scope, 'event-nodesc-edit');
      const undoJson = JSON.parse(editRow?.undoJson ?? '{}') as {
        previous?: { description?: unknown };
      };
      expect(undoJson.previous).toMatchObject({ description: null });

      const undone = callText(
        (
          await eventCall(eventApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: editRow?.actionId ?? '',
          })
        ).body,
      );
      expect(undone.isError).not.toBe(true);
      const relisted = await discord.listScheduledEvents(GUILD_A);
      expect(relisted.find((event) => event.id === eventId)?.description).toBeUndefined();
      expect(
        mcpActionsRepo.findActionById(scope, editRow?.actionId ?? '')?.undoneByActionId,
      ).toBeDefined();
    } finally {
      await eventApp.close();
    }
  });

  it('an endAt-only edit is restored by undo_action to the previous end time', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const created = callText(
        (
          await eventCall(
            eventApp,
            accessToken,
            'create_event',
            createVoiceArgs({ idempotencyKey: 'event-endat-setup' }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      const eventId = createdEventIdOf(created.text);
      const NEW_END = '2030-06-01T22:00:00.000Z';

      const edited = callText(
        (
          await eventCall(eventApp, accessToken, 'edit_event', {
            guildId: '111111111111111111',
            eventId,
            endAt: NEW_END,
            idempotencyKey: 'event-endat-edit',
          })
        ).body,
      );
      expect(edited.isError).not.toBe(true);
      expect(edited.text).toContain('kept for undo');
      expect(edited.text).not.toContain('not covered by undo');
      const scope = t.scopes.forGuild(GUILD_A);
      const editRow = mcpActionsRepo.findAction(scope, 'event-endat-edit');
      const undoJson = JSON.parse(editRow?.undoJson ?? '{}') as {
        previous?: { endAt?: unknown };
      };
      expect(undoJson.previous).toMatchObject({ endAt: Date.parse(END) });
      const moved = await discord.listScheduledEvents(GUILD_A);
      expect(moved.find((event) => event.id === eventId)?.scheduledEndAt).toBe(Date.parse(NEW_END));

      const undone = callText(
        (
          await eventCall(eventApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: editRow?.actionId ?? '',
          })
        ).body,
      );
      expect(undone.isError).not.toBe(true);
      const relisted = await discord.listScheduledEvents(GUILD_A);
      expect(relisted.find((event) => event.id === eventId)?.scheduledEndAt).toBe(Date.parse(END));
      expect(
        mcpActionsRepo.findActionById(scope, editRow?.actionId ?? '')?.undoneByActionId,
      ).toBeDefined();
    } finally {
      await eventApp.close();
    }
  });

  it('an endAt set on an event with no end time says undo does not cover it', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const created = callText(
        (
          await eventCall(
            eventApp,
            accessToken,
            'create_event',
            createVoiceArgs({ endAt: undefined, idempotencyKey: 'event-noend-setup' }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      const eventId = createdEventIdOf(created.text);
      const NEW_END = '2030-06-01T22:00:00.000Z';

      const edited = callText(
        (
          await eventCall(eventApp, accessToken, 'edit_event', {
            guildId: '111111111111111111',
            eventId,
            endAt: NEW_END,
            idempotencyKey: 'event-noend-edit',
          })
        ).body,
      );
      expect(edited.isError).not.toBe(true);
      expect(edited.text).toContain('end time');
      expect(edited.text).toContain('not covered by undo');
      const scope = t.scopes.forGuild(GUILD_A);
      const editRow = mcpActionsRepo.findAction(scope, 'event-noend-edit');
      const undoJson = JSON.parse(editRow?.undoJson ?? '{}') as {
        previous?: Record<string, unknown>;
      };
      expect(undoJson.previous).not.toHaveProperty('endAt');

      const undone = callText(
        (
          await eventCall(eventApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: editRow?.actionId ?? '',
          })
        ).body,
      );
      expect(undone.isError).not.toBe(true);
      // Discord cannot clear an end time, so the undo leaves the new one in
      // place — and still marks the original undone.
      const relisted = await discord.listScheduledEvents(GUILD_A);
      expect(relisted.find((event) => event.id === eventId)?.scheduledEndAt).toBe(
        Date.parse(NEW_END),
      );
      expect(
        mcpActionsRepo.findActionById(scope, editRow?.actionId ?? '')?.undoneByActionId,
      ).toBeDefined();
    } finally {
      await eventApp.close();
    }
  });

  it('a stored event.edit row with a malformed event id is not undoable with no port call', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const scope = t.scopes.forGuild(GUILD_A);
      mcpActionsRepo.claimAction(scope, {
        actionId: 'event-edit-bad-id',
        idempotencyKey: 'key-event-edit-bad-id',
        kind: 'event.edit',
        capGroup: 'structure',
        argsHash: 'hash-event-edit-bad-id',
        tokenId: 'tok_test',
        now: clock,
        dryRun: false,
      });
      mcpActionsRepo.completeAction(scope, 'event-edit-bad-id', {
        status: 'done',
        undoJson: JSON.stringify({ eventId: '../x', previous: { name: 'Old name' } }),
        now: clock,
      });
      const refused = callText(
        (
          await eventCall(eventApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: 'event-edit-bad-id',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('cannot be undone');
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(0);
    } finally {
      await eventApp.close();
    }
  });

  it('cancel is not undoable and says the event cannot be un-cancelled', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const created = callText(
        (
          await eventCall(
            eventApp,
            accessToken,
            'create_event',
            createVoiceArgs({ idempotencyKey: 'event-cancel-setup' }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      const eventId = createdEventIdOf(created.text);

      const cancelled = callText(
        (
          await eventCall(eventApp, accessToken, 'cancel_event', {
            guildId: '111111111111111111',
            eventId,
            idempotencyKey: 'event-cancel-k1',
          })
        ).body,
      );
      expect(cancelled.isError).not.toBe(true);
      expect(cancelled.text).toContain('cannot be un-cancelled');
      expect(discord.restCalls('cancelScheduledEvent')).toHaveLength(1);

      const scope = t.scopes.forGuild(GUILD_A);
      const cancelRow = mcpActionsRepo.findAction(scope, 'event-cancel-k1');
      expect(cancelRow?.kind).toBe('event.cancel');
      const refused = callText(
        (
          await eventCall(eventApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: cancelRow?.actionId ?? '',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('cannot be undone');
      expect(refused.text).toContain('event.cancel');
    } finally {
      await eventApp.close();
    }
  });

  it('a move out of a channel that left send scope is refused, even to an allowlisted channel', async () => {
    allowEventChannel(VOICE);
    allowEventChannel(STAGE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const eventId = createdEventIdOf(
        callText((await eventCall(eventApp, accessToken, 'create_event', createVoiceArgs())).body)
          .text,
      );
      mcpSendRepo.disallowChannel(t.scopes.forGuild(GUILD_A), VOICE, 'channel');
      for (const [key, move] of [
        ['event-move-stage', { channel: STAGE }],
        ['event-move-place', { place: 'Room 1' }],
      ] as const) {
        const refused = callText(
          (
            await eventCall(eventApp, accessToken, 'edit_event', {
              guildId: '111111111111111111',
              eventId,
              ...move,
              idempotencyKey: key,
            })
          ).body,
        );
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain(VOICE);
      }
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(0);
    } finally {
      await eventApp.close();
    }
  });

  it('an undo that would move an event back into a channel that left send scope is refused', async () => {
    allowEventChannel(VOICE);
    allowEventChannel(STAGE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const eventId = createdEventIdOf(
        callText((await eventCall(eventApp, accessToken, 'create_event', createVoiceArgs())).body)
          .text,
      );
      const moved = callText(
        (
          await eventCall(eventApp, accessToken, 'edit_event', {
            guildId: '111111111111111111',
            eventId,
            channel: STAGE,
            idempotencyKey: 'event-move-back',
          })
        ).body,
      );
      expect(moved.isError).not.toBe(true);
      mcpSendRepo.disallowChannel(t.scopes.forGuild(GUILD_A), VOICE, 'channel');
      const editRow = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'event-move-back');
      const refused = callText(
        (
          await eventCall(eventApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: editRow?.actionId ?? '',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('was not undone');
      expect(refused.text).toContain(`channel ${VOICE}: not-in-send-scope`);
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(1);
    } finally {
      await eventApp.close();
    }
  });

  it('an undo that would restore a start time already behind us refuses as expired', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const eventId = createdEventIdOf(
        callText((await eventCall(eventApp, accessToken, 'create_event', createVoiceArgs())).body)
          .text,
      );
      await eventCall(eventApp, accessToken, 'edit_event', {
        guildId: '111111111111111111',
        eventId,
        startAt: '2030-06-01T19:00:00.000Z',
        idempotencyKey: 'event-retime',
      });
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(1);
      // The original start has passed: restoring it would hand Discord a past time.
      clock = Date.parse(START) + 60_000;
      // The jump outlives the first token; a fresh one is minted at the new time.
      const laterToken = await mintToken('bananasaurs:send');
      const editRow = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'event-retime');
      const refused = callText(
        (
          await eventCall(eventApp, laterToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: editRow?.actionId ?? '',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('expired');
      expect(refused.text).toContain(START);
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(1);
    } finally {
      await eventApp.close();
    }
  });

  it('a move to a place for an event with no end time is refused, naming endAt', async () => {
    allowEventChannel(VOICE);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const eventId = createdEventIdOf(
        callText(
          (
            await eventCall(
              eventApp,
              accessToken,
              'create_event',
              createVoiceArgs({ endAt: undefined }),
            )
          ).body,
        ).text,
      );
      const refused = callText(
        (
          await eventCall(eventApp, accessToken, 'edit_event', {
            guildId: '111111111111111111',
            eventId,
            place: 'Room 1',
            idempotencyKey: 'event-place-no-end',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('endAt');
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(0);
    } finally {
      await eventApp.close();
    }
  });

  it('an unknown event id is refused as event-not-found', async () => {
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const editRefused = callText(
        (
          await eventCall(eventApp, accessToken, 'edit_event', {
            guildId: '111111111111111111',
            eventId: '999999999999999999',
            name: 'Nope',
            idempotencyKey: 'event-unknown-edit',
          })
        ).body,
      );
      expect(editRefused.isError).toBe(true);
      expect(editRefused.text).toContain('was not found');
      const cancelRefused = callText(
        (
          await eventCall(eventApp, accessToken, 'cancel_event', {
            guildId: '111111111111111111',
            eventId: '999999999999999999',
            idempotencyKey: 'event-unknown-cancel',
          })
        ).body,
      );
      expect(cancelRefused.isError).toBe(true);
      expect(cancelRefused.text).toContain('was not found');
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(0);
      expect(discord.restCalls('cancelScheduledEvent')).toHaveLength(0);
    } finally {
      await eventApp.close();
    }
  });

  it('create_poll posts through sendMessage with the poll and empty mentions; a replay posts once', async () => {
    allowEventChannel(TEXT);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const pollArgs = {
        guildId: '111111111111111111',
        channelId: TEXT,
        question: POLL_QUESTION,
        answers: ['Friday', 'Saturday'],
        durationHours: 24,
        idempotencyKey: 'poll-k1',
      };
      const first = callText(
        (await eventCall(eventApp, accessToken, 'create_poll', pollArgs)).body,
      );
      expect(first.isError).not.toBe(true);
      expect(first.text).toContain('Sent poll message');
      const second = callText(
        (await eventCall(eventApp, accessToken, 'create_poll', pollArgs)).body,
      );
      expect(second.isError).not.toBe(true);
      expect(second.text).toContain('Already sent under this idempotency key');

      const calls = discord.restCalls('sendMessage');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0]).toBe(GUILD_A);
      expect(calls[0]?.args[1]).toBe(TEXT);
      expect(calls[0]?.args[2]).toEqual({
        poll: {
          question: POLL_QUESTION,
          answers: ['Friday', 'Saturday'],
          durationHours: 24,
          allowMultiselect: false,
        },
        allowedMentions: { parse: [], roles: [], users: [] },
      });

      const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'poll-k1');
      expect(row?.kind).toBe('message.send');
      expect(row?.capGroup).toBe('message');
      const poll = discord.pollOf(TEXT, row?.resultMessageId ?? '');
      expect(poll).toEqual({
        question: POLL_QUESTION,
        answers: ['Friday', 'Saturday'],
        durationHours: 24,
        allowMultiselect: false,
      });
      const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 });
      expect(JSON.stringify(trail)).not.toContain(POLL_QUESTION);
    } finally {
      await eventApp.close();
    }
  });

  it('the kill switch refuses all four tools', async () => {
    allowEventChannel(VOICE);
    allowEventChannel(TEXT);
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const eventApp = buildEventApp(buildEventClient(true), discord);
    const accessToken = await mintToken('bananasaurs:send');
    try {
      const created = callText(
        (
          await eventCall(
            eventApp,
            accessToken,
            'create_event',
            createVoiceArgs({ idempotencyKey: 'event-killswitch-setup' }),
          )
        ).body,
      );
      expect(created.isError).not.toBe(true);
      const eventId = createdEventIdOf(created.text);
      guildRepo.setKillswitch(t.scopes.forGuild(GUILD_A), true, clock);

      const refusedCreate = callText(
        (
          await eventCall(
            eventApp,
            accessToken,
            'create_event',
            createVoiceArgs({ idempotencyKey: 'event-killswitch-create' }),
          )
        ).body,
      );
      expect(refusedCreate.isError).toBe(true);
      expect(refusedCreate.text).toContain('kill switch');
      const refusedEdit = callText(
        (
          await eventCall(eventApp, accessToken, 'edit_event', {
            guildId: '111111111111111111',
            eventId,
            name: 'Renamed under killswitch',
            idempotencyKey: 'event-killswitch-edit',
          })
        ).body,
      );
      expect(refusedEdit.isError).toBe(true);
      expect(refusedEdit.text).toContain('kill switch');
      const refusedCancel = callText(
        (
          await eventCall(eventApp, accessToken, 'cancel_event', {
            guildId: '111111111111111111',
            eventId,
            idempotencyKey: 'event-killswitch-cancel',
          })
        ).body,
      );
      expect(refusedCancel.isError).toBe(true);
      expect(refusedCancel.text).toContain('kill switch');
      const refusedPoll = callText(
        (
          await eventCall(eventApp, accessToken, 'create_poll', {
            guildId: '111111111111111111',
            channelId: TEXT,
            question: POLL_QUESTION,
            answers: ['Friday', 'Saturday'],
            durationHours: 24,
            idempotencyKey: 'poll-killswitch',
          })
        ).body,
      );
      expect(refusedPoll.isError).toBe(true);
      expect(refusedPoll.text).toContain('kill switch');

      expect(discord.restCalls('createScheduledEvent')).toHaveLength(1);
      expect(discord.restCalls('editScheduledEvent')).toHaveLength(0);
      expect(discord.restCalls('cancelScheduledEvent')).toHaveLength(0);
      expect(discord.restCalls('sendMessage')).toHaveLength(0);
    } finally {
      await eventApp.close();
    }
  });
});

/**
 * Slice 5 Task 3, daemon side: `schedule_message`, `list_scheduled`,
 * `edit_scheduled` and `cancel_scheduled` through the real stack — Fastify +
 * `registerMcpRoutes` + `createMcpServer` + the real schedule port over the
 * real repositories — with tokens minted through the real OAuth flow.
 *
 * What this proves that a unit test could not: that the daemon actually
 * threads the port rather than a test supplying it by hand, that the
 * destination and the pings are checked at schedule time, that a replay
 * inserts exactly one reminder row with `origin='mcp'`, that assistant rows
 * are invisible to all four tools, and that the undo arms restore the
 * previous content and the `scheduled` state (or refuse as expired).
 *
 * Setup reaches past `buildDashboardApp` the way the send tests do: the
 * allowlist row is written through the same repository `bananasaurs mcp
 * allow-channel` writes, dry-run is turned off (guilds default to dry-run
 * on, under which a schedule records without storing), and the instance's
 * redacted config carries the owner id the schedule port stores as the
 * reminder's creator. Tokens are minted on the dashboard `app` and spent on
 * the MCP-only `schedApp`: bearer validation reads the shared test database,
 * so the token works on either.
 */
describe('/mcp scheduled sends through the real composition', () => {
  const OWNER = '345678901234567890';
  const BOT = '123456789012345678';
  const CHANNEL = '555555555555555555';
  /** In the guild cache but never allowlisted: the allowlist refusal shape. */
  const LOUNGE = '544444444444444444';
  const BOT_ROLE = '511111111111111111';
  const LOW_ROLE = '522222222222222222';
  const DANGEROUS_ROLE = '577777777777777777';
  const MEMBER_USER = '633333333333333333';
  /** Distinctive text: must reach the reminder row, must never reach an audit row or log. */
  const CONTENT = 'sched-probe-content-that-must-never-reach-audit-zz7';
  const CONTENT_EDITED = 'sched-probe-edited-content-that-must-never-reach-audit-zz8';

  interface ScheduleDiscordInternals {
    guilds: { _add: (data: object) => Guild };
    users: { _add: (data: object) => unknown };
  }

  const seedScheduleGuild = (client: Client): void => {
    const internals = client as unknown as ScheduleDiscordInternals;
    const mutable = client as unknown as { user: unknown };
    mutable.user = internals.users._add({ id: BOT, username: 'bananasaurs', discriminator: '0' });
    const botPermissions = (
      PermissionsBitField.Flags.ViewChannel |
      PermissionsBitField.Flags.SendMessages |
      PermissionsBitField.Flags.SendMessagesInThreads
    ).toString();
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [
        {
          id: CHANNEL,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'planning',
          position: 0,
          permission_overwrites: [],
        },
        {
          id: LOUNGE,
          guild_id: GUILD_A,
          type: ChannelType.GuildText,
          name: 'lounge',
          position: 1,
          permission_overwrites: [],
        },
      ],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 7,
          permissions: botPermissions,
          managed: true,
        },
        { id: LOW_ROLE, name: 'helpers', position: 3, permissions: '0', managed: false },
        {
          id: DANGEROUS_ROLE,
          name: 'floor-watch',
          position: 2,
          permissions: String(PermissionsBitField.Flags.Administrator),
          managed: false,
        },
      ],
      members: [
        { user: { id: BOT, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
        { user: { id: MEMBER_USER, username: 'member', discriminator: '0' }, roles: [] },
      ],
      emojis: [],
      unavailable: false,
    });
  };

  const buildScheduleApp = (): FastifyInstance => {
    const discord = new FakeDiscord({ guildId: GUILD_A });
    const client = new Client(buildClientOptions(() => BOT));
    seedScheduleGuild(client);
    return createServer({
      deps: {
        ...deps,
        instance: {
          ...deps.instance,
          redactedConfig: () => ({ BANANASAURS_OWNER_USER_ID: OWNER }),
        },
      },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, client, discord);
      },
    });
  };

  const allow = (): void => {
    mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
      channelId: CHANNEL,
      addedByAccountId: ACCOUNT,
      now: clock,
    });
    guildRepo.setDryRun(t.scopes.forGuild(GUILD_A), false, clock);
  };

  const schedCall = (
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

  const futureIso = (aheadMs: number): string => new Date(clock + aheadMs).toISOString();

  const mcpRows = () => assistantRepo.listReminders(t.scopes.forGuild(GUILD_A), 'mcp');

  const actionIdFor = (key: string): string => {
    const row = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), key);
    expect(row?.status).toBe('done');
    return row?.actionId ?? '';
  };

  it('schedule, then list, then edit, then cancel, end to end', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');

      const scheduled = callText(
        (
          await schedCall(schedApp, accessToken, 'schedule_message', {
            guildId: '111111111111111111',
            channel: CHANNEL,
            content: CONTENT,
            at: futureIso(3_600_000),
            pingRoles: ['helpers'],
            pingUsers: [MEMBER_USER],
            idempotencyKey: 'sched-flow',
          })
        ).body,
      );
      expect(scheduled.isError).not.toBe(true);
      expect(scheduled.text).toContain('Scheduled message');
      expect(scheduled.text).toContain(CHANNEL);

      // Exactly one reminder row, with origin 'mcp', the owner as creator,
      // the resolved destination and the resolved mention ids — never
      // everyone or here — and a dedupe key derived from the action id.
      const rows = mcpRows();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      expect(row?.origin).toBe('mcp');
      expect(row?.creatorId).toBe(OWNER);
      expect(row?.destinationId).toBe(CHANNEL);
      expect(row?.text).toBe(CONTENT);
      expect(row?.status).toBe('scheduled');
      expect(row?.mentions).toEqual({
        userIds: [MEMBER_USER],
        roleIds: [LOW_ROLE],
        everyone: false,
        here: false,
      });
      const actionId = actionIdFor('sched-flow');
      expect(scheduled.text).toContain(actionId);
      expect(scheduled.text).toContain(row?.id ?? '');
      expect(row?.dedupeKey).toBe(`mcp:${actionId}`);
      const action = mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'sched-flow');
      expect(action?.kind).toBe('schedule.create');
      expect(action?.targetChannelId).toBe(CHANNEL);

      // The audit row carries the channel, the credential and the outcome —
      // never the content (rule 4).
      const trail = effectRepo.tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 });
      const audit = trail.find((entry) => entry.action === 'mcp.schedule.create');
      expect(audit).toBeDefined();
      expect(audit?.actorType).toBe('mcp_operator');
      expect(audit?.via).toBe('http');
      expect(audit?.subjectType).toBe('channel');
      expect(audit?.subjectId).toBe(CHANNEL);
      expect(JSON.stringify(trail)).not.toContain(CONTENT);

      const listed = callText(
        (
          await schedCall(schedApp, accessToken, 'list_scheduled', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(listed.isError).not.toBe(true);
      expect(listed.text).toContain(row?.id ?? '');
      expect(listed.text).toContain(CHANNEL);
      expect(listed.text).toContain(new Date(row?.dueAt ?? 0).toISOString());
      expect(listed.text).toContain('one-shot');
      expect(listed.text).toContain('scheduled');
      const listAudit = effectRepo
        .tailAudit(t.scopes.forGuild(GUILD_A), { limit: 25 })
        .find((entry) => entry.action === 'mcp.read.list_scheduled');
      expect(listAudit).toBeDefined();
      expect(listAudit?.actorType).toBe('mcp_operator');
      expect(JSON.stringify(listAudit)).not.toContain(CONTENT);

      const reminderId = row?.id ?? '';
      const edited = callText(
        (
          await schedCall(schedApp, accessToken, 'edit_scheduled', {
            guildId: '111111111111111111',
            reminderId,
            content: CONTENT_EDITED,
            idempotencyKey: 'sched-flow-edit',
          })
        ).body,
      );
      expect(edited.isError).not.toBe(true);
      expect(edited.text).toContain('Edited scheduled message');
      expect(mcpRows()[0]?.text).toBe(CONTENT_EDITED);

      const cancelled = callText(
        (
          await schedCall(schedApp, accessToken, 'cancel_scheduled', {
            guildId: '111111111111111111',
            reminderId,
            idempotencyKey: 'sched-flow-cancel',
          })
        ).body,
      );
      expect(cancelled.isError).not.toBe(true);
      expect(cancelled.text).toContain('Cancelled scheduled message');
      expect(mcpRows()[0]?.status).toBe('cancelled');
    } finally {
      await schedApp.close();
    }
  });

  it('a recurring schedule stores the pattern and lists its first occurrence', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const scheduled = callText(
        (
          await schedCall(schedApp, accessToken, 'schedule_message', {
            guildId: '111111111111111111',
            channel: 'planning',
            content: CONTENT,
            recurrence: { pattern: { kind: 'daily' }, timeZone: 'America/Vancouver' },
            idempotencyKey: 'sched-recurring',
          })
        ).body,
      );
      expect(scheduled.isError).not.toBe(true);
      // The channel rode in as a name and resolved to the allowlisted id.
      const rows = mcpRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.destinationId).toBe(CHANNEL);
      expect(rows[0]?.recurrence?.pattern.kind).toBe('daily');
      expect(rows[0]?.dueAt ?? 0).toBeGreaterThan(clock);
      const listed = callText(
        (
          await schedCall(schedApp, accessToken, 'list_scheduled', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(listed.isError).not.toBe(true);
      expect(listed.text).toContain('daily');
    } finally {
      await schedApp.close();
    }
  });

  it('a past at is refused and stores nothing', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const refused = callText(
        (
          await schedCall(schedApp, accessToken, 'schedule_message', {
            guildId: '111111111111111111',
            channel: CHANNEL,
            content: CONTENT,
            at: new Date(clock - 60_000).toISOString(),
            idempotencyKey: 'sched-past',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('past');
      expect(mcpRows()).toHaveLength(0);
      expect(mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'sched-past')).toBeUndefined();
    } finally {
      await schedApp.close();
    }
  });

  it('pings are checked at schedule time: a dangerous role and an unknown role refuse', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const dangerous = callText(
        (
          await schedCall(schedApp, accessToken, 'schedule_message', {
            guildId: '111111111111111111',
            channel: CHANNEL,
            content: CONTENT,
            at: futureIso(3_600_000),
            pingRoles: [DANGEROUS_ROLE],
            idempotencyKey: 'sched-dangerous-ping',
          })
        ).body,
      );
      expect(dangerous.isError).toBe(true);
      expect(dangerous.text).toContain('never allows');
      expect(dangerous.text).toContain(DANGEROUS_ROLE);
      const unknown = callText(
        (
          await schedCall(schedApp, accessToken, 'schedule_message', {
            guildId: '111111111111111111',
            channel: CHANNEL,
            content: CONTENT,
            at: futureIso(3_600_000),
            pingRoles: ['no-such-role'],
            idempotencyKey: 'sched-unknown-ping',
          })
        ).body,
      );
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('No role');
      expect(mcpRows()).toHaveLength(0);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'sched-dangerous-ping'),
      ).toBeUndefined();
    } finally {
      await schedApp.close();
    }
  });

  it('a non-allowlisted channel is refused with no row and no Discord call', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const refused = callText(
        (
          await schedCall(schedApp, accessToken, 'schedule_message', {
            guildId: '111111111111111111',
            channel: LOUNGE,
            content: CONTENT,
            at: futureIso(3_600_000),
            idempotencyKey: 'sched-outside',
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('not on the send allowlist');
      expect(mcpRows()).toHaveLength(0);
      expect(
        mcpActionsRepo.findAction(t.scopes.forGuild(GUILD_A), 'sched-outside'),
      ).toBeUndefined();
    } finally {
      await schedApp.close();
    }
  });

  it('the two-guild gate: guild B answers the shared refusal and stores nothing there', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      // The token carries mcp.authorize in guild A only, so guild B is
      // unreachable — the same principal shape the send tests use.
      const accessToken = await mintToken('bananasaurs:send');
      for (const [name, args] of [
        [
          'schedule_message',
          {
            guildId: '222222222222222222',
            channel: CHANNEL,
            content: CONTENT,
            at: futureIso(3_600_000),
            idempotencyKey: 'sched-b',
          },
        ],
        ['list_scheduled', { guildId: '222222222222222222' }],
        [
          'edit_scheduled',
          {
            guildId: '222222222222222222',
            reminderId: 'rem-b',
            content: CONTENT,
            idempotencyKey: 'sched-b-edit',
          },
        ],
        [
          'cancel_scheduled',
          {
            guildId: '222222222222222222',
            reminderId: 'rem-b',
            idempotencyKey: 'sched-b-cancel',
          },
        ],
      ] as const) {
        const refused = callText((await schedCall(schedApp, accessToken, name, { ...args })).body);
        expect(refused.isError).toBe(true);
        expect(refused.text).toBe(GUILD_REFUSAL_MESSAGE);
      }
      expect(assistantRepo.listReminders(t.scopes.forGuild(GUILD_B), 'mcp')).toHaveLength(0);
      expect(mcpRows()).toHaveLength(0);
    } finally {
      await schedApp.close();
    }
  });

  it('a replay inserts one reminder', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      const args = {
        guildId: '111111111111111111',
        channel: CHANNEL,
        content: CONTENT,
        at: futureIso(3_600_000),
        idempotencyKey: 'sched-replay',
      };
      const first = callText(
        (await schedCall(schedApp, accessToken, 'schedule_message', args)).body,
      );
      expect(first.isError).not.toBe(true);
      const second = callText(
        (await schedCall(schedApp, accessToken, 'schedule_message', args)).body,
      );
      expect(second.isError).not.toBe(true);
      expect(second.text).toContain('Already recorded');
      expect(mcpRows()).toHaveLength(1);
    } finally {
      await schedApp.close();
    }
  });

  it('an undo of the cancel restores scheduled', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      await schedCall(schedApp, accessToken, 'schedule_message', {
        guildId: '111111111111111111',
        channel: CHANNEL,
        content: CONTENT,
        at: futureIso(3_600_000),
        idempotencyKey: 'sched-undo-cancel',
      });
      const reminderId = mcpRows()[0]?.id ?? '';
      await schedCall(schedApp, accessToken, 'cancel_scheduled', {
        guildId: '111111111111111111',
        reminderId,
        idempotencyKey: 'sched-undo-cancel-do',
      });
      expect(mcpRows()[0]?.status).toBe('cancelled');
      const undone = callText(
        (
          await schedCall(schedApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: actionIdFor('sched-undo-cancel-do'),
          })
        ).body,
      );
      expect(undone.isError).not.toBe(true);
      expect(undone.text).toContain('schedule.cancel');
      expect(mcpRows()[0]?.status).toBe('scheduled');
    } finally {
      await schedApp.close();
    }
  });

  it('an undo of the cancel past its due time refuses as expired', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      await schedCall(schedApp, accessToken, 'schedule_message', {
        guildId: '111111111111111111',
        channel: CHANNEL,
        content: CONTENT,
        at: futureIso(60_000),
        idempotencyKey: 'sched-undo-expired',
      });
      const row = mcpRows()[0];
      const reminderId = row?.id ?? '';
      const dueIso = new Date(row?.dueAt ?? 0).toISOString();
      await schedCall(schedApp, accessToken, 'cancel_scheduled', {
        guildId: '111111111111111111',
        reminderId,
        idempotencyKey: 'sched-undo-expired-do',
      });
      // Past the due time, the send can no longer be restored.
      clock += 120_000;
      const refused = callText(
        (
          await schedCall(schedApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: actionIdFor('sched-undo-expired-do'),
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('expired');
      expect(refused.text).toContain(dueIso);
      expect(mcpRows()[0]?.status).toBe('cancelled');
    } finally {
      await schedApp.close();
    }
  });

  it('an undo of the edit restores the previous content', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      await schedCall(schedApp, accessToken, 'schedule_message', {
        guildId: '111111111111111111',
        channel: CHANNEL,
        content: CONTENT,
        at: futureIso(3_600_000),
        idempotencyKey: 'sched-undo-edit',
      });
      const reminderId = mcpRows()[0]?.id ?? '';
      await schedCall(schedApp, accessToken, 'edit_scheduled', {
        guildId: '111111111111111111',
        reminderId,
        content: CONTENT_EDITED,
        idempotencyKey: 'sched-undo-edit-do',
      });
      expect(mcpRows()[0]?.text).toBe(CONTENT_EDITED);
      const undone = callText(
        (
          await schedCall(schedApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: actionIdFor('sched-undo-edit-do'),
          })
        ).body,
      );
      expect(undone.isError).not.toBe(true);
      expect(undone.text).toContain('schedule.edit');
      expect(mcpRows()[0]?.text).toBe(CONTENT);
    } finally {
      await schedApp.close();
    }
  });

  it('re-timing a recurring send to `at` clears it to one-shot, and the undo restores the series', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      await schedCall(schedApp, accessToken, 'schedule_message', {
        guildId: '111111111111111111',
        channel: CHANNEL,
        content: CONTENT,
        recurrence: { pattern: { kind: 'daily' }, timeZone: 'America/Vancouver' },
        idempotencyKey: 'sched-retime-at',
      });
      const before = mcpRows()[0];
      expect(before?.recurrence?.pattern.kind).toBe('daily');
      const reminderId = before?.id ?? '';
      const newAt = clock + 7_200_000;
      const edited = callText(
        (
          await schedCall(schedApp, accessToken, 'edit_scheduled', {
            guildId: '111111111111111111',
            reminderId,
            at: new Date(newAt).toISOString(),
            idempotencyKey: 'sched-retime-at-do',
          })
        ).body,
      );
      expect(edited.isError).not.toBe(true);
      expect(mcpRows()[0]?.dueAt).toBe(newAt);
      expect(mcpRows()[0]?.recurrence).toBeUndefined();
      const undone = callText(
        (
          await schedCall(schedApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: actionIdFor('sched-retime-at-do'),
          })
        ).body,
      );
      expect(undone.isError).not.toBe(true);
      expect(mcpRows()[0]?.dueAt).toBe(before?.dueAt);
      expect(mcpRows()[0]?.recurrence).toEqual(before?.recurrence);
    } finally {
      await schedApp.close();
    }
  });

  it('re-timing a one-shot send to a recurrence sets the series, and the undo clears it back', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      await schedCall(schedApp, accessToken, 'schedule_message', {
        guildId: '111111111111111111',
        channel: CHANNEL,
        content: CONTENT,
        at: futureIso(3_600_000),
        idempotencyKey: 'sched-retime-rec',
      });
      const before = mcpRows()[0];
      expect(before?.recurrence).toBeUndefined();
      const reminderId = before?.id ?? '';
      await schedCall(schedApp, accessToken, 'edit_scheduled', {
        guildId: '111111111111111111',
        reminderId,
        recurrence: { pattern: { kind: 'daily' }, timeZone: 'America/Vancouver' },
        idempotencyKey: 'sched-retime-rec-do',
      });
      expect(mcpRows()[0]?.recurrence?.pattern.kind).toBe('daily');
      const undone = callText(
        (
          await schedCall(schedApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: actionIdFor('sched-retime-rec-do'),
          })
        ).body,
      );
      expect(undone.isError).not.toBe(true);
      expect(mcpRows()[0]?.dueAt).toBe(before?.dueAt);
      expect(mcpRows()[0]?.recurrence).toBeUndefined();
    } finally {
      await schedApp.close();
    }
  });

  it('an undo of a re-time that would restore a past due time refuses as expired', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      const accessToken = await mintToken('bananasaurs:send');
      await schedCall(schedApp, accessToken, 'schedule_message', {
        guildId: '111111111111111111',
        channel: CHANNEL,
        content: CONTENT,
        at: futureIso(60_000),
        idempotencyKey: 'sched-retime-expired',
      });
      const reminderId = mcpRows()[0]?.id ?? '';
      const originalDue = mcpRows()[0]?.dueAt ?? 0;
      const newAt = clock + 7_200_000;
      await schedCall(schedApp, accessToken, 'edit_scheduled', {
        guildId: '111111111111111111',
        reminderId,
        at: new Date(newAt).toISOString(),
        idempotencyKey: 'sched-retime-expired-do',
      });
      // The original due time is now behind us: restoring it would send at once.
      clock += 120_000;
      const refused = callText(
        (
          await schedCall(schedApp, accessToken, 'undo_action', {
            guildId: '111111111111111111',
            actionId: actionIdFor('sched-retime-expired-do'),
          })
        ).body,
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('expired');
      expect(refused.text).toContain(new Date(originalDue).toISOString());
      expect(mcpRows()[0]?.dueAt).toBe(newAt);
    } finally {
      await schedApp.close();
    }
  });

  it('an assistant-origin reminder id is not found by the schedule tools', async () => {
    allow();
    const schedApp = buildScheduleApp();
    try {
      assistantRepo.insertReminder(
        t.scopes.forGuild(GUILD_A),
        {
          id: 'assistant-row-1',
          guildId: String(GUILD_A),
          creatorId: MEMBER_USER,
          destinationId: CHANNEL,
          text: 'assistant reminder text',
          dueAt: clock + 3_600_000,
          createdAt: clock,
          status: 'scheduled',
          dedupeKey: 'reminder:assistant-row-1',
          mentions: { userIds: [], roleIds: [], everyone: false, here: false },
          deliveredCount: 0,
        },
        'assistant',
      );
      const accessToken = await mintToken('bananasaurs:send');
      const edited = callText(
        (
          await schedCall(schedApp, accessToken, 'edit_scheduled', {
            guildId: '111111111111111111',
            reminderId: 'assistant-row-1',
            content: CONTENT,
            idempotencyKey: 'sched-assistant-edit',
          })
        ).body,
      );
      expect(edited.isError).toBe(true);
      expect(edited.text).toContain('No scheduled message');
      const cancelled = callText(
        (
          await schedCall(schedApp, accessToken, 'cancel_scheduled', {
            guildId: '111111111111111111',
            reminderId: 'assistant-row-1',
            idempotencyKey: 'sched-assistant-cancel',
          })
        ).body,
      );
      expect(cancelled.isError).toBe(true);
      expect(cancelled.text).toContain('No scheduled message');
      // And the outbox listing never shows it either.
      const listed = callText(
        (
          await schedCall(schedApp, accessToken, 'list_scheduled', {
            guildId: '111111111111111111',
          })
        ).body,
      );
      expect(listed.isError).not.toBe(true);
      expect(listed.text).toContain('No scheduled messages');
      expect(listed.text).not.toContain('assistant-row-1');
    } finally {
      await schedApp.close();
    }
  });
});
