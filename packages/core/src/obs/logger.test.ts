import { describe, expect, it } from 'vitest';
import { LOGGABLE_FIELDS, safeLogFields } from './logger.js';

describe('safeLogFields — allowlist, not denylist', () => {
  it('keeps allowlisted primitive fields', () => {
    expect(safeLogFields({ guildId: '123', count: 4, dryRun: true })).toEqual({
      guildId: '123',
      count: 4,
      dryRun: true,
    });
  });

  it('drops any field not on the allowlist and says how many', () => {
    const out = safeLogFields({ guildId: '123', token: 'super-secret-token' });
    expect(out).toEqual({ guildId: '123', droppedFields: 1 });
    expect(JSON.stringify(out)).not.toContain('super-secret-token');
  });

  it('drops a field nobody thought to ban — the point of an allowlist', () => {
    // None of these are on any denylist anywhere. All must vanish anyway.
    const out = safeLogFields({
      guildId: '1',
      recoveryPhrase: 'correct horse battery staple',
      internalNotes: 'x',
      totpSeed: 'JBSWY3DPEHPK3PXP',
      messageContent: 'something a member wrote',
    });
    expect(out).toEqual({ guildId: '1', droppedFields: 4 });
    const s = JSON.stringify(out);
    for (const leak of ['horse', 'JBSWY3DPEHPK3PXP', 'something a member wrote', 'internalNotes']) {
      expect(s).not.toContain(leak);
    }
  });

  it('drops message content even though channelId and messageId are allowed', () => {
    const out = safeLogFields({ channelId: '1', messageId: '2', content: 'private text' });
    expect(out).toEqual({ channelId: '1', messageId: '2', droppedFields: 1 });
  });

  it('drops a non-primitive value even when its key is allowlisted', () => {
    // An allowlisted key must not become a smuggling route for a whole object.
    const out = safeLogFields({ reason: { nested: 'token-in-here' } });
    expect(out).toEqual({ droppedFields: 1 });
    expect(JSON.stringify(out)).not.toContain('token-in-here');
  });

  it('reduces an Error to name and message, dropping stack and custom fields', () => {
    const err = Object.assign(new Error('boom'), { token: 'leaked', stack: 'at secret/path' });
    const out = safeLogFields({ err });
    expect(out['err']).toEqual({ name: 'Error', message: 'boom' });
    expect(JSON.stringify(out)).not.toContain('leaked');
    expect(JSON.stringify(out)).not.toContain('secret/path');
  });

  it('omits droppedFields entirely when nothing was dropped', () => {
    expect(safeLogFields({ guildId: '1' })).not.toHaveProperty('droppedFields');
  });

  it('keeps null but drops undefined-valued unknown keys', () => {
    expect(safeLogFields({ reason: null })).toEqual({ reason: null });
  });

  it('does not allowlist anything credential-shaped', () => {
    for (const forbidden of [
      'token',
      'secret',
      'password',
      'passwordHash',
      'authorization',
      'cookie',
      'content',
      'sessionSecret',
      'totpSecret',
    ]) {
      expect(LOGGABLE_FIELDS.has(forbidden), `${forbidden} must not be loggable`).toBe(false);
    }
  });
});
