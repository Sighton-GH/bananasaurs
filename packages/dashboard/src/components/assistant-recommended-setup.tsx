import { useState } from 'react';
import { RECOMMENDED_CHAIN_URL } from '../api/assistant.js';
import { ApiError } from '../api.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';

/** One button that fills the model order with the recommended Gemini chain. */
export function AssistantRecommendedSetup({ onChanged }: { readonly onChanged?: () => void } = {}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const run = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    setFailed(false);
    try {
      const result = await session.writeOrThrow<{ ok: boolean; count: number }>(
        RECOMMENDED_CHAIN_URL,
        {},
      );
      if (result !== undefined) {
        setMessage('The recommended Gemini setup is saved.');
        onChanged?.();
      }
    } catch (err) {
      setFailed(true);
      setMessage(
        err instanceof ApiError && err.body.error === 'no-gemini-key'
          ? 'Add a Gemini key first'
          : 'The recommended setup could not be saved. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button busy={busy} onClick={() => void run()}>
        Use the recommended Gemini setup
      </Button>
      {message !== undefined && (
        <span role={failed ? 'alert' : 'status'} className="text-sm">
          {message}
        </span>
      )}
    </div>
  );
}
