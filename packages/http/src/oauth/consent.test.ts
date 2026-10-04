import { describe, expect, it } from 'vitest';
import { renderConsentPage, renderErrorPage } from './consent.js';

const VIEW = {
  clientName: 'Claude Desktop',
  clientId: 'cli_abcdef0123456789',
  registeredAt: '2026-09-13T12:00:00.000Z',
  redirectUriHost: 'claude.ai',
  scopes: ['bananasaurs:read'],
  requestId: 'req_abc',
  nonce: 'nonce_xyz',
} as const;

describe('renderConsentPage', () => {
  it('escapes a hostile client name and leaves no raw copy', () => {
    const html = renderConsentPage({ ...VIEW, clientName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders the nonce exactly once, in a double-quoted hidden input', () => {
    const html = renderConsentPage({ ...VIEW, nonce: 'nonce_only_once' });
    const occurrences = html.split('nonce_only_once').length - 1;
    expect(occurrences).toBe(1);
    expect(html).toContain('value="nonce_only_once"');
  });

  it('escapes a quote inside the redirect host attribute', () => {
    const html = renderConsentPage({ ...VIEW, redirectUriHost: 'evil.test" autofocus="' });
    expect(html).not.toContain('evil.test" autofocus="');
    expect(html).toContain('evil.test&quot; autofocus=&quot;');
  });

  it('names the client without taking the full redirect URI as an input', () => {
    // The view carries the host only, so a crafted path or query cannot be
    // smuggled into the page through it.
    const html = renderConsentPage({ ...VIEW });
    expect(html).toContain('claude.ai');
    expect(html).not.toContain('https://claude.ai/api/mcp/auth_callback?code=');
  });

  it('carries the phishing warning verbatim', () => {
    expect(renderConsentPage({ ...VIEW })).toContain(
      'Approve only if you started this from a client you recognise.',
    );
  });

  it('renders approve and deny as two submit buttons named decision', () => {
    const html = renderConsentPage({ ...VIEW });
    expect(html).toContain('<form method="post" action="/oauth/authorize">');
    expect(html).toContain('name="decision"');
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
  });

  it('explains each scope in plain English beside the raw string', () => {
    const html = renderConsentPage({ ...VIEW, scopes: ['bananasaurs:read', 'bananasaurs:send'] });
    expect(html).toContain('<li>bananasaurs:read — read messages, cases and server settings</li>');
    expect(html).toContain('<li>bananasaurs:send — send messages as the bot</li>');
  });

  it('explains all four scopes with no unknown permission', () => {
    const html = renderConsentPage({
      ...VIEW,
      scopes: ['bananasaurs:read', 'bananasaurs:send', 'bananasaurs:roles', 'bananasaurs:tasks'],
    });
    expect(html).toContain('<li>bananasaurs:read — read messages, cases and server settings</li>');
    expect(html).toContain('<li>bananasaurs:send — send messages as the bot</li>');
    expect(html).toContain(
      '<li>bananasaurs:roles — give and remove member roles and manage role panels</li>',
    );
    expect(html).toContain('<li>bananasaurs:tasks — create and change club tasks</li>');
    expect(html).not.toContain('unknown permission');
  });

  it('names the client id and the registration date', () => {
    const html = renderConsentPage({ ...VIEW });
    expect(html).toContain('<code>cli_abcdef0123456789</code>');
    expect(html).toContain('registered 2026-09-13T12:00:00.000Z');
  });

  it('escapes a hostile client id and registration date, leaving no raw copy', () => {
    const html = renderConsentPage({
      ...VIEW,
      clientId: 'cli_<img src=x onerror=alert(1)>',
      registeredAt: '</p><script>alert(1)</script>',
    });
    expect(html).not.toContain('cli_<img src=x onerror=alert(1)>');
    expect(html).not.toContain('</p><script>alert(1)</script>');
    expect(html).toContain('cli_&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('uses no script, no style attribute, and no external resource', () => {
    const html = renderConsentPage({ ...VIEW }).toLowerCase();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<img');
  });
});

describe('renderErrorPage', () => {
  it('escapes the message and never echoes a raw value', () => {
    const html = renderErrorPage('<b>nope</b>');
    expect(html).not.toContain('<b>nope</b>');
    expect(html).toContain('&lt;b&gt;nope&lt;/b&gt;');
  });
});
