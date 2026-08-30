import { Events, type Client } from 'discord.js';
import {
  createDispatcher,
  OPERATOR_COMMANDS,
  parseGuildId,
  Pipeline,
  safeLogFields,
  type Config,
  type DiscordPort,
  type Dispatcher,
  type DomainEvent,
  type Logger,
  type OpsInstance,
  type OpsPorts,
  type Subscriber,
} from '@bananasaurs/core';
import { attachGatewayTranslation, emitConnectionEvents } from '@bananasaurs/discord';
import { guildRepo, pipelineRepo, type GuildScope, type ScopeFactory } from '@bananasaurs/storage';
import { opsInstanceFor, opsPortsFor } from '../ops/wiring.js';
import { buildDoctorReport, formatDoctorReport } from './doctor.js';
import { buildGuildRuntime, type GuildRuntime } from './guild.js';

/**
 * The composition root.
 *
 * Takes an opened database, a `DiscordPort` and a `Client` that has not logged
 * in; `index.ts` constructs all three. That signature is deliberate: it is what
 * lets the whole assembled daemon be driven by raw gateway packets in a test,
 * with `FakeDiscord` behind the port and no socket anywhere (ADR 0020).
 *
 * Logging in is not this module's job either. It wires; `index.ts` connects.
 */

export interface DaemonDeps {
  readonly config: Config;
  readonly scopes: ScopeFactory;
  readonly discord: DiscordPort;
  readonly client: Client;
  readonly logger: Logger;
  /** A property, not a method: it is destructured and passed on by value. */
  readonly now: () => number;
  /**
   * A condition the process must not keep running through. Called with a short
   * reason; `index.ts` shuts down and exits non-zero.
   */
  onFatal?: ((reason: string) => void) | undefined;
}

export interface Daemon {
  readonly guildIds: readonly string[];
  /**
   * The operator command surface (ADR 0013). `index.ts` hands this to the
   * socket once the daemon is assembled; the socket itself was bound earlier,
   * before the database, because it is half of the single-writer guard.
   */
  readonly ops: Dispatcher;
  /** The dashboard API's seam into per-guild ports (`packages/http`'s `HttpDeps.portsFor`). */
  readonly portsFor: (scope: GuildScope) => OpsPorts;
  /** The dashboard API's seam into process-level facts (`HttpDeps.instance`). */
  readonly instance: OpsInstance;
  /** Begins draining the job queues. Does not connect. */
  start(): void;
  stop(): Promise<void>;
  /** Waits for every event dispatched so far to finish being handled. */
  settle(): Promise<void>;
  /** One drain of every guild's queue. Also what the poll loop calls. */
  drainJobs(): Promise<number>;
}

/** How often the job loop looks for work. */
const JOB_POLL_MS = 1_000;

/**
 * Confines a subscriber to the guild it was built for.
 *
 * The subscribers close over a `GuildScope` and none of them compares
 * `event.guildId` against it — correctly, because re-checking the partition key
 * inside every handler is exactly the caller discipline CLAUDE.md rule 2 exists
 * to avoid. But it means one `Pipeline` carrying two guilds' subscribers would
 * hand guild B's reaction to guild A's panels, which would find nothing, log
 * nothing surprising, and hide the fault.
 *
 * Four lines here instead of a rule nobody can enforce. ADR 0020.
 */
export const scopedTo = (guildId: string, subscriber: Subscriber): Subscriber => ({
  name: `${subscriber.name}[${guildId}]`,
  handle: (event) => (event.guildId === guildId ? subscriber.handle(event) : undefined),
});

