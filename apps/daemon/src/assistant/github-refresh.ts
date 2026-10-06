import { createHash } from 'node:crypto';
import {
  chunkDocument,
  githubChildId,
  parseGitHubUrl,
  rawGitHubUrl,
  selectRepoFiles,
  type Chunk,
  type ClubResource,
  type ResourceMeta,
} from '@bananasaurs/core';
import { computeDocId, type GuildScope } from '@bananasaurs/storage';
import { GitHubError, type GitHubClient } from './github-client.js';
import type { ConditionalResourceFetchResult, ResourceConditional } from './resource-fetcher.js';
import type {
  ResourceRefreshFetcher,
  ResourceRefreshOutcome,
  UpsertDocumentInput,
} from './resource-refresh.js';

/**
 * The GitHub refresh path (Task 17, ruling "refresh"), split out of
 * `resource-refresh.ts`: `github-org` resources discover/disable child
 * `github-repo` resources, and `github-repo` resources cache one document per
 * selected file. The hourly `resource_refresh` job routes GitHub kinds here
 * (`apps/daemon/src/jobs/resource-refresh.ts`); `refreshResource` refuses
 * them, so a GitHub URL can never be fetched website-style by accident.
 *
 * Everything is injected (`GithubRefreshDeps`: client + fetcher + store +
 * cache + clock) so unit tests never touch the network. The token travels
 * only inside the GitHub client (the `Authorization` header); nothing here
 * logs it, throws it, or writes it to an audit row — fetch details are
 * counts and sentences, never credentials.
 */

/** The stored fields the refresh reads back: validators for conditional requests and hashes for change detection. */
export interface StoredDoc {
  readonly docId: string;
  readonly url: string;
  readonly path: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly status: 'ok' | 'error';
}

export interface GithubResourceStore {
  listResources(scope: GuildScope): readonly ClubResource[];
  putResource(scope: GuildScope, input: ClubResource): void;
  setResourceEnabled(
    scope: GuildScope,
    id: string,
    input: { readonly enabled: boolean; readonly meta: ResourceMeta | undefined },
  ): boolean;
  recordResourceFetch(
    scope: GuildScope,
    id: string,
    input: {
      readonly status: 'ok' | 'failed' | 'blocked';
      readonly at: number;
      readonly detail: string;
    },
  ): void;
}

export interface GithubCacheStore {
  getDocumentByUrl(scope: GuildScope, url: string): StoredDoc | undefined;
  listDocuments(scope: GuildScope, resourceId: string): readonly StoredDoc[];
  upsertDocument(scope: GuildScope, d: UpsertDocumentInput): void;
  replaceChunks(
    scope: GuildScope,
    docId: string,
    resourceId: string,
    chunks: readonly Chunk[],
  ): void;
  deleteDocument(scope: GuildScope, docId: string): void;
}

export interface GithubRefreshDeps {
  readonly client: GitHubClient;
  readonly fetcher: ResourceRefreshFetcher;
  readonly store: GithubResourceStore;
  readonly cache: GithubCacheStore;
  readonly now: () => number;
}

export type GithubRefreshOutcome = ResourceRefreshOutcome;

/** Unauthenticated orgs re-list at most once per 24 hours (the ruling). */
const ORG_RELIST_MIN_MS = 24 * 3_600_000;

const rateLimitDetail = (error: GitHubError): string =>
  error.resetAt === undefined
    ? 'GitHub rate limit reached; will retry later.'
    : `GitHub rate limit reached; will retry after ${new Date(error.resetAt).toISOString()}.`;

/** Sentences and counts only — a GitHub message never carries the token (hard rule 4). */
const failDetail = (error: unknown): string => {
  if (error instanceof GitHubError && error.kind === 'rate-limited') return rateLimitDetail(error);
  if (error instanceof Error) return error.message;
  return 'GitHub refresh failed.';
};

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const fail = (
  scope: GuildScope,
  resource: ClubResource,
  deps: GithubRefreshDeps,
  detail: string,
): GithubRefreshOutcome => {
  deps.store.recordResourceFetch(scope, resource.id, {
    status: 'failed',
    at: deps.now(),
    detail,
  });
  return 'error';
};

const orgOwnerOf = (resource: ClubResource): string | undefined => {
  if (resource.meta?.owner !== undefined) return resource.meta.owner;
  const target = parseGitHubUrl(resource.url);
  return target === undefined ? undefined : target.owner;
};

