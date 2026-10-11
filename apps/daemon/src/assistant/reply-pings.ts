/** Code spans never ping, the ADR 0128 parser (`apps/daemon/src/mcp/targets.ts:418`). */
export const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g;
/** `@` then one word and up to three more; `@` and most punctuation end it. */
const AT = /@([A-Za-z0-9][A-Za-z0-9.'-]*(?: [A-Za-z0-9.'-]+){0,3})/g;

/**
 * For each `@` outside code: the 1–4 word phrases after it, longest first
 * ("@Sam L and" → ["Sam L and", "Sam L", "Sam"]). The caller takes the
 * longest phrase that is exactly a name, so trailing words never break a
 * match. `@everyone` / `@here` (any case) are skipped.
 */
export const extractPingPhrases = (text: string): string[][] => {
  const prose = text.replace(CODE_SPAN, ' ');
  const occurrences: string[][] = [];
  for (const match of prose.matchAll(AT)) {
    const words = (match[1] ?? '')
      .replace(/\.+$/, '')
      .split(' ')
      .filter((w) => w !== '');
    const first = words[0];
    if (first === undefined || /^(everyone|here)$/i.test(first)) continue;
    const phrases: string[] = [];
    for (let n = words.length; n >= 1; n -= 1) phrases.push(words.slice(0, n).join(' '));
    occurrences.push(phrases);
  }
  return occurrences;
};

/** Per occurrence, the longest phrase that is exactly (case-insensitively) a candidate's name; ids deduped. */
export const matchPingNames = (
  occurrences: readonly (readonly string[])[],
  candidates: readonly { readonly id: string; readonly name: string }[],
): string[] => {
  const ids: string[] = [];
  for (const phrases of occurrences) {
    for (const phrase of phrases) {
      const hit = candidates.find((c) => c.name.toLowerCase() === phrase.toLowerCase());
      if (hit === undefined) continue;
      if (!ids.includes(hit.id)) ids.push(hit.id);
      break;
    }
  }
  return ids;
};

/** True when `name` appears in `text` as whole words, case-insensitively. */
export const namedIn = (text: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, 'i').test(text);

/** Rewrites `@Name` → id token in prose segments only. */
export const replacePingTokens = (
  text: string,
  replacements: ReadonlyMap<string, string>,
): string => {
  let out = '';
  let at = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    out += replaceInProse(text.slice(at, match.index ?? at), replacements);
    out += match[0];
    at = (match.index ?? at) + match[0].length;
  }
  return out + replaceInProse(text.slice(at), replacements);
};

const replaceInProse = (prose: string, replacements: ReadonlyMap<string, string>): string => {
  let out = prose;
  // Longest name first so `@Sam L` wins over `@Sam` in the same text.
  const entries = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [name, token] of entries) {
    const pattern = new RegExp(`@${escapeRegExp(name)}(?![A-Za-z0-9'\\-])`, 'gi');
    out = out.replace(pattern, token);
  }
  return out;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
