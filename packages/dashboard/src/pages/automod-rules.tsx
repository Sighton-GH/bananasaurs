import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { ApiError } from '../api.js';
import {
  CUTOVER_STAGE_HELP,
  CUTOVER_STAGE_LABEL,
  daysObserved,
  OBSERVED_HELP,
  REVIEWED_HELP,
  RULE_CONFIG_EXAMPLE,
  RULE_KIND_LABEL,
  RULE_KINDS,
  RULE_MODE_HELP,
  type RuleKind,
  type RuleMode,
  type RuleSummary,
} from '../api/automod.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { ErrorNotice } from '../ui/ErrorNotice.js';
import { RuleConfigExample } from './automod-config-example.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Field, Input } from '../ui/Field.js';
import { HelpTip } from '../ui/HelpTip.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

const modeTone = (mode: RuleMode): 'hold' | 'danger' | 'neutral' =>
  mode === 'observe' ? 'hold' : mode === 'enforce' ? 'danger' : 'neutral';

const cutoverTone = (state: string): 'hold' | 'danger' | 'neutral' =>
  state === 'observing'
    ? 'hold'
    : state === 'cutover' || state === 'rolled_back'
      ? 'danger'
      : 'neutral';

/**
 * `/automod`: every rule, its mode, and how far through its observe window
 * it is — plus the new-rule form. Creating a rule changes what the bot does
 * to real messages, so the route needs a fresh password (the re-auth round
 * trip is `apiFetch`'s); the form reads the 400/409 answers itself through
 * `writeOrThrow` rather than `write`'s generic toast.
 */
