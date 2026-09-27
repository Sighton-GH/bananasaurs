export interface CitableSource {
  readonly title: string;
  readonly url: string;
  readonly heading?: string | undefined;
}

export interface CitationRegistry {
  /** The tag for this source, e.g. 'S3'; the same source (url + heading) always gets the same tag. Tags count up from S1 per request. */
  tag(source: CitableSource): string;
  get(tag: string): CitableSource | undefined;
}

export const createCitationRegistry = (): CitationRegistry => {
  const byKey = new Map<string, string>();
  const byTag = new Map<string, CitableSource>();
  let next = 1;
  const keyOf = (source: CitableSource): string => `${source.url}\n${source.heading ?? ''}`;
  return {
    tag(source: CitableSource): string {
      const key = keyOf(source);
      const existing = byKey.get(key);
      if (existing !== undefined) return existing;
      const made = `S${String(next)}`;
      next += 1;
      byKey.set(key, made);
      byTag.set(made, source);
      return made;
    },
    get(tag: string): CitableSource | undefined {
      return byTag.get(tag);
    },
  };
};

const TAG_GROUP_RE = /[ \t]*\[S\d{1,3}(?:,\s*S\d{1,3})*\]/g;
const SINGLE_TAG_RE = /S\d{1,3}/g;
const SOURCES_LINE_RE = /^\s*(?:-#\s*)?\**\s*sources?\s*\**\s*:/i;

/** Strips citation tags from the answer and returns the known sources it cited, in order of first appearance, deduplicated. */
export const applyCitations = (
  text: string,
  registry: CitationRegistry,
): { readonly text: string; readonly cited: readonly CitableSource[] } => {
  const lines = text.split('\n');
  const cited: CitableSource[] = [];
  const seen = new Set<string>();
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    out.push(
      line.replace(TAG_GROUP_RE, (group) => {
        for (const found of group.match(SINGLE_TAG_RE) ?? []) {
          if (seen.has(found)) continue;
          const source = registry.get(found);
          if (source === undefined) continue;
          seen.add(found);
          cited.push(source);
        }
        return '';
      }),
    );
  }
  let result = out.join('\n');
  const resultLines = result.split('\n');
  let last = resultLines.length - 1;
  while (last >= 0 && resultLines[last]!.trim() === '') last -= 1;
  if (last >= 0 && SOURCES_LINE_RE.test(resultLines[last]!)) {
    resultLines.splice(last, 1);
    result = resultLines.join('\n');
  }
  return { text: result.trim(), cited };
};
