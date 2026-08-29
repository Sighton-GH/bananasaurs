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

/**
 * Codepoints whose Unicode-assigned default presentation is text, not emoji,
 * so Discord's reaction routes only match them with U+FE0F present.
 * `unicodeEmojiKey` strips U+FE0F for every emoji, uniformly, because it is a
 * rendering choice and not part of an emoji's identity; this table is what
 * lets `unicodeEmojiChars` put it back for the codepoints where Discord's own
 * matching requires it (`docs/reports/WP5-slice-6-live-test.md` finding 1).
 *
 * Deliberately small and bounded rather than a general Unicode
 * Emoji_Presentation table: these four are the "squared letter" reaction
 * emoji this project's panels actually use — 🅰️/🅱️ are
 * `scripts/seed-test-panel.mjs`'s own defaults, and 🅾️/🅿️ share the same
 * Enclosed Alphanumeric Supplement block and text-default quirk. A full
 * emoji-presentation dataset is a dependency this port's narrowness (ADR
 * 0018) does not warrant; add another codepoint here if another text-default
 * emoji is needed.
 */
const REQUIRES_VARIATION_SELECTOR_16 = new Set<number>([
  0x1f170, // 🅰 A button (blood type)
  0x1f171, // 🅱 B button (blood type)
  0x1f17e, // 🅾 O button (blood type)
  0x1f17f, // 🅿 P button (parking)
]);

/**
 * The reverse of `unicodeEmojiKey`: turns a stored key back into the exact
 * character sequence Discord's reaction routes expect, restoring U+FE0F for
 * codepoints whose canonical emoji form needs it. Not simply "whatever the
 * member originally sent" — the key does not record that, and does not need
 * to, because Discord's reaction bucket for these codepoints only exists in
 * the fully-qualified (U+FE0F-present) form regardless of which form a
 * member's client sent.
 */
export function unicodeEmojiChars(key: EmojiKey): string {
  if (!key.startsWith('u:')) throw new Error(`not a unicode emoji key: ${key}`);
  const codepoints = key
    .slice(2)
    .split('-')
    .map((point) => Number.parseInt(point, 16));
  const withSelectors = codepoints.flatMap((point) =>
    REQUIRES_VARIATION_SELECTOR_16.has(point) ? [point, VARIATION_SELECTOR_16] : [point],
  );
  return String.fromCodePoint(...withSelectors);
}
