import { useState } from 'react';
import {
  PROVIDERS,
  providerTermsUrl,
  type AssistantSetupData,
  type ProviderTerms,
} from '../../api/assistant.js';
import type { EligibilityWarning, ProviderReviewResult } from '../../api/ops.js';
import type { UseResource } from '../../hooks/useResource.js';
import { fieldError } from '../../api/describe-error.js';
import { useSession } from '../../app/session.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable } from '../../ui/DataTable.js';
import { Card } from '../../ui/Card.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { Checkbox, Field, Input } from '../../ui/Field.js';
import { RadioGroup } from '../../ui/RadioGroup.js';
import { Textarea } from '../../ui/Textarea.js';
import { useToast } from '../../ui/Toast.js';

const trainsLabel = (trainsOnInput: string): string =>
  trainsOnInput === 'no'
    ? "Doesn't train on your data"
    : trainsOnInput === 'yes'
      ? 'May train on your data'
      : 'Not stated';

function TermsForm({
  provider,
  providerName,
  defaultUrl,
  initial,
  onSaved,
}: {
  readonly provider: string;
  readonly providerName: string;
  readonly defaultUrl: string;
  readonly initial: ProviderTerms | null;
  readonly onSaved: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [trains, setTrains] = useState<'no' | 'yes' | 'unknown'>(
    initial?.trainsOnInput ?? 'unknown',
  );
  const [clause, setClause] = useState(initial?.evidenceClause ?? '');
  const [url, setUrl] = useState(initial?.evidenceUrl ?? defaultUrl);
  const [production, setProduction] = useState(initial?.productionUseAllowed ?? false);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await session.writeOrThrow<ProviderTerms>(
        providerTermsUrl(provider),
        {
          trainsOnInput: trains,
          evidenceClause: clause,
          evidenceUrl: url,
          productionUseAllowed: production,
        },
        'PUT',
      );
      if (result === undefined) return;
      toast({ tone: 'ok', title: 'Terms record saved' });
      onSaved();
    } catch (err: unknown) {
      // writeOrThrow lets the server's 400/409 answers through; everything
      // else already became a toast. Render the answer with its field
      // problems rather than translating the refusal here.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const clauseProblem = fieldError(error, 'evidenceClause');
  const urlProblem = fieldError(error, 'evidenceUrl');

  return (
    <form
      className="mt-3 grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <RadioGroup
        legend={`Does ${providerName} use your server's data to train its models?`}
        name={`trains-${provider}`}
        value={trains}
        onChange={(value) => setTrains(value as 'no' | 'yes' | 'unknown')}
        options={[
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
          { value: 'unknown', label: "The terms don't say" },
        ]}
      />
      <Field
        label="Quote the sentence from the terms that says so"
        hint="Quote the exact sentence from the provider terms."
        {...(clauseProblem === undefined ? {} : { error: clauseProblem })}
        htmlFor="terms-clause"
      >
        <Textarea
          id="terms-clause"
          rows={3}
          maxLength={2000}
          showCount
          value={clause}
          onChange={(e) => setClause(e.target.value)}
        />
      </Field>
      <Field
        label="Link to that part of the terms"
        {...(urlProblem === undefined ? {} : { error: urlProblem })}
      >
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
        />
      </Field>
      <div className="text-sm">
        <Checkbox
          label="The terms allow use for answering member questions"
          checked={production}
          onChange={(e) => setProduction(e.target.checked)}
        />
      </div>
      {error !== undefined && <ErrorNotice error={error} />}
      <div>
        <Button variant="primary" type="submit" busy={busy}>
          Save terms record
        </Button>
      </div>
    </form>
  );
}

/**
 * The stored terms record for one provider, plus the owner-only form.
 * A stored record reads as a summary; the form stays hidden until the
 * owner asks to update it, so a first-time reader sees what is true.
 */
export function TermsCard({
  info,
  terms,
  isOwner,
  onSaved,
}: {
  readonly info: (typeof PROVIDERS)[number];
  readonly terms: ProviderTerms | null;
  readonly isOwner: boolean;
  readonly onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <Card title="Terms record">
      <p className="text-sm text-ink-muted">
        Discord&apos;s developer policy only allows sending server content to a service that
        doesn&apos;t train on it. Record what {info.name}&apos;s terms say. The assistant stays off
        until the terms are recorded; a service whose record says it may train stays available by
        the owner&apos;s decision and is flagged with warnings.
      </p>
      {terms !== null && (
        <div className="mt-3 text-sm">
          <p>
            Recorded {new Date(terms.reviewedAt).toLocaleDateString()}:{' '}
            {trainsLabel(terms.trainsOnInput)}
          </p>
          {terms.evidenceClause !== undefined && terms.evidenceClause !== '' && (
            <blockquote className="mt-2 border-l-2 border-line pl-3 text-ink-muted">
              {terms.evidenceClause}
            </blockquote>
          )}
          <a
            className="mt-2 inline-block underline"
            href={terms.evidenceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Read the cited terms
          </a>
        </div>
      )}
      {!isOwner ? (
        <p className="mt-3 text-sm text-ink-muted">Only the server owner can record the terms.</p>
      ) : terms === null ? (
        <TermsForm
          key={info.id}
          provider={info.id}
          providerName={info.name}
          defaultUrl={info.termsUrl}
          initial={terms}
          onSaved={onSaved}
        />
      ) : editing ? (
        <TermsForm
          key={info.id}
          provider={info.id}
          providerName={info.name}
          defaultUrl={info.termsUrl}
          initial={terms}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      ) : (
        <div className="mt-3">
          <Button onClick={() => setEditing(true)}>Update the terms record</Button>
        </div>
      )}
    </Card>
  );
}

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
 * The Terms tab: the terms record for each provider that has keys, plus the
 * "Service terms to check" table with its review dialog. The review writes
 * the review date only — never the row's claims (see ProvidersPage history).
 */
export function TermsSection({
  setup,
  providerTerms,
  isOwner,
  warnings,
  onChanged,
}: {
  readonly setup: AssistantSetupData;
  readonly providerTerms: ProviderTerms | null;
  readonly isOwner: boolean;
  readonly warnings: UseResource<readonly EligibilityWarning[]>;
  readonly onChanged: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [reviewing, setReviewing] = useState<EligibilityWarning | undefined>(undefined);
  const [reviewBusy, setReviewBusy] = useState(false);

  const review = async () => {
    if (reviewing === undefined) return;
    setReviewBusy(true);
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
      setReviewBusy(false);
      setReviewing(undefined);
    }
  };

  return (
    <>
      {setup.providers
        .filter((row) => row.keyCount > 0)
        .map((row) => {
          const info = PROVIDERS.find((p) => p.id === row.provider);
          if (info === undefined) return null;
          return (
            <div key={row.provider} className="mt-4 first:mt-0">
              <TermsCard
                info={info}
                terms={providerTerms?.provider === info.id ? providerTerms : null}
                isOwner={isOwner}
                onSaved={onChanged}
              />
            </div>
          );
        })}
      <div className="mt-4">
        <DataState resource={warnings.resource} isEmpty={(rows) => rows.length === 0} empty={null}>
          {(rows) => (
            <Card title="Service terms to check">
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
                  {
                    key: 'reason',
                    header: 'Why it is listed',
                    cell: (w) => REASON_TEXT[w.reason],
                  },
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
            </Card>
          )}
        </DataState>
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
        busy={reviewBusy}
        onConfirm={() => void review()}
        onCancel={() => setReviewing(undefined)}
      />
    </>
  );
}
