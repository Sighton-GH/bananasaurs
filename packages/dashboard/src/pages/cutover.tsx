import { useCallback } from 'react';
import { daysObserved, OBSERVE_FLOOR_DAYS, type CutoverState, type RuleSummary } from '../api/automod.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

const stateTone = (state: CutoverState): 'hold' | 'danger' | 'neutral' =>
  state === 'observing' ? 'hold' : state === 'cutover' || state === 'rolled_back' ? 'danger' : 'neutral';

const observedCell = (rule: RuleSummary): string => {
  const days = daysObserved(rule.observeStartedAt, Date.now());
  if (days === null) return '—';
  return rule.cutoverState === 'observing' && days < OBSERVE_FLOOR_DAYS
    ? `${String(days)} of ${String(OBSERVE_FLOOR_DAYS)}`
    : `${String(days)} days`;
};

const signoffCell = (rule: RuleSummary): string =>
  rule.enforceSignedOffBy !== null && rule.enforceSignedOffAt !== null
    ? `${rule.enforceSignedOffBy} at ${new Date(rule.enforceSignedOffAt).toLocaleString()}`
    : '—';

/**
 * `/cutover`: where each rule stands on its way from observe to enforce.
 * This board reports; enforcement is offered only by the release gate
 * (ADR 0042), so nothing here moves anything.
 */
export function CutoverPage() {
  const session = useSession();
  const load = useCallback(
    () => session.read<{ rules: RuleSummary[] }>('/api/automod/rules').then((r) => r.rules),
    [session],
  );
  const rules = useResource('the automod rules', load);

  return (
    <>
      <PageHeader
        title="Cutover"
        purpose="Where each rule stands on its way from observe to enforce."
      />
      <p className="mb-4 text-sm text-ink-muted">
        Enforcement is offered only by the release gate (ADR 0042); this board reports, it does
        not move anything.
      </p>
      <DataState
        resource={rules.resource}
        isEmpty={(r) => r.length === 0}
        empty={
          <p className="text-sm text-ink-muted">No rules yet. Create one on the Automod page.</p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Cutover board"
            rows={rows}
            rowKey={(r) => r.ruleId}
            columns={[
              { key: 'rule', header: 'Rule', cell: (r) => r.name },
              {
                key: 'legacy',
                header: 'Legacy rule ref',
                cell: (r) => r.legacyRuleRef ?? '—',
              },
              {
                key: 'state',
                header: 'Cutover state',
                cell: (r) => <Badge tone={stateTone(r.cutoverState)}>{r.cutoverState}</Badge>,
              },
              { key: 'observed', header: 'Observed', cell: observedCell },
              { key: 'matches', header: 'Matches', numeric: true, cell: (r) => r.matchCount },
              { key: 'reviewed', header: 'Reviewed', numeric: true, cell: (r) => r.reviewedCount },
              { key: 'signoff', header: 'Sign-off', cell: signoffCell },
            ]}
          />
        )}
      </DataState>
    </>
  );
}
