import { describe, expect, it } from 'vitest';
import {
  authorize,
  capabilityOf,
  principalsOf,
  CAPABILITIES,
  type Actor,
  type AuthzStore,
  type Capability,
  type PrincipalRef,
} from './authz.js';
import { parseAccountId, parseGuildId, parseSnowflakeId } from './ids.js';

const GUILD = parseGuildId('111111111111111111');
const USER = parseSnowflakeId('222222222222222222');
const ROLE = parseSnowflakeId('333333333333333333');
const ACCOUNT = parseAccountId('acct_0123456789abcdef0123456789abcdef');

const member = (over: Partial<Actor> = {}): Actor => ({
  type: 'member',
  id: USER,
  roleIds: [ROLE],
  ...over,
});

const store = (over: Partial<AuthzStore> = {}): AuthzStore => ({
  hasGrant: () => false,
  ...over,
});

describe('principalsOf', () => {
  it('presents the actor and every role it holds', () => {
    expect(principalsOf(member())).toEqual([
      { principalType: 'user', principalId: USER },
      { principalType: 'role', principalId: ROLE },
    ]);
  });

  it('presents a dashboard account as an account principal (ADR 0028)', () => {
    const dashboard = member({ type: 'dashboard', id: ACCOUNT, roleIds: [] });
    expect(principalsOf(dashboard)).toEqual([{ principalType: 'account', principalId: ACCOUNT }]);
  });

  it('never presents a dashboard account id as a Discord principal', () => {
    const dashboard = member({ type: 'dashboard', id: ACCOUNT, roleIds: [] });
    expect(principalsOf(dashboard).map((p) => p.principalType)).not.toContain('user');
  });

  it('presents nothing for a dashboard actor whose id is not an account id', () => {
    // The shape check is what stops a caller putting a snowflake in a dashboard
    // actor's `id` and picking up that Discord user's grants.
    const dashboard = member({ type: 'dashboard', id: USER, roleIds: [] });
    expect(principalsOf(dashboard)).toEqual([]);
  });

  it('ignores a dashboard actor’s Discord roles entirely (ADR 0012, ADR 0028)', () => {
    /**
     * The control this test exists for. ADR 0012: Discord role membership
     * grants nothing here, because other club members hold Administrator. If
     * `roleIds` reached `hasGrant` for a dashboard actor, the account-linking
     * feature ADR 0012 leaves for later — which would populate this very field
     * from Discord — would silently turn every role grant into a dashboard
     * capability, with nobody editing `principalsOf` to make it happen.
     *
     * Read this before "simplifying" the dashboard branch back into the common
     * path.
     */
    const linked = member({ type: 'dashboard', id: ACCOUNT, roleIds: [ROLE] });
    expect(principalsOf(linked)).toEqual([{ principalType: 'account', principalId: ACCOUNT }]);
  });

  it('does not let a dashboard actor reach a grant made to a role it claims', () => {
    const store = {
      hasGrant: (_c: Capability, refs: readonly PrincipalRef[]) =>
        refs.some((r) => r.principalType === 'role' && r.principalId === ROLE),
    };
    const linked = member({ type: 'dashboard', id: ACCOUNT, roleIds: [ROLE] });
    expect(authorize({ store, guildId: GUILD, actor: linked }, 'killswitch.toggle').ok).toBe(false);
  });
});

describe('TOTP is deferred, and this test is what re-arms it (ADR 0030)', () => {
  /**
   * ADR 0012 requires TOTP for any account holding provider-credential or purge
   * capability. Neither exists in Release 1, so the requirement is currently
   * vacuous — there is no capability to hold that would trigger it.
   *
   * ADR 0030 records the deferral. This is the condition that ends it: adding
   * any of these to `CAPABILITIES` fails the build, so whoever builds the
   * provider layer or a purge must either build TOTP or make an explicit,
   * visible decision not to. That is the difference between a deferral and an
   * omission.
   *
   * The list is a heuristic — it is the names those capabilities would
   * plausibly take. A capability that grants provider credentials or purge
   * under some other name is still covered by ADR 0012; add it here rather than
   * routing around this test.
   */
  const REQUIRES_TOTP = ['providers.manage', 'secrets.manage', 'data.purge', 'archive.export'];

  it.each(REQUIRES_TOTP)('%s is not a capability yet', (capability) => {
    expect(
      CAPABILITIES as readonly string[],
      `${capability} was added to CAPABILITIES, and ADR 0012 requires TOTP for any account ` +
        `holding it. ADR 0030 deferred TOTP only because no such capability existed. Either ` +
        `build TOTP enrolment and verification, or amend ADR 0030 with a new reason and remove ` +
        `this name from the list — but do not delete this test.`,
    ).not.toContain(capability);
  });

  it('still has the eight Release 1 capabilities, so the guard is not vacuous', () => {
    expect(CAPABILITIES).toHaveLength(8);
  });
});

