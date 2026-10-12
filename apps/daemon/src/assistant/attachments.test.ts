import { describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_HOSTS,
  classifyAttachment,
  fetchAttachment,
  sniffMediaKind,
  textEnvelopeFor,
} from './attachments.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const webp = new Uint8Array([...Buffer.from('RIFF....WEBP', 'utf8')]);
const gifStatic = new Uint8Array([...Buffer.from('GIF89a', 'utf8'), 1, 2, 3]);
const gifAnimated = new Uint8Array([...Buffer.from('GIF89aNETSCAPE2.0', 'utf8')]);
const pdf = new Uint8Array([...Buffer.from('%PDF-1.7', 'utf8')]);

describe('attachment classification and sniffing (ADR 0149)', () => {
  it('classifies by content type first, then extension', () => {
    expect(classifyAttachment({ fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 1 })).toBe(
      'text',
    );
    expect(classifyAttachment({ fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 })).toBe(
      'image',
    );
    expect(
      classifyAttachment({ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 }),
    ).toBe('pdf');
    expect(
      classifyAttachment({
        fileName: 'main.ts',
        contentType: 'application/octet-stream',
        sizeBytes: 1,
      }),
    ).toBe('text');
    expect(
      classifyAttachment({
        fileName: 'run.exe',
        contentType: 'application/octet-stream',
        sizeBytes: 1,
      }),
    ).toBe('unsupported');
    expect(
      classifyAttachment({ fileName: 'clip.mp4', contentType: 'video/mp4', sizeBytes: 1 }),
    ).toBe('unsupported');
  });

  it('sniffs magic bytes and spots animated GIFs', () => {
    expect(sniffMediaKind(png)).toBe('image');
    expect(sniffMediaKind(jpeg)).toBe('image');
    expect(sniffMediaKind(webp)).toBe('image');
    expect(sniffMediaKind(gifStatic)).toBe('image');
    expect(sniffMediaKind(gifAnimated)).toBe('animated-gif');
    expect(sniffMediaKind(pdf)).toBe('pdf');
    expect(sniffMediaKind(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe('unknown');
  });

  it('refuses oversize on the declared size before fetching', async () => {
    const fetchBytes = vi.fn(async () => ({
      ok: true as const,
      bytes: new Uint8Array(),
      mediaType: 'image/png',
    }));
    const result = await fetchAttachment(
      { fetchBytes },
      { fileName: 'big.png', contentType: 'image/png', sizeBytes: 6_000_000 },
      {
        textMaxBytes: 262_144,
        textMaxChars: 24_000,
        textMaxCount: 3,
        imageMaxBytes: 5_242_880,
        imageMaxCount: 4,
        pdfMaxBytes: 10_485_760,
        pdfMaxCount: 2,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'too-large' });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('refuses a missing url and an off-allowlist url without fetching', async () => {
    const fetchBytes = vi.fn(async () => ({
      ok: true as const,
      bytes: new Uint8Array(),
      mediaType: 'text/plain',
    }));
    const caps = {
      textMaxBytes: 262_144,
      textMaxChars: 24_000,
      textMaxCount: 3,
      imageMaxBytes: 5_242_880,
      imageMaxCount: 4,
      pdfMaxBytes: 10_485_760,
      pdfMaxCount: 2,
    };
    expect(
      await fetchAttachment({ fetchBytes }, { fileName: 'a.txt', sizeBytes: 10 }, caps),
    ).toMatchObject({ ok: false, code: 'missing-url' });
    expect(
      await fetchAttachment(
        { fetchBytes },
        { fileName: 'a.txt', sizeBytes: 10, url: 'https://evil.example/a.txt' },
        caps,
      ),
    ).toMatchObject({ ok: false, code: 'bad-host' });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('refuses a wrong magic number after fetching', async () => {
    const fetchBytes = vi.fn(async () => ({
      ok: true as const,
      bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
      mediaType: 'image/png',
    }));
    const result = await fetchAttachment(
      { fetchBytes },
      {
        fileName: 'fake.png',
        contentType: 'image/png',
        sizeBytes: 4,
        url: 'https://cdn.discordapp.com/attachments/1/2/fake.png',
      },
      {
        textMaxBytes: 262_144,
        textMaxChars: 24_000,
        textMaxCount: 3,
        imageMaxBytes: 5_242_880,
        imageMaxCount: 4,
        pdfMaxBytes: 10_485_760,
        pdfMaxCount: 2,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'bad-magic' });
  });

  it('frames text as untrusted evidence', () => {
    expect(textEnvelopeFor('message.txt', 'hello sam@example.com')).toContain(
      '[UNTRUSTED ATTACHMENT name="message.txt"]',
    );
    expect(textEnvelopeFor('message.txt', 'hello sam@example.com')).toContain(
      '[redacted by the evidence safety filter]',
    );
    expect(textEnvelopeFor('message.txt', 'hi')).toContain('[/UNTRUSTED ATTACHMENT]');
  });

  it('pins the CDN allowlist', () => {
    expect([...ATTACHMENT_HOSTS]).toEqual(['cdn.discordapp.com', 'media.discordapp.net']);
  });

  const caps = {
    textMaxBytes: 262_144,
    textMaxChars: 24_000,
    textMaxCount: 3,
    imageMaxBytes: 5_242_880,
    imageMaxCount: 4,
    pdfMaxBytes: 10_485_760,
    pdfMaxCount: 2,
  };
  const cdn = 'https://cdn.discordapp.com/attachments/1/2/';

  it('refuses a non-443 port before fetching', async () => {
    const fetchBytes = vi.fn(async () => ({
      ok: true as const,
      bytes: png,
      mediaType: 'image/png',
    }));
    const result = await fetchAttachment(
      { fetchBytes },
      {
        fileName: 'a.png',
        contentType: 'image/png',
        sizeBytes: 9,
        url: 'https://cdn.discordapp.com:8443/a.png',
      },
      caps,
    );
    expect(result).toMatchObject({ ok: false, code: 'bad-host' });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('finds NETSCAPE2.0 anywhere in the body of a 256-colour GIF', async () => {
    const big = new Uint8Array([
      ...Buffer.from('GIF89a', 'utf8'),
      ...new Uint8Array(7 + 768),
      ...Buffer.from('!\u00ff\u000bNETSCAPE2.0', 'latin1'),
    ]);
    expect(big.length).toBeGreaterThan(781);
    expect(sniffMediaKind(big)).toBe('animated-gif');
    const fetchBytes = vi.fn(async () => ({
      ok: true as const,
      bytes: big,
      mediaType: 'image/gif',
    }));
    const result = await fetchAttachment(
      { fetchBytes },
      { fileName: 'a.gif', contentType: 'image/gif', sizeBytes: big.length, url: `${cdn}a.gif` },
      caps,
    );
    expect(result).toMatchObject({ ok: false, code: 'animated' });
  });

  it.each(['text/html', 'application/octet-stream', ''])(
    'takes the image MIME from the magic bytes, not the header %j',
    async (header) => {
      const fetchBytes = vi.fn(async () => ({ ok: true as const, bytes: png, mediaType: header }));
      const result = await fetchAttachment(
        { fetchBytes },
        { fileName: 'a.png', contentType: 'image/png', sizeBytes: 9, url: `${cdn}a.png` },
        caps,
      );
      expect(result).toMatchObject({ ok: true, kind: 'image', mediaType: 'image/png' });
    },
  );

  it('maps each validated kind to its own MIME type', async () => {
    const cases: Array<[Uint8Array, string, string]> = [
      [jpeg, 'a.jpg', 'image/jpeg'],
      [webp, 'a.webp', 'image/webp'],
      [gifStatic, 'a.gif', 'image/gif'],
      [pdf, 'a.pdf', 'application/pdf'],
    ];
    for (const [bytes, name, mime] of cases) {
      const fetchBytes = vi.fn(async () => ({ ok: true as const, bytes, mediaType: 'text/html' }));
      const result = await fetchAttachment(
        { fetchBytes },
        { fileName: name, sizeBytes: bytes.length, url: `${cdn}${name}` },
        caps,
      );
      expect(result).toMatchObject({ ok: true, mediaType: mime });
    }
  });
});

describe('fetchAttachment forceKind (ADR 0149)', () => {
  it('forceKind reads an embed thumbnail with no usable filename (ADR 0149)', async () => {
    const fetchBytes = vi.fn(async () => ({
      ok: true as const,
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mediaType: 'image/png',
    }));
    const caps = {
      textMaxBytes: 262_144,
      textMaxChars: 24_000,
      textMaxCount: 3,
      imageMaxBytes: 5_242_880,
      imageMaxCount: 4,
      pdfMaxBytes: 10_485_760,
      pdfMaxCount: 2,
    };
    const result = await fetchAttachment(
      { fetchBytes },
      { fileName: 'embed thumbnail', sizeBytes: 8, url: 'https://media.discordapp.net/thumb.png' },
      caps,
      'image',
    );
    expect(result).toMatchObject({ ok: true, kind: 'image' });
  });
});
