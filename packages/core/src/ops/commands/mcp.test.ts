import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type {
  OpsAuditWrite,
  OpsInstance,
  OpsMcpClient,
  OpsMcpConnection,
  OpsMcpToken,
  OpsPorts,
} from '../ports.js';
import { OPS_MAX_LINE_BYTES } from '../protocol.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import {
  mcpCleanupCommand,
  mcpClientsCommand,
  mcpConnectionsCommand,
  mcpDeleteConnectionCommand,
  mcpDeleteTokenCommand,
  mcpDisconnectCommand,
  mcpRevokeClientCommand,
  mcpRevokeCommand,
  mcpTokensCommand,
} from './mcp.js';

const NOW = 1_700_000_000_000;

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(command: string, args?: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
}

const harness = (
  overInstance: Partial<OpsInstance> = {},
  overPorts: Partial<OpsPorts> = {},
): Harness => {
  const audit: OpsAuditWrite[] = [];
  const dispatcher = createDispatcher({
    commands: [
      mcpClientsCommand,
      mcpTokensCommand,
      mcpRevokeCommand,
      mcpRevokeClientCommand,
      mcpConnectionsCommand,
      mcpDisconnectCommand,
      mcpDeleteConnectionCommand,
      mcpDeleteTokenCommand,
      mcpCleanupCommand,
    ],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts({
        recordAudit: (input) => {
          audit.push(input);
        },
        ...overPorts,
      }),
    }),
    instance: fakeOpsInstance(overInstance),
  });
  return {
    audit,
    run: (command, args = {}, confirm = true) =>
      dispatcher.dispatch({ v: 1, command, args, confirm }),
  };
};

const client = (over: Partial<OpsMcpClient> = {}): OpsMcpClient => ({
  clientId: 'cli_abcdef0123456789',
  clientName: 'test client',
  registrationSource: 'dynamic',
  createdAt: NOW - 86_400_000,
  redirectUriCount: 1,
  ...over,
});

const token = (over: Partial<OpsMcpToken> = {}): OpsMcpToken => ({
  tokenId: 'tok_0123456789abcdef0123456789abcdef',
  kind: 'access',
  clientId: 'cli_abcdef0123456789',
  accountId: 'acct_0123456789abcdef0123456789abcdef',
  createdAt: NOW - 3_600_000,
  expiresAt: NOW + 3_600_000,
  revokedAt: null,
  lastUsedAt: null,
  connectionId: 'tok_root',
  ...over,
});

describe('mcp commands are registered on the operator surface (ADR 0045)', () => {
  it('all four appear in the command list', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toEqual(
      expect.arrayContaining(['mcp clients', 'mcp tokens', 'mcp revoke', 'mcp revoke-client']),
    );
  });

  it('clients and tokens are reads; revoke and revoke-client are writes', () => {
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp clients')?.write).toBe(false);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp tokens')?.write).toBe(false);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp revoke')?.write).toBe(true);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp revoke-client')?.write).toBe(true);
  });
});

describe('mcp clients', () => {
  it('says so plainly when no client is registered', async () => {
    const h = harness({ mcpClients: () => [] });
    const response = await h.run('mcp clients');
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toMatch(/no OAuth clients are registered/);
  });

  it('prints one line per client with id, name, source, date and redirect count', async () => {
    const h = harness({ mcpClients: () => [client()] });
    const response = await h.run('mcp clients');
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('cli_abcdef0123456789');
    expect(response.ok && response.text).toContain('test client');
    expect(response.ok && response.text).toContain('dynamic');
    expect(response.ok && response.text).toContain(new Date(NOW - 86_400_000).toISOString());
    expect(response.ok && response.text).toContain('1 redirect uri(s)');
  });

  it('returns the array as data', async () => {
    const h = harness({ mcpClients: () => [client()] });
    const response = await h.run('mcp clients');
    expect(response.ok && response.data).toMatchObject([
      { clientId: 'cli_abcdef0123456789', redirectUriCount: 1 },
    ]);
  });

  it('never asks for --confirm, since nothing changes', async () => {
    const h = harness({ mcpClients: () => [] });
    const response = await h.run('mcp clients', {}, false);
    expect(response.ok).toBe(true);
  });
});

