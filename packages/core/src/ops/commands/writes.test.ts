import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import { LOG_EVENT_KINDS } from '../../logging/subscriber.js';
import type {
  OpsAuditWrite,
  OpsInstance,
  OpsJobRow,
  OpsLogRoute,
  OpsPorts,
  OpsRetryOutcome,
  OpsSafetyState,
} from '../ports.js';
import type { OpsSettingChange } from '../settings.js';
import { OPERATOR_COMMANDS } from '../registry.js';

/**
 * The database-only write commands (slice 13d).
 *
 * Driven through `createDispatcher` rather than by calling `run` directly, so
 * every test also exercises the two guarantees that live in the machinery
 * rather than in the command: `--confirm` is required, and the audit row is
 * written by the dispatcher from a record the command could not omit.
 *
 * The registry is used whole, so a command registered under a name the CLI
 * would not produce fails here rather than at the terminal.
 */

const CHANNEL = '333333333333333333';
const OTHER_CHANNEL = '444444444444444444';

const safety = (over: Partial<OpsSafetyState> = {}): OpsSafetyState => ({
  killswitch: false,
  dryRun: false,
  breakerOpen: false,
  breakerReason: null,
  roleRatePerMin: 20,
  reconcileBudget: 25,
  breakerThreshold: 5,
  ...over,
});

const job = (over: Partial<OpsJobRow> = {}): OpsJobRow => ({
  jobId: 7,
  kind: 'reconcile_guild',
  state: 'failed',
  attempts: 5,
  maxAttempts: 5,
  runAfter: 1_000,
  lastError: 'Discord said 503',
  dedupeKey: 'reconcile:p1',
  ...over,
});

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(command: string, args: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly settings: OpsSettingChange[];
  readonly routes: OpsLogRoute[];
  readonly excluded: string[];
  readonly retried: number[];
}

interface HarnessOptions {
  readonly state?: OpsSafetyState | undefined;
  readonly routes?: OpsLogRoute[];
  readonly excluded?: string[];
  readonly job?: OpsJobRow | undefined;
  readonly retry?: OpsRetryOutcome;
  readonly instance?: Partial<OpsInstance>;
}

const harness = (options: HarnessOptions = {}): Harness => {
  const audit: OpsAuditWrite[] = [];
  const settings: OpsSettingChange[] = [];
  const routes = options.routes ?? [];
  const excluded = options.excluded ?? [];
  const retried: number[] = [];
  const state = 'state' in options ? options.state : safety();
  let routeSeq = 1;

  // Valid UUIDs, one per created route — `logRouteIdSchema` refuses anything else.
  const nextRouteId = (): string =>
    `123e4567-e89b-12d3-a456-4266141740${String(routeSeq++).padStart(2, '0')}`;

  const ports: Partial<OpsPorts> = {
    safetyState: () => state,
    recordAudit: (input) => {
      audit.push(input);
    },
    applySetting: (change) => {
      settings.push(change);
    },
    listRoutes: () => routes,
    getRoute: (routeId) => routes.find((r) => r.routeId === routeId),
    createRoute: (input) => {
      const route: OpsLogRoute = {
        routeId: nextRouteId(),
        name: input.name,
        channelId: input.channelId,
        includeContent: input.includeContent,
        enabled: input.enabled,
        createdAtMs: 1_700_000_000_000,
        eventKinds: [...input.eventKinds],
        excludedChannelIds: [...input.excludedChannelIds],
      };
      routes.push(route);
      return route;
    },
    updateRoute: (routeId, input) => {
      const at = routes.findIndex((r) => r.routeId === routeId);
      if (at === -1) return undefined;
      const existing = routes[at];
      if (existing === undefined) return undefined;
      const next: OpsLogRoute = {
        ...existing,
        name: input.name,
        channelId: input.channelId,
        includeContent: input.includeContent,
        enabled: input.enabled,
        eventKinds: [...input.eventKinds],
        excludedChannelIds: [...input.excludedChannelIds],
      };
      routes[at] = next;
      return next;
    },
    setRouteEnabled: (routeId, enabled) => {
      const at = routes.findIndex((r) => r.routeId === routeId);
      if (at === -1) return false;
      const existing = routes[at];
      if (existing === undefined) return false;
      routes[at] = { ...existing, enabled };
      return true;
    },
    deleteRoute: (routeId) => {
      const at = routes.findIndex((r) => r.routeId === routeId);
      if (at === -1) return false;
      routes.splice(at, 1);
      return true;
    },
    excludeChannel: (channelId) => {
      if (excluded.includes(channelId)) return false;
      excluded.push(channelId);
      return true;
    },
    unexcludeChannel: (channelId) => {
      const at = excluded.indexOf(channelId);
      if (at === -1) return false;
      excluded.splice(at, 1);
      return true;
    },
    findJob: () => options.job,
    retryJob: (jobId) => {
      retried.push(jobId);
      return options.retry ?? { ok: true };
    },
  };

  const dispatcher = createDispatcher({
    commands: OPERATOR_COMMANDS,
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => 1_700_000_000_000,
      ports: fakeOpsPorts(ports),
    }),
    instance: fakeOpsInstance(options.instance ?? {}),
  });

  return {
    audit,
    settings,
    routes,
    excluded,
    retried,
    run: (command, args, confirm = true) =>
      dispatcher.dispatch({ v: 1, command, args, confirm, unixUserClaimed: 'bryan' }),
  };
};

