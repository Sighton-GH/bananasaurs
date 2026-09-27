import { describe, expect, it } from 'vitest';
import { chunkDocument, clipHeading, htmlToText } from './chunker.js';

describe('chunkDocument — markdown', () => {
  it('builds heading-path breadcrumbs and correct 1-based line ranges', () => {
    const text = [
      'Welcome to the project.',
      '',
      '## Setup',
      '',
      'Install dependencies first.',
      '',
      '### Docker',
      '',
      'Run `docker compose up`.',
    ].join('\n');
    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'README.md' });
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'README.md',
      'README.md › Setup',
      'README.md › Setup › Docker',
    ]);
    expect(chunks[0]).toMatchObject({ ordinal: 0, lineStart: 1, lineEnd: 2 });
    expect(chunks[1]).toMatchObject({ ordinal: 1, lineStart: 3, lineEnd: 6 });
    expect(chunks[2]).toMatchObject({ ordinal: 2, lineStart: 7, lineEnd: 9 });
  });

  it('splits an oversized section at paragraph boundaries, keeping the same heading path', () => {
    const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6);
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}: ${para}`);
    const body: string[] = ['## Long section', ''];
    paragraphs.forEach((p, i) => {
      if (i > 0) body.push('');
      body.push(p);
    });
    const text = body.join('\n');
    expect(text.length).toBeGreaterThan(1_500);

    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'notes.md' });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toBe('notes.md › Long section');
      expect(chunk.text.length).toBeLessThanOrEqual(1_500);
    }
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.lineStart).toBeGreaterThan(chunks[i - 1]!.lineEnd);
    }
    // Every paragraph survives the split, in order.
    const joined = chunks.map((c) => c.text).join('\n');
    for (const p of paragraphs) expect(joined).toContain(p);
  });

  it('respects a caller-supplied maxChars', () => {
    const text = ['# Doc', '', 'a'.repeat(100), '', 'b'.repeat(100)].join('\n');
    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'x.md', maxChars: 120 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(120);
  });

  it('further splits a single oversized paragraph (no blank lines inside it) so every chunk stays under maxChars', () => {
    const sentence = 'This sentence describes club policy in reasonable detail for a member. ';
    const paragraph = sentence.repeat(Math.ceil(4_000 / sentence.length)).slice(0, 4_000);
    expect(paragraph.length).toBe(4_000);
    expect(paragraph).not.toContain('\n');
    const text = ['## Policy', '', paragraph].join('\n');

    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'policy.md' });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1_500);
      expect(chunk.headingPath).toBe('policy.md › Policy');
      expect(chunk.lineStart).toBeGreaterThanOrEqual(1);
      expect(chunk.lineEnd).toBeGreaterThanOrEqual(chunk.lineStart);
    }
    // The content survives the split (modulo the whitespace the sentence
    // splitter consumes at cut points), in order.
    const joined = chunks.map((c) => c.text).join('');
    expect(joined.replace(/\s+/g, ' ')).toContain('This sentence describes club policy');
  });

  it('splits an oversized multi-line paragraph at line boundaries before falling back further', () => {
    // 60 wrapped lines, ~30 chars each (no blank line between them, so this
    // is one paragraph) totalling well over 1,500 characters.
    const paragraphLines = Array.from({ length: 60 }, (_, i) => `Line ${i} of the club handbook.`);
    const paragraph = paragraphLines.join('\n');
    expect(paragraph.length).toBeGreaterThan(1_500);
    const text = ['## Handbook', '', paragraph].join('\n');

    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'handbook.md' });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1_500);
      expect(chunk.headingPath).toBe('handbook.md › Handbook');
    }
    // No line was cut mid-line: the split fell back no further than line
    // boundaries, since each individual line is well under the cap.
    for (const chunk of chunks) {
      for (const line of chunk.text.split('\n')) {
        expect(paragraphLines.includes(line) || line === '## Handbook').toBe(true);
      }
    }
    expect(
      chunks
        .map((c) => c.text)
        .join('\n')
        .split('\n')
        .filter((l) => l !== '## Handbook'),
    ).toEqual(paragraphLines);
  });

  it('hard-splits a single oversized paragraph with no sentence or word boundaries', () => {
    const paragraph = 'x'.repeat(4_000);
    const text = ['## Blob', '', paragraph].join('\n');

    const chunks = chunkDocument({
      text,
      mediaType: 'text/markdown',
      path: 'blob.md',
      maxChars: 1_500,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1_500);
      expect(chunk.headingPath).toBe('blob.md › Blob');
    }
    // The heading line is its own small paragraph/chunk ahead of the
    // oversized one; concatenating every chunk's text (blank-line
    // separators are not stored in either piece) reconstructs the heading
    // line immediately followed by the untouched paragraph, with no
    // characters lost or duplicated by the hard cut.
    expect(chunks.map((c) => c.text).join('')).toBe(`## Blob${paragraph}`);
  });
});

