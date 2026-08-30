import { isSnowflakeId } from './ids.js';
import type { GuildId, SnowflakeId } from './ids.js';

/**
 * Capability checking.
 *
 * The reason a new caller cannot skip the check is that **the check produces a
 * value the executor requires as an argument.** There is no overload of
 * `applyRoleEffect` without a witness, so forgetting to authorize is not a
 * thing you can do by omission — it is a compile error.
 *
 * **The type is not the boundary**, and amendment 3 is right that pretending
 * otherwise would be a security claim I cannot support. `Authorized<C>` is
 * erased at runtime, so `as unknown as Authorized<'roles.mutate'>` defeats it
 * entirely — and that is precisely the line someone writes to make a test
 * compile, which means it arrives with good intentions and survives review.
 *
 * So the check is enforced five ways, and the type is the weakest of them:
 *
 * 1. **Runtime re-verification** — `applyRoleEffect` calls `authorize()` again
 *    before acting. A forged witness fails there. *This is the control.*
 * 2. **Lint tripwire** — `no-restricted-syntax` bans casts onto the
 *    `Authorized` family. An `eslint-disable` defeats it, which is fine: the
 *    point is to make the bypass visible in a diff, not impossible.
 * 3. **Type level** — you cannot call the executor without a witness, and the
 *    brand symbol below is not exported, so the shape cannot be produced by an
 *    object literal either. This makes the check impossible to *forget*, which
 *    is the common failure; it does not make it impossible to *defeat*.
 * 4. **Query level** — grants come only from `capability_grants`. Discord
 *    permission bits are never consulted, so Administrator grants nothing
 *    (ADR 0012). Note that `protected` is deliberately NOT consulted here —
 *    see ADR 0015; it is a property of a *target*, checked in the gateway.
 * 5. **Module level** — the Discord REST port is importable only from
 *    `core/effects` (ADR 0014), so even code holding a forged witness cannot
 *    reach Discord except through the gateway.
 */

/**
 * A real runtime symbol, not `declare const`.
 *
 * That distinction matters: with a declared-only symbol, `authorize` would have
 * to cast to construct a witness — and the one cast in the codebase would sit
 * in the module whose whole job is to be uncastable. A real symbol lets the
 * witness be built honestly, and since it is never exported, no other module
 * can produce the shape with an object literal.
 */
const witness = Symbol('bananasaurs.authorized');

