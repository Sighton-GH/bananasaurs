import {
  authorize,
  type Actor,
  type Authorized,
  type EffectGateway,
  type EffectSource,
  type PanelEffects,
  type PanelStore,
} from '@bananasaurs/core';
import { authzStoreFor, effectRepo, panelRepo, type GuildScope } from '@bananasaurs/storage';

/**
 * Binds the panel ports to one guild.
 *
 * The composition root is the only place that knows both the domain and the
 * database, so this is where a `GuildScope` meets `core`'s port interfaces. The
 * scope is captured once, at wiring time — panel code never receives one and
 * has no way to name another guild's panels, which is the shape `jobStoreFor`
 * already established.
 */

/**
 * Who acts when a member clicks a panel.
 *
 * **Not the member.** A member holds no `roles.mutate` grant and must not need
 * one — requiring it would mean granting every member the capability to change
 * roles, which is the opposite of what the panel is for. The authorization for
 * a panel-driven change is *the panel*: an owner holding `panels.manage`
 * created it, enabled it, and chose which roles it offers. `authorize()`
 * returns a witness for `system` unconditionally (`authz.ts`), because a
 * scheduled or configured action should not stop working because a grant was
 * revoked by accident.
 *
 * Nothing about who acted is lost: the member is the *subject* of the audit
 * row, which for a panel is the same person, and every one of the gateway's
 * layers still runs — allowlist, protected target, live hierarchy, rate cap,
 * idempotency, dry run.
 */
export const PANEL_ACTOR: Actor = { type: 'system', id: undefined, roleIds: [] };

export const panelStoreFor = (scope: GuildScope): PanelStore => ({
  findPanelByMessage: (channelId, messageId) =>
    panelRepo.findPanelByMessage(scope, channelId, messageId),
  findPanel: (panelId) => panelRepo.findPanel(scope, panelId),
  listAdoptedPanels: () => panelRepo.listAdoptedPanels(scope),
});

/**
 * The effect side, with the authorization witness already bound.
 *
 * Panel code receives `apply`, never the gateway and never a witness — so it
 * cannot construct one, and the lint tripwire against casting to `Authorized`
 * has nothing to catch here because there is nothing to cast.
 */
export const panelEffectsFor = (
  scope: GuildScope,
  gateway: EffectGateway,
  auth: Authorized<'roles.mutate'>,
  // Injected rather than `Date.now()`: the same clock the gateway and the job
  // worker read, so a test can advance time and a log line's timestamps agree.
  now: () => number,
): PanelEffects => ({
  openBatch: (source: EffectSource) =>
    effectRepo.openBatch(scope, {
      source,
      actorType: PANEL_ACTOR.type,
      actorId: PANEL_ACTOR.id,
      now: now(),
    }),
  closeBatch: (batchId) => effectRepo.closeBatch(scope, batchId, now()),
  apply: (intent) => gateway.applyRoleEffect(auth, intent),
  recordGranted: (input) =>
    effectRepo.recordAssignment(scope, {
      userId: input.userId,
      roleId: input.roleId,
      panelId: input.panelId,
      effectId: input.effectId,
      now: input.now,
    }),
  forgetGranted: (input) =>
    effectRepo.removeAssignment(scope, { userId: input.userId, roleId: input.roleId }),
});

/** The witness panel code runs under. Obtained honestly, never cast. */
export const panelAuthorization = (scope: GuildScope): Authorized<'roles.mutate'> => {
  const result = authorize(
    { store: authzStoreFor(scope), guildId: scope.guildId, actor: PANEL_ACTOR },
    'roles.mutate',
  );
  if (!result.ok) {
    throw new Error(`panels could not obtain authorization: ${result.error.reason}`);
  }
  return result.value;
};
