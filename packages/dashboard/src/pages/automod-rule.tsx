import { useCallback, useState } from 'react';
import { useParams } from 'wouter';
import { ApiError } from '../api.js';
import {
  CUTOVER_STAGE_HELP,
  CUTOVER_STAGE_LABEL,
  daysObserved,
  modeScopeSentence,
  RULE_KIND_LABEL,
  RULE_MODE_HELP,
  RULE_MODE_LABEL,
  type DryRunReport,
  type ModeRequest,
  type RuleDetail,
  type RuleMode,
} from '../api/automod.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { RuleConfigExample } from './automod-config-example.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { HelpTip } from '../ui/HelpTip.js';
import { Card } from '../ui/Card.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

type Refusal = { readonly reason: string; readonly [k: string]: unknown };

const refusalReason = (refusal: Refusal): string => {
  switch (refusal.reason) {
    case 'cutover-state':
      return `the rule is still at the "${
        CUTOVER_STAGE_LABEL[refusal.state as keyof typeof CUTOVER_STAGE_LABEL] ??
        String(refusal.state)
      }" stage`;
    case 'low-volume-unsigned':
      return `${String(refusal.reviewed)} of ${String(refusal.required)} matches reviewed, and no enforcement sign-off`;
    case 'false-positive':
      return `${String(refusal.falsePositives)} false-positive or unclear verdicts among ${String(refusal.reviewed)} reviewed matches`;
    case 'rate-too-high':
      return `the false-positive rate ${String(refusal.rate)} is above the allowed ${String(refusal.threshold)}`;
    default:
      return refusal.reason;
  }
};

const eligibilitySentence = (eligibility: RuleDetail['eligibility']): string =>
  eligibility.ok
    ? 'Enforcement is available for this rule.'
    : `Enforcement is not available yet: ${refusalReason(eligibility.refusal)}.`;

const signoffText = (detail: RuleDetail): string =>
  detail.enforceSignedOffBy !== null && detail.enforceSignedOffAt !== null
    ? `${detail.enforceSignedOffBy} at ${new Date(detail.enforceSignedOffAt).toLocaleString()}`
    : '—';

const observedText = (detail: RuleDetail): string => {
  if (detail.observeStartedAt === null) return 'Not started';
  const days = daysObserved(detail.observeStartedAt, Date.now());
  return `${new Date(detail.observeStartedAt).toLocaleDateString()} (${String(days)} days)`;
};

const MODES: readonly RuleMode[] = ['test', 'observe', 'enforce'];

/**
 * `/automod/:ruleId`: one rule's status, mode, configuration, exemptions,
 * lists and dry run. Mounted only once the detail has loaded, so every piece
 * of form state below seeds directly from `detail` and a `reload()` remounts
 * this view with fresh values.
 */
