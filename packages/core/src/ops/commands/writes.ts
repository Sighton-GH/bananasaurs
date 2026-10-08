import { z } from 'zod';
import { snowflakeIdSchema } from '../../ids.js';
import { LOG_EVENT_KINDS } from '../../logging/subscriber.js';
import {
  logRouteIdSchema,
  logRouteInputSchema,
  type LogRouteInput,
} from '../../logging/route-input.js';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';
import type { OpsLogRoute } from '../ports.js';
import type { JsonValue } from '../protocol.js';
import { findSetting, OPS_SETTINGS, parseSettingValue } from '../settings.js';
import { OPS_AUDIT_ACTIONS } from '../audit-actions.js';

/**
 * The write half of the Release 1 surface that stays inside the database:
 * `config set`, `log routing create|update|on|off|delete|exclude|unexclude`, `jobs retry`.
 *
 * None of these reaches Discord. That is the line the slice is cut on — the
 * commands that do (`panel sync`, `undo`, `adoption allow`) go through the
 * effect gateway and its twelve layers, and they are 13e.
 *
 * Every one of them returns an `OpsWriteResult`, so the audit record is not
 * something a handler can forget: `write: true` and a missing `audit` field do
 * not compile (`dispatch.ts`). The dispatcher fills in the actor, the channel
 * and the timestamp, because a command does not get to choose how it is
 * attributed (ADR 0024).
 */

/**
 * A snowflake, validated at the boundary rather than at the CHECK constraint.
 *
 * `snowflakeIdSchema` rather than a local regex, for its error map: a request
 * built by an agent rather than typed at a shell can carry a *numeric*
 * snowflake, which is already corrupted by the time it arrives and matches
 * every format check we could write. That is the one failure a regex cannot
 * catch, and the reason `ids.ts` exists.
 */
const channelIdArg = snowflakeIdSchema;

// --- config set --------------------------------------------------------------

const configSetArgs = z.object({
  key: z.string().min(1).max(64),
  value: z.string().min(1).max(64),
});

export const configSetCommand = defineCommand<z.infer<typeof configSetArgs>>({
  name: 'config set',
  write: true,
  summary: 'change one per-guild runtime setting',
  positional: [
    {
      name: 'key',
      required: true,
      describe: `one of: ${OPS_SETTINGS.map((s) => s.key).join(', ')}`,
    },
    { name: 'value', required: true, describe: 'on|off, a positive whole number, or `closed`' },
  ],
  args: configSetArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const spec = findSetting(args.key);
    if (spec === undefined) {
      // ADR 0025: two namespaces, one key space to the operator. An environment
      // key is refused by name rather than reported as unknown, because "no
      // such key" would be false — it exists, it is just not settable here.
      const env = ctx.instance.redactedConfig();
      if (Object.prototype.hasOwnProperty.call(env, args.key)) {
        throw new Error(
          `${args.key} is process configuration, not a guild setting. It is read from the\n` +
            `  environment at start (/etc/bananasaurs/env on the host) and takes effect on\n` +
            `  restart; nothing running can change it.\n` +
            (ENV_EQUIVALENT[args.key] === undefined
              ? ''
              : `\n  The per-guild setting with the same effect is \`${ENV_EQUIVALENT[args.key] ?? ''}\`.\n`) +
            `\n  Settable here: ${OPS_SETTINGS.map((s) => s.key).join(', ')}`,
        );
      }
      throw new Error(
        `no such setting: ${args.key}\n\n` +
          `  Settable: ${OPS_SETTINGS.map((s) => s.key).join(', ')}\n` +
          `  Read-only process configuration: use \`config get\` for ${Object.keys(env).sort().slice(0, 3).join(', ')}, ...`,
      );
    }

    const parsed = parseSettingValue(spec, args.value);
    if (!parsed.ok) throw new Error(parsed.message);

    const state = ctx.ports.safetyState();
    if (state === undefined) {
      throw new Error(
        `guild ${ctx.guildId} has no row in \`guilds\`, so it has no settings to change. ` +
          `The daemon writes that row at startup; this usually means it has never ` +
          `started for this guild.`,
      );
    }

    const before = currentValue(spec.key, state);
    ctx.ports.applySetting(parsed.change);
    const after = parsed.change.value;

    const lines = [`${spec.key}: ${render(before)} -> ${render(after)}`];

    // The interaction ADR 0025 exists to make visible: the environment
    // overwrites `guilds.dry_run` on every start, so this change is durable
    // only until the next restart unless the two agree.
    if (spec.overriddenBy !== undefined) {
      const configured = ctx.instance.redactedConfig()[spec.overriddenBy];
      if (typeof configured === 'boolean' && configured !== after) {
        lines.push(
          '',
          `  WARNING: ${spec.overriddenBy}=${String(configured)} in this process's environment,`,
          `  and it is written over ${spec.key} at every start. This change holds until the`,
          `  daemon restarts, and then the environment wins. Change the environment file`,
          `  too if you meant this to last.`,
        );
      }
    }

    return {
      text: lines.join('\n'),
      data: { key: spec.key, before, after },
      audit: {
        action: OPS_AUDIT_ACTIONS.configSet,
        subjectType: 'setting',
        subjectId: spec.key,
        before: { [spec.key]: before },
        after: { [spec.key]: after },
      },
    };
  },
});

