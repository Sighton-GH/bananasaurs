// GitHub resource parsing and file selection (ADR 0073). Pure: no I/O. The
// GitHub REST client that actually reaches the network lives in the daemon
// (`apps/daemon/src/assistant/github-client.ts`) and calls into this module
// only for the raw-URL builder.

export type GitHubTarget =
  | { readonly kind: 'org'; readonly owner: string }
  | {
      readonly kind: 'repo';
      readonly owner: string;
      readonly repo: string;
      readonly ref?: string;
      readonly path?: string;
    };

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

/** True for GitHub's website hosts (github.com, www.github.com) — pages there are GitHub's UI, not a repository's files. */
export const isGithubWebHost = (hostname: string): boolean =>
  GITHUB_HOSTS.has(hostname.toLowerCase());

// Top-level path segments that are GitHub site sections, not usernames or
// organisation handles, so a URL like github.com/settings must never be
// treated as an org target.
const RESERVED_OWNERS = new Set([
  'settings',
  'orgs',
  'organizations',
  'marketplace',
  'notifications',
  'issues',
  'pulls',
  'explore',
  'topics',
  'trending',
  'collections',
  'events',
  'sponsors',
  'about',
  'pricing',
  'security',
  'login',
  'join',
  'logout',
  'session',
  'dashboard',
  'new',
  'search',
  'features',
  'apps',
  'codespaces',
  'account',
  'contact',
  'site',
]);

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Accepts `github.com/<owner>`, `https://github.com/<owner>/`,
 * `github.com/<owner>/<repo>` (with or without a `.git` suffix), and
 * `/tree/<ref>/<path>` or `/blob/<ref>/<path>` under a repo. GitHub user
 * pages and organisation pages share the same URL shape and the same
 * `/users/{owner}/repos` listing API, so both parse as `kind: 'org'`.
 */
export const parseGitHubUrl = (input: string): GitHubTarget | undefined => {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return undefined;

  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return undefined;
  const owner = segments[0]!;
  if (RESERVED_OWNERS.has(owner.toLowerCase()) || !OWNER_RE.test(owner)) return undefined;

  if (segments.length === 1) return { kind: 'org', owner };

  let repo = segments[1]!;
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (repo === '' || !REPO_RE.test(repo)) return undefined;

  if (segments.length === 2) return { kind: 'repo', owner, repo };

  const sub = segments[2];
  if ((sub !== 'tree' && sub !== 'blob') || segments.length < 4) {
    // An unrecognised sub-path (issues, pulls, actions, …) is still a valid
    // repo target; only the tree/blob path forms carry a ref and a path.
    return { kind: 'repo', owner, repo };
  }
  const ref = segments[3]!;
  const path = segments.slice(4).join('/');
  return path === ''
    ? { kind: 'repo', owner, repo, ref }
    : { kind: 'repo', owner, repo, ref, path };
};

/** `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`, percent-encoded per segment. */
export const rawGitHubUrl = (owner: string, repo: string, ref: string, path: string): string => {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodedPath}`;
};

const isExcluded = (path: string): boolean =>
  path.split('/').some((segment) => {
    if (segment.startsWith('.')) return true;
    const lower = segment.toLowerCase();
    return lower === 'node_modules' || lower === 'vendor';
  });

const isRootReadme = (path: string): boolean => /^README(\..+)?$/iu.test(path);
const isRootChangelog = (path: string): boolean => /^CHANGELOG(\..+)?$/iu.test(path);
const isDocsPath = (path: string): boolean => path.toLowerCase().startsWith('docs/');
const isReadmeBasename = (path: string): boolean => {
  const basename = path.split('/').pop() ?? path;
  return /^README(\..+)?$/iu.test(basename);
};
const isDefaultCandidate = (path: string): boolean =>
  isRootReadme(path) || /\.(md|markdown)$/iu.test(path);

const rankOf = (path: string): number => {
  if (isRootReadme(path)) return 0;
  if (isDocsPath(path)) return 1;
  if (isReadmeBasename(path)) return 2;
  if (isRootChangelog(path)) return 4;
  return 3;
};

const depthOf = (path: string): number => path.split('/').length - 1;

const GLOB_ESCAPE_RE = /[.+^${}()|[\]\\]/gu;
// A lone '*' becomes a within-segment wildcard; a '*' that is part of the
// '.*' already inserted for '**' is protected by the lookbehind.
const LONE_STAR_RE = /(?<!\.)\*/gu;

const globToRegExp = (glob: string): RegExp => {
  const escaped = glob.replace(GLOB_ESCAPE_RE, '\\$&');
  const withGlobstar = escaped.replace(/\*\*\//gu, '(?:.*/)?').replace(/\*\*/gu, '.*');
  const pattern = withGlobstar.replace(LONE_STAR_RE, '[^/]*');
  return new RegExp(`^${pattern}$`, 'iu');
};

/**
 * Picks which files of a repo tree to fetch: the root README plus every
 * `.md`/`.markdown` file by default (ADR 0082 decision 4), or a
 * caller-supplied set of glob `include` patterns. Any path with a
 * dot-segment (`.github/`, `.claude/`, …) or a `node_modules`/`vendor`
 * segment is excluded from both selections. Candidates are ordered by rank
 * (root README, then `docs/`, then other READMEs, then other files, with
 * root CHANGELOG last), then by depth, then by path. Capped at 100 files,
 * 200 KB per file and 2 MB total; oversize files are skipped, not fatal.
 */
export const selectRepoFiles = (
  entries: readonly {
    readonly path: string;
    readonly type: 'blob' | 'tree';
    readonly size?: number;
  }[],
  options?: {
    readonly include?: readonly string[];
    readonly maxFiles?: number;
    readonly maxFileBytes?: number;
    readonly maxTotalBytes?: number;
  },
): readonly string[] => {
  const maxFiles = options?.maxFiles ?? 100;
  const maxFileBytes = options?.maxFileBytes ?? 200_000;
  const maxTotalBytes = options?.maxTotalBytes ?? 2_000_000;
  const includeMatchers = options?.include?.map(globToRegExp);

  const matchesSelection = (path: string): boolean =>
    includeMatchers !== undefined
      ? includeMatchers.some((re) => re.test(path))
      : isDefaultCandidate(path);

  const candidates = entries.filter(
    (entry) => entry.type === 'blob' && !isExcluded(entry.path) && matchesSelection(entry.path),
  );

  const ordered = [...candidates].sort((a, b) => {
    const rank = rankOf(a.path) - rankOf(b.path);
    if (rank !== 0) return rank;
    const depth = depthOf(a.path) - depthOf(b.path);
    if (depth !== 0) return depth;
    return a.path.localeCompare(b.path);
  });

  const selected: string[] = [];
  let total = 0;
  for (const entry of ordered) {
    if (selected.length >= maxFiles) break;
    const size = entry.size ?? 0;
    if (size > maxFileBytes) continue;
    if (total + size > maxTotalBytes) continue;
    selected.push(entry.path);
    total += size;
  }
  return selected;
};
