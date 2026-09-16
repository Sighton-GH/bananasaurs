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
import { accountRepo, archiveRepo, authzRepo, guildRepo, roleRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { createServer, generateToken, hashPassword } from '@bananasaurs/http';
import { GUILD_REFUSAL_MESSAGE } from '@bananasaurs/mcp';
import { buildDashboardApp, type DashboardAppDeps } from '../http/wiring.js';
import { registerMcpRoutes } from './wiring.js';
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

  it('answers a valid read-scope token with tools/list containing all eleven tools', async () => {
    const accessToken = await mintToken();
    const response = await toolsList(accessToken);
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    const result = bodies[0] as { result?: { tools?: Array<{ name: string }> } };
    const names = result.result?.tools?.map((tool) => tool.name);
    expect(names).toHaveLength(11);
    expect(names).toEqual([
      'get_health',
      'search_messages',
      'read_channel_history',
      'get_message',
      'list_channels',
      'list_roles',
      'list_members',
      'list_mod_cases',
      'get_mod_case',
      'list_audit_events',
      'get_server_overview',
    ]);
    expect(names).not.toContain('send_message');
  });

  it('(ruling M4-D17) a send-only token minted through the real OAuth flow sees no tools', async () => {
    // Through the real authorize/consent/exchange flow, not a hand-built
    // principal: this defect is invisible to a test that constructs the
    // principal itself, which is the exact shape of the three "works in
    // tests, broken in the daemon" defects this slice already found.
    //
    // The SDK installs its `tools/list` handler lazily on the first `tool()`
    // registration (`setToolRequestHandlers` in
    // `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`), so
    // the send-only server — nothing registered — answers Method-not-found
    // rather than an empty array: there is no list at all for `send_message`'s
    // siblings to appear in.
    const accessToken = await mintToken('bananasaurs:send');
    const response = await toolsList(accessToken);
    expect(response.statusCode).toBe(200);
    const bodies = sseData(response.body);
    expect(bodies.length).toBeGreaterThan(0);
    const frame = bodies[0] as { error?: { code?: number; message?: string } };
    expect(frame.error?.code).toBe(-32601);
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
      roles: { cache: new Collection([[ROLE_MANAGED, undefined]]) },
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
  const buildGuildApp = (discordClient: Client): FastifyInstance =>
    createServer({
      deps: { ...deps, mcpPublicUrl: PUBLIC_URL },
      registerRoutes: (instance, _guard, routeDeps) => {
        registerMcpRoutes(instance, routeDeps, discordClient);
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
      expect(found.text).toContain('archive-enabled: yes');
      expect(found.text).toContain('archive-enabled: no');
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
      expect(found.text).toContain('managed-by-bananasaurs: yes');
      expect(found.text).toContain('managed-by-bananasaurs: no');
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
