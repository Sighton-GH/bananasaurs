import { useState } from 'react';
import { type AccountRevokeResult } from '../../../api/ops.js';
import { type Session } from '../../../app/session.js';
import { Button } from '../../../ui/Button.js';
import { Card } from '../../../ui/Card.js';
import { useToast } from '../../../ui/Toast.js';

export function SessionsSection({
  session,
  username,
  onChanged,
}: {
  readonly session: Session;
  readonly username: string;
  readonly onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const signOutEverywhere = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await session.write<AccountRevokeResult>(
        `/api/accounts/${encodeURIComponent(username)}/revoke-credentials`,
        {},
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `Signed out everywhere for ${result.username}`,
          message: `${String(result.sessionsRevoked)} sessions and ${String(result.tokensRevoked)} connected apps ended.`,
        });
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Sessions and apps">
      <p className="max-w-lg text-sm text-ink-muted">
        Ends every dashboard session and disconnects every connected app for {username}. The
        password keeps working — disable the account to stop sign-in.
      </p>
      <div className="mt-3">
        <Button busy={busy} onClick={() => void signOutEverywhere()}>
          Sign out everywhere and disconnect apps
        </Button>
      </div>
    </Card>
  );
}
