/**
 * Emoji identity, which is a larger source of silent panel failure than it
 * looks.
 *
 * Discord sends unicode reaction emoji as raw characters, and clients differ in
 * whether they append U+FE0F (the variation selector that asks for the emoji
 * rather than text presentation). So a member on one platform reacts with
 * U+2714 U+FE0F and another with bare U+2714, and a naive string comparison
 * matches one and silently ignores the other.
 *
 * Everything is therefore reduced to a canonical key before it is stored or
 * compared: `u:<hyphen-joined codepoints>` or `c:<snowflake>`.
 */

import type { EmojiKey } from './port.js';

const VARIATION_SELECTOR_16 = 0xfe0f;

export function unicodeEmojiKey(raw: string): EmojiKey {
  const points: number[] = [];
  for (const ch of raw) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // Drop the presentation selector. It changes rendering, not identity.
    if (cp === VARIATION_SELECTOR_16) continue;
    points.push(cp);
  }
  if (points.length === 0) throw new Error('empty emoji');
  return `u:${points.map((p) => p.toString(16)).join('-')}`;
}

export function customEmojiKey(id: string): EmojiKey {
  if (!/^\d{17,20}$/.test(id)) throw new Error(`not a custom emoji id: ${id}`);
  return `c:${id}`;
}

/**
 * Parses what a gateway reaction payload carries: either `{name}` for unicode
 * or `{id, name}` for custom.
 */
export function emojiKeyFromGateway(emoji: { id?: string | null; name?: string | null }): EmojiKey {
  if (emoji.id) return customEmojiKey(emoji.id);
  if (emoji.name) return unicodeEmojiKey(emoji.name);
  throw new Error('reaction payload carried neither an id nor a name');
}

export function isCustomEmojiKey(key: EmojiKey): boolean {
  return key.startsWith('c:');
}
