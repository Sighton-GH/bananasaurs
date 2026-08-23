import { beforeEach, describe, expect, it } from 'vitest';
import { checkRoleAssignable } from '@bananasaurs/core';
import { FakeDiscord } from './fake-discord.js';

/**
 * WP1's gate: the harness can drive a test that fails when the implementation
 * is broken. This is that test. `checkRoleAssignable` is real production code
 * in core; the fake supplies the guild it reads.
 */
const GUILD = '111111111111111111';
let d: FakeDiscord;

beforeEach(() => {
  d = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
});

describe('checkRoleAssignable, driven by the fake', () => {
  it('allows a role below the bot', async () => {
    d.defineRole({ id: '444444444444444444', position: 10 });
    expect(await checkRoleAssignable(d, GUILD, '444444444444444444')).toEqual({ assignable: true });
  });

  it('refuses a role above the bot', async () => {
    d.defineRole({ id: '444444444444444444', position: 120 });
    expect(await checkRoleAssignable(d, GUILD, '444444444444444444')).toEqual({
      assignable: false,
      reason: 'above_bot',
    });
  });

  it('refuses a role at exactly the bot position — the off-by-one that breaks panels', async () => {
    d.defineRole({ id: '444444444444444444', position: 100 });
    expect(await checkRoleAssignable(d, GUILD, '444444444444444444')).toEqual({
      assignable: false,
      reason: 'above_bot',
    });
  });

  it('refuses an integration-managed role however low it sits', async () => {
    d.defineRole({ id: '444444444444444444', position: 1, managed: true });
    expect(await checkRoleAssignable(d, GUILD, '444444444444444444')).toEqual({
      assignable: false,
      reason: 'managed',
    });
  });

  it('refuses @everyone, whose id is the guild id', async () => {
    d.defineRole({ id: GUILD, position: 0 });
    expect(await checkRoleAssignable(d, GUILD, GUILD)).toEqual({
      assignable: false,
      reason: 'is_everyone',
    });
  });

  it('reports a deleted role as missing rather than throwing', async () => {
    d.defineRole({ id: '444444444444444444', position: 10 });
    d.deleteRole('444444444444444444');
    expect(await checkRoleAssignable(d, GUILD, '444444444444444444')).toEqual({
      assignable: false,
      reason: 'missing',
    });
  });

  it('re-reads position every time, so a reorder takes effect immediately', async () => {
    d.defineRole({ id: '444444444444444444', position: 10 });
    expect(await checkRoleAssignable(d, GUILD, '444444444444444444')).toEqual({ assignable: true });

    d.setRolePosition('444444444444444444', 150); // somebody drags it in the UI
    expect(await checkRoleAssignable(d, GUILD, '444444444444444444')).toEqual({
      assignable: false,
      reason: 'above_bot',
    });
  });
});
