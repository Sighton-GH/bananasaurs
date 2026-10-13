import { useState } from 'react';
import { GITHUB_TOKEN_URL } from '../../api/assistant.js';
import { useSession } from '../../app/session.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { Field, Input } from '../../ui/Field.js';
import { useToast } from '../../ui/Toast.js';

/** The GitHub token: optional, write-only, cleared with null. */
export function GithubSection({
  tokenConfigured,
  onChanged,
}: {
  readonly tokenConfigured: boolean;
  readonly onChanged: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (value: string | null): Promise<void> => {
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean; tokenConfigured: boolean }>(
        GITHUB_TOKEN_URL,
        { token: value },
        'PUT',
      );
      if (result === undefined) return;
      // The token is write-only: drop it from the page the moment it is stored.
      setToken('');
      toast({ tone: 'ok', title: value === null ? 'GitHub token cleared' : 'GitHub token saved' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="GitHub token (optional)">
      <div className="grid gap-3">
        <p className="text-sm text-ink-muted">
          Without a token GitHub allows 60 requests an hour, so organisations refresh once a day and
          only README files are read.
        </p>
        <p className="text-sm text-ink-muted">
          To include private repositories, create a fine-grained token with Contents: Read-only
          access to the repositories you choose. Club members can then ask about those repositories,
          and their text is sent to your AI providers.
        </p>
        {tokenConfigured && (
          <p className="text-sm text-ink-muted">Saved. Saving a new token replaces it.</p>
        )}
        <Field label="GitHub token">
          <Input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            {...(tokenConfigured ? { placeholder: 'Saved. Leave blank to keep it' } : {})}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            busy={busy}
            disabled={token === ''}
            onClick={() => void save(token)}
          >
            Save token
          </Button>
          {tokenConfigured && (
            <Button busy={busy} onClick={() => void save(null)}>
              Clear token
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