const repoNameOf = (resource: ClubResource): string | undefined => {
  if (resource.meta?.repo !== undefined) return resource.meta.repo;
  const target = parseGitHubUrl(resource.url);
  return target !== undefined && target.kind === 'repo' ? target.repo : undefined;
};

const repoOwnerOf = (resource: ClubResource): string | undefined => {
  if (resource.meta?.owner !== undefined) return resource.meta.owner;
  const target = parseGitHubUrl(resource.url);
  return target !== undefined && target.kind === 'repo' ? target.owner : undefined;
};

/**
 * An org refresh: re-lists every repository the token can see (forks,
 * archived and private alike, ADR 0084) and reconciles the child
 * `github-repo` resources — missing ones are created (enabled,
 * `autoDiscovered`), auto-discovered ones that left the organisation are
 * disabled, never deleted. A child the owner turned off
 * (`meta.disabledByOwner`) is never re-enabled here. The owner's own
 * hand-picked children are left alone.
 */
export async function refreshGithubOrg(
  scope: GuildScope,
  resource: ClubResource,
  deps: GithubRefreshDeps,
): Promise<GithubRefreshOutcome> {
  const owner = orgOwnerOf(resource);
  if (owner === undefined)
    return fail(scope, resource, deps, 'This is not a GitHub organisation URL.');

  if (
    !deps.client.authenticated &&
    resource.lastFetchedAt !== undefined &&
    deps.now() - resource.lastFetchedAt < ORG_RELIST_MIN_MS
  )
    return 'skipped';

  let summaries: readonly {
    readonly name: string;
    readonly fork: boolean;
    readonly archived: boolean;
    readonly private: boolean;
    readonly defaultBranch: string;
  }[];
  try {
    summaries = (await deps.client.listOrgRepos(owner)).repos;
  } catch (error) {
    return fail(scope, resource, deps, failDetail(error));
  }

  // Every repository the listing returns (ADR 0084): forks, archived and
  // private alike. Old `includeForks`/`includeArchived` meta values are
  // ignored here; the fields stay in the schema so old rows still parse.
  const eligible = summaries;
  const eligibleNames = new Set(eligible.map((s) => s.name.toLowerCase()));

  const childKey = (child: ClubResource): string | undefined => {
    const name = child.meta?.repo ?? repoNameOf(child);
    if (name !== undefined) return name.toLowerCase();
    const slash = child.title.lastIndexOf('/');
    return slash < 0 ? child.title.toLowerCase() : child.title.slice(slash + 1).toLowerCase();
  };
  const children = deps.store.listResources(scope).filter((r) => r.parentId === resource.id);
  const byName = new Map<string, ClubResource>();
  for (const child of children) {
    const key = childKey(child);
    if (key !== undefined && !byName.has(key)) byName.set(key, child);
  }

  for (const summary of eligible) {
    const existing = byName.get(summary.name.toLowerCase());
    if (existing === undefined) {
      deps.store.putResource(scope, {
        id: githubChildId(owner, summary.name),
        guildId: scope.guildId,
        title: `${owner}/${summary.name}`,
        url: `https://github.com/${owner}/${summary.name}`,
        kind: 'github-repo',
        enabled: true,
        reviewedAt: new Date(deps.now()).toISOString(),
        parentId: resource.id,
        meta: {
          owner,
          repo: summary.name,
          branch: summary.defaultBranch,
          autoDiscovered: true,
          ...(summary.private ? { private: true as const } : {}),
        },
      });
    } else if (!existing.enabled && existing.meta?.disabledByOwner !== true) {
      // A repository that left and came back is usable again — unless the
      // owner turned it off, in which case it stays off (ADR 0084). Nothing
      // else about an existing row is touched here; the owner may have
      // edited its title, URL or branch by hand.
      deps.store.setResourceEnabled(scope, existing.id, { enabled: true, meta: existing.meta });
    }
  }

  for (const child of children) {
    const key = childKey(child);
    if (
      child.meta?.autoDiscovered === true &&
      child.enabled &&
      (key === undefined || !eligibleNames.has(key))
    )
      deps.store.setResourceEnabled(scope, child.id, { enabled: false, meta: child.meta });
  }

  deps.store.recordResourceFetch(scope, resource.id, {
    status: 'ok',
    at: deps.now(),
    detail: `GitHub organisation refreshed: ${String(eligible.length)} repositor${eligible.length === 1 ? 'y' : 'ies'}.`,
  });
  return 'ok';
}

