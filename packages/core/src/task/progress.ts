/**
 * Deterministic progress-update classifier (R2).
 *
 * A member's Discord reply to a task post (announcement, reminder, or weekly
 * check-in) counts as a progress update unless it is a bare acknowledgement
 * such as "ok" or "thanks" (O2/O3). No model is involved: attribution is only
 * ever by the replied-to message id, and this module only answers whether the
 * reply body carries an update worth recording.
 */

/** Bare acknowledgements that never become progress reports. */
export const ACK_PHRASES: ReadonlySet<string> = new Set([
  'ok',
  'okay',
  'k',
  'kk',
  'thanks',
  'thank you',
  'thx',
  'ty',
  'got it',
  'gotcha',
  'will do',
  'noted',
  'sure',
  'yes',
  'yep',
  'yeah',
  'roger',
  'cool',
  'sounds good',
  'on it',
  'understood',
]);

/** Acknowledgement phrases, longest first, for the greedy cover check below. */
const PHRASES_LONGEST_FIRST: readonly string[] = [...ACK_PHRASES].sort(
  (a, b) => b.length - a.length,
);

/** True when a reply carries a progress update rather than a bare acknowledgement. */
export const isProgressUpdate = (text: string): boolean => {
  const normalised = normalise(text);
  // Fewer than two letters cannot carry an update ("ok", "k", emoji, "").
  if ((normalised.match(/\p{L}/gu) ?? []).length < 2) return false;
  // False when the whole string is one acknowledgement phrase, or a sequence
  // of them ("ok thanks", "got it, will do"); anything else is an update
  // ("ok, wiring is done" leaves "wiring is done" uncovered).
  let rest = normalised;
  while (rest.length > 0) {
    const hit = PHRASES_LONGEST_FIRST.find(
      (phrase) => rest === phrase || rest.startsWith(`${phrase} `),
    );
    if (hit === undefined) return true;
    rest = rest.slice(hit.length).trim();
  }
  return false;
};

/** Strip mentions, emoji, and URLs, then fold punctuation, case, and spacing. */
const normalise = (text: string): string =>
  text
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/<[@#][^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE00-\uFE0F]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
