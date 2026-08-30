import type { InteractionRef, OutgoingMessage, Snowflake } from '../../discord/port.js';
import { safeLogFields, type Logger } from '../../obs/logger.js';
import type { Subscriber } from '../../pipeline/pipeline.js';
import type { OpsInstance, OpsPorts } from '../ports.js';
import { humaniseDuration } from './status.js';

/**
 * `/status` in Discord — the same facts `GET /api/health` serves, through a
 * different front door.
 *
 * Nothing here queries anything the dashboard does not already query: the
 * gateway connection from `OpsInstance.gateway()`, and the guild's safety state,
 * job counts and scheduler lag from `OpsPorts`. `packages/http` cannot be
 * imported from here (ADR 0014) and is not the point anyway — what is shared is
 * the *ports*, so the two surfaces cannot drift into reporting different
 * numbers.
 *
 * **Open to every guild member, with no `authorize()` call** (ADR 0033). That
 * asymmetry with `/api/health`'s `config.read` gate is deliberate and argued
 * there: a dashboard session is a bearer credential on a network port, while a
 * slash command arrives with the caller's real Discord identity from inside an
 * allowlisted guild. The failure this command exists to explain — dry run left
 * on, a forgotten kill switch, an open breaker — is one the member watching a
 * panel do nothing is best placed to notice.
 *
 * The reply is **ephemeral**: not for secrecy, but so repeated invocations
 * cannot fill a channel, and because a bot that answers a private question
 * privately is what panel interactions already taught members to expect.
 */

/** How a slash-command handler acknowledges and answers. */
export interface SlashResponder {
  defer(ref: InteractionRef, options: { ephemeral: boolean }): Promise<void>;
  respond(ref: InteractionRef, message: OutgoingMessage): Promise<void>;
}

export interface StatusCommandDeps {
  readonly guildId: Snowflake;
  /**
   * The guild's ports, obtained lazily.
   *
   * A thunk rather than a value because the composition root builds this
   * subscriber from the same `portsFor` seam the dashboard uses
   * (`apps/daemon/src/runtime/daemon.ts`), and that seam resolves a `GuildScope`
   * against the map built from `BANANASAURS_GUILD_ALLOWLIST`. Resolving per
   * invocation rather than at construction keeps the two surfaces on one code
   * path instead of two snapshots that could diverge.
   */
  readonly ports: () => OpsPorts;
  readonly instance: OpsInstance;
  readonly responder: SlashResponder;
  readonly now: () => number;
  readonly logger: Logger;
}

/** The name Discord registers, and the name this subscriber answers to. */
export const STATUS_COMMAND_NAME = 'status';

/**
 * What a member is told, given what the ports reported.
 *
 * Exported and pure so the wording is testable without a responder. Deliberately
 * shorter than the operator `status` command's render: an operator asks "what
 * are the configured limits", a member asks "is it working". Rate caps,
 * reconcile budgets, breaker thresholds, uptime and the environment name are all
 * on the operator surface and are absent here — not because they are secret, but
 * because they are not an answer to the question being asked.
 */
export const renderMemberStatus = (input: {
  readonly gateway: { connected: boolean; pingMs: number | undefined; guildCount: number };
  readonly safety:
    | {
        killswitch: boolean;
        dryRun: boolean;
        breakerOpen: boolean;
        breakerReason: string | null;
      }
    | undefined;
  readonly jobCounts: Readonly<Record<string, number>>;
  readonly schedulerLagMs: number;
}): string => {
  const lines: string[] = [];

  lines.push(
    input.gateway.connected
      ? `**Connected** to Discord${input.gateway.pingMs === undefined ? '' : ` (${String(input.gateway.pingMs)}ms)`}.`
      : '**Not connected** to Discord right now.',
  );

  if (input.safety === undefined) {
    // Not a cosmetic gap: the effect gateway reads this row to decide whether it
    // may act at all, so its absence explains a bot that does nothing.
    lines.push('⚠️ No settings row for this server — an operator needs to look at that.');
  } else {
    // Every control is reported when engaged and summarised when not. A status
    // that mentions dry run only while it is off would make "dry run has been on
    // for a week" invisible, which is the confusion `docs/21` walks through.
    const paused: string[] = [];
    if (input.safety.killswitch) paused.push('the kill switch is **on**');
    if (input.safety.dryRun) paused.push('**dry run** is on, so nothing is actually changed');
    if (input.safety.breakerOpen) {
      paused.push(
        `the **safety breaker** has tripped${input.safety.breakerReason === null ? '' : ` (${input.safety.breakerReason})`}`,
      );
    }
    lines.push(
      paused.length === 0
        ? 'Role changes are **enabled** — no safety control is engaged.'
        : `Role changes are **paused**: ${paused.join(', ')}.`,
    );
  }

  const queued = input.jobCounts['queued'] ?? 0;
  const running = input.jobCounts['running'] ?? 0;
  const failed = input.jobCounts['failed'] ?? 0;
  lines.push(
    `Background work: ${String(queued)} queued, ${String(running)} running, ${String(failed)} failed.`,
  );

  if (input.schedulerLagMs > 0) {
    lines.push(`The queue is **${humaniseDuration(input.schedulerLagMs)} behind**.`);
  }

  return lines.join('\n');
};

export const createStatusCommandSubscriber = (deps: StatusCommandDeps): Subscriber => ({
  name: 'slash-status',
  async handle(event) {
    if (event.kind !== 'slashCommand') return;
    // Identified synchronously, before the acknowledgement. Acknowledging a
    // command that is not ours would swallow another application's interaction —
    // the same rule the panel subscriber follows for a custom id.
    if (event.commandName !== STATUS_COMMAND_NAME) return;
    // `/status` takes no subcommand. A payload carrying one is either a stale
    // registration or something crafted, and answering it would be answering a
    // command that does not exist.
    if (event.subcommandPath.length > 0) return;

    const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };

    /**
     * Deferred first, then read.
     *
     * The reads themselves are a handful of SQLite statements and would fit
     * inside Discord's three-second acknowledgement window on any healthy
     * process — but the window is exactly three seconds, missing it discards the
     * token, and a member then sees "This interaction failed" whatever happens
     * afterwards. The one moment that window is most likely to be tight is a
     * process under enough load that somebody is asking `/status`. Deferring
     * costs one extra request and removes the failure mode.
     */
    await deps.responder.defer(ref, { ephemeral: true });

    let text: string;
    try {
      const nowMs = deps.now();
      const ports = deps.ports();
      const gateway = deps.instance.gateway();
      const dueAtMs = ports.oldestDueJobAtMs(nowMs);

      text = renderMemberStatus({
        gateway,
        safety: ports.safetyState(),
        jobCounts: ports.jobCounts(),
        // Clamped at zero so a clock that moved backwards reports "not behind"
        // rather than a negative lag nobody can interpret.
        schedulerLagMs: dueAtMs === undefined ? 0 : Math.max(0, nowMs - dueAtMs),
      });
    } catch (err) {
      deps.logger.error(
        safeLogFields({
          component: 'slash-status',
          guildId: deps.guildId,
          userId: event.userId,
          outcome: 'failed',
          err,
        }),
        'could not build a status reply',
      );
      // Already deferred, so the member gets an answer rather than a spinner
      // that never resolves.
      await deps.responder.respond(ref, {
        content: 'Something went wrong reading the status. An operator has been notified.',
      });
      return;
    }

    await deps.responder.respond(ref, { content: text });
  },
});