const okText = (response: Dispatched): string => {
  if (!response.ok) throw new Error(`expected ok, got: ${response.message}`);
  return response.text;
};
const errMessage = (response: Dispatched): string => {
  if (response.ok) throw new Error(`expected a refusal, got: ${response.text}`);
  return response.message;
};

// --- the guarantees the machinery owns ---------------------------------------

describe('every 13d command is a write', () => {
  const names = [
    'config set',
    'log routing create',
    'log routing update',
    'log routing on',
    'log routing off',
    'log routing delete',
    'log routing exclude',
    'log routing unexclude',
    'jobs retry',
  ];

  it.each(names)('%s is refused without --confirm', async (name) => {
    const h = harness({ routes: [route()], excluded: [CHANNEL], job: job() });
    const response = await h.run(name, argsFor(name), false);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe('needs-confirm');
    // Nothing reached a port, so the refusal is a gate and not a rollback.
    expect(h.audit).toEqual([]);
    expect(h.settings).toEqual([]);
    expect(h.retried).toEqual([]);
  });

  it.each(names)('%s records exactly one audit row', async (name) => {
    const h = harness({ routes: [route()], excluded: [CHANNEL], job: job() });
    await h.run(name, argsFor(name));
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      actorType: 'operator_cli',
      // Never the verified column, always the caveated one (ADR 0024).
      actorId: undefined,
      actorUnixUserClaimed: 'bryan',
      via: 'ssh',
    });
  });

  it('is registered under the name the CLI produces', () => {
    const registered = new Set(OPERATOR_COMMANDS.map((c) => c.name));
    for (const name of names) expect(registered.has(name)).toBe(true);
  });
});

const ROUTE_ID = '123e4567-e89b-12d3-a456-426614174000';
const UNKNOWN_ROUTE_ID = '123e4567-e89b-12d3-a456-426614174099';

const route = (over: Partial<OpsLogRoute> = {}): OpsLogRoute => ({
  routeId: ROUTE_ID,
  name: `→ ${CHANNEL}`,
  channelId: CHANNEL,
  enabled: true,
  includeContent: true,
  createdAtMs: 1_700_000_000_000,
  eventKinds: ['member_join'],
  excludedChannelIds: [],
  ...over,
});

