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

/** Strips citation tags from the answer and returns the known sources it cited, in order of first appearance, deduplicated. */
export const applyCitations = (
  text: string,
  registry: CitationRegistry,
): { readonly text: string; readonly cited: readonly CitableSource[] } => {
  const cited: CitableSource[] = [];
  const seen = new Set<CitableSource>();
  const lines = text.split('\n');
  let inFence = false;
  const cleaned = lines.map((line) => {
    if (line.startsWith('```')) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.replace(CITATION_GROUP, (_match, group: string) => {
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
  });
  while (cleaned.length > 0 && cleaned.at(-1)?.trim() === '') cleaned.pop();
  if (cleaned.length > 0 && SOURCE_LINE.test(cleaned.at(-1)!)) cleaned.pop();
  return { text: cleaned.join('\n').trimEnd(), cited };
};
