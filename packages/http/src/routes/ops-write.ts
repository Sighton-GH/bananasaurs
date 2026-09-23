import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CAPABILITIES,
  LOG_EVENT_KINDS,
  MAX_PANEL_OPTIONS,
  PANEL_BEHAVIOURS,
  PANEL_COMPONENTS,
  panelDefinitionSchema,
  snowflakeIdSchema,
} from '@bananasaurs/core';
import { eligibilityRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { dashboardAuditBase } from './audit-base.js';
import { isInstanceOwner } from './assistant.js';
import { requireCapability } from './capability.js';

/**
 * The dashboard's second write surface: the CLI's operator write commands
 * (`docs/17`) that the Release 1 routes did not yet cover (ADR 0051 D1–D3).
 * Automod rule management, review verdicts, cases, killswitch and the log
 * route setter already have routes in `write.ts` / `automod.ts` /
 * `cases.ts`; this module deliberately does not duplicate them.
 *
 * Same discipline as `write.ts`: nothing goes through `createDispatcher`
 * (it hard-codes `actorType: 'operator_cli'`), every handler builds its own
 * `OpsAuditWrite` from `dashboardAuditBase`, and every refusal the port
 * unions name becomes an audited-or-plain 4xx answer rather than a thrown
 * 500. Usage answers (`no-such-*`, `wrong-kind`, `not-failed`) map to 404
 * or 409 as the union's own comments direct; `already-present` /
 * `not-present` are real answers and return 200 with the outcome named.
 */

const eventKindParamSchema = z.string().refine(
  (k) => LOG_EVENT_KINDS.includes(k),
  (k) => ({
    message: `no such log event kind: ${k}`,
  }),
);

const settingsBodySchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('dry_run'), value: z.boolean() }),
  z.object({ key: z.literal('role_rate_per_min'), value: z.number().positive() }),
  z.object({ key: z.literal('reconcile_budget'), value: z.number().int().positive() }),
  z.object({ key: z.literal('breaker_threshold'), value: z.number().int().positive() }),
  z.object({ key: z.literal('breaker'), value: z.literal('closed') }),
]);

const accountCreateSchema = z.object({
  // The same shape `bananasaurs account` accepts (packages/core
  // ops/commands/account.ts): lowercase, digit, dot, dash, underscore, and
  // never a leading dash the CLI would read as a flag.
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/,
      'a username must start with a lowercase letter or digit, and may then contain ' +
        'lowercase letters, digits, dot, dash, underscore',
    ),
  // Explicit scope, reviewable before creation: access to THIS guild and
  // which capabilities inside it. Defaults are the least-privilege floor -
  // a fresh account reaches nothing.
  grantThisGuild: z.boolean().default(false),
  capabilities: z.array(z.enum(CAPABILITIES)).default([]),
});

const accountCapabilityGrantSchema = z.object({
  capability: z.enum(CAPABILITIES),
});

const archiveEnableBodySchema = z.object({
  channelId: snowflakeIdSchema,
  attachmentPolicy: z.enum(['none', 'bytes']),
});

const archiveCategoryBodySchema = z.object({
  channelId: snowflakeIdSchema,
});

const archiveThreadsBodySchema = z.object({
  value: z.enum(['all', 'none']),
});

const archiveLinkCaseBodySchema = z.object({
  messageId: snowflakeIdSchema,
  caseId: z.string().min(1),
});

