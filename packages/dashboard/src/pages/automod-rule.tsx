import { useCallback, useState } from 'react';
import { useParams } from 'wouter';
import { ApiError } from '../api.js';
import { RULE_KIND_LABEL, type RuleDetail } from '../api/automod.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { describeError } from '../api/describe-error.js';
import { RuleConfigExample } from './automod-config-example.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { ChannelPicker } from '../ui/ChannelPicker.js';
import { Checkbox, Field } from '../ui/Field.js';
import { RolePicker } from '../ui/RolePicker.js';
import { Card } from '../ui/Card.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * `/automod/:ruleId`: one rule's status, enabled flag, configuration,
 * exemptions and lists. Mounted only once the detail has loaded, so every piece
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

  const [enabledBusy, setEnabledBusy] = useState(false);

  // ADR 0121: a rule is on or off; whether enabled rules act is the guild's
  // automod switch. Turning a rule on asks for the password again (the
  // route's ADR 0029 asymmetry); `write` handles that round trip.
  const setEnabled = async (enabled: boolean) => {
    setEnabledBusy(true);
    try {
      const result = await session.write<{ ok: boolean }>(`${ruleUrl}/enabled`, { enabled });
      if (result === undefined) return;
      toast({ tone: 'ok', title: enabled ? 'Rule enabled' : 'Rule disabled' });
      reload();
    } finally {
      setEnabledBusy(false);
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
      } else {
        const d = describeError(err);
        toast({
          tone: 'danger',
          title: d.title,
          message: [d.message, d.hint].filter(Boolean).join(' '),
          detail: [
            d.code,
            d.status !== undefined ? `HTTP ${d.status}` : undefined,
            d.requestId !== undefined ? `request ${d.requestId}` : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
        });
        setConfigOpen(false);
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

  const categories = new Map<string, string[]>();
  for (const term of detail.terms) {
    const group = categories.get(term.categoryId) ?? [];
    group.push(term.text);
    categories.set(term.categoryId, group);
  }

  return (
    <>
      <Card title="Status">
        <dl className="mt-2 grid max-w-lg grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Kind</dt>
          <dd>
            {RULE_KIND_LABEL[detail.kind]} <span className="text-ink-muted">({detail.kind})</span>
          </dd>
          <dt className="text-ink-muted">Matches</dt>
          <dd>{detail.matchCount}</dd>
          <dt className="text-ink-muted">Flagged</dt>
          <dd>{detail.reviewedCount}</dd>
        </dl>
        <div className="mt-3">
          <Checkbox
            label="Enabled"
            checked={detail.enabled}
            disabled={enabledBusy}
            onChange={(e) => void setEnabled(e.target.checked)}
          />
          <p className="mt-1 text-sm text-ink-muted">
            A disabled rule is skipped even when automod is on.
          </p>
        </div>
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
              Replaces this rule&apos;s configuration. Matches recorded before now were produced by
              the old configuration.
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
            {exemptType === 'channel' ? (
              <ChannelPicker
                label="Channel"
                hint="Search for the channel this rule ignores."
                value={exemptId}
                onChange={setExemptId}
              />
            ) : (
              <RolePicker
                label="Role"
                hint="Search for the role this rule ignores."
                value={exemptId}
                onChange={setExemptId}
              />
            )}
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
        purpose="One automod rule: whether it is enabled, its configuration, and its exemptions."
      />
      <DataState resource={detail.resource}>
        {(loaded) => <RuleDetailView detail={loaded} reload={detail.reload} />}
      </DataState>
    </>
  );
}
