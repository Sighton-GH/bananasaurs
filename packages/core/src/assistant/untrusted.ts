/**
 * Untrusted content (member display names, quoted Discord messages, cached
 * resource text, tool results) travels inside `[UNTRUSTED …]…[/UNTRUSTED …]`
 * envelopes and `[CURRENT MESSAGE …]…[/CURRENT MESSAGE]` blocks, never as
 * instructions (hard rule 3). A structural marker inside the content itself
 * would close or forge its envelope and promote the rest, so every envelope
 * entry point neutralises markers first through these helpers.
 */

/** A `[/UNTRUSTED` inside content would close its envelope early and promote the rest (hard rule 3). */
export const escapeUntrustedClose = (content: string): string =>
  content.replace(/\[\/UNTRUSTED/gi, '[/untrusted-text');

/** Neutralises every structural marker the request uses, for any untrusted body. */
export const neutraliseMarkers = (content: string): string =>
  escapeUntrustedClose(content)
    .replace(/\[UNTRUSTED/gi, '[untrusted-text')
    .replace(/\[\/CURRENT MESSAGE/gi, '[/current-message')
    .replace(/\[CURRENT MESSAGE/gi, '[current-message');

// eslint-disable-next-line no-control-regex -- deliberately stripping control characters from member display names.
const CONTROL_OR_BRACKET = /[\u0000-\u001f\u007f[\]]/g;

/** A member-controlled display name made safe for labels, headers and the answer line. */
export const safeDisplayName = (name: string | undefined): string | undefined => {
  const cleaned = (name ?? '')
    .replace(CONTROL_OR_BRACKET, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32)
    .trim();
  return cleaned === '' ? undefined : cleaned;
};
