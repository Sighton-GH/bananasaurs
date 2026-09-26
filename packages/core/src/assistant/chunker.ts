// Document chunker (ADR 0073). Pure: no I/O, no clock. Splits a fetched
// document into search-sized pieces the resource cache stores and FTS5
// indexes: markdown (and HTML, converted to text first) split at headings,
// with oversized sections further split at paragraph boundaries; everything
// else (plain text, code) splits into fixed-size line windows with overlap.

export interface Chunk {
  readonly ordinal: number;
  readonly headingPath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
}

const DEFAULT_MAX_CHARS = 1_500;
const WINDOW_LINES = 60;
const WINDOW_OVERLAP_LINES = 10;

const normaliseLineEndings = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const basename = (path: string): string => {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.length > 0 ? parts[parts.length - 1]! : path;
};

const extOf = (path: string): string => {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};

const isMarkdownPath = (mediaType: string, path: string): boolean =>
  mediaType === 'text/markdown' || extOf(path) === '.md' || extOf(path) === '.markdown';

const isHtmlInput = (mediaType: string, path: string): boolean =>
  mediaType === 'text/html' ||
  mediaType === 'application/xhtml+xml' ||
  extOf(path) === '.html' ||
  extOf(path) === '.htm';

// ---------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------

const DROP_TAGS = ['head', 'svg', 'script', 'style', 'nav', 'footer', 'noscript'] as const;

const dropTagContents = (html: string): string =>
  DROP_TAGS.reduce(
    (out, tag) => out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'giu'), ''),
    html,
  );

const stripTags = (html: string): string => html.replace(/<[^>]+>/gu, '');

const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&nbsp;/giu, ' ')
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    // &amp; last, so a decoded entity's ampersand is never re-decoded.
    .replace(/&amp;/giu, '&');

const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu;

const convertAnchors = (html: string): string =>
  html.replace(
    ANCHOR_RE,
    (_match, hrefDouble: string | undefined, hrefSingle: string | undefined, inner: string) => {
      const href = hrefDouble ?? hrefSingle ?? '';
      const label = stripTags(inner).replace(/\s+/gu, ' ').trim();
      return label === '' ? href : `${label} (${href})`;
    },
  );

const HEADING_TAG_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu;

const convertHeadingTags = (html: string): string =>
  html.replace(HEADING_TAG_RE, (_match, level: string, inner: string) => {
    const marker = '#'.repeat(Number(level));
    const text = stripTags(inner).replace(/\s+/gu, ' ').trim();
    return `\n${marker} ${text}\n`;
  });

const LIST_ITEM_RE = /<li\b[^>]*>([\s\S]*?)<\/li>/giu;

const convertListItems = (html: string): string =>
  html.replace(LIST_ITEM_RE, (_match, inner: string) => {
    const text = stripTags(inner).replace(/\s+/gu, ' ').trim();
    return `\n- ${text}\n`;
  });

const convertLineBreaks = (html: string): string =>
  html
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div)>/giu, '\n')
    .replace(/<(p|div)\b[^>]*>/giu, '\n');

const collapseWhitespace = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

export const htmlToText = (html: string): string => {
  let out = dropTagContents(html);
  out = out.replace(/<!--[\s\S]*?-->/gu, '');
  out = convertAnchors(out);
  out = convertHeadingTags(out);
  out = convertListItems(out);
  out = convertLineBreaks(out);
  out = stripTags(out);
  out = decodeEntities(out);
  return collapseWhitespace(out);
};

// ---------------------------------------------------------------------------
// heading-based chunking (markdown, and HTML after conversion)
// ---------------------------------------------------------------------------

interface Section {
  readonly headingPath: string;
  readonly startLine: number; // 1-based, inclusive
  readonly endLine: number; // 1-based, inclusive
  readonly text: string;
}

interface StackEntry {
  readonly level: number;
  readonly text: string;
}

const HEADING_LINE_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

const isFenceClose = (line: string, char: '`' | '~', len: number): boolean => {
  const run = new RegExp(`^ {0,3}${char === '`' ? '`' : '~'}{${len},}\\s*$`, 'u').exec(line);
  return run !== null;
};

