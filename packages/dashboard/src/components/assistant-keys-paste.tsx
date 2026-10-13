import { useState } from 'react';
import { BULK_KEYS_URL, PROVIDERS, type BulkKeysResponse } from '../api/assistant.js';
import { ApiError } from '../api.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field, Input } from '../ui/Field.js';
import { InlineAlert } from '../ui/InlineAlert.js';
import { Select } from '../ui/Select.js';
import { Textarea } from '../ui/Textarea.js';

type CostClass = 'free' | 'paid' | 'unknown';

/** Paste many keys at once, one per line. The key text is never shown back. */
export function AssistantKeysPaste({ onSaved }: { readonly onSaved?: () => void } = {}) {
  const session = useSession();
  const [text, setText] = useState('');
  const [provider, setProvider] = useState<string>('gemini');
  const [project, setProject] = useState('');
  const [costClass, setCostClass] = useState<CostClass>('free');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await session.writeOrThrow<BulkKeysResponse>(BULK_KEYS_URL, {
        provider,
        costClass,
        keysText: text,
        ...(project.trim() === '' ? {} : { project: project.trim() }),
      });
      if (result !== undefined) {
        setMessage(`${String(result.added)} added, ${String(result.duplicates)} already saved`);
        setText('');
        onSaved?.();
      }
    } catch (err) {
      setError(
        err instanceof ApiError && err.body.error === 'empty-paste'
          ? 'Paste at least one key.'
          : 'Those keys could not be saved. Check the text and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Add many keys at once">
      <div className="grid gap-2">
        <Field label="Paste keys" hint="One key per line. Keys already saved are skipped.">
          <Textarea
            rows={4}
            value={text}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            className="font-mono"
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Field label="Service">
            <Select
              value={provider}
              onValueChange={setProvider}
              options={PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
              aria-label="Service"
            />
          </Field>
          <Field label="Cost">
            <Select
              value={costClass}
              onValueChange={(value) => setCostClass(value as CostClass)}
              options={[
                { value: 'free', label: 'Free' },
                { value: 'paid', label: 'Paid' },
                { value: 'unknown', label: 'Not sure' },
              ]}
              aria-label="Cost"
            />
          </Field>
          <Field
            label="Project label (optional)"
            hint="Keys with the same label share one daily allowance."
          >
            <Input
              maxLength={80}
              value={project}
              onChange={(event) => setProject(event.target.value)}
            />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            busy={busy}
            disabled={text.trim() === ''}
            onClick={() => void save()}
          >
            Save keys
          </Button>
          {message !== undefined && (
            <span role="status" className="text-sm">
              {message}
            </span>
          )}
          {error !== undefined && (
            <InlineAlert tone="danger" title="Keys were not saved.">
              {error}
            </InlineAlert>
          )}
        </div>
      </div>
    </Card>
  );
}
