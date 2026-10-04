import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RULE_KINDS,
  snowflakeIdSchema,
  validateRuleConfig,
  type OpsAutomodRuleSummary,
} from '@bananasaurs/core';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

/**
 * The dashboard's automod rule endpoints (Slice 8): the `/automod` rules
 * list, the `/automod/:ruleId` detail page's config editor, enabled checkbox
 * and exemptions section, and the new-rule form.
 *
 * Like `write.ts`, this module moves bytes and maps outcomes onto status
 * codes; every decision about identity comes from `guard`, every one about
 * authorization from `requireCapability`, and every one about scope from
 * `session.scope` — never a guild id from the request. Whether enabled rules
 * act is the guild-wide automod switch (`automod-state.ts`, ADR 0121).
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

const setEnabledBodySchema = z.object({ enabled: z.boolean() }).strict();

const exemptionBodySchema = z.object({
  exemptType: z.enum(['role', 'channel']),
  exemptId: snowflakeIdSchema,
});

const exemptTypeParamSchema = z.enum(['role', 'channel']);

const reviewQuerySchema = z.object({
  ruleId: ruleIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const eventIdParamSchema = z.string().min(1).max(64);

const verdictBodySchema = z.object({
  verdict: z.enum(['false_positive', 'true_positive', 'unclear']),
  note: z.string().max(500).optional(),
});

const suppressBodySchema = z.object({
  kind: z.enum(['allowlist_phrase', 'invite_code', 'link_domain', 'channel_exemption']),
  value: z.string().min(1).max(200),
});

const INVITE_CODE_PATTERN = /^[\w-]{2,64}$/;
const LINK_DOMAIN_PATTERN = /^[a-z0-9.-]{1,253}$/;

/**
 * ADR 0121 removed the per-rule staged rollout, so the dashboard never sees a
 * rule's mode, cutover state, observe clock, legacy ref, sign-off, gate
 * thresholds or eligibility. The port types still carry them until storage drops the
 * columns; this keeps them out of every response.
 */
const STAGED_FIELDS = [
  'mode',
  'cutoverState',
  'observeStartedAt',
  'legacyRuleRef',
  'maxFalsePositiveRate',
  'minReviewedMatches',
  'enforceSignedOffBy',
  'enforceSignedOffAt',
  'eligibility',
] as const;

