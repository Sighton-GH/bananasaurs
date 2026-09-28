export interface CitableSource {
  readonly title: string;
  readonly url: string;
  readonly heading?: string | undefined;
}

export interface CitationRegistry {
  /** The tag for this source, e.g. 'S3'; the same source (url + heading) always gets the same tag. */
  tag(source: CitableSource): string;
  get(tag: string): CitableSource | undefined;
}

export const createCitationRegistry = (): CitationRegistry => {
  const byKey = new Map<string, { readonly tag: string; readonly source: CitableSource }>();
  const byTag = new Map<string, CitableSource>();
  let next = 1;

  const keyFor = (source: CitableSource): string => `${source.url}\u0000${source.heading ?? ''}`;

  return {
    tag(source) {
      const key = keyFor(source);
      const existing = byKey.get(key);
      if (existing !== undefined) return existing.tag;
      const tag = `S${String(next)}`;
      next += 1;
      byKey.set(key, { tag, source });
      byTag.set(tag, source);
      return tag;
    },
    get(tag) {
      return byTag.get(tag);
    },
  };
};

const CITATION_GROUP = /[ \t]*(\[S\d{1,3}(?:,[ \t]*S\d{1,3})*\])/g;
const SOURCE_LINE = /^\s*(?:-#\s*)?\**\s*sources?\s*\**\s*:/i;
const PLURAL_SOURCES_LINE = /^\s*(?:-#\s*)?\**\s*sources\s*\**\s*:/i;
const FENCE_LINE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*([-*•]|\d+\.)\s+/;

/** Strips citation tags from the answer and returns the known sources it cited, in order of first appearance, deduplicated. */
export const applyCitations = (
  text: string,
  registry: CitationRegistry,
): { readonly text: string; readonly cited: readonly CitableSource[] } => {
  const cited: CitableSource[] = [];
  const seen = new Set<CitableSource>();
  const stripTags = (line: string): string =>
    line.replace(CITATION_GROUP, (_match, group: string) => {
      const tags = group.slice(1, -1).split(/,[ \t]*/);
      for (const tag of tags) {
        const source = registry.get(tag);
        if (source !== undefined && !seen.has(source)) {
          seen.add(source);
          cited.push(source);
        }
      }
      return '';
    });
  const lines = text.split('\n');
  // A fence closes only on its own opening marker: ``` code containing a
  // ~~~ line (or the reverse) stays fenced.
  let fence: string | undefined;
  const cleaned = lines.map((line) => {
    const fenceMatch = line.match(FENCE_LINE);
    if (fenceMatch !== null) {
      if (fence === undefined) fence = fenceMatch[1];
      else if (fenceMatch[1] === fence) fence = undefined;
      return line;
    }
    if (fence !== undefined) return line;
    // Inline-code spans keep their tags; only prose is stripped.
    return line
      .split(/(`[^`]*`)/)
      .map((part, index) => (index % 2 === 1 ? part : stripTags(part)))
      .join('');
  });
  while (cleaned.length > 0 && cleaned.at(-1)?.trim() === '') cleaned.pop();
  if (cleaned.length > 0) {
    const last = cleaned[cleaned.length - 1] ?? '';
    if (SOURCE_LINE.test(last)) {
      // A `-#` line is the service's own line shape, and a plural
      // `Sources:` line always lists sources: both go unconditionally. Only
      // a bare singular `Source:` may be a prose sentence — `Source: ask the
      // treasurer` stays, while link- or tag-shaped rests go.
      if (last.trimStart().startsWith('-#') || PLURAL_SOURCES_LINE.test(last)) {
        cleaned.pop();
      } else {
        const afterColon = last.slice(last.indexOf(':') + 1);
        if (afterColon.trim() === '' || /http|\[|S\d/.test(afterColon)) cleaned.pop();
      }
    } else {
      // Otherwise the trailing block is a source section only when walking
      // back over list items and blanks reaches a SOURCE_LINE head.
      let head = cleaned.length - 1;
      while (head > 0) {
        const line = cleaned[head] ?? '';
        if (line.trim() !== '' && !LIST_ITEM.test(line)) break;
        head -= 1;
      }
      if (head < cleaned.length - 1 && SOURCE_LINE.test(cleaned[head] ?? '')) {
        cleaned.splice(head);
      }
    }
  }
  return { text: cleaned.join('\n').trim(), cited };
};
