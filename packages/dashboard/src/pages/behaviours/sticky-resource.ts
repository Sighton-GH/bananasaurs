import { useRef } from 'react';
import type { Resource } from '../../hooks/useResource.js';

/** Data stamped with the identity (account + guild) it was loaded under. */
export interface Tagged<T> {
  readonly identity: string;
  readonly data: T;
}

/**
 * After a successful load, a reload shows the previous data instead of
 * dropping back to the loading state. `useResource` flips to `loading` on
 * every reload, which would unmount the page body and discard drafts, a
 * pending write's result and a Try answer.
 *
 * The data belongs to the identity it was loaded under (stamped by the
 * loader, because `useResource` still reports the old result for one render
 * after the session changes). Data stamped with another identity is treated
 * as loading, never shown, so a guild switch or session rebuild cannot present
 * the previous guild's behaviours as ready or give a write a stale target. An
 * error forgets the remembered data, so a retry after a 403 or failure is
 * loading, not stale data presented as current. The first load still shows
 * loading.
 */
export function useStickyResource<T>(resource: Resource<Tagged<T>>, identity: string): Resource<T> {
  const last = useRef<Tagged<T> | undefined>(undefined);
  if (last.current !== undefined && last.current.identity !== identity) last.current = undefined;
  if (resource.state === 'ready' && resource.data.identity === identity) {
    last.current = resource.data;
    return { state: 'ready', data: resource.data.data };
  }
  if (resource.state === 'error') {
    last.current = undefined;
    return resource;
  }
  if (last.current !== undefined) return { state: 'ready', data: last.current.data };
  return {
    state: 'loading',
    ...(resource.state === 'loading' && resource.retry ? { retry: resource.retry } : {}),
  };
}
