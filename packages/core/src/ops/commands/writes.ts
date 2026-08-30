import { z } from 'zod';
import { snowflakeIdSchema } from '../../ids.js';
import { LOG_EVENT_KINDS } from '../../logging/subscriber.js';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';
import { findSetting, OPS_SETTINGS, parseSettingValue } from '../settings.js';

/**
 * The write half of the Release 1 surface that stays inside the database:
 * `config set`, `log routing set|off|exclude|unexclude`, `jobs retry`.
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

const eventKindArg = z.string().refine(
  (k) => LOG_EVENT_KINDS.includes(k),
  (k) => ({
    // Named, not just refused. WP4's report §5 is that a logging module with no
    // routes is indistinguishable from a working one, and a route on an event
    // kind nothing emits reproduces that exactly: the command succeeds, the
    // listing looks configured, and nothing is ever logged.
    message: `no such log event kind: ${k}\n\n` + `  Known kinds: ${LOG_EVENT_KINDS.join(', ')}`,
  }),
);

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
        action: 'config.set',
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

// --- log routing set / off ---------------------------------------------------

const logRoutingSetArgs = z.object({
  event: eventKindArg,
  channel: channelIdArg,
  'no-content': z.boolean().default(false),
});

export const logRoutingSetCommand = defineCommand<z.infer<typeof logRoutingSetArgs>>({
  name: 'log routing set',
  write: true,
  summary: 'send one kind of event to a channel',
  positional: [
    { name: 'event', required: true, describe: `one of: ${LOG_EVENT_KINDS.join(', ')}` },
    { name: 'channel', required: true, describe: 'the destination channel id' },
  ],
  flags: [
    {
      name: 'no-content',
      kind: 'boolean',
      describe: 'log that it happened without reproducing the message text',
    },
  ],
  args: logRoutingSetArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const includeContent = !args['no-content'];
    const before = ctx.ports.listRoutes().find((r) => r.eventKind === args.event);

    ctx.ports.setRoute({
      eventKind: args.event,
      channelId: args.channel,
      includeContent,
    });

    // Stated every time, not only when it changes. Whether a log line quotes
    // the message is the privacy-relevant half of this command, and an operator
    // who is told only the channel has been told the less important half.
    const contentNote = includeContent
      ? 'Message content is included in the log line.'
      : 'Message content is NOT included; the log records that it happened.';

    return {
      text:
        (before === undefined
          ? `${args.event} now logs to <#${args.channel}>.`
          : before.channelId === args.channel && before.enabled
            ? `${args.event} still logs to <#${args.channel}>.`
            : `${args.event} now logs to <#${args.channel}> (was ` +
              `<#${before.channelId}>${before.enabled ? '' : ', disabled'}).`) +
        `\n  ${contentNote}`,
      data: { eventKind: args.event, channelId: args.channel, includeContent, enabled: true },
      audit: {
        action: 'log_route.set',
        subjectType: 'log_route',
        subjectId: args.event,
        before:
          before === undefined
            ? null
            : {
                channelId: before.channelId,
                includeContent: before.includeContent,
                enabled: before.enabled,
              },
        after: { channelId: args.channel, includeContent, enabled: true },
      },
    };
  },
});

const logRoutingOffArgs = z.object({ event: eventKindArg });

export const logRoutingOffCommand = defineCommand<z.infer<typeof logRoutingOffArgs>>({
  name: 'log routing off',
  write: true,
  summary: 'stop logging one kind of event, keeping the channel',
  positional: [{ name: 'event', required: true, describe: 'the event kind to stop logging' }],
  args: logRoutingOffArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const before = ctx.ports.listRoutes().find((r) => r.eventKind === args.event);
    const changed = ctx.ports.setRouteEnabled(args.event, false);
    if (!changed) {
      // Refused rather than reported as success. An operator who mistyped an
      // event kind must not be told that the logging they asked to stop has
      // stopped, because they will believe it.
      throw new Error(
        `${args.event} has no route in guild ${ctx.guildId}, so there was nothing to turn off.\n` +
          `  Run \`bananasaurs log routing list\` to see what is configured.`,
      );
    }

    return {
      text:
        `${args.event} no longer logs to Discord.\n` +
        `  The route is kept, so \`log routing set ${args.event} ` +
        `${before?.channelId ?? '<channel>'}\` turns it back on.`,
      data: { eventKind: args.event, enabled: false },
      audit: {
        action: 'log_route.disabled',
        subjectType: 'log_route',
        subjectId: args.event,
        before: { enabled: true, channelId: before?.channelId ?? null },
        after: { enabled: false, channelId: before?.channelId ?? null },
      },
    };
  },
});

// --- log routing exclude / unexclude -----------------------------------------

const channelArgs = z.object({ channel: channelIdArg });

export const logRoutingExcludeCommand = defineCommand<z.infer<typeof channelArgs>>({
  name: 'log routing exclude',
  write: true,
  summary: 'never log anything from this source channel',
  positional: [{ name: 'channel', required: true, describe: 'the channel to stop logging from' }],
  args: channelArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const added = ctx.ports.excludeChannel(args.channel);
    return {
      text:
        `<#${args.channel}> is excluded from logging${added ? '' : ' (it already was)'}.\n` +
        `  This wins over every route: nothing from that channel is logged, whatever\n` +
        `  \`log routing list\` shows.`,
      data: { channelId: args.channel, excluded: true, changed: added },
      audit: {
        action: 'log_exclusion.added',
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
  summary: 'let this source channel be logged again',
  positional: [{ name: 'channel', required: true, describe: 'the channel to log from again' }],
  args: channelArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const removed = ctx.ports.unexcludeChannel(args.channel);
    return {
      text: `<#${args.channel}> is no longer excluded${removed ? '' : ' (it was not)'}.`,
      data: { channelId: args.channel, excluded: false, changed: removed },
      audit: {
        action: 'log_exclusion.removed',
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
        action: 'job.retried',
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