/** The environment key that overwrites a guild setting, read the other way. */
const ENV_EQUIVALENT: Readonly<Record<string, string | undefined>> = {
  BANANASAURS_DRY_RUN: 'dry_run',
  BANANASAURS_ROLE_RATE_LIMIT_PER_MIN: 'role_rate_per_min',
  BANANASAURS_RECONCILE_BUDGET: 'reconcile_budget',
  BANANASAURS_ERROR_BREAKER_THRESHOLD: 'breaker_threshold',
};

/** A settable key's current value, read from the one row that holds them all. */
export const currentValue = (
  key: string,
  state: {
    dryRun: boolean;
    roleRatePerMin: number;
    reconcileBudget: number;
    breakerThreshold: number;
    breakerOpen: boolean;
  },
): boolean | number | string => {
  switch (key) {
    case 'dry_run':
      return state.dryRun;
    case 'role_rate_per_min':
      return state.roleRatePerMin;
    case 'reconcile_budget':
      return state.reconcileBudget;
    case 'breaker_threshold':
      return state.breakerThreshold;
    default:
      return state.breakerOpen ? 'open' : 'closed';
  }
};

const render = (value: boolean | number | string): string =>
  typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);

// --- log routing create / update / on / off / delete -------------------------

const routeIdArg = logRouteIdSchema;

const routeFlagsArgs = z.object({
  events: z.string().min(1),
  exclude: z.string().min(1).optional(),
  name: z.string().min(1).max(100).optional(),
  'no-content': z.boolean().default(false),
});

const routeFlags: { name: string; kind: 'string' | 'boolean'; describe: string }[] = [
  {
    name: 'events',
    kind: 'string',
    describe: `comma-separated kinds, or 'all': ${LOG_EVENT_KINDS.join(', ')}`,
  },
  {
    name: 'exclude',
    kind: 'string',
    describe: 'comma-separated channel ids to exclude from this route only',
  },
  { name: 'name', kind: 'string', describe: 'a name for the route (defaults to the channel)' },
  {
    name: 'no-content',
    kind: 'boolean',
    describe: 'log that it happened without reproducing the message text',
  },
];

/** `'all'` expands to every kind; anything else is a comma-separated list. */
const parseEventsFlag = (raw: string): string[] => {
  if (raw.trim() === 'all') return [...LOG_EVENT_KINDS];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

const parseExcludeFlag = (raw: string | undefined): string[] => {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

/**
 * The CLI's flags through the shared schema, so the CLI and the HTTP API
 * cannot disagree about what a route is. Throws a plain Error naming the
 * refusal — the dispatcher reports it as a usage failure, the way it does
 * for an unknown route id below.
 */
const parseRouteInput = (
  args: z.infer<typeof routeFlagsArgs> & { channel: z.infer<typeof channelIdArg> },
  enabled?: boolean,
): LogRouteInput => {
  const parsed = logRouteInputSchema.safeParse({
    ...(args.name !== undefined && { name: args.name }),
    channelId: args.channel,
    includeContent: !(args['no-content'] ?? false),
    ...(enabled !== undefined && { enabled }),
    eventKinds: parseEventsFlag(args.events),
    excludedChannelIds: parseExcludeFlag(args.exclude),
  });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) =>
          issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
        )
        .join('; '),
    );
  }
  return parsed.data;
};