/** Clips a heading (or a whole heading path) to `max` characters, ending in "…" when cut. */
export const clipHeading = (text: string, max = 120): string => {
  if (text.length <= max) return text;
  let cut = max - 1;
  // Never end on the first half of a surrogate pair (most emoji): back off one unit.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}…`;
};

const splitSections = (text: string, path: string): readonly Section[] => {
  const lines = text.split('\n');
  const base = basename(path);
  const sections: Section[] = [];
  const stack: StackEntry[] = [];
  let sectionStartIndex = 0; // 0-based
  let sectionHeadingPath = base;
  let inFence: { readonly char: '`' | '~'; readonly len: number } | null = null;

  const flush = (endIndexExclusive: number): void => {
    if (endIndexExclusive <= sectionStartIndex) return;
    const content = lines.slice(sectionStartIndex, endIndexExclusive).join('\n');
    if (content.trim() === '') return;
    sections.push({
      headingPath: sectionHeadingPath,
      startLine: sectionStartIndex + 1,
      endLine: endIndexExclusive,
      text: content,
    });
  };

  lines.forEach((line, index) => {
    if (inFence !== null) {
      if (isFenceClose(line, inFence.char, inFence.len)) inFence = null;
      return;
    }
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence !== null) {
      inFence = { char: fence[1]![0]! as '`' | '~', len: fence[1]!.length };
      return;
    }
    const match = HEADING_LINE_RE.exec(line);
    if (match === null) return;
    flush(index);
    const level = match[1]!.length;
    const headingText = clipHeading(match[2]!);
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text: headingText });
    sectionStartIndex = index;
    sectionHeadingPath = [base, ...stack.map((entry) => entry.text)].join(' › ');
  });
  flush(lines.length);
  return sections;
};

interface Piece {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

// Greedily packs ordered strings, joined by `sep`, into groups whose joined
// length never exceeds `maxChars`. Shared by the paragraph-, line- and
// sentence-level splitters below.
const packStrings = (
  parts: readonly string[],
  sep: string,
  maxChars: number,
): readonly string[] => {
  const groups: string[] = [];
  let current = '';
  for (const part of parts) {
    const candidate = current === '' ? part : `${current}${sep}${part}`;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current !== '') groups.push(current);
      current = part;
    }
  }
  if (current !== '' || groups.length === 0) groups.push(current);
  return groups;
};

const SENTENCE_SPLIT_RE = /(?<=[.?!])\s+/gu;

const splitIntoSentences = (line: string): readonly string[] =>
  line.split(SENTENCE_SPLIT_RE).filter((part) => part !== '');

/** Last-resort fallback: cuts at a word boundary when one is close by, else exactly at `maxChars`. */
const hardCut = (text: string, maxChars: number): readonly string[] => {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const spaceCut = window.lastIndexOf(' ');
    const cut = spaceCut > 0 && spaceCut >= maxChars - 200 ? spaceCut + 1 : maxChars;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
};

/**
 * Splits a single paragraph (no blank lines inside it) that is itself over
 * `maxChars`, escalating through line boundaries, then sentence ends, then a
 * hard cut at `maxChars` — whichever is the coarsest split that still fits.
 * Line ranges stay correct throughout; sub-pieces cut out of one physical
 * line necessarily share that line's number.
 */
const splitOversizedParagraph = (para: Piece, maxChars: number): readonly Piece[] => {
  if (para.text.length <= maxChars) return [para];

  const lines = para.text.split('\n');
  if (lines.length > 1) {
    const groups = packStrings(lines, '\n', maxChars);
    const pieces: Piece[] = [];
    let cursor = para.startLine;
    for (const group of groups) {
      const groupLineCount = group.split('\n').length;
      const piece: Piece = { text: group, startLine: cursor, endLine: cursor + groupLineCount - 1 };
      cursor += groupLineCount;
      // A single line within the group can still be oversized on its own.
      pieces.push(...splitOversizedParagraph(piece, maxChars));
    }
    return pieces;
  }

  const sentences = splitIntoSentences(para.text);
  if (sentences.length > 1) {
    return packStrings(sentences, ' ', maxChars).flatMap((group) =>
      group.length <= maxChars
        ? [{ text: group, startLine: para.startLine, endLine: para.endLine }]
        : hardCut(group, maxChars).map((text) => ({
            text,
            startLine: para.startLine,
            endLine: para.endLine,
          })),
    );
  }

  return hardCut(para.text, maxChars).map((text) => ({
    text,
    startLine: para.startLine,
    endLine: para.endLine,
  }));
};

