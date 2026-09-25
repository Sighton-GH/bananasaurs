import { createHash } from 'node:crypto';
import { chunkDocument, type Chunk, type ClubResource } from '@bananasaurs/core';
import { computeDocId, type GuildScope } from '@bananasaurs/storage';
import type { ConditionalResourceFetchResult, ResourceConditional } from './resource-fetcher.js';

/**
 * The resource-cache refresh logic (ADR 0073): fetches a reviewed resource
 * (or, for a note, reads its own text) and writes the persistent cache —
 * conditional requests, re-chunk only on content change, errors keep the old
 * chunks. Deliberately storage-repo-free beyond the injected `repo`: `guild.ts`
 * wires this to the real `resourceCacheRepo` and the real
 * `ReviewedResourceFetcher`, but nothing here imports either, so a unit test
 * can inject fakes for both without a database (the ruling's "injected
 * fetcher + repo + clock").
 */

export interface ResourceRefreshFetcher {
  fetch(url: string, conditional?: ResourceConditional): Promise<ConditionalResourceFetchResult>;
}

export interface StoredDocumentLike {
  readonly docId: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly path: string;
  readonly status: 'ok' | 'error';
}

export interface UpsertDocumentInput {
  readonly resourceId: string;
  readonly docId: string;
  readonly url: string;
  readonly path: string;
  readonly title: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly contentHash: string;
  readonly fetchedAt: number;
  readonly bytes: number;
  readonly status: 'ok' | 'error';
  readonly error?: string;
}

export interface ResourceRefreshRepo {
  getDocumentByUrl(scope: GuildScope, url: string): StoredDocumentLike | undefined;
  upsertDocument(scope: GuildScope, d: UpsertDocumentInput): void;
  replaceChunks(
    scope: GuildScope,
    docId: string,
    resourceId: string,
    chunks: readonly Chunk[],
  ): void;
  deleteStaleDocuments(scope: GuildScope, resourceId: string, keepDocId: string): void;
}

export interface ResourceRefreshDeps {
  readonly fetcher: ResourceRefreshFetcher;
  readonly repo: ResourceRefreshRepo;
  readonly now: () => number;
}

export type ResourceRefreshOutcome = 'ok' | 'not-modified' | 'error' | 'skipped';

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const pathOfUrl = (url: string): string => {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return '/';
  }
};

/**
 * One resource, refreshed. `discord-channel` is skipped entirely — never
 * fetched, never chunked (that surface is Task 16's tool territory, not this
 * cache). `note` is skipped as far as *fetching* goes, but its own text (the
 * resource row's `url` field — the one free-text field a note has, since it
 * carries no real URL) is chunked directly, no network involved. Every other
 * kind, including `repository` (ADR 0073 ruling: a repository resource is
 * fetched like a website, its URL page — GitHub-specific handling is Task
 * 17's), goes through the conditional fetcher.
 */