describe('chunkDocument — plain text and code windowing', () => {
  it('windows a 130-line file into 60-line chunks with 10-line overlap', () => {
    const lines = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`);
    const text = lines.join('\n');
    const chunks = chunkDocument({ text, mediaType: 'text/plain', path: 'src/app.ts' });
    expect(chunks.map((c) => [c.lineStart, c.lineEnd])).toEqual([
      [1, 60],
      [51, 110],
      [101, 130],
    ]);
    expect(chunks[0]!.headingPath).toBe('app.ts');
    expect(chunks[1]!.text.split('\n')[0]).toBe('line 51');
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it('applies the same windowing to .py files, with a 10-line overlap at the boundary', () => {
    const lines = Array.from({ length: 65 }, (_, i) => `x = ${i}`);
    const text = lines.join('\n');
    const chunks = chunkDocument({ text, mediaType: 'text/plain', path: 'tool.py' });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ lineStart: 1, lineEnd: 60 });
    expect(chunks[1]).toMatchObject({ lineStart: 51, lineEnd: 65 });
    // The overlap lines are present in both windows.
    expect(chunks[0]!.text).toContain('x = 50');
    expect(chunks[1]!.text).toContain('x = 50');
  });

  it('windows plain text with no headings the same way as code', () => {
    const lines = Array.from({ length: 61 }, (_, i) => `note ${i + 1}`);
    const chunks = chunkDocument({
      text: lines.join('\n'),
      mediaType: 'text/plain',
      path: 'notes.txt',
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ lineStart: 1, lineEnd: 60 });
    expect(chunks[1]).toMatchObject({ lineStart: 51, lineEnd: 61 });
  });
});

describe('chunkDocument — HTML', () => {
  it('converts HTML to text first, drops scripts, and keeps heading hierarchy', () => {
    const html =
      '<script>evil()</script><h1>Club</h1><p>Intro text.</p><h2>Meetings</h2><p>Mondays.</p>';
    const chunks = chunkDocument({ text: html, mediaType: 'text/html', path: 'page.html' });
    expect(chunks.some((c) => c.text.includes('evil('))).toBe(false);
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'page.html › Club',
      'page.html › Club › Meetings',
    ]);
  });
});

describe('chunkDocument — edge cases', () => {
  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkDocument({ text: '', mediaType: 'text/plain', path: 'x.md' })).toEqual([]);
    expect(chunkDocument({ text: '   \n  \n', mediaType: 'text/plain', path: 'x.md' })).toEqual([]);
  });

  it('handles CRLF input, normalising line endings and keeping correct line numbers', () => {
    const text = ['# Title', '', 'Body line one.', '', '## Section', '', 'More text.'].join('\r\n');
    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'x.md' });
    expect(chunks.every((c) => !c.text.includes('\r'))).toBe(true);
    expect(chunks.map((c) => c.headingPath)).toEqual(['x.md › Title', 'x.md › Title › Section']);
    expect(chunks[1]).toMatchObject({ lineStart: 5, lineEnd: 7 });
  });
});

describe('htmlToText', () => {
  it('drops script/style/nav/footer/noscript content and converts headings, lists, links', () => {
    const html = `
      <html><head><title>ignored</title></head>
      <body>
        <nav>Site nav links</nav>
        <script>alert('x')</script>
        <style>.a{color:red}</style>
        <h1>Club Handbook</h1>
        <p>Welcome! Read the <a href="https://club.example/rules">rules</a> first.</p>
        <h2>Meetings</h2>
        <ul>
          <li>Mondays at 7pm</li>
          <li>Room 204</li>
        </ul>
        <noscript>Enable JS</noscript>
        <footer>Copyright 2026</footer>
      </body></html>`;
    const text = htmlToText(html);
    expect(text).not.toContain('Site nav links');
    expect(text).not.toContain('alert(');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('Enable JS');
    expect(text).not.toContain('Copyright 2026');
    expect(text).toContain('# Club Handbook');
    expect(text).toContain('## Meetings');
    expect(text).toContain('rules (https://club.example/rules)');
    expect(text).toContain('- Mondays at 7pm');
    expect(text).toContain('- Room 204');
  });

  it('decodes common named and numeric entities', () => {
    const text = htmlToText(
      '<p>Tom &amp; Jerry &lt;3 &quot;friends&quot; &#39;forever&#39;&nbsp;&#65;&#x42;</p>',
    );
    expect(text).toContain('Tom & Jerry <3 "friends" \'forever\' AB');
  });

  it('turns <br>, <p> and <div> into line breaks', () => {
    const text = htmlToText('<div>First</div><p>Second<br>Third</p>');
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    expect(lines).toEqual(['First', 'Second', 'Third']);
  });
});

describe('chunkDocument — long documents keep structure', () => {
  it('keeps short heading paths and no lost text for a 60-section document', () => {
    const lines: string[] = ['# Title', ''];
    for (let n = 1; n <= 60; n++) {
      lines.push(`## Section ${n}`, '');
      lines.push(`Section ${n} explains the club policy in detail for members. `.repeat(12));
      lines.push('');
    }
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(8_000);

    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'doc.md' });
    expect(chunks.map((c) => c.headingPath)).toContain('doc.md › Title › Section 7');
    for (const chunk of chunks) expect(chunk.headingPath.length).toBeLessThanOrEqual(60);
    const joined = chunks.map((c) => c.text).join('\n');
    expect(joined).toContain(
      `Section 60 explains the club policy in detail for members. `.repeat(12),
    );
  });

  it('clips a heading line longer than 120 characters to exactly 120 ending in …', () => {
    const text = [`# ${'A'.repeat(200)}`, '', 'Body.'].join('\n');
    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'doc.md' });
    const segment = chunks[0]!.headingPath.split(' › ')[1]!;
    expect(segment).toHaveLength(120);
    expect(segment.endsWith('…')).toBe(true);
  });
});

