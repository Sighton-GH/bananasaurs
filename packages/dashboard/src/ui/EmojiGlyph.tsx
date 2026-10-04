import type { GuildEmojiInfo } from '../api/ops.js';

/**
 * One emoji as the builder holds it: Unicode characters, or a custom emoji's
 * snowflake. A custom emoji renders as its image; one the guild list does not
 * know (an id pasted from elsewhere, or a list that failed to load) renders as
 * a plain marker rather than a broken image.
 */
export function EmojiGlyph({
  value,
  customEmojis,
  className = '',
}: {
  readonly value: string;
  readonly customEmojis: readonly GuildEmojiInfo[];
  readonly className?: string;
}) {
  if (/^\d{17,20}$/.test(value)) {
    const custom = customEmojis.find((emoji) => emoji.emojiId === value);
    if (custom === undefined) {
      return (
        <span className={className} title="Custom emoji">
          ◻
        </span>
      );
    }
    return (
      <img
        src={custom.url}
        alt={`:${custom.name}:`}
        className={`inline-block h-[1.25em] w-[1.25em] align-text-bottom ${className}`}
      />
    );
  }
  return <span className={className}>{value}</span>;
}
