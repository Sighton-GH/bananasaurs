import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, type ZodError } from 'zod';
import type { JsonValue } from '@bananasaurs/core';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest, fieldsOf } from '../errors/reply.js';
import type { SessionContext } from '../auth.js';
import { dashboardAuditBase } from './audit-base.js';
import { isInstanceOwner } from '../owner.js';

/**
 * The daemon's instance settings store, restated structurally: `packages/http`
 * must not import `apps/daemon` (ADR 0014), so the tuning routes see only the
 * three methods they call.
 */
export interface InstanceSettingsPort {
  list(): readonly unknown[];
  set(key: string, value: unknown, by: string, now: number): TuningSetResult;
  reset(key: string, by: string, now: number): TuningSetResult;
}

export type TuningSetResult =
  | { readonly ok: true; readonly before: unknown; readonly after: unknown; readonly view: unknown }
  | {
      readonly ok: false;
      readonly code: 'unknown-setting' | 'invalid-setting' | 'provider-secret-store-not-configured';
      readonly error?: ZodError;
    };

const tuningBody = z.object({ value: z.unknown() }).strict();

/**
 * Assistant → AI tuning: the owner-edited instance settings (ADR 0080).
 * Instance owner only; every write is audited as `instance_setting.changed`
 * with view values, so the sealed header value is recorded only as
 * `{ configured }` — never the value.
 */
export const registerAssistantTuningRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  const requireOwner = (session: SessionContext, reply: FastifyReply): boolean => {
    if (!isInstanceOwner(deps, session)) {
      void reply.status(403).send({ error: 'owner-only' });
      return false;
    }
    return true;
  };

  const store = (): InstanceSettingsPort | undefined => deps.instanceSettings;

  app.get('/api/assistant/tuning', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const port = store();
    if (port === undefined) return reply.status(503).send({ error: 'settings-unavailable' });
    return reply.status(200).send({ settings: port.list() });
  });

  app.put('/api/assistant/tuning/:key', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const port = store();
    if (port === undefined) return reply.status(503).send({ error: 'settings-unavailable' });
    const parsed = tuningBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const key = (request.params as { key: string }).key;
    const result = port.set(key, parsed.data.value, session.accountId, deps.now());
    if (!result.ok) {
      if (result.code === 'unknown-setting')
        return reply.status(404).send({ error: 'unknown-setting' });
      if (result.code === 'provider-secret-store-not-configured')
        return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
      const first = result.error?.issues[0];
      return reply.status(400).send({
        error: 'invalid-setting',
        fields: result.error === undefined ? [] : fieldsOf(result.error),
        ...(first?.code === 'custom' ? { message: first.message } : {}),
      });
    }
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'instance_setting.changed',
      subjectType: 'instance_setting',
      subjectId: key,
      // View values by construction: parsed JSON, a registry default, or
      // `{ configured }` — always JSON-shaped, hence the cast, never a cast
      // that could carry a secret (views never hold one).
      before: result.before as JsonValue | undefined,
      after: result.after as JsonValue | undefined,
    });
    return reply.status(200).send({ setting: result.view });
  });

  app.delete('/api/assistant/tuning/:key', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const port = store();
    if (port === undefined) return reply.status(503).send({ error: 'settings-unavailable' });
    const key = (request.params as { key: string }).key;
    const result = port.reset(key, session.accountId, deps.now());
    if (!result.ok) return reply.status(404).send({ error: 'unknown-setting' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'instance_setting.changed',
      subjectType: 'instance_setting',
      subjectId: key,
      before: result.before as JsonValue | undefined,
      after: result.after as JsonValue | undefined,
    });
    return reply.status(200).send({ setting: result.view });
  });
};