const withoutStagedFields = (rule: OpsAutomodRuleSummary): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...rule };
  for (const field of STAGED_FIELDS) delete copy[field];
  return copy;
};

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
    return reply.status(200).send({ rules: ports.listAutomodRules().map(withoutStagedFields) });
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
    return reply.status(200).send({ ...withoutStagedFields(detail), configObject });
  });

  app.post('/api/automod/rules', (request, reply) => {
    const parsed = createRuleBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

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
    if (!parsed.success) return badRequest(reply, parsed.error);

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

  app.post<{ Params: { ruleId: string } }>(
    '/api/automod/rules/:ruleId/enabled',
    (request, reply) => {
      if (!ruleIdSchema.safeParse(request.params.ruleId).success) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      const parsed = setEnabledBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const enabled = parsed.data.enabled;

      const signedIn = guard.require(request, reply);
      if (signedIn === undefined) return reply;
      const before = deps.portsFor(signedIn.scope).findAutomodRuleDetail(request.params.ruleId);
      if (before === undefined) return reply.status(404).send({ error: 'not-found' });
      // Re-sending the current value changes nothing, so it is not audited.
      if (before.enabled === enabled) return reply.status(200).send({ ok: true });

      // ADR 0029's asymmetry: enabling a rule widens what automod may do, so it
      // needs a fresh password; disabling one is never harder than that.
      const session = enabled ? guard.requireFresh(request, reply) : signedIn;
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const ports = deps.portsFor(session.scope);
      const outcome = ports.setAutomodRuleEnabled({ ruleId: request.params.ruleId, enabled });
      if (outcome === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });

      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'automod_rule.enabled_set',
        subjectType: 'automod_rule',
        subjectId: request.params.ruleId,
        before: { enabled: before.enabled },
        after: { enabled },
      });

      return reply.status(200).send({ ok: true });
    },
  );

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
      if (!parsed.success) return badRequest(reply, parsed.error);

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
      if (!parsedType.success) return badRequest(reply, parsedType.error);
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

  app.get('/api/automod/review', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const parsed = reviewQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const limit = parsed.data.limit ?? 50;

    const ports = deps.portsFor(session.scope);
    const matches = ports.listUnreviewedMatches({
      ...(parsed.data.ruleId !== undefined && { ruleId: parsed.data.ruleId }),
      limit,
    });
    // Native rule ids are Discord's, not Bananasaurs' — the dashboard builds
    // `?rule=` links only for Bananasaurs rule ids, and the native section
    // ignores the filter either way (PR-53).
    const nativeHits = ports.listUnreviewedNativeHits({ limit });
    const nativeBlocked = ports.nativeBlockedCount();
    const verdicts: Record<
      string,
      { falsePositive: number; truePositive: number; unclear: number }
    > = {};
    for (const rule of ports.listAutomodRules()) {
      verdicts[rule.ruleId] = rule.verdicts;
    }
    // Resolve who each member id is from live Discord, in one bulk fetch per
    // page; an unknown or departed member comes back null and the table
    // shows the bare id rather than a guess.
    const directory = new Map(
      (
        await ports.fetchGuildMembers([
          ...matches.map((m) => m.memberId),
          ...nativeHits.map((h) => h.memberId),
        ])
      ).map((m) => [m.memberId, m]),
    );
    return reply.status(200).send({
      matches: matches.map((m) => ({ ...m, member: directory.get(m.memberId) ?? null })),
      nativeHits: nativeHits.map((h) => ({ ...h, member: directory.get(h.memberId) ?? null })),
      nativeBlocked,
      verdicts,
    });
  });

  app.post<{ Params: { eventId: string } }>(
    '/api/automod/review/:eventId/verdict',
    (request, reply) => {
      if (!eventIdParamSchema.safeParse(request.params.eventId).success) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      const parsed = verdictBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);

      // A verdict is evidence, and revisable — no fresh password (PR-54).
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const ports = deps.portsFor(session.scope);
      const outcome = ports.recordMatchVerdict({
        eventId: request.params.eventId,
        verdict: parsed.data.verdict,
        reviewedBy: session.accountId,
        ...(parsed.data.note !== undefined && { note: parsed.data.note }),
      });
      if (outcome === 'no-such-event') return reply.status(404).send({ error: 'not-found' });

      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'automod_match.verdict_recorded',
        subjectType: 'automod_match',
        subjectId: request.params.eventId,
        before: undefined,
        after: {
          verdict: parsed.data.verdict,
          ...(parsed.data.note !== undefined && { note: parsed.data.note }),
          outcome,
        },
      });

      return reply.status(200).send({ ok: true, outcome });
    },
  );

  app.post<{ Params: { ruleId: string } }>(
    '/api/automod/rules/:ruleId/suppress',
    (request, reply) => {
      if (!ruleIdSchema.safeParse(request.params.ruleId).success) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      const parsed = suppressBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);

      // A suppression strictly narrows the rule, so no fresh password (PR-54)
      // and no change to the sign-off columns — the route writes nothing to
      // `mod_rules` (PR-59).
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const { kind, value } = parsed.data;
      if (kind === 'invite_code' && !INVITE_CODE_PATTERN.test(value)) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      if (kind === 'link_domain' && !LINK_DOMAIN_PATTERN.test(value.toLowerCase())) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      if (kind === 'channel_exemption' && !snowflakeIdSchema.safeParse(value).success) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      if (kind === 'allowlist_phrase' && value.trim().length === 0) {
        return reply.status(400).send({ error: 'bad-request' });
      }

      const ports = deps.portsFor(session.scope);
      let outcome: string;
      // The audit row says what actually happened, which differs on the deny
      // path below (a removal, not an insertion).
      let auditAfter: { readonly [key: string]: string | boolean } = { kind, value };
      if (kind === 'allowlist_phrase') {
        // Canonicalised with the same expression the port stores, so the
        // audit row and the written row agree.
        const phrase = value.toLowerCase().trim().replace(/\s+/g, ' ');
        const result = ports.addAutomodAllowlistPhrase({
          ruleId: request.params.ruleId,
          phrase,
        });
        if (result === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });
        if (result === 'wrong-kind') return reply.status(409).send({ error: 'wrong-kind' });
        outcome = result;
        auditAfter = { kind, value: phrase };
      } else if (kind === 'invite_code') {
        const result = ports.addInviteAllowlistEntry({
          ruleId: request.params.ruleId,
          code: value,
          label: 'added from review',
        });
        if (result === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });
        if (result === 'wrong-kind') return reply.status(409).send({ error: 'wrong-kind' });
        outcome = result;
      } else if (kind === 'link_domain') {
        // A deny-mode rule ignores allow rows — the predicate reads only the
        // list named by `config.mode` — so suppressing there means removing
        // the domain from the deny list instead, still strictly narrowing
        // (PR-59). A domain that matched via a parent entry is not itself on
        // the list, and only the configuration editor can narrow that.
        const detail = ports.findAutomodRuleDetail(request.params.ruleId);
        if (detail === undefined) return reply.status(404).send({ error: 'not-found' });
        let denyMode = false;
        try {
          denyMode = (JSON.parse(detail.config) as { mode?: unknown }).mode === 'deny';
        } catch {
          denyMode = false;
        }
        if (denyMode) {
          const result = ports.removeLinkDomain({
            ruleId: request.params.ruleId,
            domain: value.toLowerCase(),
          });
          if (result.outcome === 'no-such-rule')
            return reply.status(404).send({ error: 'not-found' });
          if (result.outcome === 'wrong-kind')
            return reply.status(409).send({ error: 'wrong-kind' });
          if (result.outcome === 'not-present')
            return reply.status(409).send({ error: 'not-denied' });
          outcome = 'added';
          auditAfter = { kind, value, listType: 'deny', removed: true };
        } else {
          const result = ports.addLinkDomain({
            ruleId: request.params.ruleId,
            domain: value,
            listType: 'allow',
          });
          if (result.outcome === 'no-such-rule')
            return reply.status(404).send({ error: 'not-found' });
          if (result.outcome === 'wrong-kind')
            return reply.status(409).send({ error: 'wrong-kind' });
          outcome = result.outcome;
        }
      } else {
        const result = ports.addAutomodExemption({
          ruleId: request.params.ruleId,
          exemptType: 'channel',
          exemptId: value,
        });
        if (result === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });
        outcome = result;
      }

      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'automod_rule.suppression_added',
        subjectType: 'automod_rule',
        subjectId: request.params.ruleId,
        before: undefined,
        after: auditAfter,
      });

      return reply.status(200).send({ ok: true, outcome });
    },
  );
};
