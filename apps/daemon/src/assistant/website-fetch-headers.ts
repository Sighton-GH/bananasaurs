import type { InstanceSettingsStore } from '../settings/instance-settings-store.js';

/**
 * The owner's Cloudflare-allow header for a host, or undefined.
 *
 * Only when the header name, the sealed value and a matching host allowlist
 * entry are all set — and only for a listed host (compared lower-cased, as
 * stored). The value travels only into the website fetcher's request headers:
 * never into logs, responses or stored rows.
 */
export const websiteFetchHeaders =
  (settings: Pick<InstanceSettingsStore, 'get'>) =>
  (host: string): Readonly<Record<string, string>> | undefined => {
    const name = settings.get('resources.fetchHeaderName');
    const value = settings.get('resources.fetchHeaderValue');
    const hosts = settings.get('resources.fetchHeaderHosts');
    return name !== null && value !== null && hosts.includes(host.toLowerCase())
      ? { [name.toLowerCase()]: value }
      : undefined;
  };
