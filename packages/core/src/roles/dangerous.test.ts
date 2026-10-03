import { describe, expect, it } from 'vitest';
import {
  DANGEROUS_PERMISSION_BITS,
  isDangerousRole,
  rolePingAllowed,
  type RoleFacts,
} from './dangerous.js';

const role = (overrides: Partial<RoleFacts> = {}): RoleFacts => ({
  id: '111111111111111111',
  position: 1,
  permissions: 0n,
  managed: false,
  isEveryone: false,
  ...overrides,
});

describe('isDangerousRole', () => {
  it('flags each dangerous permission on its own', () => {
    for (const [flag, bit] of Object.entries(DANGEROUS_PERMISSION_BITS)) {
      expect(isDangerousRole(bit), flag).toBe(true);
    }
  });

  it('flags a role that holds one dangerous bit among harmless ones', () => {
    expect(isDangerousRole((1n << 10n) | (1n << 28n) | (1n << 13n))).toBe(true);
  });

  it('does not flag a harmless permission alone', () => {
    expect(isDangerousRole(1n << 11n)).toBe(false);
  });

  it('does not flag zero permissions', () => {
    expect(isDangerousRole(0n)).toBe(false);
  });
});

describe('rolePingAllowed refuses in the documented order', () => {
  it('refuses managed and @everyone roles before anything else', () => {
    expect(rolePingAllowed(role({ managed: true }), 10, 'below-bot', false)).toBe(
      'managed-or-everyone',
    );
    expect(rolePingAllowed(role({ isEveryone: true }), 10, 'below-bot', true)).toBe(
      'managed-or-everyone',
    );
    // Even with every later refusal stacked on top, this one wins.
    expect(
      rolePingAllowed(
        role({
          managed: true,
          permissions: DANGEROUS_PERMISSION_BITS.Administrator,
          position: 20,
        }),
        10,
        'allowlist',
        false,
      ),
    ).toBe('managed-or-everyone');
  });

  it('refuses dangerous permissions before hierarchy and allowlist', () => {
    expect(
      rolePingAllowed(
        role({ permissions: DANGEROUS_PERMISSION_BITS.ModerateMembers, position: 20 }),
        10,
        'allowlist',
        true,
      ),
    ).toBe('dangerous');
  });

  it('refuses a role at or above the bot before the allowlist', () => {
    // At the bot's highest position counts as above it.
    expect(rolePingAllowed(role({ position: 10 }), 10, 'allowlist', true)).toBe('above-bot');
    expect(rolePingAllowed(role({ position: 11 }), 10, 'below-bot', false)).toBe('above-bot');
  });

  it('refuses an unlisted role only in allowlist mode', () => {
    expect(rolePingAllowed(role(), 10, 'allowlist', false)).toBe('not-allowlisted');
    // In below-bot mode the allowlist flag is ignored.
    expect(rolePingAllowed(role(), 10, 'below-bot', false)).toBe(true);
  });
});

describe('rolePingAllowed allows the ordinary cases', () => {
  it('allows a plain role below the bot in below-bot mode', () => {
    expect(rolePingAllowed(role(), 10, 'below-bot', false)).toBe(true);
  });

  it('allows an allowlisted role in allowlist mode', () => {
    expect(rolePingAllowed(role(), 10, 'allowlist', true)).toBe(true);
  });
});