const argsFor = (name: string): Record<string, unknown> => {
  switch (name) {
    case 'config set':
      return { key: 'role_rate_per_min', value: '60' };
    case 'log routing create':
      return { channel: OTHER_CHANNEL, events: 'member_join' };
    case 'log routing update':
      return { route: ROUTE_ID, channel: OTHER_CHANNEL, events: 'member_join' };
    case 'log routing on':
    case 'log routing off':
    case 'log routing delete':
      return { route: ROUTE_ID };
    case 'log routing exclude':
      return { channel: OTHER_CHANNEL };
    case 'log routing unexclude':
      return { channel: CHANNEL };
    default:
      return { job: '7' };
  }
};

// --- config set --------------------------------------------------------------

describe('config set', () => {
  it('applies a limit and reports the transition', async () => {
    const h = harness();
    const text = okText(await h.run('config set', { key: 'role_rate_per_min', value: '60' }));
    expect(text).toContain('role_rate_per_min: 20 -> 60');
    expect(h.settings).toEqual([{ key: 'role_rate_per_min', value: 60 }]);
    expect(h.audit[0]).toMatchObject({
      action: 'config.set',
      subjectId: 'role_rate_per_min',
      before: { role_rate_per_min: 20 },
      after: { role_rate_per_min: 60 },
    });
  });

  it('refuses a rate cap of zero rather than stopping every role change', async () => {
    const h = harness();
    const message = errMessage(await h.run('config set', { key: 'role_rate_per_min', value: '0' }));
    expect(message).toContain('positive whole number');
    expect(h.settings).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('refuses an environment key by name, not as unknown (ADR 0025)', async () => {
    // "No such key" would be false: the key exists, it is just not settable
    // from here, and an operator told it does not exist will go looking for a
    // typo that is not there.
    const h = harness();
    const message = errMessage(
      await h.run('config set', { key: 'BANANASAURS_DRY_RUN', value: 'off' }),
    );
    expect(message).toContain('process configuration');
    expect(message).toContain('restart');
    expect(message).toContain('dry_run');
    expect(h.settings).toEqual([]);
  });

  it('warns when the environment will overwrite the change at the next start', async () => {
    // The interaction ADR 0025 exists to surface: `applyConfiguredDryRun`
    // writes `guilds.dry_run` from the environment on every start.
    const h = harness({
      state: safety({ dryRun: true }),
      instance: { redactedConfig: () => ({ BANANASAURS_DRY_RUN: true }) },
    });
    const text = okText(await h.run('config set', { key: 'dry_run', value: 'off' }));
    expect(text).toContain('dry_run: on -> off');
    expect(text).toContain('BANANASAURS_DRY_RUN=true');
    expect(text).toContain('restarts');
  });

  it('says nothing about the environment when the two agree', async () => {
    const h = harness({ instance: { redactedConfig: () => ({ BANANASAURS_DRY_RUN: false }) } });
    const text = okText(await h.run('config set', { key: 'dry_run', value: 'off' }));
    expect(text).not.toContain('WARNING');
  });

  it('clears a tripped breaker, which nothing else in the product could', async () => {
    const h = harness({ state: safety({ breakerOpen: true, breakerReason: 'five in a row' }) });
    const text = okText(await h.run('config set', { key: 'breaker', value: 'closed' }));
    expect(text).toContain('breaker: open -> closed');
    expect(h.settings).toEqual([{ key: 'breaker', value: 'closed' }]);
  });

  it('will not open the breaker by hand, and says which command does that', async () => {
    const h = harness();
    const message = errMessage(await h.run('config set', { key: 'breaker', value: 'open' }));
    expect(message).toContain('killswitch on');
    expect(h.settings).toEqual([]);
  });

  it('refuses when the guild has no row to hold the setting', async () => {
    const h = harness({ state: undefined });
    const message = errMessage(await h.run('config set', { key: 'dry_run', value: 'on' }));
    expect(message).toContain('no row in `guilds`');
    expect(message).not.toContain('undefined');
    expect(h.settings).toEqual([]);
  });
});

// --- log routing create / update / on / off / delete --------------------------

describe('log routing create', () => {
  it('creates a route and says whether content is included', async () => {
    const h = harness({ routes: [] });
    const text = okText(
      await h.run('log routing create', { channel: CHANNEL, events: 'member_join' }),
    );
    expect(text).toContain('Created route');
    expect(text).toContain('1 event kinds');
    expect(text).toContain(`<#${CHANNEL}>`);
    expect(text).toContain('Message content is included');
    expect(h.routes).toHaveLength(1);
    expect(h.routes[0]).toMatchObject({
      channelId: CHANNEL,
      includeContent: true,
      enabled: true,
      eventKinds: ['member_join'],
    });
    expect(h.audit[0]).toMatchObject({
      action: 'log_route.created',
      subjectType: 'log_route',
      subjectId: h.routes[0]?.routeId,
      after: {
        channelId: CHANNEL,
        includeContent: true,
        enabled: true,
        eventKinds: ['member_join'],
        excludedChannelIds: [],
      },
    });
  });

  it('honours --no-content, --name and --exclude, and says so', async () => {
    const h = harness({ routes: [] });
    const text = okText(
      await h.run('log routing create', {
        channel: CHANNEL,
        events: 'message_edit',
        exclude: OTHER_CHANNEL,
        name: 'mod log',
        'no-content': true,
      }),
    );
    expect(text).toContain('NOT included');
    expect(text).toContain('mod log');
    expect(h.routes[0]).toMatchObject({
      name: 'mod log',
      includeContent: false,
      excludedChannelIds: [OTHER_CHANNEL],
    });
    expect(h.audit[0]?.after).toMatchObject({ includeContent: false, name: 'mod log' });
  });

  it('expands --events all to every kind', async () => {
    const h = harness({ routes: [] });
    await h.run('log routing create', { channel: CHANNEL, events: 'all' });
    expect(h.routes[0]?.eventKinds).toEqual([...LOG_EVENT_KINDS].sort());
  });

  it('refuses an event kind nothing emits, and names the refusal', async () => {
    // The WP4 §5 failure exactly: a route on `membre_join` succeeds, the
    // listing looks configured, and nothing is ever logged.
    const h = harness({ routes: [] });
    const message = errMessage(
      await h.run('log routing create', { channel: CHANNEL, events: 'membre_join' }),
    );
    expect(message).toContain('no such log event kind');
    expect(h.routes).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('refuses a channel id that is not a snowflake', async () => {
    const h = harness({ routes: [] });
    const message = errMessage(
      await h.run('log routing create', { channel: '#general', events: 'member_join' }),
    );
    expect(message).toContain('snowflake');
    expect(h.routes).toEqual([]);
  });

  it('refuses a numeric snowflake, which is already corrupted', async () => {
    // Not reachable from a shell, where every argument is a string — reachable
    // from an agent that builds the JSON request itself, which is the CLI's
    // stated second audience (`docs/17` §1).
    const h = harness({ routes: [] });
    const message = errMessage(
      await h.run('log routing create', { channel: Number(CHANNEL), events: 'member_join' }),
    );
    expect(message).toContain('already corrupted');
  });

  it('refuses the destination listed in --exclude', async () => {
    const h = harness({ routes: [] });
    const message = errMessage(
      await h.run(
        'log routing create',
        { channel: CHANNEL, events: 'member_join', exclude: CHANNEL },
      ),
    );
    expect(message).toContain('cannot also be an excluded channel');
    expect(h.routes).toEqual([]);
    expect(h.audit).toEqual([]);
  });
});

describe('log routing update', () => {
  it('replaces the route and records before and after', async () => {
    const h = harness({ routes: [route()] });
    const text = okText(
      await h.run(
        'log routing update',
        { route: ROUTE_ID, channel: OTHER_CHANNEL, events: 'member_join,member_leave' },
      ),
    );
    expect(text).toContain('Updated route');
    expect(text).toContain(`<#${OTHER_CHANNEL}>`);
    expect(h.routes[0]).toMatchObject({
      routeId: ROUTE_ID,
      channelId: OTHER_CHANNEL,
      eventKinds: ['member_join', 'member_leave'],
    });
    expect(h.audit[0]).toMatchObject({
      action: 'log_route.updated',
      subjectType: 'log_route',
      subjectId: ROUTE_ID,
      before: { channelId: CHANNEL, eventKinds: ['member_join'] },
      after: { channelId: OTHER_CHANNEL, eventKinds: ['member_join', 'member_leave'] },
    });
  });

  it('keeps the current enabled state', async () => {
    const h = harness({ routes: [route({ enabled: false })] });
    await h.run('log routing update', { route: ROUTE_ID, channel: OTHER_CHANNEL, events: 'all' });
    expect(h.routes[0]).toMatchObject({ enabled: false });
    expect(h.audit[0]?.after).toMatchObject({ enabled: false });
  });

  it('refuses an unknown route id rather than reporting success', async () => {
    const h = harness({ routes: [route()] });
    const message = errMessage(
      await h.run(
        'log routing update',
        { route: UNKNOWN_ROUTE_ID, channel: OTHER_CHANNEL, events: 'member_join' },
      ),
    );
    expect(message).toContain('nothing to update');
    expect(h.routes).toHaveLength(1);
    expect(h.audit).toEqual([]);
  });

  it('refuses a route id that is not a UUID', async () => {
    const h = harness({ routes: [route()] });
    const message = errMessage(
      await h.run('log routing update', { route: 'abc', channel: OTHER_CHANNEL, events: 'x' }),
    );
    expect(message).toContain('uuid');
    expect(h.audit).toEqual([]);
  });
});

describe('log routing on', () => {
  it('enables the route and audits it', async () => {
    const h = harness({ routes: [route({ enabled: false })] });
    const text = okText(await h.run('log routing on', { route: ROUTE_ID }));
    expect(text).toContain('logs to');
    expect(text).toContain(CHANNEL);
    expect(h.routes[0]).toMatchObject({ enabled: true });
    expect(h.audit[0]).toMatchObject({
      action: 'log_route.enabled',
      subjectType: 'log_route',
      subjectId: ROUTE_ID,
      before: { enabled: false },
      after: { enabled: true },
    });
  });

  it('refuses an unknown route id rather than reporting success', async () => {
    const h = harness({ routes: [] });
    const message = errMessage(await h.run('log routing on', { route: UNKNOWN_ROUTE_ID }));
    expect(message).toContain('nothing to turn on');
    expect(h.audit).toEqual([]);
  });
});

describe('log routing off', () => {
  it('disables the route and keeps the channel', async () => {
    const h = harness({ routes: [route()] });
    const text = okText(await h.run('log routing off', { route: ROUTE_ID }));
    expect(text).toContain('no longer logs');
    expect(text).toContain('log routing on');
    expect(h.routes[0]).toMatchObject({ enabled: false, channelId: CHANNEL });
    expect(h.audit[0]).toMatchObject({
      action: 'log_route.disabled',
      subjectType: 'log_route',
      subjectId: ROUTE_ID,
      before: { enabled: true },
      after: { enabled: false },
    });
  });

  it('refuses when there was no route, rather than reporting success', async () => {
    // An operator who mistyped a route id must not be told that the logging
    // they asked to stop has stopped, because they will believe it.
    const h = harness({ routes: [] });
    const message = errMessage(await h.run('log routing off', { route: UNKNOWN_ROUTE_ID }));
    expect(message).toContain('nothing to turn off');
    expect(h.audit).toEqual([]);
  });
});

describe('log routing delete', () => {
  it('deletes the route and records what it was', async () => {
    const h = harness({ routes: [route()] });
    const text = okText(await h.run('log routing delete', { route: ROUTE_ID }));
    expect(text).toContain('Deleted route');
    expect(h.routes).toEqual([]);
    expect(h.audit[0]).toMatchObject({
      action: 'log_route.deleted',
      subjectType: 'log_route',
      subjectId: ROUTE_ID,
      before: { channelId: CHANNEL, eventKinds: ['member_join'] },
      after: undefined,
    });
  });

  it('refuses an unknown route id rather than reporting success', async () => {
    const h = harness({ routes: [] });
    const message = errMessage(await h.run('log routing delete', { route: UNKNOWN_ROUTE_ID }));
    expect(message).toContain('nothing to delete');
    expect(h.audit).toEqual([]);
  });
});

// --- exclusions --------------------------------------------------------------

describe('log routing exclude / unexclude', () => {
  it('excludes a channel from every route and names the No access list', async () => {
    const h = harness({ excluded: [] });
    const text = okText(await h.run('log routing exclude', { channel: CHANNEL }));
    expect(text).toContain('excluded from every route');
    expect(text).toContain('No access');
    expect(h.excluded).toEqual([CHANNEL]);
    expect(h.audit[0]).toMatchObject({ action: 'log_exclusion.added', subjectId: CHANNEL });
  });

  it('is idempotent, and records the repeat as well', async () => {
    // The `killswitch` convention: the trail is a history of what an operator
    // asserted, not only of what changed.
    const h = harness({ excluded: [CHANNEL] });
    const text = okText(await h.run('log routing exclude', { channel: CHANNEL }));
    expect(text).toContain('it already was');
    expect(h.audit).toHaveLength(1);
  });

  it('un-excludes, and says when there was nothing to remove', async () => {
    const h = harness({ excluded: [] });
    const text = okText(await h.run('log routing unexclude', { channel: CHANNEL }));
    expect(text).toContain('it was not');
    expect(h.audit[0]).toMatchObject({ action: 'log_exclusion.removed' });
  });
});

// --- jobs retry --------------------------------------------------------------

describe('jobs retry', () => {
  it('requeues a failed job and repeats why it failed', async () => {
    const h = harness({ job: job() });
    const text = okText(await h.run('jobs retry', { job: '7' }));
    expect(text).toContain('queued again');
    expect(text).toContain('Discord said 503');
    expect(h.retried).toEqual([7]);
    expect(h.audit[0]).toMatchObject({
      action: 'job.retried',
      subjectId: '7',
      before: { state: 'failed', attempts: 5 },
      after: { state: 'queued', attempts: 0 },
    });
  });

  it('refuses a job id that is not a positive whole number', async () => {
    const h = harness({ job: job() });
    expect(errMessage(await h.run('jobs retry', { job: 'seven' }))).toContain('job');
    expect(h.retried).toEqual([]);
  });

  it('reports a missing job as missing', async () => {
    const h = harness({ job: undefined, retry: { ok: false, reason: 'not-found' } });
    expect(errMessage(await h.run('jobs retry', { job: '9' }))).toContain('no job 9');
    expect(h.audit).toEqual([]);
  });

  it('explains that a queued job is already going to run', async () => {
    const h = harness({
      job: job({ state: 'queued' }),
      retry: { ok: false, reason: 'not-failed', state: 'queued' },
    });
    const message = errMessage(await h.run('jobs retry', { job: '7' }));
    expect(message).toContain('already going to run');
    expect(h.audit).toEqual([]);
  });

  it('translates a dedupe collision into the job that holds the key', async () => {
    // The alternative is a SQLite constraint error naming `jobs_dedupe`: true,
    // and useless to the person holding the terminal.
    const h = harness({
      job: job(),
      retry: { ok: false, reason: 'dedupe-blocked', blockingJobId: 12 },
    });
    const message = errMessage(await h.run('jobs retry', { job: '7' }));
    expect(message).toContain('job 12');
    expect(message).toContain('queue it twice');
    expect(message).not.toContain('UNIQUE');
    expect(h.audit).toEqual([]);
  });
});
