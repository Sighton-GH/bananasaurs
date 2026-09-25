import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

export type ResourceKind =
  'website' | 'document' | 'discord-channel' | 'repository' | 'note' | 'github-repo' | 'github-org';

export interface ClubResource {
  readonly id: string;
  readonly guildId: string;
  readonly title: string;
  readonly url: string;
  readonly kind: ResourceKind;
  readonly enabled: boolean;
  readonly reviewedAt: string;
  readonly lastFetchedAt?: number;
  readonly fetchStatus?: 'pending' | 'ok' | 'failed' | 'blocked';
  readonly fetchDetail?: string;
  /** The org resource's id, for a `github-repo` discovered from a `github-org`. Absent otherwise. */
  readonly parentId?: string;
  /** GitHub import details, for `github-repo` / `github-org` kinds only. Absent otherwise. */
  readonly meta?: ResourceMeta;
}

/**
 * The `meta_json` payload for `github-repo` / `github-org` resources
 * (Task 17, ADR 0073): which owner/repo/branch a resource imports, the glob
 * `include` filter for a repo (absent means the default file selection), and
 * the org import toggles. Stored as JSON text; parsed on read with
 * `parseResourceMeta` — anything corrupt or schema-invalid reads as
 * `undefined`, never throws.
 */
export const resourceMetaSchema = z
  .object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(200).optional(),
    branch: z.string().min(1).max(200).optional(),
    include: z.array(z.string().min(1).max(300)).max(40).optional(),
    autoDiscovered: z.boolean().optional(),
    includeForks: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();

export type ResourceMeta = z.infer<typeof resourceMetaSchema>;

