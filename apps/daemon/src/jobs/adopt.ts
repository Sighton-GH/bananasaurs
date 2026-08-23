import {
  adoptPanelPayload,
  JOB_KINDS,
  runAdoptionPass,
  type AdoptionPorts,
  type AdoptPanelPayload,
  type JobHandler,
} from '@bananasaurs/core';
import { panelRepo, type GuildScope } from '@bananasaurs/storage';

/**
 * The adoption pass, as a job.
 *
 * A job rather than a request because it pages `fetchReactionUsers` at 100 per
 * call and then fetches a member per reactor — that is minutes of REST traffic
 * for a well-used panel, and it must survive a restart rather than starting
 * over. `saveCursor` is what makes it resumable.
 *
 * The handler is thin on purpose: everything it decides lives in
 * `core/src/panels/adoption.ts`, and this is the composition root binding the
 * guild scope to it.
 */
export const adoptPanelHandler = (ports: AdoptionPorts): JobHandler<AdoptPanelPayload> => ({
  kind: JOB_KINDS.adoptPanel,
  payload: adoptPanelPayload,
  async run(payload, context) {
    await runAdoptionPass(ports, {
      panelId: payload.panelId,
      cursor: context.cursor,
      saveCursor: (cursor) => context.saveCursor(cursor),
    });
  },
});

/** Binds `setAdoptionPassState` to a scope, for the ports above. */
export const adoptionStateWriter =
  (scope: GuildScope, now: () => number) =>
  (panelId: string, state: Parameters<typeof panelRepo.setAdoptionPassState>[2]): void =>
    panelRepo.setAdoptionPassState(scope, panelId, state, now());
