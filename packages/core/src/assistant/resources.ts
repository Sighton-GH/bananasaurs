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

const privateHost = (host: string): boolean => {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  // WHATWG URL keeps the brackets on an IPv6 hostname ("[::1]"); isIP then
  // returns 0 and the address escaped the private-range checks below only by
  // accident (review finding 6). Strip the brackets before classifying.
  const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (isIP(bare) === 0) return false;
  return (
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|::1$|fc|fd|fe80)/i.test(bare) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(bare)
  );
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
