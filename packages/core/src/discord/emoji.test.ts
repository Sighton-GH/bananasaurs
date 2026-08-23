import { describe, expect, it } from 'vitest';
import { customEmojiKey, emojiKeyFromGateway, isCustomEmojiKey, unicodeEmojiKey } from './emoji.js';

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
