import {
  JOB_KINDS,
  modPurgePayload,
  runPurgeTick,
  type JobHandler,
  type ModPurgePayload,
  type PurgePorts,
} from '@bananasaurs/core';

/**
 * The bounded purge job, as a job handler (ADR 0037).
 *
 * Thin wiring only — the decision lives in `core`'s `runPurgeTick`
 * (`packages/core/src/mod/purge.ts`), including the dedupe-key scheme that
 * keeps a tick from colliding with its own still-`running` row. This mirrors
 * `logMessageDeleteHandler` (`apps/daemon/src/jobs/logging.ts`): the
 * composition root is the only place allowed to know both the domain and the
 * database (`docs/19` §1), and `ports` is built once per guild in
 * `apps/daemon/src/runtime/guild.ts`.
 */
export const modPurgeHandler = (ports: PurgePorts): JobHandler<ModPurgePayload> => ({
  kind: JOB_KINDS.modPurge,
  payload: modPurgePayload,
  run: (payload, context) =>
    runPurgeTick(ports, { payload, cursor: context.cursor, jobId: context.jobId }),
});
