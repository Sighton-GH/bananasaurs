import { useCallback, useRef } from 'react';
import {
  ASSISTANT_URL,
  RESOURCE_FRESHNESS_URL,
  type AssistantData,
  type ResourceFreshnessResponse,
} from '../../api/assistant.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { DataState } from '../../ui/DataState.js';
import { PageHeader } from '../../ui/PageHeader.js';

import { ResourcesCard } from './list.js';
/**
 * `/assistant/resources`: reviewed sources with scope, freshness and fetch
 * health, plus the add/edit/enable controls (ADR 0060), and the persistent
 * resource cache's per-resource status and manual refresh (ADR 0073).
 */
export function AssistantResourcesPage() {
  const fallbackRef = useRef<HTMLDivElement>(null);
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant resources', load);
  const loadFreshness = useCallback(
    () => session.read<ResourceFreshnessResponse>(RESOURCE_FRESHNESS_URL),
    [session],
  );
  const freshness = useResource('resource cache freshness', loadFreshness);

  const reloadBoth = () => {
    assistant.reload();
    freshness.reload();
  };

  const freshnessRows =
    freshness.resource.state === 'ready' ? freshness.resource.data.freshness : [];
  const githubTokenConfigured =
    freshness.resource.state === 'ready'
      ? freshness.resource.data.githubTokenConfigured
      : undefined;

  return (
    <>
      <div
        ref={fallbackRef}
        tabIndex={-1}
        aria-label="Resources header"
        className="focus-visible:outline-accent"
      >
        <PageHeader
          title="Resources"
          purpose="Reviewed sources the assistant may read, how fresh the cache is, and whether fetching them is working."
        />
      </div>
      <DataState resource={freshness.resource}>{() => null}</DataState>
      <DataState
        resource={assistant.resource}
        isEmpty={(data) => data.resources.length === 0}
        empty={
          <ResourcesCard
            resources={[]}
            freshness={freshnessRows}
            freshnessAvailable={freshness.resource.state === 'ready'}
            githubTokenConfigured={githubTokenConfigured}
            session={session}
            onSaved={reloadBoth}
            onFocusFallback={() => fallbackRef.current?.focus()}
          />
        }
      >
        {(data) => (
          <ResourcesCard
            resources={data.resources}
            freshness={freshnessRows}
            freshnessAvailable={freshness.resource.state === 'ready'}
            githubTokenConfigured={githubTokenConfigured}
            session={session}
            onSaved={reloadBoth}
            onFocusFallback={() => fallbackRef.current?.focus()}
          />
        )}
      </DataState>
    </>
  );
}
