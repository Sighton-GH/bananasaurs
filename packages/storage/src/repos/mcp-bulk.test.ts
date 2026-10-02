import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import {
  consumePreview,
  createPreview,
  findPreviewById,
  findPreviewByToken,
  sumConsumedMembers,
} from './mcp-bulk.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const ROLE = '333333333333333333';

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild-a', now: 0 });
  upsertGuild(b, { name: 'guild-b', now: 0 });
});

const sha256 = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

const create = (
  scope: GuildScope,
  overrides: {
    previewId?: string;
    token?: string;
    actionKind?: 'add' | 'remove';
    roleId?: string;
    argsHash?: string;
    memberIds?: string[];
    createdAt?: number;
    expiresAt?: number;
  } = {},
): void =>
  createPreview(scope, {
    previewId: overrides.previewId ?? 'preview-1',
    token: overrides.token ?? 'token-1',
    actionKind: overrides.actionKind ?? 'add',
    roleId: overrides.roleId ?? ROLE,
    argsHash: overrides.argsHash ?? 'args-1',
    memberIds: overrides.memberIds ?? ['444444444444444444', '555555555555555555'],
    createdAt: overrides.createdAt ?? 1000,
    expiresAt: overrides.expiresAt ?? 2000,
  });

describe('createPreview / findPreviewByToken', () => {
  it('creates then finds by token, with the member set round-tripping', () => {
    create(a);
    expect(findPreviewByToken(a, 'missing')).toBeUndefined();
    expect(findPreviewByToken(a, 'token-1')).toMatchObject({
      previewId: 'preview-1',
      actionKind: 'add',
      roleId: ROLE,
      argsHash: 'args-1',
      memberIds: ['444444444444444444', '555555555555555555'],
      createdAt: 1000,
      expiresAt: 2000,
      consumedAt: undefined,
      jobId: undefined,
    });
  });

  it('stores only the sha256 of the token, never the token itself', () => {
    create(a, { token: 'token-1' });
    const row = t.raw
      .prepare(`SELECT token_hash AS tokenHash FROM mcp_bulk_previews WHERE guild_id = ?`)
      .get(GUILD_A) as { tokenHash: string };
    expect(row.tokenHash).toBe(sha256('token-1'));
    expect(row.tokenHash).not.toContain('token-1');
    const dump = JSON.stringify(
      t.raw.prepare(`SELECT * FROM mcp_bulk_previews WHERE guild_id = ?`).all(GUILD_A),
    );
    expect(dump).not.toContain('token-1');
  });

  it('a token from guild A is not found in guild B', () => {
    create(a);
    expect(findPreviewByToken(b, 'token-1')).toBeUndefined();
  });

  it('the same preview id in guild B is a separate row', () => {
    create(a, { token: 'token-a' });
    create(b, { token: 'token-b' });
    expect(findPreviewByToken(a, 'token-a')?.previewId).toBe('preview-1');
    expect(findPreviewByToken(b, 'token-b')?.previewId).toBe('preview-1');
    expect(findPreviewByToken(a, 'token-b')).toBeUndefined();
  });

  it('two previews never share a token hash, even with different preview ids', () => {
    create(a, { previewId: 'preview-1', token: 'token-same' });
    expect(() => create(a, { previewId: 'preview-2', token: 'token-same' })).toThrow();
    expect(findPreviewByToken(a, 'token-same')?.previewId).toBe('preview-1');
  });
});