describe('mcp tokens', () => {
  it('says so plainly when there are no tokens', async () => {
    const h = harness({ mcpTokens: () => [] });
    const response = await h.run('mcp tokens');
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toMatch(/no tokens/);
  });

  it('sorts live tokens first, then newest first', async () => {
    const revoked = token({ tokenId: 'tok_aaa', revokedAt: NOW - 1_000, createdAt: NOW - 100 });
    const older = token({ tokenId: 'tok_bbb', createdAt: NOW - 2_000 });
    const newer = token({ tokenId: 'tok_ccc', createdAt: NOW - 500 });
    const h = harness({ mcpTokens: () => [revoked, older, newer] });
    const response = await h.run('mcp tokens');
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const lines = response.text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('tok_ccc');
    expect(lines[1]).toContain('tok_bbb');
    expect(lines[2]).toContain('tok_aaa');
  });

  it('renders one single line per token with kind, client, account, expiry and state', async () => {
    const h = harness({
      mcpTokens: () => [
        token(),
        token({
          tokenId: 'tok_ffffffffffffffffffffffffffffffff',
          kind: 'refresh',
          revokedAt: NOW - 1_000,
          lastUsedAt: NOW - 2_000,
        }),
      ],
    });
    const response = await h.run('mcp tokens');
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const lines = response.text.split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^[^\n]*$/m);
    }
    expect(lines[0]).toContain('access');
    expect(lines[0]).toContain('client cli_abcdef0123456789');
    expect(lines[0]).toContain('account acct_0123456789abcdef0123456789abcdef');
    expect(lines[0]).toContain('never');
    expect(lines[0]).toContain('live');
    expect(lines[1]).toContain('refresh');
    expect(lines[1]).toContain(`revoked ${new Date(NOW - 1_000).toISOString()}`);
  });

  it('prints no token value — no line contains a 43-character base64url run', async () => {
    // A minted token value is 32 random bytes as base64url: exactly 43
    // characters. The rows carry only ids and hashes, so if a value ever
    // reached this renderer this pattern would catch it.
    const h = harness({ mcpTokens: () => [token(), token({ tokenId: 'tok_bbb' })] });
    const response = await h.run('mcp tokens');
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    for (const line of response.text.split('\n')) {
      expect(line).not.toMatch(/[A-Za-z0-9_-]{43}/);
    }
    expect(JSON.stringify(response.data)).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it('never asks for --confirm, since nothing changes', async () => {
    const h = harness({ mcpTokens: () => [] });
    const response = await h.run('mcp tokens', {}, false);
    expect(response.ok).toBe(true);
  });
});

