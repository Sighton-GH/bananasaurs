// Discord message splitter (ADR 0074). Pure: no I/O, no clock. Splits long
// answers into parts that fit Discord's message limit, preferring paragraph
// boundaries, then sentence ends and spaces, and keeping fenced code blocks
// balanced so every part renders on its own.

export const DISCORD_MESSAGE_LIMIT = 2_000;

const SHORTENED_MARKER = '\n-# (answer shortened)';
const FENCE_CLOSE = '\n```';

const hardSplit = (text: string, cap: number): readonly string[] => {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > cap) {
    const window = rest.slice(0, cap);
    const sentenceEnd = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
    );
    let cut: number;
    if (sentenceEnd !== -1) {
      cut = sentenceEnd + 2;
    } else {
      const best = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
      // Never cut mid-word when a space sits in the last 200 characters.
      cut = best === -1 || (cap > 200 && best < cap - 200) ? cap : best + 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
};

const packUnits = (text: string, cap: number): readonly string[] => {
  const units: { readonly text: string; readonly sep: string }[] = [];
  text.split('\n\n').forEach((paragraph, index) => {
    const sep = index === 0 ? '' : '\n\n';
    if (paragraph.length <= cap) {
      units.push({ text: paragraph, sep });
    } else {
      hardSplit(paragraph, cap).forEach((chunk, chunkIndex) => {
        units.push({ text: chunk, sep: chunkIndex === 0 ? sep : '' });
      });
    }
  });
  const parts: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current === '' ? unit.text : current + unit.sep + unit.text;
    if (candidate.length <= cap) {
      current = candidate;
    } else {
      if (current !== '') parts.push(current);
      current = unit.text;
    }
  }
  if (current !== '' || parts.length === 0) parts.push(current);
  return parts;
};

const fenceInfo = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('```')) return undefined;
  return trimmed.slice(3).trim().split(/\s+/, 1)[0] ?? '';
};

const scanFences = (
  text: string,
  startInFence: boolean,
  startLang: string,
): { inFence: boolean; lang: string } => {
  let inFence = startInFence;
  let lang = startLang;
  for (const line of text.split('\n')) {
    const info = fenceInfo(line);
    if (info === undefined) continue;
    if (inFence) {
      inFence = false;
      lang = '';
    } else {
      inFence = true;
      lang = info;
    }
  }
  return { inFence, lang };
};

const balanceFences = (parts: readonly string[], limit: number): readonly string[] => {
  const out: string[] = [];
  let entryInFence = false;
  let entryLang = '';
  const queue = [...parts];
  while (queue.length > 0) {
    const part = queue.shift()!;
    const prefix = entryInFence ? `\`\`\`${entryLang}\n` : '';
    const exit = scanFences(part, entryInFence, entryLang);
    const suffix = exit.inFence ? FENCE_CLOSE : '';
    if (prefix.length + part.length + suffix.length <= limit) {
      out.push(prefix + part + suffix);
      entryInFence = exit.inFence;
      entryLang = exit.lang;
      continue;
    }
    // The fence markers pushed this part over the limit; pull the tail back
    // to a line or word boundary and requeue it as its own fenced part.
    const room = limit - prefix.length - FENCE_CLOSE.length;
    let cut = part.lastIndexOf('\n', room);
    if (cut === -1) cut = part.lastIndexOf(' ', room);
    if (cut === -1 || (room > 200 && cut < room - 200)) cut = room;
    if (cut <= 0 || cut >= part.length) cut = Math.min(room, part.length - 1);
    const kept = part.slice(0, cut);
    const keptExit = scanFences(kept, entryInFence, entryLang);
    out.push(prefix + kept + (keptExit.inFence ? FENCE_CLOSE : ''));
    entryInFence = keptExit.inFence;
    entryLang = keptExit.lang;
    queue.unshift(part.slice(cut));
  }
  return out;
};

export const splitForDiscord = (
  text: string,
  options?: { limit?: number; maxParts?: number },
): readonly string[] => {
  const limit = Math.max(options?.limit ?? DISCORD_MESSAGE_LIMIT, 64);
  const maxParts = Math.max(options?.maxParts ?? 5, 1);
  if (text.trim() === '') return [];
  if (text.length <= limit) return [text];
  const balanced = balanceFences(packUnits(text, limit), limit);
  if (balanced.length <= maxParts) return balanced;
  const head = balanced.slice(0, maxParts - 1);
  const tail = balanced[maxParts - 1]!;
  const room = limit - SHORTENED_MARKER.length;
  let cut = tail.slice(0, room);
  // Keep the shortened tail fence-balanced when cut inside a code block.
  if ((cut.match(/```/g) ?? []).length % 2 === 1) {
    cut = tail.slice(0, room - FENCE_CLOSE.length);
  }
  const suffix = (cut.match(/```/g) ?? []).length % 2 === 1 ? FENCE_CLOSE : '';
  return [...head, `${cut}${suffix}${SHORTENED_MARKER}`];
};