export const parseResourceMeta = (raw: string | null | undefined): ResourceMeta | undefined => {
  if (raw === null || raw === undefined) return undefined;
  try {
    const parsed = resourceMetaSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The resource id for an imported GitHub organisation (Task 17): short and
 * readable (`gh-acme`), derived from the owner handle alone so re-importing
 * the same org lands on the same row.
 */
export const githubOrgId = (owner: string): string => `gh-${owner.toLowerCase()}`;

const slugPart = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

/**
 * The resource id for a `github-repo` child of an org import (Task 17):
 * readable while it fits (`gh-acme-widget`), otherwise truncated with a
 * content hash suffix so it stays deterministic and within the 64-character
 * resource id limit. Distinct repos always give distinct ids.
 */
export const githubChildId = (owner: string, repo: string): string => {
  const plain = `gh-${slugPart(owner)}-${slugPart(repo)}`;
  if (plain.length <= 64) return plain;
  const hash = createHash('sha256').update(`${owner}/${repo}`, 'utf8').digest('hex').slice(0, 8);
  return `gh-${`${slugPart(owner)}-${slugPart(repo)}`.slice(0, 48)}-${hash}`;
};

const privateV4 = (a: number, b: number): boolean =>
  a === 127 ||
  a === 10 ||
  a === 0 ||
  (a === 169 && b === 254) ||
  (a === 192 && b === 168) ||
  (a === 172 && b >= 16 && b <= 31);

/**
 * Expands an IPv6 address to its 16 bytes, handling '::' compression and an
 * embedded dotted-quad tail. `undefined` when the input is not IPv6.
 *
 * Exported for the fetcher's DNS-answer boundary: a resolver can return the
 * same private target in expanded or hex form (`0:0:0:0:0:ffff:7f00:1`,
 * `::ffff:7f00:1`, `64:ff9b::7f00:1`), and only a byte-level read classifies
 * them all (round-2 audit).
 */
export const ipv6Bytes = (addr: string): readonly number[] | undefined => {
  if (isIP(addr) !== 6) return undefined;
  // An embedded dotted quad contributes its four bytes as the last two groups.
  let hex = addr;
  let tailBytes: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted !== null) {
    tailBytes = dotted[1]!.split('.').map(Number);
    hex = addr.slice(0, dotted.index).replace(/:$/, '');
    if (hex.endsWith(':')) hex = hex.slice(0, -1);
  }
  const halves = hex.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : [];
  const groupsNeeded = 8 - Math.ceil(tailBytes.length / 2);
  if (head.length + tail.length > groupsNeeded) return undefined;
  const missing = groupsNeeded - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  const groups = [...head, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tail];
  if (groups.length !== 8 - Math.ceil(tailBytes.length / 2)) return undefined;
  const bytes: number[] = [];
  for (const group of groups) {
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return [...bytes, ...tailBytes];
};

/**
 * The IPv4 target embedded in an IPv4-mapped (::ffff:0:0/96) or NAT64
 * (64:ff9b::/96) address, as dotted-quad text; `undefined` for any other
 * address. Byte-level, so expanded and hex-tail forms cannot slip past.
 */
export const embeddedIpv4 = (v6: readonly number[]): string | undefined => {
  if (v6.length !== 16) return undefined;
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  const nat64 =
    v6[0] === 0x00 &&
    v6[1] === 0x64 &&
    v6[2] === 0xff &&
    v6[3] === 0x9b &&
    v6.slice(4, 12).every((b) => b === 0);
  if (!mapped && !nat64) return undefined;
  return `${String(v6[12])}.${String(v6[13])}.${String(v6[14])}.${String(v6[15])}`;
};

const privateHost = (host: string): boolean => {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  // WHATWG URL keeps the brackets on an IPv6 hostname ("[::1]"); isIP then
  // returns 0 and the address escaped the private-range checks below only by
  // accident (review finding 6). Strip the brackets before classifying.
  const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (isIP(bare) === 0) return false;
  const v6 = ipv6Bytes(bare);
  if (v6 !== undefined) {
    // IPv4-mapped and NAT64 addresses embed an IPv4 target the IPv4 rules
    // already classify; an unmapped literal like https://[::ffff:127.0.0.1]/
    // sailed through before (review round 2).
    const embedded = embeddedIpv4(v6);
    if (embedded !== undefined) {
      const [a, b] = embedded.split('.').map(Number);
      return privateV4(a!, b!);
    }
    return (
      v6.every((b, i) => (i < 15 ? b === 0 : b === 1)) || // ::1
      (v6[0]! & 0xfe) === 0xfc || // fc00::/7 (ULA: fc..fd)
      (v6[0] === 0xfe && (v6[1]! & 0xc0) === 0x80) // fe80::/10 link-local
    );
  }
  const octets = bare.split('.').map(Number);
  return privateV4(octets[0]!, octets[1]!);
};

/** First SSRF boundary. The fetcher must additionally pin public DNS results through the request. */
export const validateResourceUrl = (raw: string): URL => {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('club resources must use HTTPS');
  if (url.username !== '' || url.password !== '')
    throw new Error('resource URL credentials are not allowed');
  if (privateHost(url.hostname))
    throw new Error('private and local resource hosts are not allowed');
  return url;
};

export const enabledResourcesForGuild = (
  resources: readonly ClubResource[],
  guildId: string,
  ids: readonly string[],
): readonly ClubResource[] =>
  resources.filter(
    (resource) => resource.guildId === guildId && resource.enabled && ids.includes(resource.id),
  );

/** The per-resource evidence cap: enough for a handbook page, small enough
 * that one bloated page cannot crowd the model's whole context. */
export const EVIDENCE_TEXT_MAX_CHARS = 8_000;

const HTML_ENTITIES: readonly [RegExp, string][] = [
  [/&amp;/gu, '&'],
  [/&lt;/gu, '<'],
  [/&gt;/gu, '>'],
  [/&quot;/gu, '"'],
  [/&#39;|&apos;/gu, "'"],
  [/&#x([0-9a-f]+);/giu, ' '],
  [/&#(\d+);/gu, ' '],
  [/&nbsp;/gu, ' '],
];

/**
 * Turns a fetched body into useful evidence text (should-fix, round 2).
 *
 * Raw HTML was handed to the model as-is and truncated at the byte cap,
 * which meant the evidence was mostly <head> markup and the page's actual
 * content never arrived. HTML is reduced to its visible text: scripts,
 * styles and tags removed, common entities decoded, whitespace collapsed.
 * Plain text, markdown and JSON pass through unchanged. Anything longer
 * than the cap is cut at a word boundary and says so.
 */
export const extractEvidenceText = (mediaType: string, raw: string): string => {
  let text = raw;
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    text = text
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, ' ')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/giu, ' ')
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<[^>]+>/gu, ' ');
    for (const [pattern, replacement] of HTML_ENTITIES) text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/gu, ' ').trim();
  if (text.length <= EVIDENCE_TEXT_MAX_CHARS) return text;
  const cut = text.slice(0, EVIDENCE_TEXT_MAX_CHARS);
  const boundary = cut.lastIndexOf(' ');
  return `${cut.slice(0, boundary > EVIDENCE_TEXT_MAX_CHARS - 200 ? boundary : undefined)}… (truncated at ${EVIDENCE_TEXT_MAX_CHARS.toLocaleString('en-CA')} characters)`;
};