describe('consumePreview', () => {
  it('succeeds once, records the job and the time, then fails', () => {
    create(a);
    expect(consumePreview(a, 'preview-1', 7, 1500)).toBe(true);
    expect(findPreviewByToken(a, 'token-1')).toMatchObject({
      consumedAt: 1500,
      jobId: 7,
    });
    expect(consumePreview(a, 'preview-1', 8, 1500)).toBe(false);
    expect(findPreviewByToken(a, 'token-1')?.jobId).toBe(7);
  });

  it('fails when expired and leaves the row unconsumed', () => {
    create(a, { createdAt: 1000, expiresAt: 1500 });
    expect(consumePreview(a, 'preview-1', 7, 1500)).toBe(false);
    expect(consumePreview(a, 'preview-1', 7, 1600)).toBe(false);
    expect(findPreviewByToken(a, 'token-1')?.consumedAt).toBeUndefined();
  });

  it('fails for an unknown preview id', () => {
    expect(consumePreview(a, 'preview-missing', 7, 1500)).toBe(false);
  });

  it('a consume in guild B does not touch guild A’s preview', () => {
    create(a, { token: 'token-a' });
    create(b, { token: 'token-b' });
    expect(consumePreview(b, 'preview-1', 7, 1500)).toBe(true);
    expect(findPreviewByToken(a, 'token-a')?.consumedAt).toBeUndefined();
    expect(consumePreview(a, 'preview-1', 7, 1500)).toBe(true);
  });
});

describe('findPreviewById', () => {
  it('loads the preview by id in its own guild only', () => {
    create(a, { previewId: 'preview-9', memberIds: ['666666666666666666'] });
    expect(findPreviewById(a, 'preview-9')).toMatchObject({
      previewId: 'preview-9',
      actionKind: 'add',
      roleId: ROLE,
      memberIds: ['666666666666666666'],
    });
    expect(findPreviewById(a, 'preview-missing')).toBeUndefined();
    expect(findPreviewById(b, 'preview-9')).toBeUndefined();
  });

  it('sees consumed rows too, with the job id', () => {
    create(a);
    expect(consumePreview(a, 'preview-1', 7, 1500)).toBe(true);
    expect(findPreviewById(a, 'preview-1')).toMatchObject({ consumedAt: 1500, jobId: 7 });
  });
});

describe('sumConsumedMembers', () => {
  it('sums the member counts of previews consumed since the window bound', () => {
    const live = { createdAt: 1000, expiresAt: 3000 };
    create(a, {
      previewId: 'p1',
      token: 't1',
      memberIds: ['1'.repeat(18), '2'.repeat(18)],
      ...live,
    });
    create(a, { previewId: 'p2', token: 't2', memberIds: ['3'.repeat(18)], ...live });
    create(a, { previewId: 'p3', token: 't3', memberIds: ['4'.repeat(18)], ...live });
    expect(consumePreview(a, 'p1', 7, 1500)).toBe(true);
    expect(consumePreview(a, 'p2', 8, 2500)).toBe(true);
    // p3 stays unconsumed: never counted.
    expect(sumConsumedMembers(a, 1000)).toEqual({ previewCount: 2, memberTotal: 3 });
    expect(sumConsumedMembers(a, 2000)).toEqual({ previewCount: 1, memberTotal: 1 });
    expect(sumConsumedMembers(a, 2500)).toEqual({ previewCount: 1, memberTotal: 1 });
    expect(sumConsumedMembers(a, 2501)).toEqual({ previewCount: 0, memberTotal: 0 });
  });

  it('is guild-scoped: guild B’s consumption never counts for guild A', () => {
    create(a, { previewId: 'p1', token: 't1', memberIds: ['1'.repeat(18)] });
    create(b, { previewId: 'p1', token: 't1', memberIds: ['2'.repeat(18), '3'.repeat(18)] });
    expect(consumePreview(b, 'p1', 9, 1500)).toBe(true);
    expect(sumConsumedMembers(a, 1000)).toEqual({ previewCount: 0, memberTotal: 0 });
    expect(sumConsumedMembers(b, 1000)).toEqual({ previewCount: 1, memberTotal: 2 });
    expect(consumePreview(a, 'p1', 7, 1500)).toBe(true);
    expect(sumConsumedMembers(a, 1000)).toEqual({ previewCount: 1, memberTotal: 1 });
  });
});