const panelCreateBodySchema = z.object({
  panelId: z.string().min(1).max(64),
  channelId: snowflakeIdSchema,
  /**
   * `managed` (default): the bot posts the panel message on publish.
   * `adopted`: a reaction role attached to a message that already exists -
   * the self-granted roles builder's "attach to an existing message" flow,
   * validated against live Discord below before anything is written.
   */
  kind: z.enum(['managed', 'adopted']).optional(),
  messageId: snowflakeIdSchema.optional(),
  // The message the panel posts; blank or absent falls back to default copy.
  content: z.string().trim().min(1).max(2000).optional(),
  behaviour: z.enum(PANEL_BEHAVIOURS),
  component: z.enum(PANEL_COMPONENTS),
  maxRoles: z.number().int().positive().optional(),
  requiredRoleId: snowflakeIdSchema.optional(),
  blockedRoleIds: z.array(snowflakeIdSchema).optional(),
  options: z
    .array(
      z.object({
        optionId: z.string().min(1).max(64),
        roleId: snowflakeIdSchema,
        emojiKey: z.string().min(1).optional(),
        label: z.string().min(1).max(80).optional(),
        position: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(MAX_PANEL_OPTIONS),
});

const undoBodySchema = z.object({
  batchId: z.string().min(1),
  reason: z.string().min(1).max(500),
});

const sendAllowBodySchema = z.object({
  channelId: snowflakeIdSchema,
  accountId: z.string().min(1),
});

const adoptionAllowanceBodySchema = z.object({
  count: z.number().int().positive().max(100),
});

const signoffBodySchema = z.object({ signedOffBy: z.string().min(1).max(100) });

const inviteAllowlistBodySchema = z.object({
  code: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
});

const linkDomainBodySchema = z.object({
  domain: z.string().min(1).max(253),
  listType: z.enum(['allow', 'deny']),
});

const accountDisabledBodySchema = z.object({ disabled: z.boolean() });

const accountPasswordBodySchema = z.object({ confirm: z.literal(true) });

export const registerOpsWriteRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const jobId = Number(request.params.id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return reply.status(400).send({ error: 'bad-request' });
    }
    const ports = deps.portsFor(session.scope);
    const outcome = ports.retryJob(jobId);
    if (!outcome.ok) {
      if (outcome.reason === 'not-found') {
        return reply.status(404).send({ error: 'not-found' });
      }
      return reply.status(409).send({
        error: outcome.reason,
        ...('state' in outcome ? { state: outcome.state } : {}),
        ...('blockingJobId' in outcome ? { blockingJobId: outcome.blockingJobId } : {}),
      });
    }
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'job.retried',
      subjectType: 'job',
      subjectId: String(jobId),
      before: undefined,
      after: { retried: true },
    });
    return reply.status(200).send({ ok: true });
  });

  // The role-panel builder's submit (ADR 0053): the form's fields become
  // the same definition the CLI's `panel create --definition` takes, through
  // the same schema, into the same audit action. Creating never publishes —
  // going live stays POST /api/panels/:id/publish, so a half-built panel
  // cannot reach Discord.
  app.post('/api/panels', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'panels.manage', reply)) return reply;

    const body = panelCreateBodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid-body' });

    const parsed = panelDefinitionSchema.safeParse({ kind: 'managed', ...body.data });
    if (!parsed.success) {
      const problems = parsed.error.issues
        .slice(0, 3)
        .map((issue) => {
          const where = issue.path.join('.');
          return where === '' ? issue.message : `${where}: ${issue.message}`;
        })
        .join('; ');
      return reply.status(400).send({ error: 'invalid-definition', problems });
    }

    const definition = parsed.data;
    const ports = deps.portsFor(session.scope);
    if (ports.findPanel(definition.panelId) !== undefined) {
      return reply.status(409).send({ error: 'already-exists' });
    }

    // An adopted panel attaches to a message that already exists: validate
    // the target against live Discord so a typo'd channel or message id
    // fails here with a plain answer instead of becoming a panel that can
    // never reconcile (Bryan's roles lane: safe channel/message validation).
    if (definition.kind === 'adopted') {
      const lookup = await ports.findGuildMessage(definition.channelId, definition.messageId!);
      if (lookup !== 'ok') {
        const problems =
          lookup === 'channel-not-found'
            ? 'That channel is not in this server - pick the channel from the list.'
            : lookup === 'not-text-channel'
              ? 'Reactions only work on a text channel - pick a text channel.'
              : 'No message with that id exists in the picked channel - check the message id.';
        return reply.status(400).send({ error: 'message-unusable', problems });
      }
    }

    // A role the owner picked but nobody allowlisted yet joins the allowlist
    // here, provided the live hierarchy says the bot can manage it — the
    // audited save is the allowlisting intent. A role the bot cannot manage
    // (integration-owned, or at or above the bot's own highest role) is
    // refused with its reason visible.
    const botPosition = ports.botHighestRolePosition();
    const rolesById = new Map(ports.listGuildRoles().map((role) => [role.roleId, role]));
    const unmanageable = definition.options
      .filter((option) => !ports.isManagedRole(option.roleId))
      .filter((option) => {
        const role = rolesById.get(option.roleId);
        return (
          role === undefined ||
          role.managed ||
          botPosition === undefined ||
          role.position >= botPosition
        );
      })
      .map((option) => option.roleId);
    if (unmanageable.length > 0) {
      return reply.status(400).send({ error: 'unmanageable-role', roleIds: unmanageable });
    }
    const newlyAllowlisted = definition.options
      .filter((option) => !ports.isManagedRole(option.roleId))
      .map((option) => option.roleId);
    // One storage transaction owns both effects. If any panel row or option
    // insert fails, no managed-role grant survives the failed create.
    ports.createPanel(definition, newlyAllowlisted);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'panel.created',
      subjectType: 'panel',
      subjectId: definition.panelId,
      before: undefined,
      after: {
        kind: definition.kind,
        channelId: definition.channelId,
        ...(definition.messageId !== undefined && { messageId: definition.messageId }),
        behaviour: definition.behaviour,
        component: definition.component,
        optionCount: definition.options.length,
        newlyAllowlistedRoleIds: newlyAllowlisted,
      },
    });
    return reply.status(201).send({
      ok: true,
      panelId: definition.panelId,
      published: false,
      newlyAllowlistedRoleIds: newlyAllowlisted,
    });
  });

  app.post<{ Params: { id: string } }>('/api/panels/:id/publish', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'panels.manage', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    if (ports.findPanel(request.params.id) === undefined) {
      return reply.status(404).send({ error: 'not-found' });
    }
    const result = await ports.publishPanel(request.params.id);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'panel.published',
      subjectType: 'panel',
      subjectId: request.params.id,
      before: undefined,
      after: { action: result.action, messageId: result.messageId ?? null },
    });
    return reply.status(200).send(result);
  });

  app.post<{ Params: { id: string } }>('/api/panels/:id/reconcile', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'panels.manage', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    if (ports.findPanel(request.params.id) === undefined) {
      return reply.status(404).send({ error: 'not-found' });
    }
    const enqueued = ports.enqueueReconcile(request.params.id);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'panel.reconcile_enqueued',
      subjectType: 'panel',
      subjectId: request.params.id,
      before: undefined,
      after: { enqueued: enqueued.enqueued, jobId: enqueued.jobId ?? null },
    });
    return reply.status(200).send(enqueued);
  });

  app.post('/api/settings', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const parsed = settingsBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    ports.applySetting(parsed.data);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'setting.applied',
      subjectType: 'setting',
      subjectId: parsed.data.key,
      before: undefined,
      after: { value: parsed.data.value },
    });
    return reply.status(200).send({ ok: true });
  });

  app.post<{ Params: { eventKind: string }; Body: { enabled?: boolean } }>(
    '/api/log-routes/:eventKind/enabled',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'logging.manage', reply)) return reply;

      const kindParsed = eventKindParamSchema.safeParse(request.params.eventKind);
      const bodyParsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
      if (!kindParsed.success || !bodyParsed.success) {
        return reply.status(400).send({ error: 'bad-request' });
      }

      const ports = deps.portsFor(session.scope);
      const existed = ports.setRouteEnabled(kindParsed.data, bodyParsed.data.enabled);
      if (!existed) return reply.status(404).send({ error: 'not-found' });
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: bodyParsed.data.enabled ? 'log_route.enabled' : 'log_route.disabled',
        subjectType: 'log_route',
        subjectId: kindParsed.data,
        before: { enabled: !bodyParsed.data.enabled },
        after: { enabled: bodyParsed.data.enabled },
      });
      return reply.status(200).send({ ok: true });
    },
  );

  app.post('/api/log-exclusions', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'logging.manage', reply)) return reply;

    const parsed = z.object({ channelId: snowflakeIdSchema }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const added = ports.excludeChannel(parsed.data.channelId);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'log_exclusion.added',
      subjectType: 'channel',
      subjectId: parsed.data.channelId,
      before: { excluded: !added },
      after: { excluded: true },
    });
    return reply.status(200).send({ ok: true, added });
  });

  app.delete<{ Params: { channelId: string } }>(
    '/api/log-exclusions/:channelId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'logging.manage', reply)) return reply;

      const parsed = snowflakeIdSchema.safeParse(request.params.channelId);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      const removed = ports.unexcludeChannel(parsed.data);
      if (removed) {
        ports.recordAudit({
          ...dashboardAuditBase(session, deps.now()),
          action: 'log_exclusion.removed',
          subjectType: 'channel',
          subjectId: parsed.data,
          before: { excluded: true },
          after: { excluded: false },
        });
      }
      return reply.status(200).send({ ok: true, removed });
    },
  );

  app.post('/api/archive/channels', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const parsed = archiveEnableBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const outcome = ports.archiveEnableChannel(parsed.data);
    if (outcome === 'guild-not-archive-enabled') {
      return reply.status(409).send({ error: 'guild-not-archive-enabled' });
    }
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'archive_channel.enabled',
      subjectType: 'channel',
      subjectId: parsed.data.channelId,
      before: { enabled: outcome === 'already-enabled' },
      after: { enabled: true, attachmentPolicy: parsed.data.attachmentPolicy },
    });
    return reply.status(200).send({ outcome });
  });

  app.delete<{ Params: { channelId: string } }>(
    '/api/archive/channels/:channelId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const parsed = snowflakeIdSchema.safeParse(request.params.channelId);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      const outcome = ports.archiveDisableChannel(parsed.data);
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'archive_channel.disabled',
        subjectType: 'channel',
        subjectId: parsed.data,
        before: { enabled: outcome.outcome === 'disabled' },
        after: {
          enabled: false,
          ...('messageCount' in outcome ? { messagesDestroyed: outcome.messageCount } : {}),
        },
      });
      return reply.status(200).send(outcome);
    },
  );

  // `archive enable-category` / `disable-category` / `set-threads` (the
  // threads-merge commands): category scope and per-channel thread inclusion,
  // mirroring the channel routes' refusal shapes. A category enable carries
  // no attachment-policy choice because the CLI does not offer one either.
  app.post('/api/archive/categories', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const parsed = archiveCategoryBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const outcome = ports.archiveEnableCategory({
      channelId: parsed.data.channelId,
      attachmentPolicy: 'none',
    });
    if (outcome === 'no-such-channel') {
      return reply.status(404).send({ error: 'no-such-channel' });
    }
    if (outcome === 'guild-not-archive-enabled') {
      return reply.status(409).send({ error: 'guild-not-archive-enabled' });
    }
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'archive_category.enabled',
      subjectType: 'archive_category',
      subjectId: parsed.data.channelId,
      before: { enabled: outcome === 'already-enabled' },
      after: { enabled: true },
    });
    return reply
      .status(200)
      .send({ outcome, coverage: ports.archiveCategoryCoverage(parsed.data.channelId) });
  });

  app.delete<{ Params: { channelId: string } }>(
    '/api/archive/categories/:channelId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const parsed = snowflakeIdSchema.safeParse(request.params.channelId);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      const outcome = ports.archiveDisableCategory(parsed.data);
      if (outcome.outcome === 'disabled') {
        ports.recordAudit({
          ...dashboardAuditBase(session, deps.now()),
          action: 'archive_category.disabled',
          subjectType: 'archive_category',
          subjectId: parsed.data,
          before: { enabled: true },
          after: { enabled: false, messagesDestroyed: outcome.messageCount },
        });
      }
      return reply.status(200).send(outcome);
    },
  );

  app.post<{ Params: { channelId: string } }>(
    '/api/archive/channels/:channelId/threads',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const id = snowflakeIdSchema.safeParse(request.params.channelId);
      const parsed = archiveThreadsBodySchema.safeParse(request.body);
      if (!id.success || !parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      // Read the current inclusion before the write: a repeat set must not
      // record a change that never happened.
      const prior = ports
        .archiveStatus()
        .find((channel) => channel.channelId === id.data)?.includeThreads;
      const outcome = ports.archiveSetThreads(id.data, parsed.data.value === 'all');
      if (outcome === 'not-enabled') {
        return reply.status(404).send({ error: 'not-archived' });
      }
      if (outcome === 'forum-requires-all') {
        return reply.status(409).send({ error: 'forum-requires-all' });
      }
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'archive_channel.threads_set',
        subjectType: 'channel',
        subjectId: id.data,
        before: { threads: prior === false ? 'none' : 'all' },
        after: { threads: parsed.data.value },
      });
      return reply.status(200).send({ outcome });
    },
  );

  app.post<{ Params: { messageId: string } }>(
    '/api/archive/messages/:messageId/preserve',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const parsed = snowflakeIdSchema.safeParse(request.params.messageId);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      const outcome = ports.archivePreserve(parsed.data);
      if (outcome === 'no-such-message') {
        return reply.status(404).send({ error: 'not-found' });
      }
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'archive_message.preserved',
        subjectType: 'archive_message',
        subjectId: parsed.data,
        before: undefined,
        after: { preserved: true, already: outcome === 'already-preserved' },
      });
      return reply.status(200).send({ outcome });
    },
  );

  app.post('/api/archive/link-case', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'moderation.act', reply)) return reply;

    const parsed = archiveLinkCaseBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const outcome = ports.archiveLinkCase(parsed.data);
    if (outcome === 'no-such-message' || outcome === 'no-such-case') {
      return reply.status(404).send({ error: 'not-found' });
    }
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'archive_message.case_linked',
      subjectType: 'archive_message',
      subjectId: parsed.data.messageId,
      before: undefined,
      after: { caseId: parsed.data.caseId, outcome },
    });
    return reply.status(200).send({ outcome });
  });

  app.post<{ Params: { channelId: string } }>(
    '/api/archive/channels/:channelId/backfill',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const parsed = snowflakeIdSchema.safeParse(request.params.channelId);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      ports.enqueueArchiveBackfill(parsed.data);
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'archive_backfill.enqueued',
        subjectType: 'channel',
        subjectId: parsed.data,
        before: undefined,
        after: { enqueued: true },
      });
      return reply.status(200).send({ ok: true });
    },
  );

  app.post('/api/archive/reindex', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const indexed = ports.archiveReindex();
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'archive_reindex.ran',
      subjectType: 'guild',
      subjectId: session.guildId,
      before: undefined,
      after: { indexed },
    });
    return reply.status(200).send({ indexed });
  });

  app.post('/api/undo', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'undo.execute', reply)) return reply;

    const parsed = undoBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const batch = ports.findBatch(parsed.data.batchId);
    if (batch === undefined) return reply.status(404).send({ error: 'not-found' });
    if (batch.undoneAt !== null) {
      return reply.status(409).send({ error: 'already-undone' });
    }
    const undoable = ports.countUndoable(parsed.data.batchId);
    const enqueued = ports.enqueueUndo(parsed.data);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'undo.enqueued',
      subjectType: 'effect_batch',
      subjectId: parsed.data.batchId,
      before: { undoneAt: batch.undoneAt },
      after: { reason: parsed.data.reason, undoable: undoable.reversible },
    });
    return reply.status(200).send({ ...enqueued, undoable });
  });

  app.post('/api/send-allowlist', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const parsed = sendAllowBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const outcome = ports.allowSendChannel(parsed.data);
    if (outcome === 'no-such-channel') {
      return reply.status(404).send({ error: 'no-such-channel' });
    }
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'send_channel.allowed',
      subjectType: 'channel',
      subjectId: parsed.data.channelId,
      before: { allowed: outcome === 'already-allowed' },
      after: { allowed: true, accountId: parsed.data.accountId },
    });
    return reply.status(200).send({ outcome });
  });

  app.delete<{ Params: { channelId: string } }>(
    '/api/send-allowlist/:channelId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const parsed = snowflakeIdSchema.safeParse(request.params.channelId);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      const removed = ports.disallowSendChannel(parsed.data);
      if (removed) {
        ports.recordAudit({
          ...dashboardAuditBase(session, deps.now()),
          action: 'send_channel.disallowed',
          subjectType: 'channel',
          subjectId: parsed.data,
          before: { allowed: true },
          after: { allowed: false },
        });
      }
      return reply.status(200).send({ ok: true, removed });
    },
  );

  // `mcp allow-category` / `disallow-category`: the same allowlist at
  // category scope. Fastify's static segment wins over the `:channelId`
  // parameter above, so these sit beside the channel routes safely.
  app.post('/api/send-allowlist/categories', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const parsed = sendAllowBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const outcome = ports.allowSendCategory(parsed.data);
    if (outcome === 'no-such-channel') {
      return reply.status(404).send({ error: 'no-such-channel' });
    }
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'send_category.allowed',
      subjectType: 'send_category',
      subjectId: parsed.data.channelId,
      before: { allowed: outcome === 'already-allowed' },
      after: { allowed: true, accountId: parsed.data.accountId },
    });
    return reply.status(200).send({ outcome });
  });

  app.delete<{ Params: { channelId: string } }>(
    '/api/send-allowlist/categories/:channelId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const parsed = snowflakeIdSchema.safeParse(request.params.channelId);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      const outcome = ports.disallowSendCategory(parsed.data);
      if (outcome === 'removed') {
        ports.recordAudit({
          ...dashboardAuditBase(session, deps.now()),
          action: 'send_category.disallowed',
          subjectType: 'send_category',
          subjectId: parsed.data,
          before: { allowed: true },
          after: { allowed: false },
        });
      }
      return reply.status(200).send({ ok: true, outcome });
    },
  );

  app.post('/api/adoption-allowance', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'roles.mutate', reply)) return reply;

    const parsed = adoptionAllowanceBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const before = ports.adoptionAllowance();
    ports.grantAdoptionAllowance(parsed.data.count);
    const after = ports.adoptionAllowance();
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'adoption_allowance.granted',
      subjectType: 'guild',
      subjectId: session.guildId,
      before: { allowance: before },
      after: { allowance: after, granted: parsed.data.count },
    });
    return reply.status(200).send({ allowance: after });
  });

  app.post<{ Params: { ruleId: string } }>('/api/automod/rules/:ruleId/ready', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'moderation.act', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const outcome = ports.setAutomodRuleReady(request.params.ruleId);
    if (!outcome.ok) {
      return reply.status(409).send({ error: outcome.reason, state: outcome.state });
    }
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'automod_rule.ready',
      subjectType: 'automod_rule',
      subjectId: request.params.ruleId,
      before: undefined,
      after: { ready: true },
    });
    return reply.status(200).send({ ok: true });
  });

  app.post<{ Params: { ruleId: string } }>(
    '/api/automod/rules/:ruleId/signoff',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'moderation.act', reply)) return reply;

      const parsed = signoffBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      if (ports.findAutomodRule(request.params.ruleId) === undefined) {
        return reply.status(404).send({ error: 'not-found' });
      }
      ports.recordAutomodSignOff({
        ruleId: request.params.ruleId,
        signedOffBy: parsed.data.signedOffBy,
      });
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'automod_rule.signed_off',
        subjectType: 'automod_rule',
        subjectId: request.params.ruleId,
        before: undefined,
        after: { signedOffBy: parsed.data.signedOffBy },
      });
      return reply.status(200).send({ ok: true });
    },
  );

  app.post<{ Params: { ruleId: string } }>(
    '/api/automod/rules/:ruleId/invite-allowlist',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'moderation.act', reply)) return reply;

      const parsed = inviteAllowlistBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      const outcome = ports.addInviteAllowlistEntry({
        ruleId: request.params.ruleId,
        ...parsed.data,
      });
      if (outcome === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });
      if (outcome === 'wrong-kind') return reply.status(409).send({ error: 'wrong-kind' });
      if (outcome === 'added') {
        ports.recordAudit({
          ...dashboardAuditBase(session, deps.now()),
          action: 'invite_allowlist.added',
          subjectType: 'automod_rule',
          subjectId: request.params.ruleId,
          before: undefined,
          after: { code: parsed.data.code, label: parsed.data.label },
        });
      }
      return reply.status(200).send({ outcome });
    },
  );

  app.delete<{ Params: { ruleId: string; code: string } }>(
    '/api/automod/rules/:ruleId/invite-allowlist/:code',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'moderation.act', reply)) return reply;

      const ports = deps.portsFor(session.scope);
      const outcome = ports.removeInviteAllowlistEntry({
        ruleId: request.params.ruleId,
        code: request.params.code,
      });
      if (outcome === 'no-such-rule') return reply.status(404).send({ error: 'not-found' });
      if (outcome === 'wrong-kind') return reply.status(409).send({ error: 'wrong-kind' });
      if (outcome === 'removed') {
        ports.recordAudit({
          ...dashboardAuditBase(session, deps.now()),
          action: 'invite_allowlist.removed',
          subjectType: 'automod_rule',
          subjectId: request.params.ruleId,
          before: { code: request.params.code },
          after: undefined,
        });
      }
      return reply.status(200).send({ outcome });
    },
  );

  app.post<{ Params: { ruleId: string } }>(
    '/api/automod/rules/:ruleId/link-domains',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'moderation.act', reply)) return reply;

      const parsed = linkDomainBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const ports = deps.portsFor(session.scope);
      const result = ports.addLinkDomain({ ruleId: request.params.ruleId, ...parsed.data });
      if (result.outcome === 'no-such-rule') {
        return reply.status(404).send({ error: 'not-found' });
      }
      if (result.outcome === 'wrong-kind') {
        return reply.status(409).send({ error: 'wrong-kind' });
      }
      if (result.outcome === 'added') {
        ports.recordAudit({
          ...dashboardAuditBase(session, deps.now()),
          action: 'link_domain.added',
          subjectType: 'automod_rule',
          subjectId: request.params.ruleId,
          before: undefined,
          after: { domain: parsed.data.domain, listType: parsed.data.listType },
        });
      }
      return reply.status(200).send(result);
    },
  );

  app.delete<{ Params: { ruleId: string; domain: string } }>(
    '/api/automod/rules/:ruleId/link-domains/:domain',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'moderation.act', reply)) return reply;

      const ports = deps.portsFor(session.scope);
      const result = ports.removeLinkDomain({
        ruleId: request.params.ruleId,
        domain: request.params.domain,
      });
      if (result.outcome === 'no-such-rule') {
        return reply.status(404).send({ error: 'not-found' });
      }
      if (result.outcome === 'wrong-kind') {
        return reply.status(409).send({ error: 'wrong-kind' });
      }
      if (result.outcome === 'removed') {
        ports.recordAudit({
          ...dashboardAuditBase(session, deps.now()),
          action: 'link_domain.removed',
          subjectType: 'automod_rule',
          subjectId: request.params.ruleId,
          before: { domain: request.params.domain },
          after: undefined,
        });
      }
      return reply.status(200).send(result);
    },
  );

  app.post('/api/backup-now', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const result = deps.instance.backupNow();
    // Instance-level effect with no guild scope: the audit row still
    // attributes through the session's guild, the scope the operator was
    // acting from.
    const ports = deps.portsFor(session.scope);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: result.ok ? 'backup.ran' : 'backup.failed',
      subjectType: 'instance',
      subjectId: 'instance',
      before: undefined,
      after: result.ok
        ? { fileName: result.fileName, sizeBytes: result.sizeBytes, pruned: result.prunedCount }
        : { error: result.error },
    });
    if (!result.ok)
      return reply.status(500).send({ error: 'backup-failed', message: result.error });
    return reply.status(200).send(result);
  });

  app.post<{ Params: { provider: string } }>(
    '/api/providers/:provider/review',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const result = deps.instance.providerReview(request.params.provider);
      if (result === 'no-such-provider') {
        return reply.status(404).send({ error: 'no-such-provider' });
      }
      const ports = deps.portsFor(session.scope);
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'provider.reviewed',
        subjectType: 'provider',
        subjectId: request.params.provider,
        before: undefined,
        after: { trainsOnInput: result.trainsOnInput, reviewedAt: result.reviewedAt },
      });
      return reply.status(200).send(result);
    },
  );

  const providerTermsBodySchema = z.object({
    trainsOnInput: z.enum(['no', 'yes', 'unknown']),
    evidenceClause: z.string().trim().min(10).max(2000),
    evidenceUrl: z.string().url().max(500).refine((u) => u.startsWith('https://')),
    productionUseAllowed: z.boolean(),
  });
  const TERMS_PROVIDERS = new Set(['gemini', 'openrouter', 'nvidia-nim']);

  app.put<{ Params: { provider: string } }>('/api/providers/:provider/terms', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!isInstanceOwner(deps, session))
      return reply.status(403).send({ error: 'owner-only' });
    const provider = request.params.provider;
    if (!TERMS_PROVIDERS.has(provider))
      return reply.status(404).send({ error: 'no-such-provider' });
    const parsed = providerTermsBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });
    const beforeRow = eligibilityRepo.findEligibility(deps.scopes.instance(), provider);
    const before =
      beforeRow === undefined
        ? undefined
        : {
            trainsOnInput: beforeRow.trainsOnInput,
            evidenceUrl: beforeRow.evidenceUrl,
            evidenceClause: beforeRow.evidenceClause ?? null,
            productionUseAllowed: beforeRow.productionUseAllowed,
            reviewedAt: beforeRow.reviewedAt,
          };
    const now = deps.now();
    eligibilityRepo.recordEligibilityClaim(deps.scopes.instance(), {
      ...parsed.data,
      provider,
      now,
    });
    const afterRow = eligibilityRepo.findEligibility(deps.scopes.instance(), provider);
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, now),
      action: 'provider.terms_recorded',
      subjectType: 'provider',
      subjectId: provider,
      before,
      after: {
        trainsOnInput: parsed.data.trainsOnInput,
        evidenceUrl: parsed.data.evidenceUrl,
        evidenceClause: parsed.data.evidenceClause,
        productionUseAllowed: parsed.data.productionUseAllowed,
        reviewedAt: now,
      },
    });
    return reply.status(200).send(afterRow);
  });

  app.post<{ Params: { username: string } }>(
    '/api/accounts/:username/disabled',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'accounts.manage', reply)) return reply;

      const parsed = accountDisabledBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const result = deps.instance.accountSetDisabled(
        request.params.username,
        parsed.data.disabled,
      );
      if (result === 'no-such-account') {
        return reply.status(404).send({ error: 'no-such-account' });
      }
      const ports = deps.portsFor(session.scope);
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: result.disabled ? 'account.disabled' : 'account.enabled',
        subjectType: 'account',
        subjectId: result.username,
        before: { disabled: !result.disabled },
        after: { disabled: result.disabled, enabledOwnersRemaining: result.enabledOwnersRemaining },
      });
      return reply.status(200).send(result);
    },
  );

  // Owner-provisioned account creation, web half: the account starts
  // non-owner with nothing, and the guild access and capabilities the form
  // named are granted here as real grants (the same levers the page edits
  // with afterwards). The generated password is returned exactly once and
  // appears in no audit row.
  app.post('/api/accounts', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'accounts.manage', reply)) return reply;

    const parsed = accountCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'bad-request', issues: parsed.error.issues });
    }
    // A capability lives inside a guild, so granting one without the guild
    // is a form mistake, not a state - refuse it before anything is created.
    if (parsed.data.capabilities.length > 0 && !parsed.data.grantThisGuild) {
      return reply.status(400).send({
        error: 'capabilities-need-guild-access',
        message:
          'capabilities live inside a guild: grant this guild to the new account, or create it with no capabilities',
      });
    }

    const created = await deps.instance.accountCreate(parsed.data.username);
    if (created === 'username-taken') {
      return reply.status(409).send({ error: 'username-taken' });
    }

    const ports = deps.portsFor(session.scope);
    let guildAccess = false;
    if (parsed.data.grantThisGuild) {
      guildAccess = ports.accountGrantGuild(parsed.data.username) === 'granted';
    }
    const grantedCapabilities: string[] = [];
    if (guildAccess) {
      for (const capability of parsed.data.capabilities) {
        const outcome = ports.grantAccountCapability({
          username: parsed.data.username,
          capability,
          grantedBy: session.accountId,
        });
        if (outcome === 'granted' || outcome === 'already-held') {
          grantedCapabilities.push(capability);
        }
      }
    }
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'account.created',
      subjectType: 'account',
      subjectId: parsed.data.username,
      before: undefined,
      after: {
        isOwner: false,
        guildAccess,
        capabilities: grantedCapabilities,
      },
    });
    return reply.status(201).send({
      accountId: created.accountId,
      username: created.username,
      password: created.password,
      guildAccess,
      capabilities: grantedCapabilities,
    });
  });

  app.delete<{ Params: { username: string } }>('/api/accounts/:username', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'accounts.manage', reply)) return reply;

    const result = deps.instance.accountDelete(request.params.username);
    if (result === 'no-such-account') {
      return reply.status(404).send({ error: 'no-such-account' });
    }
    const ports = deps.portsFor(session.scope);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'account.deleted',
      subjectType: 'account',
      subjectId: result.username,
      before: { isOwner: result.wasOwner },
      after: {
        tokensRevoked: result.tokensRevoked,
        codesDeleted: result.codesDeleted,
        enabledOwnersRemaining: result.enabledOwnersRemaining,
      },
    });
    return reply.status(200).send(result);
  });

  app.post<{ Params: { username: string } }>(
    '/api/accounts/:username/revoke-credentials',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'accounts.manage', reply)) return reply;

      const result = deps.instance.accountRevokeCredentials(request.params.username);
      if (result === 'no-such-account') {
        return reply.status(404).send({ error: 'no-such-account' });
      }
      const ports = deps.portsFor(session.scope);
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'account.credentials_revoked',
        subjectType: 'account',
        subjectId: result.username,
        before: undefined,
        after: {
          sessionsRevoked: result.sessionsRevoked,
          tokensRevoked: result.tokensRevoked,
          codesDeleted: result.codesDeleted,
          guildsTouched: result.guildsTouched,
        },
      });
      return reply.status(200).send(result);
    },
  );

  app.post<{ Params: { username: string } }>(
    '/api/accounts/:username/password',
    async (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'accounts.manage', reply)) return reply;

      // The body is the operator's explicit confirmation, mirroring the
      // CLI's prompt: the response carries the new plaintext exactly once,
      // and nothing but that one response ever sees it — never an audit row,
      // never a log line (S13-D3/D4).
      const parsed = accountPasswordBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

      const result = await deps.instance.accountSetPassword(request.params.username);
      if (result === 'no-such-account') {
        return reply.status(404).send({ error: 'no-such-account' });
      }
      const ports = deps.portsFor(session.scope);
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'account.password_reset',
        subjectType: 'account',
        subjectId: result.username,
        before: undefined,
        after: { sessionsRevoked: result.sessionsRevoked, guildsTouched: result.guildsTouched },
      });
      return reply.status(200).send(result);
    },
  );

  app.post<{ Params: { username: string } }>(
    '/api/accounts/:username/grant-guild',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'accounts.manage', reply)) return reply;

      const ports = deps.portsFor(session.scope);
      const outcome = ports.accountGrantGuild(request.params.username);
      if (outcome === 'no-such-account') {
        return reply.status(404).send({ error: 'no-such-account' });
      }
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'account.guild_granted',
        subjectType: 'account',
        subjectId: request.params.username,
        before: { hadAccess: outcome === 'already-had-it' },
        after: { guildId: session.guildId },
      });
      return reply.status(200).send({ outcome });
    },
  );

  app.post<{ Params: { username: string } }>(
    '/api/accounts/:username/revoke-guild',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'accounts.manage', reply)) return reply;

      const ports = deps.portsFor(session.scope);
      const outcome = ports.accountRevokeGuild(request.params.username);
      if (outcome === 'no-such-account') {
        return reply.status(404).send({ error: 'no-such-account' });
      }
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'account.guild_revoked',
        subjectType: 'account',
        subjectId: request.params.username,
        before: { hadAccess: true },
        after: { revoked: outcome === 'revoked' },
      });
      return reply.status(200).send({ outcome });
    },
  );

  // `bananasaurs account grant <username> <capability> --confirm`, web half:
  // grants one capability in THIS guild. Unknown accounts and accounts that
  // cannot reach the guild are usage answers (404/409) with no audit row,
  // exactly the CLI's throws; a repeat grant is audited with changed:false,
  // exactly the CLI's `already-held` row.
  app.post<{ Params: { username: string } }>(
    '/api/accounts/:username/capabilities',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'accounts.manage', reply)) return reply;

      const parsed = accountCapabilityGrantSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'bad-request', issues: parsed.error.issues });
      }

      const ports = deps.portsFor(session.scope);
      const outcome = ports.grantAccountCapability({
        username: request.params.username,
        capability: parsed.data.capability,
        // Recorded, consulted for nothing - the same posture the CLI takes
        // with `unixUserClaimed` (ADR 0024, amendment 2). Here the actor is
        // the session account, already on the audit row via dashboardAuditBase.
        grantedBy: session.accountId,
      });
      if (outcome === 'no-such-account') {
        return reply.status(404).send({ error: 'no-such-account' });
      }
      if (outcome === 'no-guild-access') {
        return reply.status(409).send({
          error: 'no-guild-access',
          message: `account ${request.params.username} cannot reach this guild, so it cannot hold a capability here`,
        });
      }
      ports.recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'account.capability.granted',
        subjectType: 'account',
        subjectId: request.params.username,
        before: { held: outcome === 'already-held' },
        after: {
          held: true,
          capability: parsed.data.capability,
          changed: outcome === 'granted',
        },
      });
      return reply.status(200).send({ outcome });
    },
  );

  app.post<{ Params: { tokenId: string } }>('/api/mcp/tokens/:tokenId/revoke', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    // Like the CLI, an unknown id is a usage answer with no audit row:
    // nothing changed. The port revokes the token's whole lineage.
    const tokensRevoked = deps.instance.mcpRevokeToken(request.params.tokenId);
    if (tokensRevoked === undefined) {
      return reply
        .status(404)
        .send({ error: 'no-such-token', message: `no such token ${request.params.tokenId}` });
    }
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'mcp.token.revoked',
      subjectType: 'instance',
      subjectId: 'instance',
      before: { tokenId: request.params.tokenId, live: true },
      after: { tokenId: request.params.tokenId, live: false, tokensRevoked },
    });
    return reply.status(200).send({ tokenId: request.params.tokenId, tokensRevoked });
  });

  app.post<{ Params: { clientId: string } }>(
    '/api/mcp/clients/:clientId/revoke',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'config.write', reply)) return reply;

      const tokensRevoked = deps.instance.mcpRevokeClient(request.params.clientId);
      if (tokensRevoked === undefined) {
        return reply
          .status(404)
          .send({ error: 'no-such-client', message: `no such client ${request.params.clientId}` });
      }
      deps.portsFor(session.scope).recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'mcp.client.revoked',
        subjectType: 'instance',
        subjectId: 'instance',
        before: { clientId: request.params.clientId },
        after: { clientId: request.params.clientId, tokensRevoked },
      });
      return reply.status(200).send({ clientId: request.params.clientId, tokensRevoked });
    },
  );
};
