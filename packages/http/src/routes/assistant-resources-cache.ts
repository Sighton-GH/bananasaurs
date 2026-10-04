import type { FastifyInstance } from 'fastify';
import { JOB_KINDS, resourceRefreshDedupeKey } from '@bananasaurs/core';
import { assistantRepo, jobRepo, resourceCacheRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { RESOURCE_FAILURE_TEXT } from '../errors/resource-failures.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

/**
 * The resource cache's freshness and manual-refresh routes (ADR 0073):
 * `GET .../freshness` for the Resources page's status pills, and the two
 * "Update now" / "Update all" enqueue routes. The actual fetch/chunk work
 * happens in the `resource_refresh` job — these routes only enqueue it and
 * audit that a refresh was asked for.
 */

const MINUTE_MS = 60_000;

export const registerAssistantResourceCacheRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/assistant/resources/freshness', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const tokenState = deps.assistantProviderConfig?.githubTokenConfigured?.();
    return reply.status(200).send({
      freshness: resourceCacheRepo.resourceFreshness(session.scope).map((row) => {
        const errorExplain =
          row.errorCode === undefined ? undefined : RESOURCE_FAILURE_TEXT[row.errorCode];
        return {
          ...row,
          ...(errorExplain === undefined ? {} : { errorExplain }),
        };
      }),
      ...(tokenState === undefined ? {} : { githubTokenConfigured: tokenState }),
    });
  });

  app.post<{ Params: { id: string } }>('/api/assistant/resources/:id/refresh', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const { id } = request.params;
    const resource = assistantRepo.listResources(session.scope).find((r) => r.id === id);
    if (resource === undefined) return reply.status(404).send({ error: 'not-found' });

    const now = deps.now();
    jobRepo.enqueue(session.scope, {
      kind: JOB_KINDS.resourceRefresh,
      payload: JSON.stringify({ resourceId: id, reason: 'manual' }),
      dedupeKey: resourceRefreshDedupeKey({
        reason: 'manual',
        resourceId: id,
        minuteBucket: Math.floor(now / MINUTE_MS),
      }),
      oncePerBucket: true,
      now,
    });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, now),
      action: 'assistant_resource.refresh_requested',
      subjectType: 'assistant_resource',
      subjectId: id,
      before: undefined,
      after: { resourceId: id },
    });
    return reply.status(200).send({ ok: true });
  });

  app.post('/api/assistant/resources/refresh', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const now = deps.now();
    jobRepo.enqueue(session.scope, {
      kind: JOB_KINDS.resourceRefresh,
      payload: JSON.stringify({ reason: 'manual' }),
      dedupeKey: resourceRefreshDedupeKey({
        reason: 'manual',
        minuteBucket: Math.floor(now / MINUTE_MS),
      }),
      oncePerBucket: true,
      now,
    });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, now),
      action: 'assistant_resource.refresh_requested',
      subjectType: 'assistant_resource',
      subjectId: 'all',
      before: undefined,
      after: { resourceId: 'all' },
    });
    return reply.status(200).send({ ok: true });
  });
};
