import type { DomainEvent } from '../discord/events.js';
import type { Snowflake } from '../discord/port.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import { fingerprintOf } from './fingerprint.js';

/**
 * The one path every gateway event travels.
 *
 *     adapter -> DomainEvent
 *       -> guild allowlist gate   (not allowlisted -> log + leave, stop)
 *       -> dedupe gate            (first sight? no -> drop)
 *       -> subscribers            (isolated: one throwing does not stop another)
 *
 * The gates are ordered deliberately. The allowlist runs first because an event
 * from a guild we are not supposed to be in must not reach a subscriber, must
 * not be recorded, and must not cause a write — it should cause a departure.
 * Deduplication runs second because it writes a row, and writing rows for a
 * guild we are leaving is exactly what the allowlist is there to prevent.
 */

/**
 * Records the first sight of a fingerprint.
 *
 * Returns true when this dispatch is the first. The implementation is an
 * INSERT OR IGNORE and a zero-row result, so the check and the record are one
 * atomic operation — a check-then-write would let a replay slip between them.
 */
export interface DedupeStore {
  firstSight(input: {
    guildId: Snowflake;
    eventKind: string;
    fingerprint: string;
    atMs: number;
  }): boolean;
}

export interface Subscriber {
  /** Appears in logs when this subscriber throws. */
  readonly name: string;
  handle(event: DomainEvent): Promise<void> | void;
}

export interface PipelineDeps {
  /** Guilds this instance is permitted to operate in. */
  readonly allowlist: ReadonlySet<Snowflake>;
  readonly dedupe: DedupeStore;
  readonly subscribers: readonly Subscriber[];
  /** Called once per unlisted guild. The adapter leaves. */
  leaveGuild(guildId: Snowflake): Promise<void>;
  readonly logger: Logger;
}

export type DispatchOutcome =
  | { status: 'delivered'; ran: number; failed: readonly string[] }
  | { status: 'dropped'; reason: 'duplicate' }
  | { status: 'refused'; reason: 'guild-not-allowlisted' };

export class Pipeline {
  /**
   * Guilds we have already asked to leave.
   *
   * Without this, a burst of events from an unlisted guild produces one
   * `leaveGuild` REST call per event. The set is process-local on purpose: if
   * the leave failed and we restart, trying again is the correct behaviour.
   */
  readonly #departed = new Set<Snowflake>();

  constructor(private readonly deps: PipelineDeps) {}

  async dispatch(event: DomainEvent): Promise<DispatchOutcome> {
    const { allowlist, dedupe, logger } = this.deps;

    // --- gate 1: guild allowlist ------------------------------------------
    if (!allowlist.has(event.guildId)) {
      logger.warn(
        safeLogFields({
          component: 'pipeline',
          guildId: event.guildId,
          eventKind: event.kind,
          reason: 'guild-not-allowlisted',
        }),
        'event from a guild outside the allowlist; leaving',
      );

      if (!this.#departed.has(event.guildId)) {
        this.#departed.add(event.guildId);
        try {
          await this.deps.leaveGuild(event.guildId);
        } catch (err) {
          // Retried on the next restart: the set is process-local.
          this.#departed.delete(event.guildId);
          logger.error(
            safeLogFields({ component: 'pipeline', guildId: event.guildId, err }),
            'failed to leave an unlisted guild',
          );
        }
      }
      return { status: 'refused', reason: 'guild-not-allowlisted' };
    }

    // --- gate 2: deduplication --------------------------------------------
    const fingerprint = fingerprintOf(event);
    if (fingerprint !== undefined) {
      const first = dedupe.firstSight({
        guildId: event.guildId,
        eventKind: event.kind,
        fingerprint,
        atMs: event.receivedAtMs,
      });
      if (!first) {
        logger.debug(
          safeLogFields({
            component: 'pipeline',
            guildId: event.guildId,
            eventKind: event.kind,
            fingerprint,
            outcome: 'duplicate',
          }),
          'dropping a duplicate dispatch',
        );
        return { status: 'dropped', reason: 'duplicate' };
      }
    }

    // --- subscribers, isolated ---------------------------------------------
    // One subscriber throwing must not stop another. The logging module going
    // wrong should not take role panels down with it, and vice versa.
    const failed: string[] = [];
    for (const subscriber of this.deps.subscribers) {
      try {
        await subscriber.handle(event);
      } catch (err) {
        failed.push(subscriber.name);
        logger.error(
          safeLogFields({
            component: subscriber.name,
            guildId: event.guildId,
            eventKind: event.kind,
            err,
          }),
          'subscriber threw; other subscribers continue',
        );
      }
    }

    return { status: 'delivered', ran: this.deps.subscribers.length, failed };
  }
}
