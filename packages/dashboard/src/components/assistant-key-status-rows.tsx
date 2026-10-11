import { useCallback } from 'react';
import type { KeyCooling, SetupChainRow, SetupKeyRow } from '../api/assistant.js';
import { modelHealthUrl } from '../api/model-health.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';

const MAY_TRAIN_NOTE =
  'Free Gemini keys: Google may use what you send to improve its models. The key still works.';

interface CoolingResponse {
  readonly models: readonly KeyCooling[];
}

/** Daily requests left for one key: the tightest limit across its chain rows. */
export const remainingToday = (
  keyId: string,
  chain: readonly SetupChainRow[],
): number | undefined => {
  const left = chain
    .filter((row) => row.keyId === keyId && row.rpdLimit !== null)
    .map((row) => Math.max(0, (row.rpdLimit ?? 0) - (row.usage?.today ?? 0)));
  return left.length === 0 ? undefined : Math.min(...left);
};

/** One line per key: what is left today, when it cools off, and the may-train note. */
export function AssistantKeyStatusRows({
  keys,
  chain,
}: {
  readonly keys: readonly SetupKeyRow[];
  readonly chain: readonly SetupChainRow[];
}) {
  const session = useSession();
  const load = useCallback(
    () =>
      session
        .read<CoolingResponse>(modelHealthUrl('24h'))
        .catch((): CoolingResponse => ({ models: [] })),
    [session],
  );
  const health = useResource('key cooldowns', load);
  const cooling = health.resource.state === 'ready' ? health.resource.data.models : [];
  return (
    <ul aria-label="Key status" className="grid gap-1 text-sm">
      {keys.map((key) => {
        const left = remainingToday(key.keyId, chain);
        const until = cooling
          .filter((m) => m.keyId === key.keyId && m.coolingUntil !== undefined)
          .map((m) => m.coolingUntil as number)
          .sort((a, b) => b - a)[0];
        return (
          <li key={key.keyId} className="flex flex-wrap gap-x-3 text-ink-muted">
            <span className="text-ink">{key.label}</span>
            {key.project != null && <span>Project {key.project}</span>}
            {left !== undefined && <span>{String(left)} left today</span>}
            {until !== undefined && until > Date.now() && (
              <span>Cooling until {new Date(until).toLocaleString()}</span>
            )}
            {key.provider === 'gemini' && key.costClass === 'free' && <span>{MAY_TRAIN_NOTE}</span>}
          </li>
        );
      })}
    </ul>
  );
}
