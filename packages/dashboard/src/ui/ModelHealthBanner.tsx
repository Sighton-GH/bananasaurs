import { useCallback, type JSX } from 'react';
import { Link } from 'wouter';
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

/** One line per stuck model; the link to the editor follows the list, once. */
function PersistentLine({ model }: { readonly model: ModelHealth | DashboardModelHealth }) {
  const persistent = model.persistent;
  if (persistent === undefined) return null;
  return (
    <li>
      <strong className="font-mono text-xs">{model.model}</strong> has failed {persistent.count}{' '}
      times in a row since {new Date(persistent.since).toLocaleString()} —{' '}
      {failureTitle(persistent.code)}.
    </li>
  );
}

/** ADR 0129 §8: site-wide warning for models that keep failing the same non-transient way. */
export function ModelHealthBanner(): JSX.Element | null {
  const session = useSession();
  const load = useCallback(
    () => session.read<ModelHealthResponse>(modelHealthUrl('24h')),
    [session],
  );
  // The banner learns access from the response: a 403 or any other error
  // leaves the resource in `error`, which renders nothing — the banner is
  // never itself an error.
  const live = useLiveResource<ModelHealthResponse>('model health', load, {
    fastMs: 60000,
    slowMs: 60000,
    isFast: () => false,
  });
  if (live.resource.state !== 'ready') return null;
  // ADR 0129: warn only about persistent models still in the current chain.
  // A missing `inChain` (older responses) counts as in the chain.
  const persistent = live.resource.data.models.filter(
    (m) => m.persistent !== undefined && m.inChain !== false,
  );
  if (persistent.length === 0) return null;
  return (
    <section
      aria-label="Model health warning"
      className="mb-4 rounded border border-danger/40 bg-danger/5 p-3"
    >
      <ul className="grid gap-1 text-sm">
        {persistent.map((m) => (
          <PersistentLine key={`${m.keyId} ${m.model}`} model={m} />
        ))}
      </ul>
      <Link href="/assistant/setup" className="mt-1 inline-block text-sm font-medium underline">
        Open Model order
      </Link>
    </section>
  );
}