interface SelectedFile {
  readonly path: string;
  readonly url: string;
}

/**
 * A repo refresh. Authenticated: `getRepo` + `listTree` + `selectRepoFiles`
 * (with `meta.include` when set), one cached document per selected file with
 * the file path as its title. Unauthenticated: README only, no `listTree`
 * (and no `getRepo` when the branch is already known) — except a
 * `meta.private` repository, which is turned off with no fetch at all, since
 * no token can read it. Rate limits record
 * the retry sentence and keep the old chunks; files the selection no longer
 * names have their documents deleted.
 */
export async function refreshGithubRepo(
  scope: GuildScope,
  resource: ClubResource,
  deps: GithubRefreshDeps,
): Promise<GithubRefreshOutcome> {
  const owner = repoOwnerOf(resource);
  const repo = repoNameOf(resource);
  if (owner === undefined || repo === undefined)
    return fail(scope, resource, deps, 'This is not a GitHub repository URL.');

  const disableNotFound = (target: ClubResource): GithubRefreshOutcome => {
    if (target.enabled)
      deps.store.setResourceEnabled(scope, target.id, { enabled: false, meta: target.meta });
    return fail(
      scope,
      target,
      deps,
      "GitHub can't find this repository, or the token can't read it. It has been turned off, so its cached text is no longer searched.",
    );
  };

  const syncPrivateMeta = (base: ClubResource, isPrivate: boolean): ClubResource => {
    if (isPrivate === (base.meta?.private === true)) return base;
    const rest: Partial<ResourceMeta> = { ...(base.meta ?? {}) };
    delete rest.private;
    const next: ClubResource = {
      ...base,
      meta: isPrivate ? { ...rest, owner, private: true } : { ...rest, owner },
    };
    deps.store.setResourceEnabled(scope, base.id, { enabled: base.enabled, meta: next.meta });
    return next;
  };

  let current = resource;
  let ref = resource.meta?.branch;
  let files: readonly SelectedFile[];
  let isPrivate = false;
  let branch = '';
  if (deps.client.authenticated) {
    let defaultBranch: string;
    try {
      const detail = await deps.client.getRepo(owner, repo);
      current = syncPrivateMeta(current, detail.private);
      isPrivate = detail.private;
      defaultBranch = detail.defaultBranch;
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not-found')
        return disableNotFound(resource);
      return fail(scope, resource, deps, failDetail(error));
    }
    branch = ref ?? defaultBranch;
    let entries: readonly {
      readonly path: string;
      readonly type: 'blob' | 'tree';
      readonly size?: number;
    }[];
    try {
      entries = (await deps.client.listTree(owner, repo, branch)).entries;
    } catch (error) {
      return fail(scope, current, deps, failDetail(error));
    }
    const include = current.meta?.include;
    files = selectRepoFiles(
      entries,
      include === undefined ? undefined : { include: [...include] },
    ).map((path) => ({ path, url: rawGitHubUrl(owner, repo, branch, path) }));
  } else {
    // Without a token a private repository cannot be read at all (ADR 0083
    // decision 4): turn it off instead of caching its README in the open.
    // Nothing is fetched here — no public README, no API call.
    if (resource.meta?.private === true) {
      if (resource.enabled)
        deps.store.setResourceEnabled(scope, resource.id, {
          enabled: false,
          meta: resource.meta,
        });
      return fail(
        scope,
        resource,
        deps,
        'This repository is private and no GitHub token is saved. It has been turned off, so its cached text is no longer searched.',
      );
    }
    if (ref === undefined) {
      try {
        const detail = await deps.client.getRepo(owner, repo);
        current = syncPrivateMeta(current, detail.private);
        isPrivate = detail.private;
        ref = detail.defaultBranch;
      } catch (error) {
        if (error instanceof GitHubError && error.kind === 'not-found')
          return disableNotFound(resource);
        return fail(scope, resource, deps, failDetail(error));
      }
    }
    branch = ref;
    files = [{ path: 'README.md', url: rawGitHubUrl(owner, repo, branch, 'README.md') }];
  }

  const fetchFile = (
    file: SelectedFile,
    conditional: ResourceConditional,
  ): Promise<ConditionalResourceFetchResult> => {
    if (!isPrivate) return deps.fetcher.fetch(file.url, conditional);
    return (async (): Promise<ConditionalResourceFetchResult> => {
      let raw: Awaited<ReturnType<GitHubClient['getFileRaw']>>;
      try {
        raw = await deps.client.getFileRaw(owner, repo, branch, file.path, conditional.etag);
      } catch (error) {
        if (error instanceof GitHubError) {
          const message = error.kind === 'rate-limited' ? rateLimitDetail(error) : error.message;
          return { ok: false, code: 'http-status', message };
        }
        throw error;
      }
      if (raw.notModified) return { ok: true, notModified: true };
      const text = raw.notModified === false ? raw.text.replaceAll('\u0000', '') : '';
      return {
        ok: true,
        cache: 'miss',
        evidence: {
          url: file.url,
          mediaType: 'text/plain',
          text,
          fetchedAt: deps.now(),
          trust: 'untrusted-reviewed-resource',
        },
        ...(raw.notModified === false && raw.etag ? { etag: raw.etag } : {}),
      };
    })();
  };

  const fetchedAt = deps.now();
  let fresh = false;
  let firstFileError: string | undefined;
  const wanted = new Set(files.map((f) => f.url));
  for (const file of files) {
    const existing = deps.cache.getDocumentByUrl(scope, file.url);
    const conditional: ResourceConditional = {
      ...(existing?.etag !== undefined ? { etag: existing.etag } : {}),
      ...(existing?.lastModified !== undefined ? { lastModified: existing.lastModified } : {}),
    };
    let result: Awaited<ReturnType<ResourceRefreshFetcher['fetch']>>;
    try {
      result = await fetchFile(file, conditional);
    } catch (error) {
      firstFileError ??= error instanceof Error ? error.message : 'GitHub file fetch failed.';
      continue;
    }
    if (result.ok && result.notModified === true) {
      if (existing !== undefined) {
        deps.cache.upsertDocument(scope, {
          resourceId: current.id,
          docId: existing.docId,
          url: file.url,
          path: existing.path,
          title: existing.path,
          ...(existing.etag !== undefined ? { etag: existing.etag } : {}),
          ...(existing.lastModified !== undefined ? { lastModified: existing.lastModified } : {}),
          contentHash: existing.contentHash,
          fetchedAt,
          bytes: existing.bytes,
          status: 'ok',
        });
      }
      continue;
    }
    if (!result.ok) {
      firstFileError ??= result.message;
      continue;
    }
    const text = result.evidence.text;
    const contentHash = sha256Hex(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    const docId = computeDocId(file.url);
    deps.cache.upsertDocument(scope, {
      resourceId: current.id,
      docId,
      url: file.url,
      path: file.path,
      title: file.path,
      ...(result.etag !== undefined ? { etag: result.etag } : {}),
      ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
      contentHash,
      fetchedAt,
      bytes,
      status: 'ok',
    });
    if (existing !== undefined && existing.status === 'ok' && existing.contentHash === contentHash)
      continue;
    fresh = true;
    deps.cache.replaceChunks(
      scope,
      docId,
      current.id,
      chunkDocument({ text, mediaType: result.evidence.mediaType, path: file.path }),
    );
  }

  for (const doc of deps.cache.listDocuments(scope, current.id)) {
    if (!wanted.has(doc.url)) deps.cache.deleteDocument(scope, doc.docId);
  }

  if (firstFileError !== undefined) return fail(scope, current, deps, firstFileError);
  deps.store.recordResourceFetch(scope, current.id, {
    status: 'ok',
    at: fetchedAt,
    detail:
      files.length === 1
        ? 'GitHub repository refreshed: README cached.'
        : `GitHub repository refreshed: ${String(files.length)} files cached.`,
  });
  return fresh ? 'ok' : 'not-modified';
}

/** Routes one resource to its GitHub refresh; anything else is a caller bug. */
export async function refreshGithubResource(
  scope: GuildScope,
  resource: ClubResource,
  deps: GithubRefreshDeps,
): Promise<GithubRefreshOutcome> {
  if (resource.kind === 'github-org') return refreshGithubOrg(scope, resource, deps);
  if (resource.kind === 'github-repo') return refreshGithubRepo(scope, resource, deps);
  throw new Error(`GitHub refresh does not handle resource kind ${resource.kind}.`);
}
