import { useState } from 'react';
import { type AccountRevealResult, type AccountSetPasswordResult } from '../../../api/ops.js';
import { fieldError } from '../../../api/describe-error.js';
import { type Session } from '../../../app/session.js';
import { Button } from '../../../ui/Button.js';
import { Card } from '../../../ui/Card.js';
import { ErrorNotice } from '../../../ui/ErrorNotice.js';
import { Field, Input } from '../../../ui/Field.js';
import { RadioGroup } from '../../../ui/RadioGroup.js';
import { PrintOnceDialog } from '../../../ui/PrintOnceDialog.js';

export function SetPasswordForm({
  session,
  username,
  onPasswordSet,
}: {
  readonly session: Session;
  readonly username: string;
  /** Runs when the new-password dialog is dismissed, so a reload cannot unmount the only copy. */
  readonly onPasswordSet: () => void;
}) {
  const [choice, setChoice] = useState<'generate' | 'choose'>('generate');
  const [chosen, setChosen] = useState('');
  const [reset, setReset] = useState<AccountSetPasswordResult | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const ok = choice === 'generate' || chosen.length >= 12;
  // Client-side validation wins; the server's field problem shows once the
  // shape is right but the value is refused.
  const clientError =
    choice === 'generate' || chosen === '' || chosen.length >= 12
      ? undefined
      : 'Use at least 12 characters.';
  const passwordProblem = clientError ?? fieldError(error, 'password');

  const submit = async (): Promise<void> => {
    if (!ok || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await session.writeOrThrow<AccountSetPasswordResult>(
        `/api/accounts/${encodeURIComponent(username)}/password`,
        choice === 'generate' ? {} : { password: chosen },
        'PUT',
      );
      if (result !== undefined) {
        // No toast: the plaintext lives in the PrintOnceDialog only.
        setReset(result);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <p className="text-sm font-medium">Set a new password</p>
      <RadioGroup
        legend="New password source"
        name={`password-choice-${username}`}
        value={choice}
        onChange={(value) => setChoice(value as 'generate' | 'choose')}
        options={[
          { value: 'generate', label: 'Generate one for me' },
          { value: 'choose', label: "I'll choose one" },
        ]}
      />
      {choice === 'choose' && (
        <div className="mt-3 max-w-md">
          <Field
            label="New password"
            hint="At least 12 characters."
            {...(passwordProblem === undefined ? {} : { error: passwordProblem })}
          >
            <Input
              type="password"
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
      )}
      {error !== undefined && (
        <div className="mt-2">
          <ErrorNotice error={error} />
        </div>
      )}
      <div className="mt-3">
        <Button variant="primary" busy={busy} disabled={!ok} onClick={() => void submit()}>
          Set new password
        </Button>
      </div>
      <PrintOnceDialog
        open={reset !== undefined}
        title="New password"
        secretLabel={reset === undefined ? '' : `New password for ${reset.username}`}
        secret={reset?.password}
        onDone={() => {
          setReset(undefined);
          onPasswordSet();
        }}
      />
    </div>
  );
}

export function PasswordSection({
  session,
  username,
  canReveal,
  revealable,
  onChanged,
}: {
  readonly session: Session;
  readonly username: string;
  readonly canReveal: boolean;
  readonly revealable: boolean;
  readonly onChanged: () => void;
}) {
  const [revealed, setRevealed] = useState<AccountRevealResult | undefined>(undefined);
  const [revealError, setRevealError] = useState<unknown>(undefined);
  const [revealBusy, setRevealBusy] = useState(false);

  const reveal = async (): Promise<void> => {
    if (revealBusy) return;
    setRevealBusy(true);
    setRevealError(undefined);
    try {
      const result = await session.writeOrThrow<AccountRevealResult>(
        `/api/accounts/${encodeURIComponent(username)}/reveal-password`,
        {},
      );
      if (result !== undefined) setRevealed(result);
    } catch (err) {
      setRevealError(err);
    } finally {
      setRevealBusy(false);
    }
  };

  return (
    <Card title="Password">
      {canReveal &&
        (revealable ? (
          <div>
            <Button busy={revealBusy} onClick={() => void reveal()}>
              Reveal current password
            </Button>
            {revealError !== undefined && (
              <div className="mt-2">
                <ErrorNotice error={revealError} />
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            Set a new password to be able to reveal it later.
          </p>
        ))}
      <SetPasswordForm session={session} username={username} onPasswordSet={onChanged} />
      <PrintOnceDialog
        open={revealed !== undefined}
        title="Current password"
        secretLabel={revealed === undefined ? '' : `Current password for ${revealed.username}`}
        secret={revealed?.password}
        onDone={() => setRevealed(undefined)}
      />
    </Card>
  );
}
