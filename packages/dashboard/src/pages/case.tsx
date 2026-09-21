import { useCallback } from 'react';
import { useParams } from 'wouter';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';
import type { ModCase } from './cases.js';

/** One event of a case, as `GET /api/mod/cases/:caseId` returns it. */
export interface ModCaseEvent {
  readonly eventId: string;
  readonly caseId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: string;
  readonly escalationAction: string | undefined;
  readonly refusalReason: string | undefined;
  readonly actorId: string | undefined;
  readonly trace: string | undefined;
}

/** One case with its events, oldest first as the page renders them. */
export interface ModCaseDetail {
  readonly case: ModCase;
  readonly events: readonly ModCaseEvent[];
}

const cellOrDash = (value: string | undefined): string => value ?? '—';

/**
 * `/cases/:caseId`: one moderation case and what the bot did about it. The
 * case renders as a `<dl>`, then its events oldest first. The `trace` JSON
 * sits behind a native `<details>` per event so it stays keyboard-operable
 * with no dependency; the snippet is a plain cell (ADR 0043 forbids monospace
 * for data).
 */
export function CasePage() {
  const { caseId } = useParams<{ caseId: string }>();
  const session = useSession();
  const load = useCallback(
    () => session.read<ModCaseDetail>(`/api/mod/cases/${caseId}`),
    [session, caseId],
  );
  const detail = useResource(`case ${caseId}`, load);

  return (
    <>
      <PageHeader title={caseId} purpose="One moderation case and what the bot did about it." />
      <DataState resource={detail.resource}>
        {({ case: item, events }) => {
          const ordered = [...events].sort((a, b) => a.at - b.at);
          return (
            <div className="grid gap-4">
              <Card title="Case">
                <dl className="grid max-w-lg gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                  <dt className="text-ink-muted">Case</dt>
                  <dd>{item.caseId}</dd>
                  <dt className="text-ink-muted">Member</dt>
                  <dd>{item.memberId}</dd>
                  <dt className="text-ink-muted">Opened</dt>
                  <dd>{new Date(item.openedAt).toLocaleString()}</dd>
                  <dt className="text-ink-muted">Violations</dt>
                  <dd>{item.violationCount}</dd>
                  <dt className="text-ink-muted">Tier</dt>
                  <dd>{item.escalationTier}</dd>
                  <dt className="text-ink-muted">Status</dt>
                  <dd>{item.status}</dd>
                </dl>
              </Card>
              <Card title="Events">
                {ordered.length === 0 ? (
                  <p className="text-sm text-ink-muted">
                    No events yet. Events appear here as the bot acts on this case.
                  </p>
                ) : (
                  <DataTable
                    caption="Case events"
                    rows={ordered}
                    rowKey={(e) => e.eventId}
                    columns={[
                      {
                        key: 'when',
                        header: 'When',
                        cell: (e) => new Date(e.at).toLocaleString(),
                      },
                      { key: 'rule', header: 'Rule', cell: (e) => e.ruleId },
                      { key: 'category', header: 'Category', cell: (e) => e.matchedCategory },
                      { key: 'snippet', header: 'Snippet', cell: (e) => e.matchedSnippet },
                      { key: 'action', header: 'Action taken', cell: (e) => e.actionTaken },
                      {
                        key: 'escalation',
                        header: 'Escalation',
                        cell: (e) => cellOrDash(e.escalationAction),
                      },
                      {
                        key: 'refusal',
                        header: 'Refusal',
                        cell: (e) => cellOrDash(e.refusalReason),
                      },
                      { key: 'actor', header: 'Actor', cell: (e) => cellOrDash(e.actorId) },
                      {
                        key: 'trace',
                        header: 'Trace',
                        cell: (e) =>
                          e.trace === undefined ? (
                            '—'
                          ) : (
                            <details>
                              <summary>Trace</summary>
                              <p className="max-w-md text-sm break-words whitespace-pre-wrap">
                                {e.trace}
                              </p>
                            </details>
                          ),
                      },
                    ]}
                  />
                )}
              </Card>
            </div>
          );
        }}
      </DataState>
    </>
  );
}
