import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from './authz.js';
import { ACCOUNT_ROLES, CAPABILITY_INFO, roleForCapabilities } from './account-roles.js';

describe('account roles (ADR 0069)', () => {
  it('describes every capability', () => {
    for (const c of CAPABILITIES) {
      expect(CAPABILITY_INFO[c].label.length).toBeGreaterThan(0);
      expect(CAPABILITY_INFO[c].description.endsWith('.')).toBe(true);
    }
    expect(CAPABILITY_INFO['accounts.manage'].highTrust).toBe(true);
  });

  it('no preset grants accounts.manage or mcp.authorize', () => {
    for (const r of ACCOUNT_ROLES) {
      expect(r.capabilities).not.toContain('accounts.manage');
      expect(r.capabilities).not.toContain('mcp.authorize');
    }
  });

  it('the server manager preset includes tasks.manage, the others do not (ADR 0130)', () => {
    for (const r of ACCOUNT_ROLES) {
      expect(r.capabilities.includes('tasks.manage')).toBe(r.id === 'server-manager');
    }
    expect(CAPABILITY_INFO['tasks.manage'].label).toBe('Manage club tasks');
    const manager = ACCOUNT_ROLES.find((r) => r.id === 'server-manager');
    expect(roleForCapabilities(manager?.capabilities ?? [])).toBe('server-manager');
  });

  it('maps capability sets back to a role', () => {
    expect(roleForCapabilities(['config.read', 'audit.read'])).toBe('viewer');
    expect(roleForCapabilities(['audit.read', 'config.read'])).toBe('viewer'); // order-free
    expect(roleForCapabilities(['config.read'])).toBe('custom');
  });
});
