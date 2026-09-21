import { isIP } from 'node:net';

export interface ClubResource {
  readonly id: string;
  readonly guildId: string;
  readonly title: string;
  readonly url: string;
  readonly kind: 'website' | 'document' | 'discord-channel' | 'repository' | 'note';
  readonly enabled: boolean;
  readonly reviewedAt: string;
  readonly lastFetchedAt?: number;
  readonly fetchStatus?: 'pending' | 'ok' | 'failed' | 'blocked';
  readonly fetchDetail?: string;
}

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
 */
const ipv6Bytes = (addr: string): readonly number[] | undefined => {
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
    // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) embed an IPv4
    // target the IPv4 rules already classify; an unmapped literal like
    // https://[::ffff:127.0.0.1]/ sailed through before (review round 2).
    const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
    const nat64 =
      v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b &&
      v6.slice(4, 12).every((b) => b === 0);
    if (mapped || nat64) return privateV4(v6[12]!, v6[13]!);
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
