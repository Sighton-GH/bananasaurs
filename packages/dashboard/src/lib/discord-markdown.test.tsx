// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderDiscordMarkdown, safeHttpUrl, formatDiscordTimestamp } from './discord-markdown.js';

afterEach(cleanup);
const html = (text: string, opts = {}): string => {
  const { container } = render(<div>{renderDiscordMarkdown(text, opts)}</div>);
  return container.firstElementChild?.innerHTML ?? '';
};
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const clock = { now: NOW, timeZone: 'UTC' };

it('renders bold, italic and code', () => {
  expect(html('a **b** *c* `d`')).toBe('<p>a <strong>b</strong> <em>c</em> <code>d</code></p>');
});

it('keeps backslash-escaped markup literal (what the P1 renderer emits)', () => {
  expect(html('\\*\\*not bold\\*\\* \\[x\\]\\(https://a.b\\) \\`c\\` \\\\')).toBe(
    '<p>**not bold** [x](https://a.b) `c` \\</p>',
  );
});

it('renders a bold title that holds escaped punctuation', () => {
  const { container } = render(<div>{renderDiscordMarkdown('**a\\*b\\_c\\\\d**')}</div>);
  expect(container.querySelector('strong')?.textContent).toBe('a*b_c\\d');
});

it('renders subtext and quotes as blocks', () => {
  const out = html('-# small\n> one\n> two\nplain');
  expect(out).toContain('<small');
  expect(out).toContain('small</small>');
  expect(out.match(/<blockquote/g)).toHaveLength(1);
  expect(out).toContain('one');
  expect(out).toContain('two');
  expect(out).toContain('plain');
});

it('does not read an escaped line-start marker as a quote or subtext', () => {
  const out = html('\\> not quote\n\\-# not small');
  expect(out).not.toContain('<blockquote');
  expect(out).not.toContain('<small');
  expect(out).toContain('&gt; not quote');
});

it('shows mentions and channels as pills', () => {
  const { container } = render(
    <div>
      {renderDiscordMarkdown('<@123456789012345678> <@&223456789012345678> <#323456789012345678>')}
    </div>,
  );
  const pills = [...container.querySelectorAll('[data-pill]')].map((n) => [
    n.getAttribute('data-pill'),
    n.textContent,
  ]);
  expect(pills).toEqual([
    ['user', '@member'],
    ['role', '@role'],
    ['channel', '#channel'],
  ]);
});

it('treats a mention with a non-numeric id as text', () => {
  expect(html('<@abc>')).toContain('&lt;@abc&gt;');
});

it('formats every timestamp style deterministically', () => {
  const sec = Math.floor(Date.UTC(2026, 9, 14, 17, 30, 0) / 1000);
  const f = (s: string) => formatDiscordTimestamp(sec, s, clock);
  expect(f('d')).toBe('10/14/2026');
  expect(f('D')).toBe('October 14, 2026');
  expect(f('f')).toBe('October 14, 2026 at 5:30 PM');
  expect(f('F')).toBe('Wednesday, October 14, 2026 at 5:30 PM');
  expect(f('t')).toBe('5:30 PM');
  expect(f('T')).toBe('5:30:00 PM');
  expect(f('R')).toBe('in 2 days');
});

it('timestamp zone is an input, not the host', () => {
  const sec = Math.floor(Date.UTC(2026, 9, 14, 3, 30, 0) / 1000);
  expect(formatDiscordTimestamp(sec, 'f', { now: NOW, timeZone: 'America/Vancouver' })).toBe(
    'October 13, 2026 at 8:30 PM',
  );
});

it('relative style reads past and future', () => {
  const at = (ms: number) => formatDiscordTimestamp(Math.floor((NOW + ms) / 1000), 'R', clock);
  expect(at(-3 * 3600_000)).toBe('3 hours ago');
  expect(at(5 * 60_000)).toBe('in 5 minutes');
  expect(at(-20_000)).toBe('20 seconds ago');
});

it('renders a timestamp token with a machine-readable time', () => {
  const sec = Math.floor(Date.UTC(2026, 9, 14, 17, 30, 0) / 1000);
  const { container } = render(<div>{renderDiscordMarkdown(`<t:${sec}:f>`, clock)}</div>);
  const t = container.querySelector('time');
  expect(t?.getAttribute('dateTime')).toBe('2026-10-14T17:30:00.000Z');
  expect(t?.textContent).toBe('October 14, 2026 at 5:30 PM');
});

it('leaves an out-of-range or unknown timestamp as text', () => {
  expect(html('<t:99999999999999999:f>', clock)).toContain('&lt;t:');
  expect(html('<t:100:z>', clock)).toContain('&lt;t:100:z&gt;');
});

it('never parses HTML', () => {
  const { container } = render(
    <div>{renderDiscordMarkdown('<script>alert(1)</script> <img src=x onerror=y>')}</div>,
  );
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('<script>alert(1)</script>');
});

it('links only to safe http(s) targets', () => {
  const { container } = render(
    <div>{renderDiscordMarkdown('[ok](https://example.com/a?b=1)')}</div>,
  );
  const a = container.querySelector('a');
  expect(a?.getAttribute('href')).toBe('https://example.com/a?b=1');
  expect(a?.getAttribute('target')).toBe('_blank');
  expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
});

it.each([
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,x',
  '//evil.example',
  '/\\evil.example',
  'https://a.b\\c',
  'https://a.b/\u0001',
  'https://a.b/\u200b',
  'vbscript:x',
  'file:///etc/passwd',
  '/relative',
  'https:///',
  'http://',
  '',
])('does not activate %j', (url) => {
  expect(safeHttpUrl(url)).toBeNull();
  const { container } = render(<div>{renderDiscordMarkdown(`[label](${url})`)}</div>);
  expect(container.querySelector('a')).toBeNull();
});

it('shows the label of an unsafe link as text', () => {
  expect(html('[label](javascript:f(1))')).toContain('label');
});

it('keeps unrecognised syntax as typed', () => {
  expect(html('~~x~~ __y__ # h ||s|| **open')).toBe('<p>~~x~~ __y__ # h ||s|| **open</p>');
});

it('does not hang or blow up on hostile input', () => {
  const evil = '*'.repeat(5000) + '['.repeat(2000) + '`'.repeat(3000) + '<'.repeat(2000);
  expect(html(evil).length).toBeGreaterThan(0);
});
