import { describe, expect, it } from 'vitest';
import {
  customEmojiKey,
  emojiKeyFromGateway,
  isCustomEmojiKey,
  unicodeEmojiChars,
  unicodeEmojiKey,
} from './emoji.js';

describe('emoji canonicalisation', () => {
  it('treats an emoji with and without the variation selector as the same key', () => {
    // U+2714 vs U+2714 U+FE0F. Different clients send different bytes for what
    // the member sees as one reaction.
    expect(unicodeEmojiKey('✔')).toBe(unicodeEmojiKey('✔️'));
  });

  it('is stable for a plain multi-byte emoji', () => {
    expect(unicodeEmojiKey('🧠')).toBe('u:1f9e0');
  });

  it('keeps distinct emoji distinct', () => {
    expect(unicodeEmojiKey('🧠')).not.toBe(unicodeEmojiKey('🎨'));
  });

  it('keeps skin-tone variants distinct from the base emoji', () => {
    // These are genuinely different reactions on Discord, so they must not collapse.
    expect(unicodeEmojiKey('👍')).not.toBe(unicodeEmojiKey('👍🏽'));
  });

  it('preserves a ZWJ sequence as one key rather than splitting it', () => {
    const family = unicodeEmojiKey('👨‍💻');
    expect(family).toContain('-');
    expect(family).not.toBe(unicodeEmojiKey('👨'));
  });

  it('namespaces custom emoji by id so they cannot collide with unicode', () => {
    expect(customEmojiKey('123456789012345678')).toBe('c:123456789012345678');
    expect(isCustomEmojiKey('c:123456789012345678')).toBe(true);
    expect(isCustomEmojiKey('u:1f9e0')).toBe(false);
  });

  it('rejects a custom emoji id that is not a snowflake', () => {
    expect(() => customEmojiKey('nope')).toThrow();
  });

  it('reads a gateway payload of either shape', () => {
    expect(emojiKeyFromGateway({ id: '123456789012345678', name: 'blob' })).toBe(
      'c:123456789012345678',
    );
    expect(emojiKeyFromGateway({ id: null, name: '🧠' })).toBe('u:1f9e0');
  });

  it('throws on a payload carrying neither id nor name', () => {
    expect(() => emojiKeyFromGateway({ id: null, name: null })).toThrow();
    expect(() => unicodeEmojiKey('')).toThrow();
  });
});

describe('unicodeEmojiChars — the REST round-trip (finding 1)', () => {
  it('restores the variation selector for a button emoji whose canonical form needs it', () => {
    // 🅱️ is U+1F171 U+FE0F. unicodeEmojiKey strips U+FE0F for storage, so the
    // key alone cannot tell restEmoji() this codepoint needs it back — live
    // evidence (docs/reports/WP5-slice-6-live-test.md) is that Discord's own
    // reaction bucket for 🅱️ does not match a bare U+1F171 query.
    expect(unicodeEmojiChars(unicodeEmojiKey('🅱️'))).toBe('🅱️');
    expect(unicodeEmojiChars(unicodeEmojiKey('🅰️'))).toBe('🅰️');
  });

  it('restores it regardless of which form the key was built from', () => {
    // A member's client may have sent the bare codepoint; the stored key is
    // identical either way, and the REST form must always be the qualified one.
    expect(unicodeEmojiChars(unicodeEmojiKey('🅱'))).toBe('🅱️');
  });

  it('leaves an emoji that is already emoji-presentation-default unchanged', () => {
    expect(unicodeEmojiChars(unicodeEmojiKey('🧠'))).toBe('🧠');
    expect(unicodeEmojiChars(unicodeEmojiKey('👍'))).toBe('👍');
  });

  it('restores the selector inside a multi-codepoint sequence, not only a bare one', () => {
    expect(unicodeEmojiChars('u:1f17e-1f9e0')).toBe('🅾️🧠');
  });

  it('rejects a custom emoji key', () => {
    expect(() => unicodeEmojiChars('c:123456789012345678')).toThrow();
  });
});
