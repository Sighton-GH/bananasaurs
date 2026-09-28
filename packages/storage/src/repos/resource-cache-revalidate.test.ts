import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, type Chunk } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import { putResource } from './assistant.js';
import {
  computeDocId,
  getDocumentByUrl,
  outline,
  replaceChunks,
  upsertDocument,
} from './resource-cache.js';

const GUILD_A = parseGuildId('111111111111111111');

let t: MigratedTestDatabase;
let a: GuildScope;

const seedResource = (scope: GuildScope, id: string, url: string, title = 'A resource') =>
  putResource(scope, {
    id,
    guildId: scope.guildId,
    title,
    url,
    kind: 'website',
    enabled: true,
    reviewedAt: new Date(0).toISOString(),
  });

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  upsertGuild(a, { name: 'guild-a', now: 0 });
});

describe('migration 0048 resets resource cache validators', () => {
  it('clears etag, last_modified and content_hash while keeping chunks', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      etag: '"abc"',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      contentHash: 'deadbeef',
      fetchedAt: 1000,
      bytes: 42,
      status: 'ok',
    });
    const chunk: Chunk = {
      ordinal: 0,
      headingPath: 'Guide',
      lineStart: 1,
      lineEnd: 1,
      text: 'hello world',
    };
    replaceChunks(a, docId, 'res-1', [chunk]);
    expect(outline(a, docId)).toHaveLength(1);

    const sql = readFileSync(
      fileURLToPath(
        new URL('../../../../drizzle/0048_reset_resource_cache_validators.sql', import.meta.url),
      ),
      'utf8',
    );
    t.raw.exec(sql);

    const doc = getDocumentByUrl(a, 'https://example.com/guide');
    expect(doc?.etag).toBeUndefined();
    expect(doc?.lastModified).toBeUndefined();
    expect(doc?.contentHash).toBe('');
    expect(outline(a, docId)).toHaveLength(1);

    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../drizzle/meta/_journal.json', import.meta.url)),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.some((e) => e.tag === '0048_reset_resource_cache_validators')).toBe(
      true,
    );
  });
});
