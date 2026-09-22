import { useCallback, useState } from 'react';
import type { EligibilityWarning, ProviderReviewResult } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

const REASON_TEXT: Record<EligibilityWarning['reason'], string> = {
  'not-no':
    'This service has not confirmed that it will keep your server data out of model training',
  stale: 'The terms review is old. Check the source again before using this service',
  'not-production': 'This service is not approved for live member questions',
  unverified:
    'No verified eligibility record — assistant answers are intentionally disabled until the owner verifies this provider’s terms and adds the record',
};

const trainsTone = (trainsOnInput: string): 'hold' | 'danger' | 'ok' =>
  trainsOnInput === 'no' ? 'ok' : trainsOnInput === 'unknown' ? 'hold' : 'danger';

/**
 * `/providers`: the training-eligibility rows `doctor` warns about
 * (`bananasaurs provider status` / `provider review`). "I checked these terms today"
 * records that the owner re-checked the row as it stands — it writes the
 * review date, never the row's claims (docs/17). Changing a provider's
 * training flag or production eligibility stays a config change on the host.
 */
export function ProvidersPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(
    () =>
      session
        .read<{ warnings: EligibilityWarning[] }>('/api/providers/eligibility')
        .then((r) => r.warnings),
    [session],
  );
  const warnings = useResource('the provider eligibility warnings', load);

  const [provider, setProvider] = useState<'off' | 'gemini' | 'openrouter' | 'nvidia-nim'>('off');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [reviewing, setReviewing] = useState<EligibilityWarning | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const review = async () => {
    if (reviewing === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<ProviderReviewResult>(
        `/api/providers/${encodeURIComponent(reviewing.provider)}/review`,
        {},
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `${result.provider} marked reviewed`,
          message: `Review date moved from ${new Date(result.previouslyReviewedAt).toLocaleDateString()} to ${new Date(result.reviewedAt).toLocaleDateString()}.`,
        });
        warnings.reload();
      }
    } finally {
      setBusy(false);
      setReviewing(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title="AI setup"
        purpose="Bananasaurs sends member questions and any allowed server context to this company. Choose one only after checking its terms and cost."
      />
      <DataState
        resource={warnings.resource}
        isEmpty={(rows) => rows.length === 0}
        empty={
          <div className="max-w-2xl">
            <Card title="Eligibility">
              <p className="text-sm">
                The configured AI service says it will not use your server's data to train its
                models. Recheck when its terms change.
              </p>
            </Card>
          </div>
        }
      >
        {(rows) => (
          <div className="max-w-4xl">
            <DataTable
              caption="Provider eligibility warnings"
              rows={rows}
              rowKey={(w) => `${w.provider}:${w.reason}`}
              columns={[
                { key: 'provider', header: 'Provider', cell: (w) => w.provider },
                {
                  key: 'trains',
                  header: 'Uses server data for training',
                  cell: (w) => (
                    <Badge tone={trainsTone(w.trainsOnInput)}>
                      {w.trainsOnInput === 'no'
                        ? 'No'
                        : w.trainsOnInput === 'yes'
                          ? 'Yes'
                          : 'Not confirmed'}
                    </Badge>
                  ),
                },
                { key: 'reason', header: 'Why it is listed', cell: (w) => REASON_TEXT[w.reason] },
                {
                  key: 'reviewed',
                  header: 'Last reviewed',
                  cell: (w) =>
                    w.reason === 'unverified'
                      ? 'never — no record exists'
                      : new Date(w.reviewedAt).toLocaleDateString(),
                },
                {
                  key: 'actions',
                  header: '',
                  // Nothing to review without a row: "I checked these terms today" writes
                  // the review date of a record, and this one does not exist.
                  cell: (w) =>
                    w.reason === 'unverified' ? null : (
                      <Button onClick={() => setReviewing(w)}>I checked these terms today</Button>
                    ),
                },
              ]}
            />
          </div>
        )}
      </DataState>
      <div className="mt-4 max-w-4xl">
        <Card title="Choose an AI service">
          <p className="mb-3 text-sm">
            API keys are encrypted at rest and write-only. After save, the API returns only whether
            a key exists. Eligibility still gates traffic.
          </p>
          <div className="mb-4 grid gap-2 text-sm sm:grid-cols-3">
            <p>
              <strong>Google Gemini</strong>
              <br />
              Sends questions and allowed context.{' '}
              <a
                className="underline"
                href="https://ai.google.dev/gemini-api/terms"
                target="_blank"
                rel="noreferrer"
              >
                Terms
              </a>{' '}
              ·{' '}
              <a
                className="underline"
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
              >
                Get a key
              </a>
              <br />
              Suggested: Gemini 2.5 Flash. Usage may cost money.
            </p>
            <p>
              <strong>OpenRouter</strong>
              <br />
              Sends data through OpenRouter to the chosen model.{' '}
              <a
                className="underline"
                href="https://openrouter.ai/terms"
                target="_blank"
                rel="noreferrer"
              >
                Terms
              </a>{' '}
              ·{' '}
              <a
                className="underline"
                href="https://openrouter.ai/settings/keys"
                target="_blank"
                rel="noreferrer"
              >
                Get a key
              </a>
              <br />
              Choose a no-training model. Prices vary.
            </p>
            <p>
              <strong>NVIDIA NIM</strong>
              <br />
              Sends questions and allowed context.{' '}
              <a
                className="underline"
                href="https://www.nvidia.com/en-us/data-center/products/nvidia-ai-enterprise/eula/"
                target="_blank"
                rel="noreferrer"
              >
                Terms
              </a>{' '}
              ·{' '}
              <a
                className="underline"
                href="https://build.nvidia.com/"
                target="_blank"
                rel="noreferrer"
              >
                Get a key
              </a>
              <br />
              Choose a supported instruct model. Limits and cost vary.
            </p>
          </div>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                setBusy(true);
                const result = await session.write<{ keyConfigured: boolean }>(
                  '/api/assistant/provider',
                  {
                    provider,
                    ...(model.trim() === '' ? {} : { model: model.trim() }),
                    ...(apiKey === '' ? {} : { apiKey }),
                    enabled,
                  },
                  'PUT',
                );
                setBusy(false);
                if (result !== undefined) {
                  setApiKey('');
                  toast({
                    tone: 'ok',
                    title: enabled ? 'Provider configuration saved' : 'Assistant provider disabled',
                    message: result.keyConfigured
                      ? 'A write-only API key is stored.'
                      : 'No API key is stored.',
                  });
                }
              })();
            }}
          >
            <label className="text-sm">
              Provider{' '}
              <select
                className="rounded-sm border border-line bg-canvas px-2 py-1"
                value={provider}
                onChange={(e) => setProvider(e.target.value as typeof provider)}
              >
                <option value="off">Off</option>
                <option value="gemini">Gemini</option>
                <option value="openrouter">OpenRouter</option>
                <option value="nvidia-nim">NVIDIA NIM</option>
              </select>
            </label>
            <label className="text-sm">
              Model{' '}
              <input
                className="rounded-sm border border-line bg-canvas px-2 py-1"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Replace API key{' '}
              <input
                type="password"
                autoComplete="new-password"
                className="rounded-sm border border-line bg-canvas px-2 py-1"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enable provider after save (eligibility still required)
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" busy={busy}>
                Save AI setup
              </Button>
              <Button
                type="button"
                disabled
                title="Save the AI setup before testing the connection"
              >
                Test connection after saving
              </Button>
            </div>
          </form>
        </Card>
      </div>
      <ConfirmDialog
        open={reviewing !== undefined}
        title={`Mark ${reviewing?.provider ?? ''} reviewed?`}
        scope={
          <p>
            Records that you re-checked the training-eligibility row for {reviewing?.provider ?? ''}{' '}
            as it stands today. It writes the review date only — the row&apos;s claims do not
            change.
          </p>
        }
        confirmLabel="I checked these terms today"
        busy={busy}
        onConfirm={() => void review()}
        onCancel={() => setReviewing(undefined)}
      />
    </>
  );
}
