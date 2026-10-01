import type { GuildEmojiInfo } from '../api/ops.js';
import { EmojiGlyph } from './EmojiGlyph.js';

export interface PreviewOption {
  readonly key: string;
  /** Unicode characters or a custom emoji snowflake; empty when none is chosen. */
  readonly emoji: string;
  readonly label: string;
}

/**
 * A sketch of what members will see in Discord: the message and, under it,
 * the reactions (a reaction role) or the buttons / dropdown (a role panel).
 * It only draws what the form already holds - it is not Discord's rendering,
 * so the heading says "Preview" and nothing here claims to be exact.
 */
export function PanelPreview({
  kind,
  component,
  channelName,
  authorName,
  content,
  contentPlaceholder,
  options,
  customEmojis,
}: {
  readonly kind: 'reaction' | 'panel';
  readonly component: 'button' | 'select';
  readonly channelName: string | undefined;
  /** The existing message's author (reaction roles) or the bot (panels). */
  readonly authorName: string;
  /** The message text; empty shows the placeholder in muted italics. */
  readonly content: string;
  readonly contentPlaceholder: string;
  readonly options: readonly PreviewOption[];
  readonly customEmojis: readonly GuildEmojiInfo[];
}) {
  const hasContent = content.trim() !== '';
  return (
    <section aria-label="Preview" className="grid gap-2 text-sm">
      <h3 className="font-medium text-ink">Preview</h3>
      {channelName !== undefined && <p className="text-xs text-ink-muted">#{channelName}</p>}
      <div className="grid gap-2 rounded-sm border border-line bg-canvas p-3">
        <div className="flex items-start gap-3">
          <div
            aria-hidden="true"
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel text-sm font-medium text-ink-muted"
          >
            {authorName.charAt(0).toUpperCase() || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">{authorName}</p>
            <p
              className={`whitespace-pre-wrap break-words ${hasContent ? 'text-ink' : 'italic text-ink-muted'}`}
            >
              {hasContent ? content : contentPlaceholder}
            </p>
            {kind === 'reaction' ? (
              <div className="mt-2 flex flex-wrap gap-1" aria-label="Reactions">
                {options
                  .filter((option) => option.emoji !== '')
                  .map((option) => (
                    <span
                      key={option.key}
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-0.5 text-ink"
                    >
                      <EmojiGlyph value={option.emoji} customEmojis={customEmojis} />
                      <span className="text-xs text-ink-muted">1</span>
                    </span>
                  ))}
                {options.every((option) => option.emoji === '') && (
                  <span className="text-xs italic text-ink-muted">
                    Reactions appear here as you pick emoji.
                  </span>
                )}
              </div>
            ) : component === 'button' ? (
              <div className="mt-2 flex flex-wrap gap-1" aria-label="Buttons">
                {options.map((option) => (
                  <span
                    key={option.key}
                    className="inline-flex items-center gap-1 rounded-sm bg-panel px-3 py-1 text-ink"
                  >
                    {option.emoji !== '' && (
                      <EmojiGlyph value={option.emoji} customEmojis={customEmojis} />
                    )}
                    {option.label.trim() === '' ? '…' : option.label}
                  </span>
                ))}
              </div>
            ) : (
              <div className="mt-2 grid gap-1" aria-label="Dropdown">
                <span className="rounded-sm border border-line bg-panel px-3 py-1 text-ink-muted">
                  Choose your roles ▾
                </span>
                <ul className="grid gap-0.5 rounded-sm border border-line bg-panel px-2 py-1">
                  {options.map((option) => (
                    <li key={option.key} className="flex items-center gap-1 text-ink">
                      {option.emoji !== '' && (
                        <EmojiGlyph value={option.emoji} customEmojis={customEmojis} />
                      )}
                      {option.label.trim() === '' ? '…' : option.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
