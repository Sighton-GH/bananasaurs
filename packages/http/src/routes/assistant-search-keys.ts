import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import type { SessionContext } from '../auth.js';
import { dashboardAuditBase } from './audit-base.js';
import { isInstanceOwner } from './assistant.js';

const limit = z.number().int().min(1).max(1_000_000).nullable();

const searchKeyBody = z
  .object({
    source: z.enum(['brave', 'tavily', 'parallel']),
    label: z.string().trim().min(1).max(60),
    apiKey: z.string().min(1).max(1000),
    monthlyLimit: limit.optional(),
    dailyLimit: limit.optional(),
  })
  .strict();

const searchKeyPatch = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    apiKey: z.string().min(1).max(1000).optional(),
    enabled: z.boolean().optional(),
    monthlyLimit: limit.optional(),
    dailyLimit: limit.optional(),
  })
  .strict();

const searchKeyMove = z.object({ direction: z.enum(['up', 'down']) }).strict();

/**
 * ADR 0120: the web search keys across both sources, ordered for fallback.
 * Instance owner only; every change is audited as `assistant_search.*` with
 * ids, labels and limits — a key, sealed or plain, never appears in any
 * response, audit row, log or error. Responses are built field by field from
 * the store rows, which carry no `apiKeyEnc` here (ADR 0014), so the sealed
 * value cannot be reached, let alone returned.
 */
export const registerAssistantSearchKeyRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  const store = () => deps.assistantProviderConfig;

  const requireOwner = (session: SessionContext, reply: FastifyReply): boolean => {
    if (!isInstanceOwner(deps, session)) {
      void reply.status(403).send({ error: 'owner-only' });
      return false;
    }
    return true;
  };

  app.get('/api/assistant/search-keys', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (
      configured?.searchKeys === undefined ||
      configured.isSearchKeyReadable === undefined ||
      configured.searchKeyUsage === undefined
    ) {
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    }
    const webSearch = configured.status().webSearch;
    const keys = configured.searchKeys().map((key) => ({
      keyId: key.keyId,
      source: key.source,
      label: key.label,
      enabled: key.enabled,
      position: key.position,
      monthlyLimit: key.monthlyLimit,
      dailyLimit: key.dailyLimit,
      readable: configured.isSearchKeyReadable?.(key.keyId) ?? false,
      usage: configured.searchKeyUsage?.(key.keyId) ?? { last24h: 0, last31d: 0 },
    }));
    return reply.status(200).send({
      enabled: webSearch?.enabled ?? false,
      source: webSearch?.source ?? 'brave',
      keys,
    });
  });

  app.post('/api/assistant/search-keys', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.addSearchKey === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const parsed = searchKeyBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    // Omitted limits are not sent through: the store applies its own default
    // (1000/month, no daily cap), while the audit row records the effective
    // values, never the key.
    // ADR 0147: a new Parallel key defaults to 4,500 a month (under its 5,000 free allowance).
    const monthlyLimit =
      parsed.data.monthlyLimit === undefined && parsed.data.source === 'parallel'
        ? 4500
        : parsed.data.monthlyLimit;
    const keyId = configured.addSearchKey(
      {
        source: parsed.data.source,
        label: parsed.data.label,
        apiKey: parsed.data.apiKey,
        ...(monthlyLimit === undefined ? {} : { monthlyLimit }),
        ...(parsed.data.dailyLimit === undefined ? {} : { dailyLimit: parsed.data.dailyLimit }),
      },
      deps.now(),
    );
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_search.key_added',
      subjectType: 'assistant_search_key',
      subjectId: keyId,
      before: undefined,
      after: {
        source: parsed.data.source,
        label: parsed.data.label,
        monthlyLimit: monthlyLimit === undefined ? 1000 : monthlyLimit,
        dailyLimit: parsed.data.dailyLimit ?? null,
      },
    });
    return reply.status(200).send({ keyId });
  });

  app.patch('/api/assistant/search-keys/:keyId', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.searchKeys === undefined || configured.updateSearchKey === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const keyId = (request.params as { keyId: string }).keyId;
    const before = configured.searchKeys().find((key) => key.keyId === keyId);
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });
    const parsed = searchKeyPatch.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (
      parsed.data.label === undefined &&
      parsed.data.apiKey === undefined &&
      parsed.data.enabled === undefined &&
      parsed.data.monthlyLimit === undefined &&
      parsed.data.dailyLimit === undefined
    ) {
      return reply.status(400).send({ error: 'bad-request' });
    }
    configured.updateSearchKey(keyId, { ...parsed.data }, deps.now());
    const after = configured.searchKeys().find((key) => key.keyId === keyId);
    // The re-read row is the shown value; `before` is only the fallback when
    // the row went missing. Reading fields off `after` with `??` would turn a
    // limit cleared to `null` back into the old value in the audit row.
    const shown = after ?? before;
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_search.key_updated',
      subjectType: 'assistant_search_key',
      subjectId: keyId,
      before: {
        source: before.source,
        label: before.label,
        enabled: before.enabled,
        monthlyLimit: before.monthlyLimit,
        dailyLimit: before.dailyLimit,
      },
      after: {
        source: shown.source,
        label: shown.label,
        enabled: shown.enabled,
        monthlyLimit: shown.monthlyLimit,
        dailyLimit: shown.dailyLimit,
        keyReplaced: parsed.data.apiKey !== undefined,
      },
    });
    return reply.status(200).send({ ok: true });
  });

  app.post('/api/assistant/search-keys/:keyId/move', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.moveSearchKey === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const keyId = (request.params as { keyId: string }).keyId;
    const parsed = searchKeyMove.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (!configured.moveSearchKey(keyId, parsed.data.direction, deps.now()))
      return reply.status(404).send({ error: 'not-found' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_search.key_moved',
      subjectType: 'assistant_search_key',
      subjectId: keyId,
      before: undefined,
      after: { direction: parsed.data.direction },
    });
    return reply.status(200).send({ ok: true });
  });

  app.delete('/api/assistant/search-keys/:keyId', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.searchKeys === undefined || configured.removeSearchKey === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const keyId = (request.params as { keyId: string }).keyId;
    const before = configured.searchKeys().find((key) => key.keyId === keyId);
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });
    configured.removeSearchKey(keyId);
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_search.key_removed',
      subjectType: 'assistant_search_key',
      subjectId: keyId,
      before: { source: before.source, label: before.label },
      after: undefined,
    });
    return reply.status(200).send({ ok: true });
  });
};