describe('clipHeading', () => {
  it('leaves short text alone and clips long text with an ellipsis', () => {
    expect(clipHeading('abc', 120)).toBe('abc');
    const clipped = clipHeading('x'.repeat(200), 50);
    expect(clipped).toHaveLength(50);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('never cuts an emoji in half', () => {
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
    for (const max of [119, 120, 121]) {
      const clipped = clipHeading('🚗'.repeat(70), max);
      expect(clipped.length).toBeLessThanOrEqual(max);
      expect(clipped.endsWith('…')).toBe(true);
      expect(loneSurrogate.test(clipped)).toBe(false);
    }
  });
});

describe('chunkDocument — fenced code blocks', () => {
  it('treats # lines inside a ``` fence as content, not headings', () => {
    const text = [
      '# Setup',
      '```bash',
      '# Load module into kernel',
      'sudo insmod x.ko',
      '```',
      '## Usage',
      'run it',
    ].join('\n');
    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'README.md' });
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'README.md › Setup',
      'README.md › Setup › Usage',
    ]);
    expect(chunks[0]!.text).toContain('# Load module into kernel');
  });

  it('treats # lines inside a ~~~ fence as content, not headings', () => {
    const text = [
      '# Guide',
      '~~~python',
      '# a comment, not a heading',
      'print("hi")',
      '~~~',
      '## Next',
      'after',
    ].join('\n');
    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'guide.md' });
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'guide.md › Guide',
      'guide.md › Guide › Next',
    ]);
    expect(chunks[0]!.text).toContain('# a comment, not a heading');
  });

  it('treats an unclosed fence as running to the end of the document', () => {
    const text = ['# Top', '```', '# not a heading', 'more'].join('\n');
    const chunks = chunkDocument({ text, mediaType: 'text/markdown', path: 'notes.md' });
    expect(chunks.map((c) => c.headingPath)).toEqual(['notes.md › Top']);
    expect(chunks[0]!.text).toContain('# not a heading');
  });
});

describe('chunkDocument — cached HTML evidence', () => {
  it('reduces fetched HTML to useful page text', () => {
    const html = `<!doctype html><html><head><title>Handbook</title><style>body{color:red}</style></head><body><h1>Club handbook</h1><script>steal()</script><p>Batteries must be &lt;approved&gt;.</p></body></html>`;
    const chunks = chunkDocument({ text: html, mediaType: 'text/html', path: 'page.html' });
    const joined = chunks.map((c) => c.text).join('\n');
    expect(joined).toContain('Club handbook');
    expect(joined).toContain('Batteries must be <approved>.');
    expect(joined).not.toContain('steal');
    expect(joined).not.toContain('color:red');
    expect(joined).not.toContain('<title>');
    for (const chunk of chunks) expect(chunk.text.startsWith('Handbook')).toBe(false);
    expect(chunks[0]!.headingPath).toBe('page.html › Club handbook');
  });
});

describe('htmlToText — head, header and svg', () => {
  it('keeps <header> content even though <head> is dropped', () => {
    const text = htmlToText('<header><h1>Site</h1></header><p>Body text</p>');
    expect(text).toContain('Site');
    expect(text).toContain('Body text');
  });

  it('drops inline SVG content', () => {
    const text = htmlToText('<svg><text>logo</text></svg><p>Hi</p>');
    expect(text).not.toContain('logo');
    expect(text).toContain('Hi');
  });
});
