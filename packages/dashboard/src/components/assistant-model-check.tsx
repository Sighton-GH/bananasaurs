import { useState } from 'react';
import { MODEL_CHECK_URL, type ModelCheckResponse } from '../api/assistant.js';
import { ApiError } from '../api.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';

const REFUSAL: Readonly<Record<string, string>> = {
  'budget-exhausted': 'Out of test budget — try again after the reset',
  'entry-unusable': 'This entry cannot be checked right now. Fix its key or turn it on first.',
};

/** Check one chain entry: three fixed messages, expected versus first action. */
export function AssistantModelCheck({ position }: { readonly position: number }) {
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
        <Button busy={busy} onClick={() => void run()}>
          Check this entry
        </Button>
        <span className="text-xs text-ink-muted">
          Sends three short test messages and compares the expected versus first action. Nothing is
          posted.
        </span>
      </div>
      {failure !== undefined && (
        <p role="alert" className="text-danger">
          {failure}
        </p>
      )}
      {outcome?.ok === false && (
        <p role="alert" className="text-danger">
          {REFUSAL[outcome.error ?? ''] ?? outcome.error ?? 'The check did not run.'}
        </p>
      )}
      {outcome?.ok === true && (
        <table aria-label={`Check results for entry ${String(position + 1)}`} className="text-left">
          <thead>
            <tr className="text-xs text-ink-muted">
              <th className="pr-3">Test</th>
              <th className="pr-3">Wanted</th>
              <th className="pr-3">First action</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {(outcome.results ?? []).map((r) => (
              <tr key={r.id}>
                <td className="pr-3">{r.id}</td>
                <td className="pr-3">{r.expectedFirstAction}</td>
                <td className="pr-3">{r.firstAction}</td>
                <td>{r.matches ? 'Match' : (r.error ?? 'Different')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
