import { safeLogFields, type Logger } from '../obs/logger.js';
import { kindsInLane, type JobLane } from './lanes.js';
import type { ClaimedJob, JobWorker } from './worker.js';

/**
 * One lane's share of the scheduler: which lane, and how many jobs of it may
 * run at once.
 */
export interface LaneConfig {
  readonly lane: JobLane;
  /** Read on every tick, so a settings change applies without a restart. Values < 1 are treated as 1. */
  readonly concurrency: () => number;
}

const laneKinds = (
  lane: JobLane,
): { kinds: readonly string[] } | { excludeKinds: readonly string[] } => {
  if (lane === 'assistant') return { kinds: kindsInLane('assistant') };
  if (lane === 'background') return { kinds: kindsInLane('background') };
  // Any unmapped kind runs in `default`, so it claims by exclusion, not by list.
  return { excludeKinds: [...kindsInLane('assistant'), ...kindsInLane('background')] };
};

/**
 * Runs durable jobs in lanes (ADR 0135).
 *
 * Each lane claims only its own kinds and never exceeds its concurrency. The
 * worker stays serial — `runOnce` and `drain` keep their behaviour — while
 * this starts one `execute` per free slot without awaiting it. The daemon owns
 * the timer and calls `tick()`; `stop()` awaits `idle()`.
 */
export class LaneScheduler {
  readonly #worker: JobWorker;
  readonly #lanes: readonly LaneConfig[];
  readonly #logger: Logger;
  readonly #running = new Map<JobLane, Set<ClaimedJob>>();
  readonly #inFlight = new Set<Promise<void>>();

  constructor(deps: { readonly worker: JobWorker; readonly lanes: readonly LaneConfig[]; readonly logger: Logger }) {
    this.#worker = deps.worker;
    this.#lanes = deps.lanes;
    this.#logger = deps.logger;
  }

  /** Claims and starts (without awaiting) as many jobs as each lane has free slots for. Returns how many started. Never throws. */
  tick(): number {
    let started = 0;
    for (const config of this.#lanes) {
      try {
        started += this.#tickLane(config.lane, Math.max(1, config.concurrency()));
      } catch (err) {
        this.#logger.error(
          safeLogFields({ component: 'jobs', lane: config.lane, err }),
          'job claim failed',
        );
      }
    }
    return started;
  }

  /** Resolves when no job started by this scheduler is still running. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  /** Jobs currently running, per lane (for tests and diagnostics). */
  runningCount(lane: JobLane): number {
    return this.#running.get(lane)?.size ?? 0;
  }

  #tickLane(lane: JobLane, limit: number): number {
    let started = 0;
    const kinds = laneKinds(lane);
    while (this.runningCount(lane) < limit) {
      const running = [...(this.#running.get(lane) ?? [])];
      // An exclusive, keyless job owns the lane until it settles.
      if (running.some((job) => job.orderingKey == null)) break;
      let job: ClaimedJob | undefined;
      try {
        job = this.#worker.claim({
          ...kinds,
          busyOrderingKeys: running.flatMap((item) =>
            item.orderingKey == null ? [] : [item.orderingKey],
          ),
          laneBusy: running.length > 0,
        });
      } catch (err) {
        this.#logger.error(
          safeLogFields({ component: 'jobs', lane, err }),
          'job claim failed',
        );
        break;
      }
      if (job === undefined) break;
      let set = this.#running.get(lane);
      if (set === undefined) {
        set = new Set();
        this.#running.set(lane, set);
      }
      set.add(job);
      started += 1;
      void this.#run(lane, job);
    }
    return started;
  }

  async #run(lane: JobLane, job: ClaimedJob): Promise<void> {
    const done = this.#worker.execute(job).then(
      () => {
        this.#release(lane, job);
      },
      (err: unknown) => {
        this.#release(lane, job);
        this.#logger.error(
          safeLogFields({ component: 'jobs', jobId: job.jobId, jobKind: job.kind, err }),
          'job execution threw',
        );
      },
    );
    this.#inFlight.add(done);
    try {
      await done;
    } finally {
      this.#inFlight.delete(done);
    }
  }

  #release(lane: JobLane, job: ClaimedJob): void {
    this.#running.get(lane)?.delete(job);
  }
}
