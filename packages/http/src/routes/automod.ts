import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RULE_KINDS,
  snowflakeIdSchema,
  validateRuleConfig,
} from '@bananasaurs/core';
import type { HttpDeps, RouteGuard } from '../server.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

/**
 * The dashboard's automod rule endpoints (Slice 8): the `/automod` rules
 * list, the `/automod/:ruleId` detail page's config editor, mode dialog and
 * exemptions section, and the new-rule form.
 *
 * Like `write.ts`, this module moves bytes and maps outcomes onto status
 * codes; every decision about identity comes from `guard`, every one about
 * authorization from `requireCapability`, and every one about scope from
 * `session.scope` — never a guild id from the request. The state machine
 * itself lives in storage's `setRuleMode`; the mode route reports its
 * refusal rather than re-deciding it.
 */

const ruleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const createRuleBodySchema = z.object({
  ruleId: ruleIdSchema,
  kind: z.enum(RULE_KINDS),
  name: z.string().min(1).max(80),
  config: z.record(z.unknown()),
});

const setConfigBodySchema = z.object({
  config: z.record(z.unknown()),
});

const setModeBodySchema = z
  .object({
    mode: z.enum(['test', 'observe', 'enforce']).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => body.mode !== undefined || body.enabled !== undefined, {
    message: 'one of mode or enabled is required',
  });

const exemptionBodySchema = z.object({
  exemptType: z.enum(['role', 'channel']),
  exemptId: snowflakeIdSchema,
});

const exemptTypeParamSchema = z.enum(['role', 'channel']);

export const registerAutomodRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/automod/rules', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    return reply.status(200).send({ rules: ports.listAutomodRules() });
  });

  app.get<{ Params: { ruleId: string } }>('/api/automod/rules/:ruleId', (request, reply) => {
    if (!ruleIdSchema.safeParse(request.params.ruleId).success) {
      return reply.status(400).send({ error: 'bad-request' });
    }
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const detail = ports.findAutomodRuleDetail(request.params.ruleId);
    if (detail === undefined) return reply.status(404).send({ error: 'not-found' });
    let configObject: unknown;
    try {
      configObject = JSON.parse(detail.config) as unknown;
    } catch {
      return reply.status(500).send({ error: 'internal' });
    }
    return reply.status(200).send({ ...detail, configObject });
  });

  app.post('/api/automod/rules', (request, reply) => {
    const parsed = createRuleBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    // Creating a rule changes what the bot does to real messages, so it
    // needs a fresh password (PR-45) — the same treatment disabling the
    // kill switch gets in `write.ts`.
    const session = guard.requireFresh(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const configJson = JSON.stringify(parsed.data.config);
    const validation = validateRuleConfig(parsed.data.kind, configJson);
    if (!validation.ok) {
      return reply.status(400).send({
        error: 'invalid-config',
        reason: validation.reason,
        detail: validation.detail,
      });
    }

    const ports = deps.portsFor(session.scope);
    const outcome = ports.createAutomodRule({
      ruleId: parsed.data.ruleId,
      kind: parsed.data.kind,
      name: parsed.data.name,
      config: configJson,
    });
    if (outcome === 'exists') return reply.status(409).send({ error: 'exists' });

    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'automod_rule.created',
      subjectType: 'automod_rule',
      subjectId: parsed.data.ruleId,
      before: undefined,
      after: { kind: parsed.data.kind, name: parsed.data.name, config: configJson },
    });

    return reply.status(200).send({ ok: true });
  });

  app.put<{ Params: { ruleId: string } }>('/api/automod/rules/:ruleId/config', (request, reply) => {
    if (!ruleIdSchema.safeParse(request.params.ruleId).success) {
      return reply.status(400).send({ error: 'bad-request' });
    }
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const parsed = setConfigBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const before = ports.findAutomodRuleDetail(request.params.ruleId);
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });

    const configJson = JSON.stringify(parsed.data.config);
    const validation = validateRuleConfig(before.kind, configJson);
    if (!validation.ok) {
      return reply.status(400).send({
        error: 'invalid-config',
        reason: validation.reason,
        detail: validation.detail,
      });
    }

    const outcome = ports.setAutomodRuleConfig({
      ruleId: request.params.ruleId,
      config: configJson,
    });
    if (outcome === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });

    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'automod_rule.config_set',
      subjectType: 'automod_rule',
      subjectId: request.params.ruleId,
      before: before.config,
      after: configJson,
    });

    return reply.status(200).send({ ok: true });
  });

  app.post<{ Params: { ruleId: string } }>('/api/automod/rules/:ruleId/mode', (request, reply) => {
    if (!ruleIdSchema.safeParse(request.params.ruleId).success) {
      return reply.status(400).send({ error: 'bad-request' });
    }
    const parsed = setModeBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    // A mode change starts or stops what the bot does to real messages, so
    // it needs a fresh password (PR-45).
    const session = guard.requireFresh(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const before = ports.findAutomodRuleDetail(request.params.ruleId);
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });

    // Conditional spreads, not `mode: parsed.data.mode` directly:
    // `exactOptionalPropertyTypes` treats an explicit `undefined` as distinct
    // from the property being absent.
    const outcome = ports.setAutomodRuleMode({
      ruleId: request.params.ruleId,
      ...(parsed.data.mode !== undefined && { mode: parsed.data.mode }),
      ...(parsed.data.enabled !== undefined && { enabled: parsed.data.enabled }),
    });
    if (outcome === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });
    // The dialog states the consequence; the server decides (PR-48). A
    // refusal writes nothing, so it records no audit row either.
    if (!outcome.ok) {
      return reply.status(409).send({ error: 'not-eligible', refusal: outcome.refusal });
    }

    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'automod_rule.mode_set',
      subjectType: 'automod_rule',
      subjectId: request.params.ruleId,
      before: { mode: before.mode, enabled: before.enabled },
      after: {
        ...(parsed.data.mode !== undefined && { mode: parsed.data.mode }),
        ...(parsed.data.enabled !== undefined && { enabled: parsed.data.enabled }),
      },
    });

    return reply.status(200).send({ ok: true });
  });

  app.post<{ Params: { ruleId: string } }>(
    '/api/automod/rules/:ruleId/exemptions',
    (request, reply) => {
      if (!ruleIdSchema.safeParse(request.params.ruleId).success) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const parsed = exemptionBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      const outcome = ports.addAutomodExemption({
        ruleId: request.params.ruleId,
        exemptType: parsed.data.exemptType,
        exemptId: parsed.data.exemptId,
      });
      if (outcome === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });

      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'automod_rule.exemption_added',
        subjectType: 'automod_rule',
        subjectId: request.params.ruleId,
        before: undefined,
        after: {
          exemptType: parsed.data.exemptType,
          exemptId: parsed.data.exemptId,
          outcome,
        },
      });

      return reply.status(200).send({ ok: true, outcome });
    },
  );

  app.delete<{ Params: { ruleId: string; exemptType: string; exemptId: string } }>(
    '/api/automod/rules/:ruleId/exemptions/:exemptType/:exemptId',
    (request, reply) => {
      if (!ruleIdSchema.safeParse(request.params.ruleId).success) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      const parsedType = exemptTypeParamSchema.safeParse(request.params.exemptType);
      if (!parsedType.success) return reply.status(400).send({ error: 'bad-request' });
      if (!snowflakeIdSchema.safeParse(request.params.exemptId).success) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const ports = deps.portsFor(session.scope);
      const outcome = ports.removeAutomodExemption({
        ruleId: request.params.ruleId,
        exemptType: parsedType.data,
        exemptId: request.params.exemptId,
      });

      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'automod_rule.exemption_removed',
        subjectType: 'automod_rule',
        subjectId: request.params.ruleId,
        before: undefined,
        after: {
          exemptType: parsedType.data,
          exemptId: request.params.exemptId,
          outcome,
        },
      });

      return reply.status(200).send({ ok: true, outcome });
    },
  );

  app.post<{ Params: { ruleId: string } }>(
    '/api/automod/rules/:ruleId/dry-run',
    (request, reply) => {
      if (!ruleIdSchema.safeParse(request.params.ruleId).success) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.read', reply)) return reply;

      // A dry run writes nothing, so a disabled rule may be dry-run here
      // (PR-47: edit, dry-run, then enable); the CLI's enabled-only
      // `findAutomodRule` is unchanged.
      const ports = deps.portsFor(session.scope);
      const report = ports.runAutomodDryRun(request.params.ruleId);
      if (report === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });
      return reply.status(200).send(report);
    },
  );
};
