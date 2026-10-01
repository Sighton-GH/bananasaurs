import { useEffect, useMemo, useRef, useState } from 'react';
import type { GuildEmojiInfo } from '../api/ops.js';
import { EmojiGlyph } from './EmojiGlyph.js';
import { loadEmojiCatalog, matchesQuery, withTone, type EmojiCatalog } from './emoji-data.js';

const TONES: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Default skin tone' },
  { value: 1, label: 'Light' },
  { value: 2, label: 'Medium-light' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Medium-dark' },
  { value: 5, label: 'Dark' },
];

/**
 * A searchable emoji chooser: every Unicode emoji (with skin tones) plus the
 * server's own custom emoji. The value is what the builder stores - Unicode
 * characters, or a custom emoji's snowflake - so the surrounding form needs no
 * parsing. The trigger button carries the field's accessible name.
 */
export function EmojiPicker({
  label,
  value,
  onChange,
  customEmojis,
  clearable = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly customEmojis: readonly GuildEmojiInfo[];
  /** Offer "No emoji" - for panels, where an emoji is optional. */
  readonly clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(0);
  const [catalog, setCatalog] = useState<EmojiCatalog | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || catalog !== undefined) return;
    let live = true;
    loadEmojiCatalog().then(
      (loaded) => {
        if (live) setCatalog(loaded);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [open, catalog]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

  const customMatches = customEmojis.filter(
    (emoji) => query.trim() === '' || emoji.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const sections = useMemo(() => {
    if (catalog === undefined) return [];
    return catalog.groups
      .map((group) => ({
        group,
        items: catalog.emoji.filter(
          (entry) =>
            entry.group === group.id && (query.trim() === '' || matchesQuery(entry, query)),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [catalog, query]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-[2.125rem] min-w-[4.5rem] items-center justify-center gap-1 rounded-sm border border-line bg-canvas px-2 py-1 text-ink hover:border-ink-muted"
      >
        {value === '' ? (
          <span className="text-xs text-ink-muted">Pick emoji</span>
        ) : (
          <EmojiGlyph value={value} customEmojis={customEmojis} className="text-lg leading-none" />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${label} picker`}
          className="absolute left-0 z-20 mt-1 grid w-80 max-w-[85vw] gap-2 rounded-sm border border-line bg-panel p-2 shadow-lg"
        >
          <input
            aria-label="Search emoji"
            // The picker was just opened on purpose; typing to search is the point.
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji, e.g. banana"
            autoComplete="off"
            className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          />
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <select
              aria-label="Skin tone"
              value={tone}
              onChange={(e) => setTone(Number(e.target.value))}
              className="rounded-sm border border-line bg-canvas px-1 py-0.5 text-ink"
            >
              {TONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {clearable && value !== '' && (
              <button
                type="button"
                onClick={() => pick('')}
                className="ml-auto underline hover:text-ink"
              >
                No emoji
              </button>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {customMatches.length > 0 && (
              <section aria-label="This server">
                <h4 className="sticky top-0 bg-panel py-1 text-xs font-medium text-ink-muted">
                  This server
                </h4>
                <div className="flex flex-wrap gap-0.5">
                  {customMatches.map((emoji) => (
                    <button
                      key={emoji.emojiId}
                      type="button"
                      aria-label={`:${emoji.name}:`}
                      title={`:${emoji.name}:`}
                      onClick={() => pick(emoji.emojiId)}
                      className="rounded-sm p-1 hover:bg-canvas"
                    >
                      <img src={emoji.url} alt="" className="h-6 w-6" />
                    </button>
                  ))}
                </div>
              </section>
            )}
            {catalog === undefined && !failed && (
              <p className="py-2 text-xs text-ink-muted">Loading emoji…</p>
            )}
            {failed && (
              <p role="alert" className="py-2 text-xs text-danger">
                The emoji list could not be loaded. Reload the page and try again.
              </p>
            )}
            {sections.map(({ group, items }) => (
              <section key={group.id} aria-label={group.label}>
                <h4 className="sticky top-0 bg-panel py-1 text-xs font-medium text-ink-muted">
                  {group.label}
                </h4>
                <div className="flex flex-wrap gap-0.5">
                  {items.map((entry) => {
                    const shown = withTone(entry, tone);
                    return (
                      <button
                        key={entry.unicode}
                        type="button"
                        aria-label={entry.label}
                        title={entry.label}
                        onClick={() => pick(shown)}
                        className="rounded-sm p-1 text-xl leading-none hover:bg-canvas"
                      >
                        {shown}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
            {catalog !== undefined && sections.length === 0 && customMatches.length === 0 && (
              <p className="py-2 text-xs text-ink-muted">No emoji match “{query.trim()}”.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
