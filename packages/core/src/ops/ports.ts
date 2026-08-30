import type { JsonValue } from './protocol.js';
/**
 * Everything the operator commands can reach.
 *
 * Two interfaces, split by whether the thing is guild-scoped:
 *
 * - `OpsPorts` — guild-scoped. Every member is supplied by the composition root
 *   as a closure over one `GuildScope`, so there is no parameter through which
 *   a command could name a different guild (`CLAUDE.md` rule 2). The split is
 *   the point: "does every query take a guild id" is answered by *which
 *   interface it is on*, not by reading each signature.
 * - `OpsInstance` — process-level. Uptime, the gateway connection, the
 *   configured mode. None of it is a query against guild data.
 *
 * Both grow one slice at a time, like `PanelStore` and `LoggingPorts` before
 * them.
 */

/**
 * One row for `audit_events`, as the operator surface writes it.
 *
 * `actorId` is absent by construction rather than optional-in-practice: the CLI
 * has no verified identity to put there (ADR 0024), and laundering the claimed
 * Unix name into the column every other actor type fills with a *verified*
 * identity is exactly the mistake amendment 2 exists to prevent. The claim goes
 * in `actorUnixUserClaimed`, whose name carries the caveat.
 */
export interface OpsAuditWrite {
  readonly at: number;
  readonly actorType: 'operator_cli';
  readonly actorId: undefined;
  readonly actorUnixUserClaimed: string | undefined;
  /**
   * `ssh`, per `docs/19` §6.9 — the column's vocabulary is
   * `'ssh' | 'http' | 'gateway'` and predates the distinction between an
   * operator on the box and one over SSH. It means "came in on the operator
   * socket"; `http` is the dashboard and `gateway` is Discord.
   */
  readonly via: 'ssh';
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | undefined;
  readonly before: JsonValue | undefined;
  readonly after: JsonValue | undefined;
  readonly dryRun: boolean;
}

/** The guild's row in `guilds`, as the effect gateway reads it. */
export interface OpsSafetyState {
  readonly killswitch: boolean;
  readonly dryRun: boolean;
  readonly breakerOpen: boolean;
  readonly breakerReason: string | null;
  readonly roleRatePerMin: number;
  readonly reconcileBudget: number;
  readonly breakerThreshold: number;
}

export interface OpsPorts {
  /** The guild's display name, or `undefined` before the first `GUILD_CREATE`. */
  guildName(): string | undefined;
  /** `undefined` when the guild has no row at all, which is itself a finding. */
  safetyState(): OpsSafetyState | undefined;
  /** Jobs by state: `queued`, `running`, `done`, `failed`, `cancelled`. */
  jobCounts(): Readonly<Record<string, number>>;
  /**
   * The `run_after` of the oldest queued job already due, or `undefined` when
   * nothing is overdue.
   *
   * This is what makes "scheduler lag" a number rather than a vibe: `now` minus
   * this is how far behind the worker actually is. A queued job scheduled for
   * the future is not lag, so the query filters on due-ness rather than
   * reporting the oldest queued row.
   */
  oldestDueJobAtMs(nowMs: number): number | undefined;
  /**
   * Writes one `audit_events` row.
   *
   * Called by the dispatcher, not by the command, so "every write is audited"
   * is a property of the machinery rather than of each handler remembering.
   */
  recordAudit(input: OpsAuditWrite): void;
  /** `guilds.killswitch`, layer 2 of the effect gateway's twelve. */
  setKillswitch(on: boolean): void;
}

/** Whether the gateway is connected, as the daemon's client reports it. */
export interface OpsGatewayState {
  readonly connected: boolean;
  /** Websocket heartbeat round-trip in ms, or `undefined` before the first beat. */
  readonly pingMs: number | undefined;
  /** Guilds the client is actually in, which is not the allowlist. */
  readonly guildCount: number;
}

export interface OpsInstance {
  /** `Date.now()` at process start, for uptime. */
  readonly startedAtMs: number;
  /** `BANANASAURS_READONLY`. Reported, so an operator is never puzzled by a refusal. */
  readonly readonly: boolean;
  readonly env: string;
  gateway(): OpsGatewayState;
}
