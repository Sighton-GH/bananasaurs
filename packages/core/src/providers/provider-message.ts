/**
 * ADR 0129 §3: a provider's short error text made safe to store. Collapses whitespace runs to one
 * space, replaces key-shaped substrings with `[redacted]`, and caps the result at 160 characters
 * (cut text ends with `…`).
 */
export const sanitizeProviderMessage: (text: string) => string = (text) => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const redacted = collapsed
    .replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/nvapi-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/tvly-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
  return redacted.length > 160 ? `${redacted.slice(0, 159)}…` : redacted;
};