export function createDaemon(deps: DaemonDeps): Daemon {
  const { config, scopes, discord, client, logger, now } = deps;

  // Branded here, at the boundary. The config schema has already checked the
  // shape; this is what carries that check into every scope and port below.
  const guildIds = config.BANANASAURS_GUILD_ALLOWLIST.map((id) => parseGuildId(id));
  const allowlist = new Set<string>(guildIds);

  const byGuild = new Map<string, { scope: GuildScope; runtime: GuildRuntime }>();
  for (const guildId of guildIds) {
    const scope = scopes.forGuild(guildId);
    applyConfiguredDryRun(scope, config, logger, now());
    byGuild.set(guildId, {
      scope,
      runtime: buildGuildRuntime({ scope, config, discord, logger, now }),
    });
  }

  const pipeline = new Pipeline({
    allowlist,
    dedupe: {
      firstSight: (input) => pipelineRepo.recordFirstSight(scopeOf(byGuild, input.guildId), input),
    },
    subscribers: [...byGuild.values()].flatMap(({ runtime }) =>
      runtime.subscribers.map((s) => scopedTo(runtime.guildId, s)),
    ),
    leaveGuild: (guildId) => discord.leaveGuild(guildId),
    logger,
  });

  /**
   * Every dispatch currently in flight.
   *
   * `attachGatewayTranslation` calls `emit` from a synchronous discord.js
   * listener and cannot await it, so without this a caller has no way to know
   * when the work an event caused has finished. Shutdown needs that, and so
   * does any test that asserts on the result of a packet.
   */
  const inFlight = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  /**
   * One in-order chain of work per guild.
   *
   * **Handling dispatches concurrently is a correctness bug, not a slow path.**
   * Discord delivers a shard's dispatches in order and discord.js emits them in
   * order, but nothing awaits a listener — so without this, a replayed reaction
   * arriving alongside its original has both handlers read "the member does not
   * have the role", and both call `addRole`. The effect gateway cannot collapse
   * them: `trigger_ref` is part of the idempotency key on purpose, so that a
   * member toggling a role off and on again is not mistaken for a replay, and
   * two concurrent passes carry two pass ids. That is CLAUDE.md rule 6 —
   * "double execution impossible" — failing to a race the tests could not see
   * until something assembled the daemon and pushed two packets at it.
   *
   * Serialising per *guild* rather than globally, because guild scope is the
   * partition key everywhere else and two guilds share no state to race over.
   * The expensive work — an adoption pass, a reconciliation — is a job and does
   * not run here, which is what keeps a queue of one at a time affordable.
   */
  const chains = new Map<string, Promise<unknown>>();

  const emit = (event: DomainEvent): void => {
    const previous = chains.get(event.guildId) ?? Promise.resolve();
    const next = previous.then(() =>
      pipeline.dispatch(event).catch((err: unknown) => {
        // A subscriber that throws must not become an unhandled rejection: the
        // gateway listener that produced this returned long ago, and taking the
        // process down over one event is the failure this catch exists to stop.
        logger.error(
          safeLogFields({
            component: 'pipeline',
            guildId: event.guildId,
            eventKind: event.kind,
            err,
          }),
          'dispatch failed',
        );
      }),
    );
    chains.set(event.guildId, next);
    void next.finally(() => {
      // Only the tail clears the chain, so an idle guild does not hold an entry
      // and a busy one keeps its ordering.
      if (chains.get(event.guildId) === next) chains.delete(event.guildId);
    });
    track(next);
  };

  attachGatewayTranslation(client, {
    now,
    isGuildAllowed: (guildId) => allowlist.has(guildId),
    emit,
    onError: (err, context) => {
      logger.error(
        safeLogFields({ component: 'gateway', eventKind: context.event, err }),
        'could not translate a gateway event',
      );
    },
  });

  // --- connection lifecycle -------------------------------------------------
  /**
   * When the socket went away, or `undefined` if it has not since start.
   *
   * A cold start is a fresh IDENTIFY by definition, so the first READY records a
   * gap too — `docs/21` exercise 4 is "Ctrl-C, react while it is down, restart",
   * and reactions added in that window produced no dispatch at all. The gap's
   * *duration* is unknown to a process that was not running, so it is recorded
   * as zero-length; the gap's *existence* is what enqueues the reconciliation
   * that recovers the window.
   */
  let disconnectedAtMs: number | undefined;

  client.on(Events.ShardDisconnect, () => {
    disconnectedAtMs = now();
    logger.warn(
      safeLogFields({ component: 'connection', outcome: 'disconnected' }),
      'shard closed',
    );
  });

  const connectionEvent = (resumed: boolean): void => {
    const receivedAtMs = now();
    emitConnectionEvents(
      guildIds,
      { resumed, disconnectedAtMs: disconnectedAtMs ?? receivedAtMs, receivedAtMs },
      emit,
    );
    disconnectedAtMs = undefined;
  };

  /**
   * The leave for an unlisted guild is the pipeline's, not this listener's: the
   * translation layer emits `guildCreate` exempt from the allowlist filter
   * precisely so the pipeline's gate can refuse it and call `leaveGuild` once.
   * All this does is keep an allowlisted guild's name current.
   */
  client.on(Events.GuildCreate, (guild) => {
    if (!allowlist.has(guild.id)) return;
    const entry = byGuild.get(guild.id);
    if (entry) guildRepo.upsertGuild(entry.scope, { name: guild.name, enabled: true, now: now() });
  });

  client.on(Events.ClientReady, () => {
    checkBotIdentity(client, config, logger, deps.onFatal);
    recordGuildMembership(client, byGuild, logger, now());
    // `doctor` on every start, not only when asked. Its findings — a missing
    // partial, an ungranted intent, a bot below the roles it manages — all look
    // identical from the outside: nothing happens and nothing says why.
    reportHealth(client, config, logger);
    connectionEvent(false);
  });
  client.on(Events.ShardResume, () => {
    connectionEvent(true);
  });

  // --- job loop -------------------------------------------------------------
  let timer: NodeJS.Timeout | undefined;
  let draining = false;

  const drainJobs = async (): Promise<number> => {
    // Non-reentrant: SQLite has one writer and a second concurrent drain would
    // interleave transactions with the first for no gain.
    if (draining) return 0;
    draining = true;
    try {
      let total = 0;
      for (const { runtime } of byGuild.values()) total += await runtime.worker.drain();
      return total;
    } finally {
      draining = false;
    }
  };

  // A handled event can dispatch another, so drain rather than snapshot.
  const settle = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  };

  // Shared by the operator dispatcher and the dashboard API: both need "the
  // process-level facts" and neither should build its own second copy of them.
  const instance = opsInstanceFor({
    config,
    client,
    startedAtMs: now(),
    instanceScope: scopes.instance(),
    now,
  });

  /**
   * The dashboard's seam into per-guild ports (slice 14, `packages/http`
   * `HttpDeps.portsFor`).
   *
   * The same expression `contextFor` below uses to build the operator
   * dispatcher's `OpsPorts`, keyed by `scope.guildId` instead of a bare guild
   * id string because a dashboard route has a `GuildScope` from
   * `session.scope` and nothing else — `packages/http` cannot import
   * `apps/daemon` (ADR 0014) to build one itself. Throws rather than returning
   * `undefined` on a miss: a session's scope can only ever name a guild this
   * daemon was constructed with, because `login` only accepts guild ids from
   * the same `BANANASAURS_GUILD_ALLOWLIST` this map was built from, so a miss
   * here is a bug in that invariant, not a normal-traffic case a route should
   * have to handle.
   */
  const portsFor = (scope: GuildScope): OpsPorts => {
    const entry = byGuild.get(scope.guildId);
    if (entry === undefined) {
      throw new Error(`portsFor: no guild runtime for ${scope.guildId} — outside the allowlist`);
    }
    return opsPortsFor(entry.scope, entry.runtime.ops, now);
  };

  const ops = createDispatcher({
    commands: OPERATOR_COMMANDS,
    guildIds,
    // The context is a closure over one guild's scope, obtained from the same
    // map every subscriber and job handler is built from. There is no path by
    // which a command reaches a guild that is not in the allowlist.
    contextFor: (guildId) => {
      const entry = byGuild.get(guildId);
      if (entry === undefined) return undefined;
      return {
        guildId: parseGuildId(guildId),
        now,
        ports: opsPortsFor(entry.scope, entry.runtime.ops, now),
      };
    },
    instance,
  });

  return {
    guildIds,
    ops,
    portsFor,
    instance,

    start() {
      for (const { runtime } of byGuild.values()) runtime.worker.recoverStranded();
      timer = setInterval(() => {
        void drainJobs().catch((err: unknown) => {
          logger.error(safeLogFields({ component: 'jobs', err }), 'job drain failed');
        });
      }, JOB_POLL_MS);
      // Node keeps the process alive for a pending timer, and the socket is
      // what should do that. A daemon whose gateway died must exit, not idle.
      timer.unref();
    },

    async stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await settle();
    },

    settle,
    drainJobs,
  };
}

