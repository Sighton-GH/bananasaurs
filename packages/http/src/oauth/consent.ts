/**
 * The consent page: the project's first server-rendered HTML (ADR 0045 D6).
 *
 * It borrows the dashboard's password verifier, never its session cookie —
 * this page reads no cookie at all. The form carries the pending
 * authorization's id and single-use nonce as hidden inputs (Amendment 1
 * PR-91); the route also requires `originMatchesHost`, the password, and the
 * `mcp.authorize` capability before minting anything.
 */

export interface ConsentView {
  readonly clientName: string;
  /** The `cli_…` id, so two clients with the same display name are distinguishable. */
  readonly clientId: string;
  /** ISO date of the client's registration, formatted by the route from the row. */
  readonly registeredAt: string;
  readonly redirectUriHost: string;
  readonly scopes: readonly string[];
  readonly requestId: string;
  readonly nonce: string;
  readonly error?: 'invalid-credentials' | 'locked-out' | 'no-grant';
}

/** The five XML entities. Every interpolated value goes through this. */
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

const errorLine = (error: NonNullable<ConsentView['error']>): string => {
  switch (error) {
    case 'invalid-credentials':
      return '<p>Sign-in failed: unknown username or wrong password.</p>';
    case 'locked-out':
      return '<p>Sign-in failed: this account is locked out. Try again later.</p>';
    case 'no-grant':
      return '<p>This account is not authorized to approve OAuth clients.</p>';
  }
};

/** One plain-English clause per scope in the vocabulary (ruling PR-103). */
const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'bananasaurs:read': 'read messages, cases and server settings',
  'bananasaurs:send': 'send messages as the bot',
};

export const renderConsentPage = (view: ConsentView): string => {
  const scopes = view.scopes
    .map((scope) => `<li>${esc(scope)} — ${esc(SCOPE_DESCRIPTIONS[scope] ?? 'unknown permission')}</li>`)
    .join('');
  const error = view.error === undefined ? '' : errorLine(view.error);
  return (
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head><meta charset="utf-8">' +
    `<title>Authorize ${esc(view.clientName)}</title>` +
    '</head>' +
    '<body>' +
    `<h1>Authorize ${esc(view.clientName)}?</h1>` +
    `<p>Client <strong>${esc(view.clientName)}</strong> is requesting access to this server.</p>` +
    `<p>Client id <code>${esc(view.clientId)}</code>, registered ${esc(view.registeredAt)}.</p>` +
    `<p>It will return to host <code>${esc(view.redirectUriHost)}</code>.</p>` +
    '<p>Scopes requested:</p>' +
    `<ul>${scopes}</ul>` +
    '<p>Approve only if you started this from a client you recognise.</p>' +
    error +
    '<form method="post" action="/oauth/authorize">' +
    `<input type="hidden" name="requestId" value="${esc(view.requestId)}">` +
    `<input type="hidden" name="nonce" value="${esc(view.nonce)}">` +
    '<label>Username <input type="text" name="username" autocomplete="username"></label>' +
    '<label>Password <input type="password" name="password" autocomplete="current-password"></label>' +
    '<button type="submit" name="decision" value="approve">Approve</button>' +
    '<button type="submit" name="decision" value="deny">Deny</button>' +
    '</form>' +
    '</body>' +
    '</html>'
  );
};

export const renderErrorPage = (message: string): string =>
  '<!DOCTYPE html>' +
  '<html lang="en">' +
  '<head><meta charset="utf-8"><title>Authorization failed</title></head>' +
  '<body>' +
  '<h1>Authorization failed</h1>' +
  `<p>${esc(message)}</p>` +
  '</body>' +
  '</html>';