describe('mcp revoke', () => {
  it('refuses without --confirm before argument validation', async () => {
    const h = harness({ mcpRevokeToken: () => 1 });
    // A deliberately invalid argument: the error must still be needs-confirm,
    // because the dispatcher checks confirmation before running validation.
    const response = await h.run('mcp revoke', { tokenId: 123 }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
  });

  it('revokes a live token and audits the write', async () => {
    const h = harness({ mcpRevokeToken: () => 1 });
    const response = await h.run('mcp revoke', { tokenId: 'tok_abc' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe(
      'revoked token tok_abc and 1 token(s) in its lineage',
    );
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.token.revoked',
      subjectType: 'instance',
      subjectId: undefined,
      before: { tokenId: 'tok_abc', live: true },
      after: { tokenId: 'tok_abc', live: false, tokensRevoked: 1 },
    });
  });

  it('reports the lineage count when the sibling is live, and audits it', async () => {
    // The port killed the access token and its live sibling refresh token:
    // the text and the audit row carry how many rows went, not just the id.
    const h = harness({ mcpRevokeToken: () => 2 });
    const response = await h.run('mcp revoke', { tokenId: 'tok_abc' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe(
      'revoked token tok_abc and 2 token(s) in its lineage',
    );
    expect(response.ok && response.data).toMatchObject({ tokenId: 'tok_abc', tokensRevoked: 2 });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.token.revoked',
      after: { tokenId: 'tok_abc', tokensRevoked: 2 },
    });
  });

  it('throws on an unknown id and produces no audit row', async () => {
    const h = harness({ mcpRevokeToken: () => undefined });
    const response = await h.run('mcp revoke', { tokenId: 'tok_nope' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('no such token tok_nope');
    expect(h.audit).toHaveLength(0);
  });
});

describe('mcp revoke-client', () => {
  it('refuses without --confirm before argument validation', async () => {
    const h = harness({ mcpRevokeClient: () => 2 });
    const response = await h.run('mcp revoke-client', { clientId: 123 }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
  });

  it('removes the client, reports how many tokens went with it, and audits', async () => {
    const h = harness({ mcpRevokeClient: () => 2 });
    const response = await h.run('mcp revoke-client', { clientId: 'cli_abc' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe('removed client cli_abc and revoked 2 token(s)');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.client.revoked',
      after: { clientId: 'cli_abc', tokensRevoked: 2 },
    });
  });

  it('throws on an unknown client and produces no audit row', async () => {
    const h = harness({ mcpRevokeClient: () => undefined });
    const response = await h.run('mcp revoke-client', { clientId: 'cli_nope' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('cli_nope');
    expect(h.audit).toHaveLength(0);
  });
});

const connection = (over: Partial<OpsMcpConnection> = {}): OpsMcpConnection => ({
  connectionId: 'tok_root',
  accountId: 'acct_1',
  accountUsername: 'racerbot-club-claude',
  clientId: 'cli_abc',
  clientName: 'Claude',
  scopes: ['bananasaurs:read', 'bananasaurs:send', 'bananasaurs:tasks'],
  createdAt: NOW - 86_400_000,
  lastUsedAt: null,
  status: 'connected',
  tokenCount: 12,
  ...over,
});

describe('mcp connections (ADR 0130)', () => {
  it('prints one line per connection with account, app, plain scope labels and counts', async () => {
    const h = harness({
      mcpConnections: () => [
        connection(),
        connection({
          connectionId: 'tok_old',
          status: 'revoked',
          lastUsedAt: NOW - 1000,
          accountUsername: null,
        }),
      ],
    });
    const response = await h.run('mcp connections', {}, false);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const lines = response.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `tok_root  connected  account racerbot-club-claude  app "Claude" (cli_abc)  ` +
        `can Read, Post, Tasks  since ${new Date(NOW - 86_400_000).toISOString()}  ` +
        `last used never  12 token rows`,
    );
    expect(lines[1]).toContain('last used ' + new Date(NOW - 1000).toISOString());
    expect(lines[1]).toContain('account (deleted)');
  });

  it('says so when there are none', async () => {
    const h = harness({ mcpConnections: () => [] });
    const response = await h.run('mcp connections', {}, false);
    expect(response.ok && response.text).toBe('no connections');
  });

  it('mcp tokens filters by --connection', async () => {
    const h = harness({
      mcpTokens: () => [
        token({ tokenId: 'tok_a', connectionId: 'c1' }),
        token({ tokenId: 'tok_b', connectionId: 'c2' }),
      ],
    });
    const response = await h.run('mcp tokens', { connection: 'c2' }, false);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.text).toContain('tok_b');
    expect(response.text).not.toContain('tok_a');
  });

  it('mcp tokens caps at the newest 100 rows and 1,000 rows still fit the socket line', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      token({
        tokenId: `tok_${String(i).padStart(32, '0')}`,
        createdAt: NOW - i * 1000,
        lastUsedAt: NOW - i,
      }),
    );
    const h = harness({ mcpTokens: () => rows });
    const response = await h.run('mcp tokens', {}, false);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const lines = response.text.split('\n');
    expect(lines).toHaveLength(101);
    expect(lines[100]).toBe('…and 900 more; filter with --connection');
    expect(lines[0]).toContain('tok_00000000000000000000000000000000');
    expect(Buffer.byteLength(JSON.stringify(response)) + 1).toBeLessThan(OPS_MAX_LINE_BYTES);
  });
});

describe('mcp disconnect / delete-connection / delete-token / cleanup (ADR 0130)', () => {
  it('all are writes, registered, and refuse without --confirm', async () => {
    for (const name of [
      'mcp disconnect',
      'mcp delete-connection',
      'mcp delete-token',
      'mcp cleanup',
    ]) {
      expect(OPERATOR_COMMANDS.find((c) => c.name === name)?.write).toBe(true);
    }
    const h = harness({ mcpCleanup: () => ({ tokens: 1, clients: 0 }) });
    const response = await h.run('mcp cleanup', {}, false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(h.audit).toHaveLength(0);
  });

  it('disconnect revokes and audits ids and counts only', async () => {
    const h = harness({ mcpDisconnect: () => 3 });
    const response = await h.run('mcp disconnect', { connectionId: 'tok_root' });
    expect(response.ok).toBe(true);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.connection.revoked',
      subjectType: 'instance',
      after: { connectionId: 'tok_root', tokensRevoked: 3 },
    });
  });

  it('delete-connection audits and reports counts; unknown id throws with no audit', async () => {
    const h = harness({
      mcpDeleteConnection: (id) => (id === 'tok_root' ? { revoked: 2, deleted: 12 } : undefined),
    });
    const ok = await h.run('mcp delete-connection', { connectionId: 'tok_root' });
    expect(ok.ok).toBe(true);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.connection.deleted',
      after: { connectionId: 'tok_root', tokensRevoked: 2, tokensDeleted: 12 },
    });
    const bad = await h.run('mcp delete-connection', { connectionId: 'nope' });
    expect(bad.ok).toBe(false);
    expect(h.audit).toHaveLength(1);
  });

  it('delete-token audits', async () => {
    const h = harness({ mcpDeleteToken: () => ({ revoked: 1, deleted: 1 }) });
    const response = await h.run('mcp delete-token', { tokenId: 'tok_a' });
    expect(response.ok).toBe(true);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.token.deleted',
      after: { tokenId: 'tok_a', tokensRevoked: 1, tokensDeleted: 1 },
    });
  });

  it('cleanup audits the counts', async () => {
    const h = harness({ mcpCleanup: () => ({ tokens: 400, clients: 2 }) });
    const response = await h.run('mcp cleanup');
    expect(response.ok && response.text).toContain('400');
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.tokens.cleaned',
      after: { tokensDeleted: 400, clientsDeleted: 2 },
    });
  });
});
