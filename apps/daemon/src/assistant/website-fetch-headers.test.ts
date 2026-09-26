import { describe, expect, it } from 'vitest';
import type { InstanceSettingsStore } from '../settings/instance-settings-store.js';
import { websiteFetchHeaders } from './website-fetch-headers.js';

const settings = (over: {
  readonly name?: string | null;
  readonly value?: string | null;
  readonly hosts?: string[];
}): Pick<InstanceSettingsStore, 'get'> => {
  const get = (key: string): string | string[] | null => {
    if (key === 'resources.fetchHeaderName') return over.name ?? null;
    if (key === 'resources.fetchHeaderValue') return over.value ?? null;
    if (key === 'resources.fetchHeaderHosts') return over.hosts ?? [];
    throw new Error(`unexpected key ${key}`);
  };
  return { get: get as InstanceSettingsStore['get'] };
};

describe('websiteFetchHeaders', () => {
  it('returns the header for a listed host', () => {
    const forHost = websiteFetchHeaders(
      settings({ name: 'X-Bananasaurs-Fetch', value: 'tok', hosts: ['example.com'] }),
    );
    expect(forHost('example.com')).toEqual({ 'x-bananasaurs-fetch': 'tok' });
  });

  it('matches the host case-insensitively', () => {
    const forHost = websiteFetchHeaders(
      settings({ name: 'X-Fetch', value: 'tok', hosts: ['example.com'] }),
    );
    expect(forHost('Example.COM')).toEqual({ 'x-fetch': 'tok' });
  });

  it('returns undefined for a host that is not listed', () => {
    const forHost = websiteFetchHeaders(
      settings({ name: 'X-Fetch', value: 'tok', hosts: ['example.com'] }),
    );
    expect(forHost('other.com')).toBeUndefined();
  });

  it('returns undefined when the name is null', () => {
    const forHost = websiteFetchHeaders(
      settings({ name: null, value: 'tok', hosts: ['example.com'] }),
    );
    expect(forHost('example.com')).toBeUndefined();
  });

  it('returns undefined when the value is null', () => {
    const forHost = websiteFetchHeaders(
      settings({ name: 'X-Fetch', value: null, hosts: ['example.com'] }),
    );
    expect(forHost('example.com')).toBeUndefined();
  });

  it('returns undefined when the host list is empty', () => {
    const forHost = websiteFetchHeaders(settings({ name: 'X-Fetch', value: 'tok', hosts: [] }));
    expect(forHost('example.com')).toBeUndefined();
  });
});
