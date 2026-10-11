import { useState } from 'react';
import {
  MODEL_CHAIN_URL,
  type ChainPool,
  type ChainTierName,
  type SetupChainRow,
} from '../api/assistant.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';

interface Draft {
  readonly pool: ChainPool;
  readonly tier: ChainTierName;
}

/** Pool and tier columns for the saved chain. Saves the whole chain with the extra fields. */
export function AssistantChainPools({
  chain,
  onChanged,
}: {
  readonly chain: readonly SetupChainRow[];
  readonly onChanged: () => void;
}) {
  const session = useSession();
  const [drafts, setDrafts] = useState<readonly Draft[]>(() =>
    chain.map((row) => ({ pool: row.pool ?? 'key', tier: row.tier ?? 'standard' })),
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const patch = (index: number, change: Partial<Draft>): void => {
    setSaved(false);
    setDrafts((current) => current.map((d, i) => (i === index ? { ...d, ...change } : d)));
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean }>(
        MODEL_CHAIN_URL,
        {
          entries: chain.map((row, index) => ({
            keyId: row.keyId,
            model: row.model,
            rpmLimit: row.rpmLimit,
            rpdLimit: row.rpdLimit,
            pool: drafts[index]?.pool ?? 'key',
            tier: drafts[index]?.tier ?? 'standard',
          })),
        },
        'PUT',
      );
      if (result !== undefined) {
        setSaved(true);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };
  if (chain.length === 0) return null;
  return (
    <div className="grid gap-2 text-sm">
      {chain.map((row, index) => (
        <div key={`${row.keyId} ${row.model}`} className="flex flex-wrap items-center gap-3">
          <span className="text-ink">{row.model}</span>
          <label className="grid gap-0.5 text-xs text-ink-muted">
            Pool for row {index + 1}
            <select
              className="rounded-sm border border-line bg-canvas px-2 py-1 text-sm text-ink"
              value={drafts[index]?.pool ?? 'key'}
              onChange={(event) => patch(index, { pool: event.target.value as ChainPool })}
            >
              <option value="key">One key</option>
              <option value="provider">Whole provider</option>
            </select>
          </label>
          <label className="grid gap-0.5 text-xs text-ink-muted">
            Tier for row {index + 1}
            <select
              className="rounded-sm border border-line bg-canvas px-2 py-1 text-sm text-ink"
              value={drafts[index]?.tier ?? 'standard'}
              onChange={(event) => patch(index, { tier: event.target.value as ChainTierName })}
            >
              <option value="standard">Standard</option>
              <option value="light">Light</option>
            </select>
          </label>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button busy={busy} onClick={() => void save()}>
          Save pools and tiers
        </Button>
        {saved && <span role="status">Saved</span>}
      </div>
    </div>
  );
}
