/**
 * RFC 7591 leaves redirect URIs to the server. ADR 0045 D7: https or
 * loopback only, because dynamic registration is unauthenticated and an
 * arbitrary http:// target turns registration into an open redirector.
 * Loopback is `127.0.0.1`, `[::1]` or `localhost` over http, any port.
 */
export const isAllowedRedirectUri = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash !== '') return false;
  if (url.hostname === '') return false;
  // WHATWG skips every slash after the scheme of a special scheme, so
  // `https:///nohost` parses with host `nohost`. The raw text must still
  // carry a non-empty authority immediately after `://`.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]/.test(raw)) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
};
