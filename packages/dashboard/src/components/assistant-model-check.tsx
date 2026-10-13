import { useState } from 'react';
import { MODEL_CHECK_URL, type ModelCheckResponse } from '../api/assistant.js';
import { ApiError } from '../api.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';
import { DataTable } from '../ui/DataTable.js';
import { InlineAlert } from '../ui/InlineAlert.js';

const REFUSAL: Readonly<Record<string, string>> = {
  'budget-exhausted': 'Out of test budget — try again after the reset',
  'entry-unusable': 'This entry cannot be checked right now. Fix its key or turn it on first.',
};

/** Check one chain entry: three fixed messages, expected versus first action. */
export function AssistantModelCheck({
  position,
  model,
  keyLabel,
}: {
  readonly position: number;
  readonly model: string;
  readonly keyLabel: string;
}) {
  const entryName = `Check entry ${String(position + 1)}: ${model} on ${keyLabel}`;
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ModelCheckResponse | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const run = async (): Promise<void> => {
    setBusy(true);
    setOutcome(undefined);
    setFailure(undefined);
    try {
      const result = await session.writeOrThrow<ModelCheckResponse>(MODEL_CHECK_URL, { position });
      if (result !== undefined) setOutcome(result);
    } catch (err) {
      setFailure(
        err instanceof ApiError && err.status === 404
          ? 'That entry is not saved yet.'
          : 'The check could not run. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <Button busy={busy} aria-label={entryName} onClick={() => void run()}>
          {entryName}
        </Button>
        <span className="text-xs text-ink-muted">
          Entry {String(position + 1)} ({model} on {keyLabel}) sends three short test messages and
          compares the expected versus first action. Nothing is posted.
        </span>
      </div>
      {failure !== undefined && (
        <InlineAlert tone="danger" title="The check could not run.">
          {failure}
        </InlineAlert>
      )}
      {outcome?.ok === false && (
        <InlineAlert tone="danger" title="The check was refused.">
          {REFUSAL[outcome.error ?? ''] ?? outcome.error ?? 'The check did not run.'}
        </InlineAlert>
      )}
      {outcome?.ok === true && (
        <DataTable
          caption={`Check results for entry ${String(position + 1)}: ${model} on ${keyLabel}`}
          rows={outcome.results ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'id', header: 'Test', cell: (r) => r.id },
            { key: 'expected', header: 'Wanted', cell: (r) => r.expectedFirstAction },
            { key: 'first', header: 'First action', cell: (r) => r.firstAction },
            {
              key: 'result',
              header: 'Result',
              cell: (r) => (r.matches ? 'Match' : (r.error ?? 'Different')),
            },
          ]}
        />
      )}
    </div>
  );
}
