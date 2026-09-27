import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { githubChildId, githubOrgId, parseGitHubUrl, selectRepoFiles } from '@bananasaurs/core';
import { assistantRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

/**
 * The "Add from GitHub" routes (Task 17, ruling "routes"): preview a repo or
 * org URL, then import it as cached `github-repo` / `github-org` resources.
 *
 * `packages/http` cannot import `apps/daemon` (ADR 0014), so the GitHub REST
 * client arrives as the `githubClient` factory on `HttpDeps` — the daemon's
 * HTTP wiring builds the pinned, token-carrying client; route tests inject a
 * fake. The interface is structural on purpose: the daemon's
 * `createGitHubClient` result satisfies it without either package importing
 * the other. The token itself never crosses this boundary — it stays inside
 * the client's `Authorization` header — so no response or audit row here can
 * carry it (hard rule 4).
 */

export interface GithubRouteRepoSummary {
  readonly name: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly fork: boolean;
  readonly archived: boolean;
  readonly private: boolean;
}

export interface GithubRouteOrgRepos {
  readonly repos: readonly GithubRouteRepoSummary[];
  /** True when the client hit its page cap — more repositories may exist. */
  readonly truncated: boolean;
}

export interface GithubRouteClient {
  readonly authenticated: boolean;
  listOrgRepos(owner: string): Promise<GithubRouteOrgRepos>;
  getRepo(
    owner: string,
    repo: string,
  ): Promise<{
    readonly defaultBranch: string;
    readonly description: string | null;
    readonly private: boolean;
  }>;
  listTree(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<{
    readonly entries: readonly {
      readonly path: string;
      readonly type: 'blob' | 'tree';
      readonly size?: number;
    }[];
    readonly truncated: boolean;
  }>;
}

const previewBody = z.object({ url: z.string().min(1).max(2_000) });

const importBody = z.object({
  url: z.string().min(1).max(2_000),
  include: z.array(z.string().min(1).max(300)).max(40).optional(),
});

/** Reads the GitHub error kind structurally — the real `GitHubError` carries `kind`, and so do test doubles. */
const githubErrorKind = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
};

const githubResetAt = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const resetAt = (error as { resetAt?: unknown }).resetAt;
  return typeof resetAt === 'number' && Number.isFinite(resetAt) ? resetAt : undefined;
};

const PREVIEW_LIMIT = 500;

