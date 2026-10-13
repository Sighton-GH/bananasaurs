import type { ClubResource } from '@bananasaurs/core';
import { type ResourceFreshnessRow } from '../../api/assistant.js';
import { Badge } from '../../ui/Badge.js';

export const KINDS = ['website', 'document', 'discord-channel', 'repository', 'note'] as const;

/** `bytes` as a short human size — mirrors `backups.tsx`'s own local `formatSize` (not shared: pages here do not import from one another). */
export const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${String(bytes)} B`;
};

type ResourceCacheStatus = 'ready' | 'needs-attention' | 'off';

/**
 * Ready: enabled, cached, and the last refresh succeeded. Off: the operator
 * disabled it (the assistant never reads it, cached or not — a resource with
 * no fetch trouble at all is still "Off" once disabled, not "Ready"). Needs
 * attention: enabled but either never cached yet or its last refresh errored.
 */
export const cacheStatusOf = (
  resource: ClubResource,
  freshness: ResourceFreshnessRow | undefined,
): ResourceCacheStatus => {
  if (!resource.enabled) return 'off';
  if (
    freshness === undefined ||
    freshness.fetchedAt === undefined ||
    freshness.lastError !== undefined
  )
    return 'needs-attention';
  return 'ready';
};

export function StatusPill({ status }: { readonly status: ResourceCacheStatus }) {
  if (status === 'ready')
    return (
      <Badge tone="ok" wrap>
        Ready
      </Badge>
    );
  if (status === 'off')
    return (
      <Badge tone="neutral" wrap>
        Off
      </Badge>
    );
  return (
    <Badge tone="danger" wrap>
      Needs attention
    </Badge>
  );
}
