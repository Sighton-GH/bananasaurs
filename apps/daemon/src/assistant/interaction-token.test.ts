import { describe, expect, it } from 'vitest';
import { createInteractionTokenSealer } from './interaction-token.js';

describe('interaction token sealer', () => {
  it('round-trips a token sealed and opened by the same process', () => {
    const sealer = createInteractionTokenSealer();
    expect(sealer.open(sealer.seal('discord-token'))).toBe('discord-token');
  });

  it('never opens a token sealed by a previous process', () => {
    // The restart case: the key is per-process, so a job queued before a
    // restart carries ciphertext this process cannot open - and the handler
    // must fail closed on that (commands.test.ts drives it end to end).
    const before = createInteractionTokenSealer();
    const after = createInteractionTokenSealer();
    expect(after.open(before.seal('discord-token'))).toBeUndefined();
  });

  it('rejects tampered and malformed ciphertext', () => {
    const sealer = createInteractionTokenSealer();
    const sealed = sealer.seal('discord-token');
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('aa') ? 'ab' : 'aa'}`;
    expect(sealer.open(tampered)).toBeUndefined();
    expect(sealer.open('not-a-sealed-token')).toBeUndefined();
    expect(sealer.open('')).toBeUndefined();
  });
});