const scopeOf = (
  byGuild: Map<string, { scope: GuildScope; runtime: GuildRuntime }>,
  guildId: string,
): GuildScope => {
  const entry = byGuild.get(guildId);
  // Unreachable behind the pipeline's allowlist gate, which runs first. Thrown
  // rather than defaulted: a scope chosen by fallback is a scope that writes one
  // guild's rows under another's id.
  if (!entry) throw new Error(`no runtime for guild ${guildId}`);
  return entry.scope;
};

/**
 * Makes `BANANASAURS_DRY_RUN` mean something.
 *
 * `guilds.dry_run` is what the effect gateway reads, and it defaults to 1.
 * `docs/21` exercise 3 tells the operator to turn dry run off by setting the
 * environment variable and restarting — so without this the instruction does
 * nothing at all and a correctly-working bot looks broken. The environment wins
 * on every start, because it is the more explicit statement of intent and
 * because this is a safety control (`docs/18` layer 4), not a tuning knob.
 */
function applyConfiguredDryRun(
  scope: GuildScope,
  config: Config,
  logger: Logger,
  nowMs: number,
): void {
  const wanted = config.BANANASAURS_DRY_RUN;

  // An observe-only process cannot apply it, and must not die trying.
  //
  // `docs/17` §1 offers `BANANASAURS_READONLY=1` for ordinary inspection, and
  // every write below would throw `ReadonlyError` out of `createDaemon` on any
  // database whose guild row is missing or whose `dry_run` disagrees with the
  // environment — which is every fresh install. Skipped with a warning rather
  // than caught, because "the process cannot write" is a fact known here, and
  // catching an exception to discover it would be finding out by accident.
  //
  // Safe to skip: a read-only process performs no Discord side effect anyway,
  // so the layer-4 flag it would have written governs nothing it can do.
  if (config.BANANASAURS_READONLY) {
    logger.warn(
      safeLogFields({
        component: 'startup',
        guildId: scope.guildId,
        dryRun: wanted,
        outcome: 'dry-run-not-applied',
      }),
      'read-only: BANANASAURS_DRY_RUN was not applied and guilds.dry_run stands as it is',
    );
    return;
  }

  // The row has to exist before the effect gateway can read a safety state from
  // it. The id stands in for the name until GUILD_CREATE supplies the real one;
  // `upsertGuild` would overwrite a good name with the id on every restart.
  if (guildRepo.findGuild(scope) === undefined) {
    guildRepo.upsertGuild(scope, { name: scope.guildId, enabled: true, now: nowMs });
  }
  const current = guildRepo.readSafetyState(scope)?.dryRun;
  if (current === wanted) return;

  guildRepo.setDryRun(scope, wanted, nowMs);
  logger.warn(
    safeLogFields({
      component: 'startup',
      guildId: scope.guildId,
      dryRun: wanted,
      outcome: 'dry-run-changed',
    }),
    wanted
      ? 'dry run turned ON by configuration; no Discord side effect will be performed'
      : 'dry run turned OFF by configuration; Discord side effects are live',
  );
}