export function AutomodRulesPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(
    () => session.read<{ rules: RuleSummary[] }>('/api/automod/rules').then((r) => r.rules),
    [session],
  );
  const rules = useResource('the automod rules', load);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<RuleKind>('keyword_filter');
  const [configText, setConfigText] = useState('{}');
  const [configError, setConfigError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setConfigError(undefined);
    setFormError(undefined);
    let config: unknown;
    try {
      config = JSON.parse(configText) as unknown;
    } catch {
      setConfigError('Not valid JSON');
      return;
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      setConfigError('Configuration must be a JSON object.');
      return;
    }
    setBusy(true);
    try {
      const result = await session.writeOrThrow<{ ok: boolean }>('/api/automod/rules', {
        ruleId: name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
        kind,
        name,
        config,
      });
      if (result === undefined) return;
      toast({ tone: 'ok', title: 'Rule created' });
      setName('');
      setKind('keyword_filter');
      setConfigText('{}');
      rules.reload();
    } catch (err) {
      // The 400 branch stays: the route's own `detail` names the exact
      // schema violation, which says more than the catalog text. Anything
      // else renders as the server's answer below.
      if (err instanceof ApiError && err.status === 400 && err.body.error === 'invalid-config') {
        const detail = (err.body as { detail?: unknown }).detail;
        setConfigError(
          typeof detail === 'string' ? detail : 'The configuration is invalid for this kind.',
        );
      } else {
        setFormError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Automod"
        purpose="Every rule, what mode it is in, and how far through its observe window it is."
      />
      <DataState
        resource={rules.resource}
        isEmpty={(r) => r.length === 0}
        empty={<p className="text-sm text-ink-muted">No rules yet. Create one below.</p>}
      >
        {(rows) => {
          const observing = rows.filter((r) => r.cutoverState === 'observing').length;
          const enforcing = rows.filter((r) => r.mode === 'enforce').length;
          return (
            <>
              <div className="mb-4 grid max-w-4xl gap-3 sm:grid-cols-3">
                <Card title="Rules">
                  <p className="text-2xl font-semibold">{rows.length}</p>
                </Card>
                <Card title="Observing">
                  <p className="text-2xl font-semibold">{observing}</p>
                  <p className="mt-1 text-xs text-ink-muted">collecting matches without acting</p>
                </Card>
                <Card title="Enforcing">
                  <p className="text-2xl font-semibold">{enforcing}</p>
                  <p className="mt-1 text-xs text-ink-muted">
                    a rule acts only after its observe window
                  </p>
                </Card>
              </div>
              <Card title="All rules">
                <DataTable
                  caption="Automod rules"
                  rows={rows}
                  rowKey={(r) => r.ruleId}
                  columns={[
                    {
                      key: 'rule',
                      header: 'Rule',
                      cell: (r) => <Link href={`/automod/${r.ruleId}`}>{r.name}</Link>,
                    },
                    {
                      key: 'kind',
                      header: 'Kind',
                      cell: (r) => (
                        <>
                          {RULE_KIND_LABEL[r.kind]}{' '}
                          <span className="text-ink-muted">({r.kind})</span>
                        </>
                      ),
                    },
                    {
                      key: 'enabled',
                      header: 'Enabled',
                      cell: (r) => <Badge>{r.enabled ? 'on' : 'off'}</Badge>,
                    },
                    {
                      key: 'mode',
                      header: (
                        <>
                          Mode
                          <HelpTip label="rule modes">
                            test {RULE_MODE_HELP.test} observe {RULE_MODE_HELP.observe} enforce{' '}
                            {RULE_MODE_HELP.enforce}
                          </HelpTip>
                        </>
                      ),
                      mobileLabel: 'Mode',
                      cell: (r) => <Badge tone={modeTone(r.mode)}>{r.mode}</Badge>,
                    },
                    {
                      key: 'cutover',
                      header: (
                        <>
                          Stage
                          <HelpTip label="the stage column">{CUTOVER_STAGE_HELP}</HelpTip>
                        </>
                      ),
                      mobileLabel: 'Stage',
                      cell: (r) => (
                        <Badge tone={cutoverTone(r.cutoverState)}>
                          {CUTOVER_STAGE_LABEL[r.cutoverState]}
                        </Badge>
                      ),
                    },
                    {
                      key: 'observed',
                      header: (
                        <>
                          Observed
                          <HelpTip label="the observed column">{OBSERVED_HELP}</HelpTip>
                        </>
                      ),
                      mobileLabel: 'Observed',
                      cell: (r) => {
                        const days = daysObserved(r.observeStartedAt, Date.now());
                        return days === null ? '—' : `${String(days)} days`;
                      },
                    },
                    { key: 'matches', header: 'Matches', numeric: true, cell: (r) => r.matchCount },
                    {
                      key: 'reviewed',
                      header: (
                        <>
                          Reviewed
                          <HelpTip label="the reviewed column">{REVIEWED_HELP}</HelpTip>
                        </>
                      ),
                      mobileLabel: 'Reviewed',
                      numeric: true,
                      cell: (r) => (
                        <Link href={`/review?rule=${encodeURIComponent(r.ruleId)}`}>
                          {`${String(r.verdicts.falsePositive + r.verdicts.truePositive + r.verdicts.unclear)} (${String(r.verdicts.falsePositive)} false ${r.verdicts.falsePositive === 1 ? 'positive' : 'positives'})`}
                        </Link>
                      ),
                    },
                  ]}
                />
              </Card>
            </>
          );
        }}
      </DataState>
      <div className="mt-6 max-w-md">
        <Card title="New rule">
          <form onSubmit={(e) => void submit(e)} className="grid gap-3">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. No invites"
              />
            </Field>
            <Field label="Kind">
              <select
                value={kind}
                onChange={(e) => {
                  const next = e.target.value as RuleKind;
                  setKind(next);
                  setConfigText(RULE_CONFIG_EXAMPLE[next].json);
                }}
                className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                {RULE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {RULE_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-sm text-ink-muted">
              A safe starting configuration is filled in for this rule type. You can change it after
              creating the rule.
            </p>
            <details>
              <summary className="cursor-pointer text-sm">Advanced configuration</summary>
              <Field
                label="Configuration data"
                hint="For experienced operators only"
                {...(configError !== undefined ? { error: configError } : {})}
              >
                <textarea
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  rows={4}
                  className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
                />
              </Field>
              <RuleConfigExample
                key={kind}
                kind={kind}
                onUse={(json) => {
                  setConfigText(json);
                  setConfigError(undefined);
                }}
              />
            </details>
            {formError !== undefined && <ErrorNotice error={formError} />}
            <div>
              <Button type="submit" variant="primary" busy={busy}>
                Create rule
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
