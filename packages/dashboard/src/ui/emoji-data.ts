/**
 * The Unicode emoji catalogue behind the emoji picker. Discord accepts every
 * standard emoji, so the picker offers the whole `emojibase-data` set - bundled
 * (nothing is fetched from a third party) and loaded on first use, so the
 * ~570 KB of data is a separate chunk that the rest of the dashboard never
 * pays for.
 */

/** One emoji as `emojibase-data` ships it in its compact form. */
interface RawEmoji {
  readonly label: string;
  readonly unicode: string;
  readonly group?: number;
  readonly tags?: readonly string[];
  readonly skins?: readonly { readonly hexcode: string; readonly unicode: string }[];
}

interface RawGroup {
  readonly order: number;
  readonly message: string;
}

export interface EmojiEntry {
  readonly unicode: string;
  readonly label: string;
  /** Lowercased label and keywords, searched as one string. */
  readonly search: string;
  readonly group: number;
  /** Single-skin-tone variants, indexed by tone 1 (light) to 5 (dark). */
  readonly tones: Readonly<Record<number, string>>;
}

export interface EmojiGroup {
  readonly id: number;
  readonly label: string;
}

export interface EmojiCatalog {
  readonly groups: readonly EmojiGroup[];
  readonly emoji: readonly EmojiEntry[];
}

/** Fitzpatrick modifiers 1F3FB-1F3FF are tones 1-5. */
const TONE_BY_HEX: Readonly<Record<string, number>> = {
  '1F3FB': 1,
  '1F3FC': 2,
  '1F3FD': 3,
  '1F3FE': 4,
  '1F3FF': 5,
};

/** A skin variant belongs to a tone only when it uses exactly one tone throughout. */
const toneOf = (hexcode: string): number | undefined => {
  const tones = new Set(
    hexcode
      .split('-')
      .map((part) => TONE_BY_HEX[part])
      .filter((tone): tone is number => tone !== undefined),
  );
  return tones.size === 1 ? [...tones][0] : undefined;
};

/** Emoji with no group in the data (the regional indicators) land here. */
const OTHER_GROUP = 99;

export const buildCatalog = (
  raw: readonly RawEmoji[],
  rawGroups: readonly RawGroup[],
): EmojiCatalog => {
  const groups: EmojiGroup[] = [...rawGroups]
    .sort((a, b) => a.order - b.order)
    .map((group) => ({ id: group.order, label: capitalise(group.message) }));
  const entries = raw.map((item): EmojiEntry => {
    const tones: Record<number, string> = {};
    for (const skin of item.skins ?? []) {
      const tone = toneOf(skin.hexcode);
      if (tone !== undefined && tones[tone] === undefined) tones[tone] = skin.unicode;
    }
    return {
      unicode: item.unicode,
      label: item.label,
      search: [item.label, ...(item.tags ?? [])].join(' ').toLowerCase(),
      group: item.group ?? OTHER_GROUP,
      tones,
    };
  });
  if (entries.some((entry) => entry.group === OTHER_GROUP)) {
    groups.push({ id: OTHER_GROUP, label: 'Other' });
  }
  return { groups, emoji: entries };
};

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

let loading: Promise<EmojiCatalog> | undefined;

/** Loads the catalogue once; later callers share the same promise. */
export const loadEmojiCatalog = (): Promise<EmojiCatalog> => {
  loading ??= Promise.all([
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/en/messages.json'),
  ]).then(([compact, messages]) =>
    buildCatalog(
      compact.default as unknown as readonly RawEmoji[],
      (messages.default as unknown as { groups: readonly RawGroup[] }).groups,
    ),
  );
  return loading;
};

/** Every search word must appear in the emoji's label or keywords. */
export const matchesQuery = (entry: EmojiEntry, query: string): boolean => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => entry.search.includes(word));
};

/** The emoji to show for the chosen skin tone (0 is the default yellow). */
export const withTone = (entry: EmojiEntry, tone: number): string =>
  tone === 0 ? entry.unicode : (entry.tones[tone] ?? entry.unicode);
