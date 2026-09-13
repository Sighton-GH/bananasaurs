import { useCallback, useState } from 'react';
import { useParams } from 'wouter';
import { ApiError } from '../api.js';
import {
  OBSERVE_FLOOR_DAYS,
  daysObserved,
  type CutoverState,
  type DryRunReport,
  type RuleDetail,
  type RuleMode,
} from '../api/automod.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

const DAY_MS = 86_400_000;

type Refusal = { readonly reason: string; readonly [k: string]: unknown };

const refusalSentence = (refusal: Refusal): string => {
  switch (refusal.reason) {
    case 'cutover-state':
      return `Not offerable: cutover state is ${String(refusal.state)}.`;
    case 'low-volume-unsigned':
      return `Not offerable: ${String(refusal.reviewed)} of ${String(refusal.required)} matches reviewed and no sign-off.`;
    case 'false-positive':
      return `Not offerable: ${String(refusal.falsePositives)} false-positive or unclear verdicts among ${String(refusal.reviewed)} reviewed.`;
    case 'rate-too-high':
      return `Not offerable: false-positive rate ${String(refusal.rate)} exceeds ${String(refusal.threshold)}.`;
    default:
      return `Not offerable: ${refusal.reason}.`;
  }
};

const eligibilitySentence = (eligibility: RuleDetail['eligibility']): string =>
  eligibility.ok ? 'Enforcement is offerable.' : refusalSentence(eligibility.refusal);

/**
 * The `ConfirmDialog` scope for a mode change, computed client-side from the
 * current cutover state and the request (PR-48). The sentence is chosen by
 * `mode` when one is requested, and by `enabled` only when no `mode` is —
 * the server's precedence: `mode` drives the state machine, `enabled` alone
 * never moves it.
 */
const modeScopeSentence = (input: {
  readonly currentMode: RuleMode;
  readonly cutoverState: CutoverState;
  readonly requestedMode: RuleMode | undefined;
  readonly requestedEnabled: boolean | undefined;
  readonly now: number;
}): string => {
  if (input.requestedMode === 'enforce') {
    return 'Enforces this rule for real. Its cutover state becomes cutover and the bot starts acting on matches.';
  }
  if (
    input.requestedMode === 'observe' &&
    (input.cutoverState === 'not_started' || input.cutoverState === 'rolled_back')
  ) {
    const elapses = new Date(input.now + OBSERVE_FLOOR_DAYS * DAY_MS).toLocaleDateString();
    return `Starts this rule's observe window now. The two-week floor elapses on ${elapses}.`;
  }
  if (input.requestedMode === 'test' && input.cutoverState === 'observing') {
    return 'Switches to test mode: the rule keeps matching and recording fixtures but stops deleting; its cutover state stays observing and its clock keeps running, so the window will elapse with a gap in its evidence.';
  }
  if (input.requestedMode !== undefined && input.cutoverState === 'cutover') {
    return 'Rolls this rule back from enforcement and withdraws its sign-off; it must observe again before it can enforce.';
  }
  if (input.requestedMode !== undefined) {
    return `Changes mode from ${input.currentMode} to ${input.requestedMode}; cutover state stays ${input.cutoverState}.`;
  }
  if (input.requestedEnabled === false) {
    return 'Disables the rule. Its cutover state and clock are unchanged.';
  }
  return `Enables the rule in its current mode, ${input.currentMode}.`;
};

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
  const scopeSentence = modeScopeSentence({
    currentMode: detail.mode,
    cutoverState: detail.cutoverState,
    requestedMode: modeChanged ? modeSel : undefined,
    requestedEnabled: enabledChanged ? enabledSel : undefined,
    now: Date.now(),
  });

  const applyMode = async () => {
    const body: { mode?: RuleMode; enabled?: boolean } = {
      ...(modeChanged ? { mode: modeSel } : {}),
      ...(enabledChanged ? { enabled: enabledSel } : {}),
    };
    setModeBusy(true);
    try {
      await session.writeOrThrow<{ ok: boolean }>(`${ruleUrl}/mode`, body);
      toast({ tone: 'ok', title: 'Mode applied' });
      setModeOpen(false);
      reload();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 401 &&
        (err.body as { error?: string }).error === 'reauth-required'
      ) {
        toast({ tone: 'neutral', title: 'Cancelled', message: 'Nothing was changed.' });
        setModeOpen(false);
      } else if (err instanceof ApiError && err.status === 409) {
        const refusal = (err.body as { refusal?: Refusal }).refusal;
        const sentence = refusal !== undefined ? refusalSentence(refusal) : err.message;
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
      await session.writeOrThrow<{ ok: boolean }>(`${ruleUrl}/config`, { config }, 'PUT');
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
      <section>
        <h2 className="text-lg">Status</h2>
        <dl className="mt-2 grid max-w-lg grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Kind</dt>
          <dd>{detail.kind}</dd>
          <dt className="text-ink-muted">Enabled</dt>
          <dd>{detail.enabled ? 'On' : 'Off'}</dd>
          <dt className="text-ink-muted">Mode</dt>
          <dd>{detail.mode}</dd>
          <dt className="text-ink-muted">Cutover state</dt>
          <dd>{detail.cutoverState}</dd>
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
      </section>

      <section className="mt-6">
        <h2 className="text-lg">Mode</h2>
        <fieldset className="mt-2">
          <legend className="text-sm text-ink-muted">Mode</legend>
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
                {mode}
              </label>
            ))}
          </div>
        </fieldset>
        {!detail.eligibility.ok && (
          <p className="mt-1 text-sm text-ink-muted">
            Enforce is unavailable: {eligibilitySentence(detail.eligibility)}
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
      </section>

      <section className="mt-6">
        <h2 className="text-lg">Configuration</h2>
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
      </section>

      <section className="mt-6">
        <h2 className="text-lg">Exemptions</h2>
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
      </section>

      <section className="mt-6">
        <h2 className="text-lg">Lists</h2>
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
                  The keyword word list has no editor yet — it is seeded, and Slice 9&apos;s review
                  screen adds allowlist terms.
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
      </section>

      <section className="mt-6">
        <h2 className="text-lg">Dry run</h2>
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
                  <dt className="text-ink-muted">Corpus size</dt>
                  <dd>{report.corpusSize}</dd>
                  <dt className="text-ink-muted">Evaluated</dt>
                  <dd>{report.total}</dd>
                  <dt className="text-ink-muted">Matched</dt>
                  <dd>{report.matched}</dd>
                  <dt className="text-ink-muted">False positives</dt>
                  <dd>{report.falsePositives}</dd>
                  <dt className="text-ink-muted">False negatives</dt>
                  <dd>{report.falseNegatives}</dd>
                  <dt className="text-ink-muted">Threw</dt>
                  <dd>{report.threw}</dd>
                </dl>
                <div className="mt-3">
                  <DataTable
                    caption="Dry-run results"
                    rows={dryRows}
                    rowKey={(r) => r.fixtureId}
                    columns={[
                      { key: 'fixture', header: 'Fixture', cell: (r) => r.fixtureId },
                      { key: 'label', header: 'Label', cell: (r) => r.label },
                      {
                        key: 'matched',
                        header: 'Matched',
                        cell: (r) => (r.matched ? 'yes' : 'no'),
                      },
                      { key: 'agreement', header: 'Agreement', cell: (r) => r.agreement },
                      { key: 'outcome', header: 'Outcome', cell: (r) => r.outcome },
                    ]}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </section>
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
