import { z } from 'zod';
import { defineCommand, type OpsCommandResult, type OpsContext } from '../dispatch.js';

/**
 * `bananasaurs status` — gateway, db, jobs, scheduler lag, uptime (`docs/17`).
 *
 * The first thing `docs/17` §3.2 tells an operator (or an agent the operator is
 * driving) to run when asked "what happened", so it answers the questions that
 * make every *other* symptom legible: is the gateway up, is a safety control
 * silently refusing everything, is the queue moving.
 *
 * **Every safety control is reported, including the ones that are fine.** A
 * status that only mentions a control when it is engaged makes "dry run is on
 * and has been for a week" invisible, which is exactly the confusion `docs/21`
 * exercise 2 and 3 walk an operator through.
 */

/** `1d 2h 3m`, dropping leading zero units. Seconds only when that is all there is. */
export const humaniseDuration = (ms: number): string => {
  if (ms < 1_000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  const seconds = Math.floor(ms / 1_000);
  const parts: string[] = [];
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (days > 0) parts.push(`${String(days)}d`);
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0) parts.push(`${String(minutes)}m`);
  if (parts.length === 0 || rest > 0) parts.push(`${String(rest)}s`);
  return parts.join(' ');
};

const render = (ctx: OpsContext, data: StatusData): string => {
  const lines: string[] = [];
  lines.push(`guild     ${data.guildName ?? '(name not yet known)'}  ${ctx.guildId}`);
  lines.push(
    data.gateway.connected
      ? `gateway   connected, ${data.gateway.pingMs === null ? 'no heartbeat yet' : `${String(data.gateway.pingMs)}ms`}, in ${String(data.gateway.guildCount)} guild(s)`
      : `gateway   DISCONNECTED`,
  );
  lines.push(`uptime    ${humaniseDuration(data.uptimeMs)}  (${data.env})`);

  const jobs = Object.entries(data.jobs);
  lines.push(
    `jobs      ${jobs.length === 0 ? 'none' : jobs.map(([state, n]) => `${state}=${String(n)}`).join(' ')}`,
  );
  lines.push(
    `lag       ${data.schedulerLagMs === 0 ? 'none' : `${humaniseDuration(data.schedulerLagMs)} behind`}`,
  );

  if (data.safety === null) {
    // Not a cosmetic gap: the effect gateway reads this row to decide whether
    // it may act, so its absence is a real finding rather than a blank field.
    lines.push('safety    no row in `guilds` for this guild — the effect gateway cannot read it');
  } else {
    lines.push(
      `safety    ${data.safety.killswitch ? 'KILL SWITCH ON' : 'killswitch off'} · ` +
        `${data.safety.dryRun ? 'DRY RUN ON (no Discord side effect will be performed)' : 'dry run off'} · ` +
        `${data.safety.breakerOpen ? `BREAKER OPEN: ${data.safety.breakerReason ?? 'no reason recorded'}` : 'breaker closed'}`,
    );
    lines.push(
      `limits    ${String(data.safety.roleRatePerMin)}/min roles · ` +
        `reconcile budget ${String(data.safety.reconcileBudget)} · ` +
        `breaker at ${String(data.safety.breakerThreshold)} failures`,
    );
  }

  if (data.readonly) {
    lines.push('mode      read-only (BANANASAURS_READONLY=1): every write command will refuse');
  }
  return lines.join('\n');
};

type StatusData = {
  readonly guildId: string;
  readonly guildName: string | null;
  readonly env: string;
  readonly readonly: boolean;
  readonly uptimeMs: number;
  readonly gateway: {
    readonly connected: boolean;
    readonly pingMs: number | null;
    readonly guildCount: number;
  };
  readonly jobs: Readonly<Record<string, number>>;
  readonly schedulerLagMs: number;
  readonly safety: {
    readonly killswitch: boolean;
    readonly dryRun: boolean;
    readonly breakerOpen: boolean;
    readonly breakerReason: string | null;
    readonly roleRatePerMin: number;
    readonly reconcileBudget: number;
    readonly breakerThreshold: number;
  } | null;
};

export const statusCommand = defineCommand<Record<string, never>>({
  name: 'status',
  write: false,
  summary: 'gateway, database, jobs, scheduler lag, uptime and every safety control',
  args: z.object({}),
  run(ctx: OpsContext): OpsCommandResult {
    const nowMs = ctx.now();
    const gateway = ctx.instance.gateway();
    const safety = ctx.ports.safetyState();
    const dueAt = ctx.ports.oldestDueJobAtMs(nowMs);

    const data: StatusData = {
      guildId: ctx.guildId,
      guildName: ctx.ports.guildName() ?? null,
      env: ctx.instance.env,
      readonly: ctx.instance.readonly,
      uptimeMs: nowMs - ctx.instance.startedAtMs,
      gateway: {
        connected: gateway.connected,
        // `null`, not `0`: a heartbeat that has not happened is not a fast one.
        pingMs: gateway.pingMs ?? null,
        guildCount: gateway.guildCount,
      },
      jobs: ctx.ports.jobCounts(),
      // Clamped at zero so a clock that moved backwards reports "not behind"
      // rather than a negative lag nobody can interpret.
      schedulerLagMs: dueAt === undefined ? 0 : Math.max(0, nowMs - dueAt),
      safety: safety ?? null,
    };

    return { text: render(ctx, data), data };
  },
});