export async function refreshResource(
  scope: GuildScope,
  resource: ClubResource,
  deps: ResourceRefreshDeps,
): Promise<ResourceRefreshOutcome> {
  // Task 17: GitHub kinds refresh through `github-refresh.ts` (routed by the
  // `resource_refresh` job) — never here, so a GitHub URL can never be
  // fetched website-style by accident.
  if (resource.kind === 'github-org' || resource.kind === 'github-repo')
    throw new Error('GitHub resources refresh through refreshGithubResource, not refreshResource.');
  if (resource.kind === 'discord-channel') return 'skipped';

  const fetchedAt = deps.now();

  if (resource.kind === 'note') {
    const text = resource.url;
    const docId = computeDocId(resource.url);
    const contentHash = sha256Hex(text);
    const existing = deps.repo.getDocumentByUrl(scope, resource.url);
    if (
      existing !== undefined &&
      existing.status === 'ok' &&
      existing.contentHash === contentHash
    ) {
      deps.repo.upsertDocument(scope, {
        resourceId: resource.id,
        docId,
        url: resource.url,
        path: existing.path,
        title: resource.title,
        contentHash,
        fetchedAt,
        bytes: existing.bytes,
        status: 'ok',
      });
      // The note's text is its URL, so an edit is a new doc id — drop the
      // document row the previous text hashed to, if it is still cached.
      deps.repo.deleteStaleDocuments(scope, resource.id, docId);
      return 'not-modified';
    }
    const path = `${resource.title || 'note'}.txt`;
    const chunks = chunkDocument({ text, mediaType: 'text/plain', path });
    deps.repo.upsertDocument(scope, {
      resourceId: resource.id,
      docId,
      url: resource.url,
      path,
      title: resource.title,
      contentHash,
      fetchedAt,
      bytes: Buffer.byteLength(text, 'utf8'),
      status: 'ok',
    });
    deps.repo.deleteStaleDocuments(scope, resource.id, docId);
    deps.repo.replaceChunks(scope, docId, resource.id, chunks);
    return 'ok';
  }

  // website / document / repository: a conditional fetch against the cache.
  const docId = computeDocId(resource.url);
  const existing = deps.repo.getDocumentByUrl(scope, resource.url);
  const conditional: ResourceConditional = {
    ...(existing?.etag !== undefined ? { etag: existing.etag } : {}),
    ...(existing?.lastModified !== undefined ? { lastModified: existing.lastModified } : {}),
  };
  const result = await deps.fetcher.fetch(resource.url, conditional);
  const path = pathOfUrl(resource.url);

  if (result.ok && result.notModified === true) {
    if (existing !== undefined) {
      deps.repo.upsertDocument(scope, {
        resourceId: resource.id,
        docId,
        url: resource.url,
        path: existing.path,
        title: resource.title,
        ...(existing.etag !== undefined ? { etag: existing.etag } : {}),
        ...(existing.lastModified !== undefined ? { lastModified: existing.lastModified } : {}),
        contentHash: existing.contentHash,
        fetchedAt,
        bytes: existing.bytes,
        status: 'ok',
      });
      deps.repo.deleteStaleDocuments(scope, resource.id, docId);
    }
    return 'not-modified';
  }

  if (!result.ok) {
    deps.repo.upsertDocument(scope, {
      resourceId: resource.id,
      docId,
      url: resource.url,
      path: existing?.path ?? path,
      title: resource.title,
      ...(existing?.etag !== undefined ? { etag: existing.etag } : {}),
      ...(existing?.lastModified !== undefined ? { lastModified: existing.lastModified } : {}),
      contentHash: existing?.contentHash ?? '',
      fetchedAt,
      bytes: existing?.bytes ?? 0,
      status: 'error',
      error: result.message,
    });
    // The old chunks are left exactly as they were — no replaceChunks call —
    // but documents cached under a previous URL for this resource still go.
    deps.repo.deleteStaleDocuments(scope, resource.id, docId);
    return 'error';
  }

  const text = result.evidence.text;
  const contentHash = sha256Hex(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  const docInput: UpsertDocumentInput = {
    resourceId: resource.id,
    docId,
    url: resource.url,
    path,
    title: resource.title,
    ...(result.etag !== undefined ? { etag: result.etag } : {}),
    ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
    contentHash,
    fetchedAt,
    bytes,
    status: 'ok',
  };
  deps.repo.upsertDocument(scope, docInput);
  // The URL is editable and the doc id hashes it, so a resource saved with
  // a new URL arrives here with no `existing` row — without this the
  // previous URL's document and chunks would stay searchable under the same
  // resource id, and `resourceFreshness` would return several unordered rows
  // for one resource.
  deps.repo.deleteStaleDocuments(scope, resource.id, docId);
  if (existing !== undefined && existing.status === 'ok' && existing.contentHash === contentHash) {
    // The server didn't say 304, but the content is byte-identical to what
    // is already chunked — no point re-chunking unchanged text.
    return 'not-modified';
  }
  deps.repo.replaceChunks(
    scope,
    docId,
    resource.id,
    chunkDocument({ text, mediaType: result.evidence.mediaType, path }),
  );
  return 'ok';
}

/** Every resource in `resources`, refreshed in turn. Independent failures — one resource's fetch error never stops the rest. */
export async function refreshAll(
  scope: GuildScope,
  resources: readonly ClubResource[],
  deps: ResourceRefreshDeps,
): Promise<readonly { readonly resourceId: string; readonly outcome: ResourceRefreshOutcome }[]> {
  const results: { resourceId: string; outcome: ResourceRefreshOutcome }[] = [];
  for (const resource of resources) {
    const outcome = await refreshResource(scope, resource, deps);
    results.push({ resourceId: resource.id, outcome });
  }
  return results;
}
