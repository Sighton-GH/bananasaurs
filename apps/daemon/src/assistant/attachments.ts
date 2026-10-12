import { redactEvidenceText, neutraliseMarkers } from '@bananasaurs/core';

export const ATTACHMENT_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'] as const;

export interface AttachmentSource {
  readonly fileName: string;
  readonly contentType?: string | undefined;
  readonly sizeBytes: number;
  readonly url?: string | undefined;
}

export type AttachmentKind = 'text' | 'image' | 'pdf' | 'unsupported';

export interface AttachmentCaps {
  readonly textMaxBytes: number;
  readonly textMaxChars: number;
  readonly textMaxCount: number;
  readonly imageMaxBytes: number;
  readonly imageMaxCount: number;
  readonly pdfMaxBytes: number;
  readonly pdfMaxCount: number;
}

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.js',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.css',
  '.html',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.log',
  '.csv',
  '.sh',
]);

/** Pre-fetch guess from the declared type, falling back to the file extension (ADR 0149). */
export const classifyAttachment = (source: AttachmentSource): AttachmentKind => {
  const type = (source.contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  const dot = source.fileName.lastIndexOf('.');
  const ext = dot === -1 ? '' : source.fileName.slice(dot).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif')
    return 'image';
  return 'unsupported';
};

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((b, i) => bytes[i] === b);

/** Magic-byte check on fetched bytes (ADR 0149). `animated-gif` (NETSCAPE2.0) is refused, not sent. */
export const sniffMediaKind = (
  bytes: Uint8Array,
): 'image' | 'pdf' | 'text' | 'animated-gif' | 'unknown' => {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image';
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return Buffer.from(bytes).includes('NETSCAPE2.0', 0, 'latin1') ? 'animated-gif' : 'image';
  }
  return 'unknown';
};

/** The MIME type we send on, taken from validated magic bytes and never from the HTTP header. */
const mimeFromMagic = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) return 'image/webp';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  return undefined;
};

export const textEnvelopeFor = (name: string, text: string): string => {
  const clean = neutraliseMarkers(redactEvidenceText(text).text);
  return `[UNTRUSTED ATTACHMENT name=${JSON.stringify(neutraliseMarkers(name))}]\n${clean}\n[/UNTRUSTED ATTACHMENT]`;
};

export type AttachmentFetchResult =
  | { readonly ok: true; readonly kind: 'text'; readonly name: string; readonly text: string }
  | {
      readonly ok: true;
      readonly kind: 'image' | 'pdf';
      readonly name: string;
      readonly mediaType: string;
      readonly dataBase64: string;
      readonly sizeBytes: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'missing-url'
        | 'bad-host'
        | 'too-large'
        | 'bad-magic'
        | 'fetch-failed'
        | 'animated'
        | 'unsupported';
      readonly note: string;
    };

/** One attachment end to end: declared-size cap first, host check, fetch, magic check (ADR 0149, refusal-first). */
export const fetchAttachment = async (
  deps: {
    readonly fetchBytes: (
      url: string,
      maxBytes: number,
    ) => Promise<
      | { readonly ok: true; readonly bytes: Uint8Array; readonly mediaType: string }
      | { readonly ok: false; readonly code: string }
    >;
  },
  source: AttachmentSource,
  caps: AttachmentCaps,
): Promise<AttachmentFetchResult> => {
  const kind = classifyAttachment(source);
  if (kind === 'unsupported')
    return {
      ok: false,
      code: 'unsupported',
      note: `${source.fileName} is not a text file, image or PDF.`,
    };
  const maxBytes =
    kind === 'text' ? caps.textMaxBytes : kind === 'image' ? caps.imageMaxBytes : caps.pdfMaxBytes;
  if (source.sizeBytes > maxBytes)
    return { ok: false, code: 'too-large', note: `${source.fileName} is over the size limit.` };
  if (source.url === undefined || source.url === '')
    return { ok: false, code: 'missing-url', note: `${source.fileName} has no download link.` };
  let parsed: URL;
  let host: string;
  try {
    parsed = new URL(source.url);
    host = parsed.hostname.toLowerCase();
  } catch {
    return { ok: false, code: 'bad-host', note: `${source.fileName} has no valid download link.` };
  }
  if (parsed.port !== '' && parsed.port !== '443')
    return {
      ok: false,
      code: 'bad-host',
      note: `${source.fileName} is not on the attachment host.`,
    };
  if (!ATTACHMENT_HOSTS.some((h) => host === h))
    return {
      ok: false,
      code: 'bad-host',
      note: `${source.fileName} is not on the attachment host.`,
    };
  const fetched = await deps.fetchBytes(source.url, maxBytes);
  if (!fetched.ok)
    return { ok: false, code: 'fetch-failed', note: `${source.fileName} could not be downloaded.` };
  if (kind === 'image' || kind === 'pdf') {
    const sniffed = sniffMediaKind(fetched.bytes);
    if (sniffed === 'animated-gif')
      return { ok: false, code: 'animated', note: `${source.fileName} is an animated image.` };
    if ((kind === 'image' && sniffed !== 'image') || (kind === 'pdf' && sniffed !== 'pdf'))
      return {
        ok: false,
        code: 'bad-magic',
        note: `${source.fileName} is not the file type it claims to be.`,
      };
    return {
      ok: true,
      kind,
      name: source.fileName,
      mediaType: mimeFromMagic(fetched.bytes) ?? 'application/octet-stream',
      dataBase64: Buffer.from(fetched.bytes).toString('base64'),
      sizeBytes: fetched.bytes.byteLength,
    };
  }
  const text = Buffer.from(fetched.bytes).toString('utf8').replaceAll('\u0000', '');
  return { ok: true, kind: 'text', name: source.fileName, text };
};