/**
 * `doctor` on every start, wrapped.
 *
 * Everything it looks for — a missing partial, an ungranted intent, a bot below
 * the roles it manages — presents identically from the outside: nothing happens
 * and nothing says why. So it runs unasked rather than only when an operator
 * thinks to ask.
 *
 * Wrapped because it reads discord.js structures that compute lazily and throw:
 * `GuildMember.permissions` builds a bitfield from every cached role and a role
 * delivered without a `permissions` field makes it throw. A diagnostic that can
 * take the process down on startup is worse than no diagnostic at all.
 */
function reportHealth(client: Client, config: Config, logger: Logger): void {
  try {
    const report = buildDoctorReport(client, config);
    logger[report.ok ? 'info' : 'warn'](
      { doctor: formatDoctorReport(report) },
      report.ok ? 'doctor: ok' : 'doctor: PROBLEMS FOUND',
    );
  } catch (err) {
    logger.error(
      safeLogFields({ component: 'startup', err, outcome: 'doctor-failed' }),
      'could not build the startup health report',
    );
  }
}

/**
 * Checks the assumption that the application id is the bot's user id.
 *
 * It is how Discord mints a bot, but the two are separate fields and the
 * consequence of being wrong is not subtle: `botUserId` is what makes the
 * reaction subscriber ignore the bot's own seeded reactions, so a mismatch turns
 * every seeded panel reaction into a member request.
 */
function checkBotIdentity(
  client: Client,
  config: Config,
  logger: Logger,
  onFatal: ((reason: string) => void) | undefined,
): void {
  const actual = client.user?.id;
  if (actual === undefined || actual === config.DISCORD_APPLICATION_ID) return;

  logger.error(
    safeLogFields({ component: 'startup', userId: actual, outcome: 'identity-mismatch' }),
    'the bot user id does not match DISCORD_APPLICATION_ID; the bot would act on its own reactions',
  );
  onFatal?.('bot-user-id-mismatch');
}

/** Records the guilds the client is actually in, for `doctor` and the log. */
function recordGuildMembership(
  client: Client,
  byGuild: Map<string, { scope: GuildScope; runtime: GuildRuntime }>,
  logger: Logger,
  nowMs: number,
): void {
  for (const [guildId, { scope }] of byGuild) {
    const guild = client.guilds.cache.get(guildId);
    if (guild === undefined) {
      logger.warn(
        safeLogFields({ component: 'startup', guildId, outcome: 'allowlisted-but-absent' }),
        'configured for a guild the bot is not in',
      );
      continue;
    }
    guildRepo.upsertGuild(scope, { name: guild.name, enabled: true, now: nowMs });
  }
}