/**
 * The audited shape of a route: the same projection the HTTP API writes into
 * its `before`/`after`, so the two trails read the same.
 */
const routeAuditShape = (route: OpsLogRoute): { [k: string]: JsonValue } => ({
  name: route.name,
  channelId: route.channelId,
  includeContent: route.includeContent,
  enabled: route.enabled,
  eventKinds: [...route.eventKinds],
  excludedChannelIds: [...route.excludedChannelIds],
});

const routeData = (route: OpsLogRoute): { [k: string]: JsonValue } => ({
  routeId: route.routeId,
  ...routeAuditShape(route),
  createdAtMs: route.createdAtMs,
});

/**
 * Stated every time, not only when it changes. Whether a log line quotes
 * the message is the privacy-relevant half of this command, and an operator
 * who is told only the channel has been told the less important half.
 */
const contentNoteFor = (includeContent: boolean): string =>
  includeContent
    ? 'Message content is included in the log line.'
    : 'Message content is NOT included; the log records that it happened.';

const logRoutingCreateArgs = z.object({
  channel: channelIdArg,
  ...routeFlagsArgs.shape,
});

export const logRoutingCreateCommand = defineCommand<z.infer<typeof logRoutingCreateArgs>>({
  name: 'log routing create',
  write: true,
  summary: 'log event kinds to a channel as a named route',
  positional: [{ name: 'channel', required: true, describe: 'the destination channel id' }],
  flags: routeFlags,
  args: logRoutingCreateArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const input = parseRouteInput(args);
    // The schema leaves `enabled` undefined when omitted; a create defaults
    // it to on (`update` keeps the stored route's own state instead).
    const route = ctx.ports.createRoute({ ...input, enabled: input.enabled ?? true });

    return {
      text:
        `Created route ${route.routeId.slice(0, 8)} "${route.name}": ` +
        `${String(route.eventKinds.length)} event kinds -> <#${route.channelId}>.` +
        `\n  ${contentNoteFor(route.includeContent)}`,
      data: { route: routeData(route) },
      audit: {
        action: OPS_AUDIT_ACTIONS.logRouteCreated,
        subjectType: 'log_route',
        subjectId: route.routeId,
        before: undefined,
        after: routeAuditShape(route),
      },
    };
  },
});

const logRoutingUpdateArgs = z.object({
  route: routeIdArg,
  channel: channelIdArg,
  ...routeFlagsArgs.shape,
});

export const logRoutingUpdateCommand = defineCommand<z.infer<typeof logRoutingUpdateArgs>>({
  name: 'log routing update',
  write: true,
  summary: "replace a route's channel, events, exclusions, name and content flag",
  positional: [
    { name: 'route', required: true, describe: 'the route id from `log routing list`' },
    { name: 'channel', required: true, describe: 'the new destination channel id' },
  ],
  flags: routeFlags,
  args: logRoutingUpdateArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const before = ctx.ports.getRoute(args.route);
    if (before === undefined) {
      // Refused rather than reported as success. An operator who mistyped a
      // route id must not be told that the route they named has been replaced,
      // because they will believe it.
      throw new Error(
        `${args.route} names no log route in guild ${ctx.guildId}, so there was nothing to update.\n` +
          `  Run \`bananasaurs log routing list\` to see what is configured.`,
      );
    }
    // The enabled state is the route's own, not a flag: update replaces the
    // content, `on`/`off` flips the switch.
    const input = parseRouteInput(args, before.enabled);
    // The stored state was handed to the parser, so `enabled` is resolved;
    // the `??` is the type-level proof the ports require, never taken.
    const updated = ctx.ports.updateRoute(args.route, {
      ...input,
      enabled: input.enabled ?? before.enabled,
    });
    if (updated === undefined) {
      throw new Error(
        `${args.route} names no log route in guild ${ctx.guildId}, so there was nothing to update.\n` +
          `  Run \`bananasaurs log routing list\` to see what is configured.`,
      );
    }

    return {
      text:
        `Updated route ${updated.routeId.slice(0, 8)} "${updated.name}": ` +
        `${String(updated.eventKinds.length)} event kinds -> <#${updated.channelId}>.` +
        `\n  ${contentNoteFor(updated.includeContent)}`,
      data: { route: routeData(updated) },
      audit: {
        action: OPS_AUDIT_ACTIONS.logRouteUpdated,
        subjectType: 'log_route',
        subjectId: updated.routeId,
        before: routeAuditShape(before),
        after: routeAuditShape(updated),
      },
    };
  },
});