function RuleDetailView({
  detail,
  reload,
}: {
  readonly detail: RuleDetail;
  readonly reload: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const ruleUrl = `/api/automod/rules/${detail.ruleId}`;

  const [modeRefusal, setModeRefusal] = useState<string | undefined>(undefined);

  const [modeSel, setModeSel] = useState<RuleMode>(detail.mode);
  const [enabledSel, setEnabledSel] = useState(detail.enabled);
  const [modeOpen, setModeOpen] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const modeChanged = modeSel !== detail.mode;
  const enabledChanged = enabledSel !== detail.enabled;
  const request: ModeRequest = {
    ...(modeChanged ? { mode: modeSel } : {}),
    ...(enabledChanged ? { enabled: enabledSel } : {}),
  };
  const scopeSentence = modeScopeSentence(detail, request, Date.now());

  const applyMode = async () => {
    const body: { mode?: RuleMode; enabled?: boolean } = {
      ...(modeChanged ? { mode: modeSel } : {}),
      ...(enabledChanged ? { enabled: enabledSel } : {}),
    };
    setModeBusy(true);
    try {
      const result = await session.writeOrThrow<{ ok: boolean }>(`${ruleUrl}/mode`, body);
      if (result === undefined) return;
      toast({ tone: 'ok', title: 'Mode applied' });
      setModeOpen(false);
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const refusal = (err.body as { refusal?: Refusal }).refusal;
        const sentence =
          refusal !== undefined
            ? `Enforcement is not available yet: ${refusalReason(refusal)}.`
            : err.message;
        setModeRefusal(sentence);
        toast({ tone: 'danger', title: 'Mode not applied', message: sentence });
        setModeOpen(false);
      } else if (err instanceof Error) {
        toast({ tone: 'danger', title: 'The request failed', message: err.message });
        setModeOpen(false);
      } else {
        throw err;
      }
    } finally {
      setModeBusy(false);
    }
  };

  const [configText, setConfigText] = useState(() => JSON.stringify(detail.configObject, null, 2));
  const [configError, setConfigError] = useState<string | undefined>(undefined);
  const [configOpen, setConfigOpen] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);

  const openConfigConfirm = () => {
    try {
      JSON.parse(configText) as unknown;
    } catch {
      setConfigError('Not valid JSON');
      return;
    }
    setConfigError(undefined);
    setConfigOpen(true);
  };

  const saveConfig = async () => {
    const config = JSON.parse(configText) as unknown;
    setConfigBusy(true);
    try {
      const result = await session.writeOrThrow<{ ok: boolean }>(
        `${ruleUrl}/config`,
        { config },
        'PUT',
      );
      if (result === undefined) return;
      toast({ tone: 'ok', title: 'Configuration saved' });
      setConfigOpen(false);
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const bodyDetail = (err.body as { detail?: unknown }).detail;
        setConfigError(
          typeof bodyDetail === 'string'
            ? bodyDetail
            : 'The configuration is invalid for this kind.',
        );
        setConfigOpen(false);
      } else if (err instanceof Error) {
        toast({ tone: 'danger', title: 'The request failed', message: err.message });
        setConfigOpen(false);
      } else {
        throw err;
      }
    } finally {
      setConfigBusy(false);
    }
  };

  const [exemptType, setExemptType] = useState<'role' | 'channel'>('role');
  const [exemptId, setExemptId] = useState('');
  const [exemptBusy, setExemptBusy] = useState(false);

  const addExemption = async (e: React.FormEvent) => {
    e.preventDefault();
    setExemptBusy(true);
    try {
      const result = await session.write<{ ok: boolean; outcome: string }>(
        `${ruleUrl}/exemptions`,
        {
          exemptType,
          exemptId,
        },
      );
      if (result === undefined) return;
      if (result.outcome === 'already-present') {
        toast({ tone: 'neutral', title: 'Already exempt' });
      } else {
        toast({ tone: 'ok', title: 'Exemption added' });
        setExemptId('');
        reload();
      }
    } finally {
      setExemptBusy(false);
    }
  };

  const removeExemption = async (type: string, id: string) => {
    const result = await session.write<{ ok: boolean }>(
      `${ruleUrl}/exemptions/${type}/${id}`,
      {},
      'DELETE',
    );
    if (result !== undefined) {
      toast({ tone: 'ok', title: 'Exemption removed' });
      reload();
    }
  };

  const [report, setReport] = useState<DryRunReport | null>(null);
  const [dryBusy, setDryBusy] = useState(false);

  const runDryRun = async () => {
    setDryBusy(true);
    try {
      const result = await session.write<DryRunReport>(`${ruleUrl}/dry-run`, {});
      if (result !== undefined) setReport(result);
    } finally {
      setDryBusy(false);
    }
  };

  const categories = new Map<string, string[]>();
  for (const term of detail.terms) {
    const group = categories.get(term.categoryId) ?? [];
    group.push(term.text);
    categories.set(term.categoryId, group);
  }

  const dryRows =
    report === null
      ? []
      : [...report.results].sort(
          (a, b) => (a.agreement === 'disagreed' ? 0 : 1) - (b.agreement === 'disagreed' ? 0 : 1),
        );

  return (
    <>
      <Card title="Status">
        <dl className="mt-2 grid max-w-lg grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Kind</dt>
          <dd>
            {RULE_KIND_LABEL[detail.kind]} <span className="text-ink-muted">({detail.kind})</span>
          </dd>
          <dt className="text-ink-muted">Enabled</dt>
          <dd>{detail.enabled ? 'On' : 'Off'}</dd>
          <dt className="text-ink-muted">Mode</dt>
          <dd>{detail.mode}</dd>
          <dt className="text-ink-muted">
            Stage
            <HelpTip label="the rule's stage">{CUTOVER_STAGE_HELP}</HelpTip>
          </dt>
          <dd>{CUTOVER_STAGE_LABEL[detail.cutoverState]}</dd>
          <dt className="text-ink-muted">Observed since</dt>
          <dd>{observedText(detail)}</dd>
          <dt className="text-ink-muted">Matches</dt>
          <dd>{detail.matchCount}</dd>
          <dt className="text-ink-muted">Reviewed</dt>
          <dd>{detail.reviewedCount}</dd>
          <dt className="text-ink-muted">Sign-off</dt>
          <dd>{signoffText(detail)}</dd>
        </dl>
        <p className="mt-2 text-sm">{eligibilitySentence(detail.eligibility)}</p>
        {modeRefusal !== undefined && (
          <p role="alert" className="mt-1 text-sm text-danger">
            {modeRefusal}
          </p>
        )}
      </Card>

      <Card title="Mode">
        <fieldset className="mt-2">
          <legend className="text-sm text-ink-muted">
            Mode
            <HelpTip label="rule modes">
              test {RULE_MODE_HELP.test} observe {RULE_MODE_HELP.observe} enforce{' '}
              {RULE_MODE_HELP.enforce}
            </HelpTip>
          </legend>
          <div className="mt-1 flex gap-4">
            {MODES.map((mode) => (
              <label key={mode} className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="mode"
                  value={mode}
                  checked={modeSel === mode}
                  onChange={() => setModeSel(mode)}
                  disabled={mode === 'enforce' && !detail.eligibility.ok}
                />
                {RULE_MODE_LABEL[mode]}
              </label>
            ))}
          </div>
        </fieldset>
        {!detail.eligibility.ok && (
          <p className="mt-1 text-sm text-ink-muted">
            Enforce is unavailable: {refusalReason(detail.eligibility.refusal)}.
          </p>
        )}
        <div className="mt-2">
          <Checkbox
            label="Enabled"
            checked={enabledSel}
            onChange={(e) => setEnabledSel(e.target.checked)}
          />
        </div>
        <div className="mt-3">
          <Button
            variant="primary"
            disabled={!modeChanged && !enabledChanged}
            busy={modeBusy}
            onClick={() => setModeOpen(true)}
          >
            Apply mode
          </Button>
        </div>
        <ConfirmDialog
          open={modeOpen}
          title="Apply mode?"
          scope={<p>{scopeSentence}</p>}
          confirmLabel="Apply mode"
          danger={modeChanged && modeSel === 'enforce'}
          busy={modeBusy}
          onConfirm={() => void applyMode()}
          onCancel={() => setModeOpen(false)}
        />
      </Card>

      <Card title="Configuration">
        <div className="mt-2 max-w-lg">
          <Field
            label="Configuration"
            hint="JSON; validated against the kind's schema when you save"
            {...(configError !== undefined ? { error: configError } : {})}
          >
            <textarea
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              rows={8}
              className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
            />
          </Field>
          <RuleConfigExample
            kind={detail.kind}
            onUse={(json) => {
              setConfigText(json);
              setConfigError(undefined);
            }}
          />
        </div>
        <div className="mt-3">
          <Button variant="primary" busy={configBusy} onClick={openConfigConfirm}>
            Save configuration
          </Button>
        </div>
        <ConfirmDialog
          open={configOpen}
          title="Save configuration?"
          scope={
            <p>
              Replaces this rule&apos;s configuration. Any enforcement sign-off is withdrawn; the
              observe window and its clock are unchanged, so matches recorded before now were
              produced by the old configuration.
            </p>
          }
          confirmLabel="Save configuration"
          busy={configBusy}
          onConfirm={() => void saveConfig()}
          onCancel={() => setConfigOpen(false)}
        />
      </Card>

      <Card title="Exemptions">
        {detail.exemptions.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No exemptions yet. Add one below.</p>
        ) : (
          <div className="mt-2">
            <DataTable
              caption="Exemptions"
              rows={detail.exemptions}
              rowKey={(e) => `${e.exemptType}:${e.exemptId}`}
              columns={[
                { key: 'type', header: 'Type', cell: (e) => e.exemptType },
                { key: 'id', header: 'ID', cell: (e) => e.exemptId },
                {
                  key: 'remove',
                  header: 'Remove',
                  cell: (e) => (
                    <Button onClick={() => void removeExemption(e.exemptType, e.exemptId)}>
                      Remove
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        )}
        <form onSubmit={(e) => void addExemption(e)} className="mt-3 flex max-w-lg items-end gap-2">
          <div className="w-28">
            <Field label="Type">
              <select
                value={exemptType}
                onChange={(e) => setExemptType(e.target.value as 'role' | 'channel')}
                className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                <option value="role">role</option>
                <option value="channel">channel</option>
              </select>
            </Field>
          </div>
          <div className="flex-1">
            <Field label="ID" hint="a role or channel ID">
              <Input
                value={exemptId}
                onChange={(e) => setExemptId(e.target.value)}
                placeholder="e.g. 1540816150026518620"
              />
            </Field>
          </div>
          <Button type="submit" variant="primary" busy={exemptBusy}>
            Add exemption
          </Button>
        </form>
      </Card>

      <Card title="Lists">
        <div className="mt-2 text-sm">
          {detail.kind === 'keyword_filter' &&
            (detail.terms.length > 0 || detail.allowlist.length > 0) && (
              <div>
                {[...categories.entries()].map(([categoryId, texts]) => (
                  <p key={categoryId}>
                    Category {categoryId}: {texts.join(', ')}
                  </p>
                ))}
                {detail.allowlist.length > 0 && <p>Allowlist: {detail.allowlist.join(', ')}</p>}
                <p className="mt-1 text-ink-muted">
                  The keyword word list is seeded and has no editor; the Review page adds allowlist
                  phrases from real matches.
                </p>
              </div>
            )}
          {detail.kind === 'invite' && detail.inviteAllowlist.length > 0 && (
            <div>
              <p>
                Allowlisted codes:{' '}
                {detail.inviteAllowlist
                  .map((entry) =>
                    entry.label === '' ? entry.code : `${entry.code} (${entry.label})`,
                  )
                  .join(', ')}
              </p>
              <p className="mt-1 text-ink-muted">
                Edit invite codes with <code>bananasaurs automod invite-allow</code> /{' '}
                <code>invite-deny</code>.
              </p>
            </div>
          )}
          {detail.kind === 'link_domain' && detail.linkDomains.length > 0 && (
            <div>
              {detail.linkDomains.map((entry) => (
                <p key={`${entry.listType}:${entry.domain}`}>
                  {entry.domain} ({entry.listType})
                </p>
              ))}
              <p className="mt-1 text-ink-muted">
                Edit domains with <code>automod domain-add</code> / <code>domain-rm</code>.
              </p>
            </div>
          )}
          {((detail.kind === 'keyword_filter' &&
            detail.terms.length === 0 &&
            detail.allowlist.length === 0) ||
            (detail.kind === 'invite' && detail.inviteAllowlist.length === 0) ||
            (detail.kind === 'link_domain' && detail.linkDomains.length === 0) ||
            (detail.kind !== 'keyword_filter' &&
              detail.kind !== 'invite' &&
              detail.kind !== 'link_domain')) && <p className="text-ink-muted">No lists.</p>}
        </div>
      </Card>

      <Card title="Dry run">
        <p className="mt-2 text-sm text-ink-muted">
          Replays recorded matches against the current configuration without acting on anything.
          <HelpTip label="fixtures">
            Fixtures are real matches the rule recorded while observing. Replaying them shows what
            the current configuration would have caught, so tuning is safe.
          </HelpTip>
        </p>
        <div className="mt-2">
          <Button busy={dryBusy} onClick={() => void runDryRun()}>
            Run against fixtures
          </Button>
        </div>
        {report !== null && (
          <div className="mt-3">
            {report.usable ? (
              <p className="text-sm">Usable.</p>
            ) : (
              <p role="alert" className="text-sm text-danger">
                Not usable: {report.failure?.reason} — {report.failure?.detail}
              </p>
            )}
            {report.corpusSize === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">
                No fixtures yet. Matches recorded during the observe window become fixtures.
              </p>
            ) : (
              <>
                <dl className="mt-2 grid max-w-lg grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-muted">Fixtures</dt>
                  <dd>{report.corpusSize}</dd>
                  <dt className="text-ink-muted">Evaluated</dt>
                  <dd>{report.total}</dd>
                  <dt className="text-ink-muted">Matched</dt>
                  <dd>{report.matched}</dd>
                  <dt className="text-ink-muted">False positives</dt>
                  <dd>{report.falsePositives}</dd>
                  <dt className="text-ink-muted">False negatives</dt>
                  <dd>{report.falseNegatives}</dd>
                  <dt className="text-ink-muted">Errors</dt>
                  <dd>{report.threw}</dd>
                </dl>
                <div className="mt-3">
                  <DataTable
                    caption="Dry-run results"
                    rows={dryRows}
                    rowKey={(r) => r.fixtureId}
                    columns={[
                      { key: 'fixture', header: 'Fixture', cell: (r) => r.fixtureId },
                      {
                        key: 'label',
                        header: 'Label',
                        cell: (r) => r.label.replaceAll('_', ' '),
                      },
                      {
                        key: 'matched',
                        header: 'Matched',
                        cell: (r) => (r.matched ? 'yes' : 'no'),
                      },
                      { key: 'agreement', header: 'Agreement', cell: (r) => r.agreement },
                      {
                        key: 'outcome',
                        header: 'Outcome',
                        cell: (r) => (r.outcome === 'threw' ? 'error' : r.outcome),
                      },
                    ]}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * `/automod/:ruleId` (`useParams<{ ruleId: string }>()` from `wouter`). Loads
 * `GET /api/automod/rules/:ruleId` through `useResource`; a 404 renders the
 * error state naming the rule.
 */
export function AutomodRulePage() {
  const { ruleId } = useParams<{ ruleId: string }>();
  const session = useSession();
  const load = useCallback(
    () => session.read<RuleDetail>(`/api/automod/rules/${ruleId}`),
    [session, ruleId],
  );
  const detail = useResource(`rule ${ruleId}`, load);

  return (
    <>
      <PageHeader
        title={ruleId}
        purpose="One automod rule: its status, mode, configuration, and history."
      />
      <DataState resource={detail.resource}>
        {(loaded) => <RuleDetailView detail={loaded} reload={detail.reload} />}
      </DataState>
    </>
  );
}