export const registerAssistantGithubRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  const clientFor = (): GithubRouteClient | undefined => deps.githubClient?.();

  app.post('/api/assistant/github/preview', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = previewBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const target = parseGitHubUrl(parsed.data.url);
    if (target === undefined) return reply.status(400).send({ error: 'not-github' });
    const client = clientFor();
    if (client === undefined) return reply.status(503).send({ error: 'github-not-configured' });

    try {
      if (target.kind === 'org') {
        const listed = await client.listOrgRepos(target.owner);
        const repos = listed.repos.slice(0, PREVIEW_LIMIT).map((s) => ({
          name: s.name,
          description: s.description,
          fork: s.fork,
          archived: s.archived,
          private: s.private,
        }));
        return reply.status(200).send({
          target: { kind: 'org', owner: target.owner },
          authenticated: client.authenticated,
          repos,
          truncated: listed.truncated,
        });
      }
      if (!client.authenticated) {
        const branch =
          target.ref ?? (await client.getRepo(target.owner, target.repo)).defaultBranch;
        return reply.status(200).send({
          target: { kind: 'repo', owner: target.owner, repo: target.repo, branch },
          authenticated: false,
          files: ['README.md'],
        });
      }
      const detail = await client.getRepo(target.owner, target.repo);
      const branch = target.ref ?? detail.defaultBranch;
      const tree = await client.listTree(target.owner, target.repo, branch);
      return reply.status(200).send({
        target: { kind: 'repo', owner: target.owner, repo: target.repo, branch },
        authenticated: true,
        private: detail.private,
        files: selectRepoFiles(tree.entries),
      });
    } catch (error) {
      const kind = githubErrorKind(error);
      if (kind === 'not-found') return reply.status(404).send({ error: 'not-found' });
      if (kind === 'rate-limited') {
        const resetAt = githubResetAt(error);
        return reply.status(429).send({
          error: 'rate-limited',
          ...(resetAt === undefined ? {} : { resetAt }),
        });
      }
      throw error;
    }
  });

  app.post('/api/assistant/github/import', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = importBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const target = parseGitHubUrl(parsed.data.url);
    if (target === undefined) return reply.status(400).send({ error: 'not-github' });
    const client = clientFor();
    if (client === undefined) return reply.status(503).send({ error: 'github-not-configured' });

    const include = parsed.data.include === undefined ? undefined : [...parsed.data.include];
    const nowIso = new Date(deps.now()).toISOString();
    const enqueue = (resourceId: string): void => {
      deps.enqueueResourceRefresh?.(session.scope, resourceId, 'added');
    };

    try {
      if (target.kind === 'org') {
        // ADR 0084: every repository the token can see is imported — forks,
        // archived and private alike. There is no per-repository selection:
        // the hourly refresh adds every repository anyway.
        const selected = (await client.listOrgRepos(target.owner)).repos;

        const orgId = githubOrgId(target.owner);
        assistantRepo.putResource(session.scope, {
          id: orgId,
          guildId: session.guildId,
          title: target.owner,
          url: `https://github.com/${target.owner}`,
          kind: 'github-org',
          enabled: true,
          reviewedAt: nowIso,
          meta: { owner: target.owner },
        });
        enqueue(orgId);
        for (const repo of selected) {
          const childId = githubChildId(target.owner, repo.name);
          assistantRepo.putResource(session.scope, {
            id: childId,
            guildId: session.guildId,
            title: `${target.owner}/${repo.name}`,
            url: `https://github.com/${target.owner}/${repo.name}`,
            kind: 'github-repo',
            enabled: true,
            reviewedAt: nowIso,
            parentId: orgId,
            meta: {
              owner: target.owner,
              repo: repo.name,
              branch: repo.defaultBranch,
              ...(include === undefined ? {} : { include }),
              ...(repo.private ? { private: true } : {}),
            },
          });
          enqueue(childId);
        }
        const created = 1 + selected.length;
        // Counts only: no repo names, URLs or tokens ever reach the audit row.
        deps.portsFor(session.scope).recordAudit({
          ...dashboardAuditBase(session, deps.now()),
          action: 'assistant_resource.github_imported',
          subjectType: 'assistant_resource',
          subjectId: orgId,
          before: undefined,
          after: { kind: 'org', created },
        });
        return reply.status(200).send({ created });
      }

      const detail = await client.getRepo(target.owner, target.repo);
      const branch = target.ref ?? detail.defaultBranch;
      const repoId = githubChildId(target.owner, target.repo);
      assistantRepo.putResource(session.scope, {
        id: repoId,
        guildId: session.guildId,
        title: `${target.owner}/${target.repo}`,
        url: `https://github.com/${target.owner}/${target.repo}`,
        kind: 'github-repo',
        enabled: true,
        reviewedAt: nowIso,
        meta: {
          owner: target.owner,
          repo: target.repo,
          branch,
          ...(include === undefined ? {} : { include }),
          ...(detail.private ? { private: true } : {}),
        },
      });
      enqueue(repoId);
      deps.portsFor(session.scope).recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'assistant_resource.github_imported',
        subjectType: 'assistant_resource',
        subjectId: repoId,
        before: undefined,
        after: { kind: 'repo', created: 1 },
      });
      return reply.status(200).send({ created: 1 });
    } catch (error) {
      const kind = githubErrorKind(error);
      if (kind === 'not-found') return reply.status(404).send({ error: 'not-found' });
      if (kind === 'rate-limited') {
        const resetAt = githubResetAt(error);
        return reply.status(429).send({
          error: 'rate-limited',
          ...(resetAt === undefined ? {} : { resetAt }),
        });
      }
      throw error;
    }
  });
};