const logRoutingOnArgs = z.object({ route: routeIdArg });

export const logRoutingOnCommand = defineCommand<z.infer<typeof logRoutingOnArgs>>({
  name: 'log routing on',
  write: true,
  summary: 'turn a route back on, keeping its channel',
  positional: [{ name: 'route', required: true, describe: 'the route id from `log routing list`' }],
  args: logRoutingOnArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const before = ctx.ports.getRoute(args.route);
    if (before === undefined) {
      throw new Error(
        `${args.route} names no log route in guild ${ctx.guildId}, so there was nothing to turn on.\n` +
          `  Run \`bananasaurs log routing list\` to see what is configured.`,
      );
    }
    ctx.ports.setRouteEnabled(args.route, true);

    return {
      text: `Route ${args.route.slice(0, 8)} "${before.name}" logs to <#${before.channelId}> again.`,
      data: { routeId: args.route, enabled: true },
      audit: {
        action: OPS_AUDIT_ACTIONS.logRouteEnabled,
        subjectType: 'log_route',
        subjectId: args.route,
        before: { enabled: before.enabled },
        after: { enabled: true },
      },
    };
  },
});

const logRoutingOffArgs = z.object({ route: routeIdArg });

export const logRoutingOffCommand = defineCommand<z.infer<typeof logRoutingOffArgs>>({
  name: 'log routing off',
  write: true,
  summary: 'stop a route logging, keeping its channel',
  positional: [{ name: 'route', required: true, describe: 'the route id from `log routing list`' }],
  args: logRoutingOffArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const before = ctx.ports.getRoute(args.route);
    if (before === undefined) {
      // Refused rather than reported as success. An operator who mistyped a
      // route id must not be told that the logging they asked to stop has
      // stopped, because they will believe it.
      throw new Error(
        `${args.route} names no log route in guild ${ctx.guildId}, so there was nothing to turn off.\n` +
          `  Run \`bananasaurs log routing list\` to see what is configured.`,
      );
    }
    ctx.ports.setRouteEnabled(args.route, false);

    return {
      text:
        `Route ${args.route.slice(0, 8)} "${before.name}" no longer logs to Discord.\n` +
        `  The route is kept, so \`log routing on ${args.route}\` turns it back on.`,
      data: { routeId: args.route, enabled: false },
      audit: {
        action: OPS_AUDIT_ACTIONS.logRouteDisabled,
        subjectType: 'log_route',
        subjectId: args.route,
        before: { enabled: before.enabled },
        after: { enabled: false },
      },
    };
  },
});

const logRoutingDeleteArgs = z.object({ route: routeIdArg });

export const logRoutingDeleteCommand = defineCommand<z.infer<typeof logRoutingDeleteArgs>>({
  name: 'log routing delete',
  write: true,
  summary: 'delete a route; its id is never reused',
  positional: [{ name: 'route', required: true, describe: 'the route id from `log routing list`' }],
  args: logRoutingDeleteArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const before = ctx.ports.getRoute(args.route);
    if (before === undefined) {
      throw new Error(
        `${args.route} names no log route in guild ${ctx.guildId}, so there was nothing to delete.\n` +
          `  Run \`bananasaurs log routing list\` to see what is configured.`,
      );
    }
    ctx.ports.deleteRoute(args.route);

    return {
      text: `Deleted route ${args.route.slice(0, 8)} "${before.name}".`,
      data: { routeId: args.route, deleted: true },
      audit: {
        action: OPS_AUDIT_ACTIONS.logRouteDeleted,
        subjectType: 'log_route',
        subjectId: args.route,
        before: routeAuditShape(before),
        after: undefined,
      },
    };
  },
});

