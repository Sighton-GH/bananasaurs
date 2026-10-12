import { useCallback, useState } from 'react';
import { TUNING_URL, tuningKeyUrl, type TuningListResponse } from '../api/tuning.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { Field, Input } from '../ui/Field.js';
import { useToast } from '../ui/Toast.js';

const KEYS = [
  'assistant.digestEnabled',
  'assistant.digestHour',
  'assistant.digestInputChars',
  'assistant.digestMaxProposals',
] as const;

const LABELS: Record<(typeof KEYS)[number], string> = {
  'assistant.digestEnabled': 'Digest on or off (1 or 0)',
  'assistant.digestHour': 'Digest hour (local time)',
  'assistant.digestInputChars': 'Digest input cap (characters)',
  'assistant.digestMaxProposals': 'Digest max proposals',
};

/** The digest controls on Assistant → Memory (ADR 0150, spec §4.7). Four keys; the tier lives on the Routing page in AI setup. */
export function AssistantDigestSettings() {
  const session = useSession();
  const load = useCallback(() => session.read<TuningListResponse>(TUNING_URL), [session]);
  const settings = useResource('digest settings', load);
  return (
    <Card title="Daily digest">
      <p className="mb-2 text-sm text-ink-muted">
        One summary a day of what members talked about with the assistant, with memory proposals for
        review. The model tier for the digest is on the Routing page in AI setup.
      </p>
      <DataState resource={settings.resource}>
        {(data) => <DigestSettingsForm initial={data.settings} reload={settings.reload} />}
      </DataState>
    </Card>
  );
}

function DigestSettingsForm({
  initial,
  reload,
}: {
  readonly initial: TuningListResponse['settings'];
  readonly reload: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const current = (key: string): string => {
    const found = initial.find((s) => s.key === key)?.value;
    return typeof found === 'number' ? String(found) : '';
  };
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(KEYS.map((k) => [k, current(k)])),
  );
  const [busy, setBusy] = useState(false);
  // No refresh effect: like RetentionForm, this form mounts with data present
  // (DataState renders children only when ready), so the initializer above
  // sees the live values; after a save the drafts already equal what was
  // written.
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      for (const key of KEYS) {
        const raw = drafts[key] ?? '';
        const value = Number(raw);
        if (raw.trim() === '' || !Number.isInteger(value)) continue;
        const live = initial.find((s) => s.key === key)?.value;
        if (live === value) continue;
        const saved = await session.write(tuningKeyUrl(key), { value }, 'PUT');
        if (saved === undefined) {
          reload();
          return;
        }
      }
      toast({ tone: 'ok', title: 'Saved digest settings.' });
      reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void save(e)} className="grid max-w-2xl gap-3">
      {KEYS.map((key) => (
        <Field key={key} label={LABELS[key]}>
          <Input
            value={drafts[key] ?? ''}
            onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
          />
        </Field>
      ))}
      <div>
        <Button type="submit" variant="primary" busy={busy}>
          Save digest settings
        </Button>
      </div>
    </form>
  );
}