describe('authorize', () => {
  it('grants when a principal holds the capability', () => {
    const result = authorize(
      { store: store({ hasGrant: () => true }), guildId: GUILD, actor: member() },
      'roles.mutate',
    );
    expect(result.ok).toBe(true);
  });

  it('refuses when no principal holds it', () => {
    const result = authorize({ store: store(), guildId: GUILD, actor: member() }, 'roles.mutate');
    expect(result).toEqual({
      ok: false,
      error: { reason: 'no-grant', capability: 'roles.mutate', guildId: GUILD },
    });
  });

  it('never consults Discord permission bits, so Administrator grants nothing', () => {
    // ADR 0012. The club has other administrators; "admin in Discord" must not
    // silently mean "can reconfigure the bot". There is no code path here that
    // could read a permission bit even if someone wanted to.
    const administrator = member({ type: 'owner' });
    const result = authorize(
      { store: store(), guildId: GUILD, actor: administrator },
      'config.write',
    );
    expect(result.ok).toBe(false);
  });

  it('does not consult `protected` when deciding capability', () => {
    // ADR 0015. `protected` means "the bot will not mutate this", and nothing
    // else. If it also denied capability, protecting the role you act through
    // would lock you out of your own bot — which is how a safety feature
    // becomes an outage. The target-side check lives in the effect gateway.
    const result = authorize(
      { store: store({ hasGrant: () => true }), guildId: GUILD, actor: member() },
      'roles.mutate',
    );
    expect(result.ok).toBe(true);
  });

  it('refuses an actor with no identity at all', () => {
    const anonymous = member({ id: undefined, roleIds: [] });
    expect(
      authorize(
        { store: store({ hasGrant: () => true }), guildId: GUILD, actor: anonymous },
        'roles.mutate',
      ),
    ).toMatchObject({ ok: false, error: { reason: 'actor-has-no-identity' } });
  });

  it('authorizes system actors by wiring rather than by grant', () => {
    // A scheduled reconciliation pass should not stop repairing drift because
    // someone revoked a grant by accident.
    const system = member({ type: 'system', id: undefined, roleIds: [] });
    expect(authorize({ store: store(), guildId: GUILD, actor: system }, 'roles.mutate').ok).toBe(
      true,
    );
  });

  it('carries the capability it checked, so re-verification checks the same one', () => {
    const result = authorize(
      { store: store({ hasGrant: () => true }), guildId: GUILD, actor: member() },
      'undo.execute',
    );
    expect(result.ok && capabilityOf(result.value)).toBe('undo.execute');
  });

  it('carries the guild it checked, so a witness cannot be reused elsewhere', () => {
    const result = authorize(
      { store: store({ hasGrant: () => true }), guildId: GUILD, actor: member() },
      'roles.mutate',
    );
    expect(result.ok && result.value.guildId).toBe(GUILD);
  });

  it('asks the store for the capability actually requested', () => {
    const asked: string[] = [];
    authorize(
      {
        store: store({
          hasGrant: (capability) => {
            asked.push(capability);
            return true;
          },
        }),
        guildId: GUILD,
        actor: member(),
      },
      'killswitch.toggle',
    );
    expect(asked).toEqual(['killswitch.toggle']);
  });
});

describe('the witness cannot be produced by an object literal', () => {
  it('is documented as a type-level property, not asserted at runtime', () => {
    // The brand symbol is module-private, so `{ guildId, actor }` does not
    // satisfy `Authorized<C>` and there is no exported way to add the symbol.
    // That is a compile-time property; the runtime control is the gateway
    // re-checking the grant, which `gateway.test.ts` exercises directly.
    const result = authorize(
      { store: store({ hasGrant: () => true }), guildId: GUILD, actor: member() },
      'roles.mutate',
    );
    expect(result.ok && Object.getOwnPropertySymbols(result.value)).toHaveLength(1);
  });
});

describe('the operator CLI (ADR 0024)', () => {
  const cli = (over: Partial<Actor> = {}): Actor => ({
    type: 'operator_cli',
    id: undefined,
    roleIds: [],
    unixUserClaimed: 'bryan',
    ...over,
  });

  it('is authorized by reaching the socket, with no grant row anywhere', () => {
    // ADR 0024. `capability_grants` cannot hold a Unix username, the claimed
    // name is not kernel-verified, and a fresh install has zero grant rows —
    // so a CLI gated on a grant could never issue the first grant.
    const result = authorize({ store: store(), guildId: GUILD, actor: cli() }, 'roles.mutate');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(capabilityOf(result.value)).toBe('roles.mutate');
  });

  it('does not consult the grant store at all', () => {
    let asked = false;
    const result = authorize(
      {
        store: store({
          hasGrant: () => {
            asked = true;
            return false;
          },
        }),
        guildId: GUILD,
        actor: cli(),
      },
      'killswitch.toggle',
    );
    expect(result.ok).toBe(true);
    expect(asked).toBe(false);
  });

  it('carries the claimed unix user on the witness, for the audit row', () => {
    const result = authorize({ store: store(), guildId: GUILD, actor: cli() }, 'undo.execute');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actor.unixUserClaimed).toBe('bryan');
    expect(result.value.actor.type).toBe('operator_cli');
  });

  it('does not extend to the dashboard, which still needs an owner-issued grant', () => {
    // ADR 0012 is untouched by ADR 0024: a dashboard account holds an explicit
    // capability set, and a Discord permission bit grants nothing. Widening the
    // socket's exemption to cover `dashboard` would quietly undo that.
    const dashboard = cli({ type: 'dashboard', id: 'acct_01HXYZ' });
    const result = authorize({ store: store(), guildId: GUILD, actor: dashboard }, 'roles.mutate');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('actor-has-no-identity');
  });

  it('does not extend to a member, however they present themselves', () => {
    const spoofing = member({ unixUserClaimed: 'root' });
    const result = authorize({ store: store(), guildId: GUILD, actor: spoofing }, 'roles.mutate');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('no-grant');
  });

  it('does not extend to the owner actor type either', () => {
    // `owner` is a Discord identity like any other. The socket is the boundary,
    // not a claim about who someone is.
    const owner = member({ type: 'owner' });
    const result = authorize({ store: store(), guildId: GUILD, actor: owner }, 'roles.mutate');
    expect(result.ok).toBe(false);
  });
});
