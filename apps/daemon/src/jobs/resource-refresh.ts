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

/**
 * The resource-cache refresh job (ADR 0073), as thin wiring over
 * `refreshResource`/`refreshAll` (`apps/daemon/src/assistant/resource-refresh.ts`)
 * — everything the job decides lives there; this binds the guild scope and
 * the resource list to it, mirroring `adoptPanelHandler`.
 *
 * `payload.resourceId` present means one resource (a manual "Update now", or
 * the `added` reason on save); absent means every enabled resource in the
 * guild (the hourly sweep, or "Update all"). A resource id that no longer
 * exists (deleted between enqueue and run) is a no-op, not a failure — a job
 * enqueued for it is inherently racing a delete, and racing it correctly
 * means doing nothing, not retrying forever.
 */
export const resourceRefreshHandler = (deps: {
  readonly scope: GuildScope;
  readonly listResources: (scope: GuildScope) => readonly ClubResource[];
  readonly refresh: ResourceRefreshDeps;
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
    if (payload.resourceId === undefined) {
      const results = await refreshAll(deps.scope, resources, deps.refresh);
      deps.logger.info(
        safeLogFields({
          component: 'jobs',
          jobKind: JOB_KINDS.resourceRefresh,
          count: results.length,
        }),
        `resource cache: refreshed ${String(results.length)} resource(s) (reason=${payload.reason})`,
      );
      return;
    }
    const resource = resources.find((r) => r.id === payload.resourceId);
    if (resource === undefined) return;
    const outcome = await refreshResource(deps.scope, resource, deps.refresh);
    deps.logger.info(
      safeLogFields({ component: 'jobs', jobKind: JOB_KINDS.resourceRefresh }),
      `resource cache: refreshed ${resource.id} -> ${outcome} (reason=${payload.reason})`,
    );
  },
});
