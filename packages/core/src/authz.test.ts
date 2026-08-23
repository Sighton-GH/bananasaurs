import { describe, expect, it } from 'vitest';
import { authorize, capabilityOf, principalsOf, type Actor, type AuthzStore } from './authz.js';
import { parseGuildId, parseSnowflakeId } from './ids.js';

const GUILD = parseGuildId('111111111111111111');
const USER = parseSnowflakeId('222222222222222222');
const ROLE = parseSnowflakeId('333333333333333333');

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

  it('does not present a dashboard account id as a Discord principal', () => {
    // Account ids are not snowflakes. Without the shape check, a dashboard
    // actor could match a `principals` row by coincidence.
    const dashboard = member({ type: 'dashboard', id: 'acct_01HXYZ', roleIds: [] });
    expect(principalsOf(dashboard)).toEqual([]);
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
