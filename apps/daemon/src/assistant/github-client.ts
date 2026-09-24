import { z } from 'zod';

/**
 * The GitHub REST client (ADR 0073). Reaches `api.github.com` only, through
 * an injected `fetch` and the existing outbound URL safety check (`guard`,
 * from `apps/daemon/src/assistant/resource-fetcher.ts`'s validation), never
 * `child_process` or the `gh` CLI. The token, when present, is used once to
 * build the Authorization header and is never logged or included in an
 * error.
 */

const API_ROOT = 'https://api.github.com';
const USER_AGENT = 'Bananasaurs';
const API_VERSION = '2022-11-28';
const MAX_PAGES = 5;
const PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

export type GitHubErrorKind = 'not-found' | 'rate-limited' | 'network' | 'invalid-response';

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  readonly resetAt?: number;

  constructor(kind: GitHubErrorKind, message: string, resetAt?: number) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    if (resetAt !== undefined) this.resetAt = resetAt;
  }
}

export interface GitHubRepoSummary {
  readonly name: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly fork: boolean;
  readonly archived: boolean;
  readonly private: boolean;
}

export interface GitHubRepoDetail {
  readonly defaultBranch: string;
  readonly description: string | null;
  readonly private: boolean;
}

export interface GitHubTreeEntry {
  readonly path: string;
  readonly type: 'blob' | 'tree';
  readonly size?: number;
}

export interface GitHubTreeResult {
  readonly entries: readonly GitHubTreeEntry[];
  readonly truncated: boolean;
}

export interface GitHubClient {
  listOrgRepos(owner: string): Promise<readonly GitHubRepoSummary[]>;
  getRepo(owner: string, repo: string): Promise<GitHubRepoDetail>;
  listTree(owner: string, repo: string, ref: string): Promise<GitHubTreeResult>;
  readonly authenticated: boolean;
}

export interface GitHubClientDeps {
  readonly token: () => string | undefined;
  readonly fetch: typeof fetch;
  /** The existing outbound URL safety check; called before every request. */
  readonly guard: (url: URL) => Promise<void>;
  readonly timeoutMs?: number;
}

const repoSummarySchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  default_branch: z.string(),
  fork: z.boolean(),
  archived: z.boolean(),
  private: z.boolean(),
});

const repoDetailSchema = z.object({
  default_branch: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
});

const treeEntrySchema = z.object({
  path: z.string(),
  type: z.enum(['blob', 'tree', 'commit']),
  size: z.number().optional(),
});

const treeResponseSchema = z.object({
  tree: z.array(treeEntrySchema),
  truncated: z.boolean(),
});

const toTreeEntry = (entry: z.infer<typeof treeEntrySchema>): GitHubTreeEntry => ({
  path: entry.path,
  type: entry.type as 'blob' | 'tree',
  ...(entry.size !== undefined ? { size: entry.size } : {}),
});

export const createGitHubClient = (deps: GitHubClientDeps): GitHubClient => {
  const token = deps.token();
  const authenticated = token !== undefined && token !== '';
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request = async (url: URL): Promise<unknown> => {
    await deps.guard(url);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': USER_AGENT,
    };
    // Re-read the token per request (never cached beyond this closure) and
    // only ever set the header when it is a real, non-empty string.
    const currentToken = deps.token();
    if (currentToken !== undefined && currentToken !== '') {
      headers.authorization = `Bearer ${currentToken}`;
    }
    let response: Response;
    try {
      response = await deps.fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GitHubError('network', 'GitHub could not be reached.');
    }
    if (response.status === 404) {
      throw new GitHubError('not-found', 'GitHub returned 404 for this URL.');
    }
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      const resetSeconds = resetHeader === null ? NaN : Number(resetHeader);
      const resetAt = Number.isFinite(resetSeconds) ? resetSeconds * 1_000 : undefined;
      throw new GitHubError('rate-limited', 'GitHub rate limit reached.', resetAt);
    }
    if (!response.ok) {
      throw new GitHubError('network', `GitHub returned HTTP ${String(response.status)}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new GitHubError('invalid-response', 'GitHub returned a response that was not valid JSON.');
    }
  };

  const listOrgRepos = async (owner: string): Promise<readonly GitHubRepoSummary[]> => {
    const repos: GitHubRepoSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(`${API_ROOT}/users/${encodeURIComponent(owner)}/repos`);
      url.searchParams.set('per_page', String(PER_PAGE));
      url.searchParams.set('type', 'owner');
      url.searchParams.set('page', String(page));
      const body = await request(url);
      const parsed = z.array(repoSummarySchema).safeParse(body);
      if (!parsed.success) {
        throw new GitHubError('invalid-response', 'GitHub returned an unexpected repo list shape.');
      }
      for (const item of parsed.data) {
        repos.push({
          name: item.name,
          description: item.description,
          defaultBranch: item.default_branch,
          fork: item.fork,
          archived: item.archived,
          private: item.private,
        });
      }
      if (parsed.data.length < PER_PAGE) break;
    }
    return repos;
  };

  const getRepo = async (owner: string, repo: string): Promise<GitHubRepoDetail> => {
    const url = new URL(`${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    const body = await request(url);
    const parsed = repoDetailSchema.safeParse(body);
    if (!parsed.success) {
      throw new GitHubError('invalid-response', 'GitHub returned an unexpected repo shape.');
    }
    return {
      defaultBranch: parsed.data.default_branch,
      description: parsed.data.description,
      private: parsed.data.private,
    };
  };

  const listTree = async (owner: string, repo: string, ref: string): Promise<GitHubTreeResult> => {
    const url = new URL(
      `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}`,
    );
    url.searchParams.set('recursive', '1');
    const body = await request(url);
    const parsed = treeResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new GitHubError('invalid-response', 'GitHub returned an unexpected tree shape.');
    }
    const entries = parsed.data.tree
      .filter((entry) => entry.type === 'blob' || entry.type === 'tree')
      .map(toTreeEntry);
    return { entries, truncated: parsed.data.truncated };
  };

  return { listOrgRepos, getRepo, listTree, authenticated };
};