export const CAPABILITIES = [
  'roles.mutate',
  'panels.manage',
  'logging.manage',
  'config.read',
  'config.write',
  'audit.read',
  'killswitch.toggle',
  'undo.execute',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type ActorType = 'member' | 'owner' | 'operator_cli' | 'dashboard' | 'system' | 'doctor';

export interface Actor {
  readonly type: ActorType;
  /** A Discord user id, or a dashboard account id. Absent for `system`. */
  readonly id: string | undefined;
  /** Discord roles held, so a grant to a role reaches its members. */
  readonly roleIds: readonly SnowflakeId[];
  /**
   * CLI-asserted and **not kernel-verified** — Node cannot read SO_PEERCRED
   * (amendment 2). The real access control is the socket's group permissions.
   * Recorded as a claim, rendered as a claim.
   */
  readonly unixUserClaimed?: string | undefined;
}

/** Proof that `capability` was checked for this actor in this guild. */
export interface Authorized<C extends Capability> {
  readonly [witness]: C;
  readonly guildId: GuildId;
  readonly actor: Actor;
}

export type DenialReason =
  | 'no-grant'
  /** `system` acts without a principal; it is granted only what is wired in. */
  | 'actor-has-no-identity';

export interface Denied {
  readonly reason: DenialReason;
  readonly capability: Capability;
  readonly guildId: GuildId;
}

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface PrincipalRef {
  readonly principalType: 'user' | 'role';
  readonly principalId: SnowflakeId;
}

export interface AuthzStore {
  /**
   * True when any of these principals holds `capability` in this guild.
   *
   * Deliberately the only question this port answers. `protected` is a
   * property of a **target**, not of an actor (ADR 0015), so it is checked in
   * the effect gateway against the member and role being changed — never here
   * against the member asking.
   */
  hasGrant(capability: Capability, principals: readonly PrincipalRef[]): boolean;
}

/**
 * Actor types that act on the instance's own behalf rather than a member's.
 *
 * They hold no principal row and are not granted capability by this function —
 * a scheduled reconciliation pass is authorized by being wired into the daemon,
 * not by a grant someone could revoke by accident and then wonder why drift
 * repair stopped.
 */
const SYSTEM_ACTORS: ReadonlySet<ActorType> = new Set<ActorType>(['system', 'doctor']);

/**
 * Actor types whose **channel** is the authorization (ADR 0024).
 *
 * `operator_cli` reaches this process over `/run/bananasaurs/admin.sock`, owned
 * `bananasaurs:bananasaurs-ops`, mode 0660. Group membership is a filesystem
 * permission the kernel enforces, and it is the whole access control; the
 * `unixUserClaimed` the request carries is an assertion (amendment 2), recorded
 * in the audit trail and consulted for nothing here.
 *
 * **Deliberately its own set rather than an entry in `SYSTEM_ACTORS`.** That set
 * means "authorized by being wired into the daemon, not by a grant someone
 * could revoke by accident" — a different justification, which happens to reach
 * the same outcome. Folding the two together would mean the next person to
 * change either rule silently changes the other.
 *
 * Three reasons the alternative — check `capability_grants` like everyone else —
 * is not available, all recorded in ADR 0024: the table is keyed by a Discord
 * snowflake and a Unix username is not one; the identity is not verifiable, so
 * the check would be a control built on an assertion; and a fresh install has
 * zero grant rows, so a CLI gated on a grant could never issue the first grant.
 *
 * `dashboard` is **not** here and must not be added. ADR 0012 makes a dashboard
 * account's capability an explicit owner-issued grant, and that is the decision
 * keeping the club's other Discord administrators out of the control plane.
 */
const CHANNEL_AUTHORIZED_ACTORS: ReadonlySet<ActorType> = new Set<ActorType>(['operator_cli']);

/**
 * The principals an actor presents: itself, plus every role it holds.
 *
 * `isSnowflakeId` is a type predicate rather than a shape check followed by a
 * cast — a cast onto `SnowflakeId` is banned by the lint tripwire, and rightly:
 * this is exactly the spot where one would have been written for convenience.
 * A dashboard account id is not a snowflake, so it simply never becomes a
 * Discord principal, rather than relying on account ids never colliding with
 * user ids.
 */
export const principalsOf = (actor: Actor): PrincipalRef[] => {
  const principals: PrincipalRef[] = actor.roleIds.map((roleId) => ({
    principalType: 'role',
    principalId: roleId,
  }));
  if (actor.id !== undefined && isSnowflakeId(actor.id)) {
    principals.unshift({ principalType: 'user', principalId: actor.id });
  }
  return principals;
};

export interface AuthorizeInput {
  readonly store: AuthzStore;
  readonly guildId: GuildId;
  readonly actor: Actor;
}

/**
 * The single implementation. Everything that checks capability calls this,
 * including `applyRoleEffect` re-checking a witness it was handed.
 */
export function authorize<C extends Capability>(
  input: AuthorizeInput,
  capability: C,
): Result<Authorized<C>, Denied> {
  const { store, guildId, actor } = input;
  const deny = (reason: DenialReason): Result<Authorized<C>, Denied> => ({
    ok: false,
    error: { reason, capability, guildId },
  });

  if (SYSTEM_ACTORS.has(actor.type)) {
    // Authorized by being wired in, not by a grant. Still gets a witness so the
    // executor's signature is uniform and the audit row records who acted.
    return { ok: true, value: { [witness]: capability, guildId, actor } };
  }

  if (CHANNEL_AUTHORIZED_ACTORS.has(actor.type)) {
    // Authorized by the socket's group permissions (ADR 0024). The witness
    // carries the actor unchanged, so the claimed Unix user reaches the audit
    // row — and `applyRoleEffect`'s runtime re-verification lands back here and
    // reaches the same conclusion, rather than being a special case it skips.
    return { ok: true, value: { [witness]: capability, guildId, actor } };
  }

  const principals = principalsOf(actor);
  if (principals.length === 0) return deny('actor-has-no-identity');

  // No protection check here, deliberately (ADR 0015). Marking a principal
  // protected must not deny it capability, or protecting the role you act
  // through locks you out of your own bot.
  if (!store.hasGrant(capability, principals)) return deny('no-grant');

  return { ok: true, value: { [witness]: capability, guildId, actor } };
}

/** Reads the capability a witness carries, for logging and re-verification. */
export const capabilityOf = <C extends Capability>(auth: Authorized<C>): C => auth[witness];