// --- log routing exclude / unexclude -----------------------------------------

const channelArgs = z.object({ channel: channelIdArg });

export const logRoutingExcludeCommand = defineCommand<z.infer<typeof channelArgs>>({
  name: 'log routing exclude',
  write: true,
  summary: 'exclude a source channel from every route (the guild-wide No access list)',
  positional: [{ name: 'channel', required: true, describe: 'the channel to stop logging from' }],
  args: channelArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const added = ctx.ports.excludeChannel(args.channel);
    return {
      text:
        `<#${args.channel}> is excluded from every route${added ? '' : ' (it already was)'}.\n` +
        `  This is the guild-wide No access list: nothing from that channel is logged, whatever\n` +
        `  \`log routing list\` shows.`,
      data: { channelId: args.channel, excluded: true, changed: added },
      audit: {
        action: OPS_AUDIT_ACTIONS.logExclusionAdded,
        subjectType: 'channel',
        subjectId: args.channel,
        before: { excluded: !added },
        after: { excluded: true },
      },
    };
  },
});

export const logRoutingUnexcludeCommand = defineCommand<z.infer<typeof channelArgs>>({
  name: 'log routing unexclude',
  write: true,
  summary: 'let a source channel be logged again (the guild-wide No access list)',
  positional: [{ name: 'channel', required: true, describe: 'the channel to log from again' }],
  args: channelArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const removed = ctx.ports.unexcludeChannel(args.channel);
    return {
      text:
        `<#${args.channel}> is no longer excluded from every route${removed ? '' : ' (it was not)'}.\n` +
        `  That was the guild-wide No access list; a route that excludes the channel itself still skips it.`,
      data: { channelId: args.channel, excluded: false, changed: removed },
      audit: {
        action: OPS_AUDIT_ACTIONS.logExclusionRemoved,
        subjectType: 'channel',
        subjectId: args.channel,
        before: { excluded: removed },
        after: { excluded: false },
      },
    };
  },
});

// --- jobs retry --------------------------------------------------------------

const jobsRetryArgs = z.object({
  // The CLI hands every positional through as a string; coerced here rather
  // than parsed there, so the socket protocol accepts either and one validator
  // decides what a job id is.
  job: z.coerce.number().int().positive(),
});

export const jobsRetryCommand = defineCommand<z.infer<typeof jobsRetryArgs>>({
  name: 'jobs retry',
  write: true,
  summary: 'return one failed job to the queue',
  positional: [{ name: 'job', required: true, describe: 'the job id from `jobs list --failed`' }],
  args: jobsRetryArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const before = ctx.ports.findJob(args.job);
    const outcome = ctx.ports.retryJob(args.job);

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not-found':
          throw new Error(`no job ${String(args.job)} in guild ${ctx.guildId}`);
        case 'not-failed':
          throw new Error(
            `job ${String(args.job)} is ${outcome.state}, not failed, so there is nothing to retry.\n` +
              (outcome.state === 'queued'
                ? '  It is already going to run.'
                : outcome.state === 'running'
                  ? '  It is running now; wait for it to finish.'
                  : `  Its work is done.`),
          );
        case 'dedupe-blocked':
          // The partial unique index over queued/running (ADR 0016) would
          // otherwise surface as a SQLite constraint error naming an index —
          // true, and useless to the person holding the terminal.
          throw new Error(
            `job ${String(args.job)} shares its dedupe key with job ` +
              `${String(outcome.blockingJobId)}, which is already pending.\n` +
              `  The work is going to run; retrying this row would queue it twice.`,
          );
      }
    }

    return {
      text:
        `job ${String(args.job)} is queued again, due now.\n` +
        `  Its attempt count is reset, so it gets a full set of retries.` +
        (before?.lastError == null ? '' : `\n  It last failed with: ${before.lastError}`),
      data: { jobId: args.job, state: 'queued', kind: before?.kind ?? null },
      audit: {
        action: OPS_AUDIT_ACTIONS.jobRetried,
        subjectType: 'job',
        subjectId: String(args.job),
        before:
          before === undefined
            ? null
            : { state: before.state, attempts: before.attempts, lastError: before.lastError },
        after: { state: 'queued', attempts: 0 },
      },
    };
  },
});
