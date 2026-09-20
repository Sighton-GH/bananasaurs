import { useCallback } from 'react';
import {
  daysObserved,
  OBSERVE_FLOOR_DAYS,
  type CutoverState,
  type RuleSummary,
} from '../api/automod.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

const stateTone = (state: CutoverState): 'hold' | 'danger' | 'neutral' =>
  state === 'observing'
    ? 'hold'
    : state === 'cutover' || state === 'rolled_back'
      ? 'danger'
      : 'neutral';

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
        Enforcement is offered only by the release gate (ADR 0042); this board reports, it does not
        move anything.
      </p>
      <DataState
        resource={rules.resource}
        isEmpty={(r) => r.length === 0}
        empty={
          <p className="text-sm text-ink-muted">No rules yet. Create one on the Automod page.</p>
        }
      >
        {(rows) => {
          const observing = rows.filter((r) => r.cutoverState === 'observing').length;
          const pastFloor = rows.filter(
            (r) =>
              r.cutoverState === 'observing' &&
              (daysObserved(r.observeStartedAt, Date.now()) ?? 0) >= OBSERVE_FLOOR_DAYS,
          ).length;
          return (
            <>
              <div className="mb-4 grid max-w-4xl gap-3 sm:grid-cols-3">
                <Card title="Rules on the board">
                  <p className="text-2xl font-semibold">{rows.length}</p>
                </Card>
                <Card title="Still observing">
                  <p className="text-2xl font-semibold">{observing}</p>
                </Card>
                <Card title="Past the observe floor">
                  <p className="text-2xl font-semibold">{pastFloor}</p>
                  <p className="mt-1 text-xs text-ink-muted">
                    the floor is necessary, not sufficient: the release gate also reads the review
                    tally (ADR 0042)
                  </p>
                </Card>
              </div>
              <Card title="Every rule">
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
                    {
                      key: 'falsePositive',
                      header: 'False positive',
                      numeric: true,
                      cell: (r) => r.verdicts.falsePositive,
                    },
                    {
                      key: 'truePositive',
                      header: 'True positive',
                      numeric: true,
                      cell: (r) => r.verdicts.truePositive,
                    },
                    {
                      key: 'unclear',
                      header: 'Unclear',
                      numeric: true,
                      cell: (r) => r.verdicts.unclear,
                    },
                    { key: 'signoff', header: 'Sign-off', cell: signoffCell },
                  ]}
                />
              </Card>
            </>
          );
        }}
      </DataState>
    </>
  );
}
