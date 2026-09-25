/**
 * Untrusted content (quoted Discord messages, cached resource text, tool
 * results) travels inside `[UNTRUSTED …]…[/UNTRUSTED …]` envelopes, never as
 * instructions (hard rule 3). A closing marker inside the content itself
 * would end the envelope early and promote the rest, so every envelope entry
 * point neutralises it first through this one helper.
 */
export const escapeUntrustedClose = (content: string): string =>
  content.replace(/\[\/UNTRUSTED/gi, '[/untrusted-text');
