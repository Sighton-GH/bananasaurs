import { useCallback, type JSX } from 'react';
import { PROVIDER_FAILURE_TEXT, type FailureText, type ModelHealth } from '@bananasaurs/core';
import {
  modelHealthUrl,
  type DashboardModelHealth,
  type ModelHealthResponse,
} from '../api/model-health.js';
import { useSession } from '../app/session.js';
import { useLiveResource } from '../hooks/useLiveResource.js';

const failureTitle = (code: string): string =>
  (PROVIDER_FAILURE_TEXT as Readonly<Record<string, FailureText | undefined>>)[code]?.title ?? code;

export interface ModelHealthWarnings {
  /** ADR 0129: persistent models still in the current chain, one entry per key and model. */
  readonly models: readonly DashboardModelHealth[];
  /** The distinct model names behind `models`, in response order. */
  readonly failingModels: readonly string[];
}

const NONE: ModelHealthWarnings = { models: [], failingModels: [] };

/**
 * ADR 0129 §8: models that keep failing the same non-transient way. The
 * system banner turns the names into one cause and shows the streak lines in
 * that cause's details. The hook never surfaces an error itself: a 403 or
 * any other failure leaves the resource in `error`, which yields no warning.
 */
export function useModelHealthWarnings(): ModelHealthWarnings {
  const session = useSession();
  const load = useCallback(
    () => session.read<ModelHealthResponse>(modelHealthUrl('24h')),
    [session],
  );
  const live = useLiveResource<ModelHealthResponse>('model health', load, {
    fastMs: 60000,
    slowMs: 60000,
    isFast: () => false,
  });
  if (live.resource.state !== 'ready') return NONE;
  // A missing `inChain` (older responses) counts as in the chain.
  const models = live.resource.data.models.filter(
    (m) => m.persistent !== undefined && m.inChain !== false,
  );
  if (models.length === 0) return NONE;
  return { models, failingModels: [...new Set(models.map((m) => m.model))] };
}

/** One line per stuck model: its streak, since when, and the failure. */
function PersistentLine({ model }: { readonly model: ModelHealth | DashboardModelHealth }) {
  const persistent = model.persistent;
  if (persistent === undefined) return null;
  return (
    <li>
      <strong className="font-mono text-xs break-all">{model.model}</strong> has failed{' '}
      {persistent.count} times in a row since {new Date(persistent.since).toLocaleString()} —{' '}
      {failureTitle(persistent.code)}.
    </li>
  );
}

/** The streak lines, rendered inside the models cause of the system banner. */
export function ModelHealthLines({
  models,
}: {
  readonly models: readonly DashboardModelHealth[];
}): JSX.Element | null {
  if (models.length === 0) return null;
  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer">Model details</summary>
      <ul className="mt-1 grid min-w-0 gap-1 break-words">
        {models.map((m) => (
          <PersistentLine key={`${m.keyId} ${m.model}`} model={m} />
        ))}
      </ul>
    </details>
  );
}
