import {
  JOB_KINDS,
  resourceRefreshPayload,
  safeLogFields,
  type ClubResource,
  type JobHandler,
  type Logger,
  type ResourceRefreshPayload,
} from '@bananasaurs/core';
import type { GuildScope } from '@bananasaurs/storage';
import {
  refreshAll,
  refreshResource,
  type ResourceRefreshDeps,
} from '../assistant/resource-refresh.js';
import {
  refreshGithubResource,
  type GithubRefreshDeps,
  type GithubRefreshOutcome,
} from '../assistant/github-refresh.js';

/**
 * The resource-cache refresh job (ADR 0073), as thin wiring over
 * `refreshResource`/`refreshAll` (`apps/daemon/src/assistant/resource-refresh.ts`)
 * — everything the job decides lives there; this binds the guild scope and
 * the resource list to it, mirroring `adoptPanelHandler`.
 *
 * `payload.resourceId` present means one resource (a manual "Update now", or
 * the `added` reason on save); absent means every resource in the
 * guild (the hourly sweep, or "Update all"). A resource id that no longer
 * exists (deleted between enqueue and run) is a no-op, not a failure — a job
 * enqueued for it is inherently racing a delete, and racing it correctly
 * means doing nothing, not retrying forever.
 */
export const resourceRefreshHandler = (deps: {
  readonly scope: GuildScope;
  readonly listResources: (scope: GuildScope) => readonly ClubResource[];
  readonly refresh: ResourceRefreshDeps;
  /**
   * Task 17: the GitHub refresh deps (client + fetcher + store + cache +
   * clock). Absent in older wiring and isolated tests, in which case GitHub
   * resources refresh as `skipped` rather than failing.
   */
  readonly github?: GithubRefreshDeps | undefined;
  readonly logger: Logger;
}): JobHandler<ResourceRefreshPayload> => ({
  kind: JOB_KINDS.resourceRefresh,
  payload: resourceRefreshPayload,
  async run(payload) {
    // Every resource, not only enabled ones: an "Update now" on a disabled
    // resource (kept fresh while an operator decides whether to turn it on)
    // must still work, and the hourly sweep refreshing a disabled resource
    // too is a wasted fetch, not a correctness problem. `enabled` gates
    // whether the assistant *reads* a resource (service.ts), not whether the
    // cache stays current for it.
    const resources = deps.listResources(deps.scope);
    const isGithub = (r: ClubResource): boolean =>
      r.kind === 'github-org' || r.kind === 'github-repo';
    const refreshGithub = async (resource: ClubResource): Promise<GithubRefreshOutcome> =>
      deps.github === undefined
        ? 'skipped'
        : refreshGithubResource(deps.scope, resource, deps.github);
    if (payload.resourceId === undefined) {
      const plain = resources.filter((r) => !isGithub(r));
      const results = await refreshAll(deps.scope, plain, deps.refresh);
      const githubOutcomes: { readonly resourceId: string; readonly outcome: string }[] = [];
      for (const resource of resources) {
        if (isGithub(resource))
          githubOutcomes.push({ resourceId: resource.id, outcome: await refreshGithub(resource) });
      }
      deps.logger.info(
        safeLogFields({
          component: 'jobs',
          jobKind: JOB_KINDS.resourceRefresh,
          count: results.length + githubOutcomes.length,
        }),
        `resource cache: refreshed ${String(results.length + githubOutcomes.length)} resource(s) (reason=${payload.reason})`,
      );
      return;
    }
    const resource = resources.find((r) => r.id === payload.resourceId);
    if (resource === undefined) return;
    if (isGithub(resource)) {
      const outcome = await refreshGithub(resource);
      deps.logger.info(
        safeLogFields({ component: 'jobs', jobKind: JOB_KINDS.resourceRefresh }),
        `resource cache: refreshed ${resource.id} -> ${outcome} (reason=${payload.reason})`,
      );
      return;
    }
    const detail = await refreshResource(deps.scope, resource, deps.refresh);
    deps.logger.info(
      safeLogFields({
        component: 'jobs',
        jobKind: JOB_KINDS.resourceRefresh,
        resourceId: resource.id,
        outcome: detail.outcome,
        ...(detail.code === undefined ? {} : { code: detail.code }),
        ...(detail.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
        ...(detail.host === undefined ? {} : { host: detail.host }),
      }),
      `resource cache: refreshed ${resource.id} -> ${detail.outcome}${detail.code !== undefined ? ` (${detail.code})` : ''} (reason=${payload.reason})`,
    );
  },
});
