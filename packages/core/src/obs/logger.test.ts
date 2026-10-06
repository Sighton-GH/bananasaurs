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

  it('passes a string through unredacted under err/error, since a string cannot smuggle extra properties', () => {
    // packages/core/src/jobs/worker.ts's #fail logs `describeError()`'s own
    // output under `error` — already a plain string, not a raw Error, so the
    // instanceof check stomped it to '<non-error>' on every job failure,
    // regardless of what actually failed (docs/reports/WP5-slice-6-live-test.md
    // finding 2). The redaction exists to stop a raw Error's extra properties
    // (a token, a stack path) from reaching the log; a string cannot carry
    // those, so it is not the thing this key's redaction protects against.
    const out = safeLogFields({ error: 'DiscordApiError: Unknown Emoji' });
    expect(out['error']).toBe('DiscordApiError: Unknown Emoji');
  });

  it('still reduces a non-Error, non-string value under err/error to <non-error>', () => {
    const out = safeLogFields({ err: { weird: 'object', token: 'leaked' } });
    expect(out['err']).toBe('<non-error>');
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
      'accessToken',
      'refreshToken',
      'oauthToken',
      'authorizationCode',
      'codeVerifier',
      'nonce',
      'clientSecret',
    ]) {
      expect(LOGGABLE_FIELDS.has(forbidden), `${forbidden} must not be loggable`).toBe(false);
    }
  });

  it('keeps nudge slot ids and kinds, which are routing facts rather than member text', () => {
    expect(safeLogFields({ slotId: 'review:task:2', kind: 'review', guildId: '1' })).toEqual({
      slotId: 'review:task:2',
      kind: 'review',
      guildId: '1',
    });
  });

  it('keeps the permission purpose, a fixed routing enum like kind', () => {
    expect(safeLogFields({ guildId: '1', purpose: 'read', outcome: 'seeded' })).toEqual({
      guildId: '1',
      purpose: 'read',
      outcome: 'seeded',
    });
  });

  it('allowlists the OAuth id fields (ADR 0045 D8)', () => {
    // An id is a row key, never a credential — the credential is the token
    // VALUE, which has no allowlisted name. `code` stays allowlisted for its
    // unrelated error/status-code purpose; the log-scan test in
    // `packages/http/src/oauth/log-scan.test.ts` is what guards against an
    // authorization-code VALUE going out under it.
    expect(LOGGABLE_FIELDS.has('oauthClientId')).toBe(true);
    expect(LOGGABLE_FIELDS.has('oauthTokenId')).toBe(true);
    expect(safeLogFields({ oauthClientId: 'cli_abc', oauthTokenId: 'tok_def' })).toEqual({
      oauthClientId: 'cli_abc',
      oauthTokenId: 'tok_def',
    });
  });

  it('keeps runId, finishReason and upstream (ADR 0129 §5)', () => {
    expect(safeLogFields({ runId: '123', finishReason: 'length', upstream: 'X' })).toEqual({
      runId: '123',
      finishReason: 'length',
      upstream: 'X',
    });
  });
});