const extractParagraphs = (section: Section): readonly Piece[] => {
  const lines = section.text.split('\n');
  const paragraphs: Piece[] = [];
  let paraLines: string[] = [];
  let paraStart = section.startLine;
  const pushPara = (endLine: number): void => {
    if (paraLines.length === 0) return;
    paragraphs.push({ text: paraLines.join('\n'), startLine: paraStart, endLine });
    paraLines = [];
  };
  lines.forEach((line, i) => {
    const lineNo = section.startLine + i;
    if (line.trim() === '') {
      pushPara(lineNo - 1);
      paraStart = lineNo + 1;
    } else {
      if (paraLines.length === 0) paraStart = lineNo;
      paraLines.push(line);
    }
  });
  pushPara(section.startLine + lines.length - 1);
  return paragraphs;
};

const splitSectionByParagraph = (section: Section, maxChars: number): readonly Piece[] => {
  if (section.text.length <= maxChars) {
    return [{ startLine: section.startLine, endLine: section.endLine, text: section.text }];
  }
  const paragraphs = extractParagraphs(section);

  const pieces: Piece[] = [];
  let current: Piece | undefined;
  const flushCurrent = (): void => {
    if (current !== undefined) {
      pieces.push(current);
      current = undefined;
    }
  };
  for (const para of paragraphs) {
    if (para.text.length > maxChars) {
      // A lone oversized paragraph is never merged with its neighbours; it
      // is split on its own and spliced in as one or more standalone pieces.
      flushCurrent();
      pieces.push(...splitOversizedParagraph(para, maxChars));
      continue;
    }
    if (current === undefined) {
      current = para;
      continue;
    }
    const candidate = `${current.text}\n\n${para.text}`;
    if (candidate.length <= maxChars) {
      current = { text: candidate, startLine: current.startLine, endLine: para.endLine };
    } else {
      pieces.push(current);
      current = para;
    }
  }
  flushCurrent();
  return pieces;
};

const chunkProse = (text: string, path: string, maxChars: number): readonly Chunk[] => {
  const sections = splitSections(text, path);
  const chunks: Chunk[] = [];
  let ordinal = 0;
  for (const section of sections) {
    for (const piece of splitSectionByParagraph(section, maxChars)) {
      chunks.push({
        ordinal: ordinal++,
        headingPath: section.headingPath,
        lineStart: piece.startLine,
        lineEnd: piece.endLine,
        text: piece.text,
      });
    }
  }
  return chunks;
};

// ---------------------------------------------------------------------------
// fixed-size line windows (plain text and code)
// ---------------------------------------------------------------------------

const chunkWindowed = (text: string, path: string): readonly Chunk[] => {
  const lines = text.split('\n');
  const headingPath = basename(path);
  const step = WINDOW_LINES - WINDOW_OVERLAP_LINES;
  const chunks: Chunk[] = [];
  let start = 0;
  let ordinal = 0;
  while (start < lines.length) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    chunks.push({
      ordinal: ordinal++,
      headingPath,
      lineStart: start + 1,
      lineEnd: end,
      text: lines.slice(start, end).join('\n'),
    });
    if (end >= lines.length) break;
    start += step;
  }
  return chunks;
};

// ---------------------------------------------------------------------------

export const chunkDocument = (input: {
  readonly text: string;
  readonly mediaType: string;
  readonly path: string;
  readonly maxChars?: number;
}): readonly Chunk[] => {
  const text = normaliseLineEndings(input.text);
  if (text.trim() === '') return [];
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  if (isHtmlInput(input.mediaType, input.path)) {
    const converted = htmlToText(text);
    if (converted.trim() === '') return [];
    return chunkProse(converted, input.path, maxChars);
  }
  if (isMarkdownPath(input.mediaType, input.path)) {
    return chunkProse(text, input.path, maxChars);
  }
  return chunkWindowed(text, input.path);
};
