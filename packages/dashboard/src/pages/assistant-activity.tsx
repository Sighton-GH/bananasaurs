import { useCallback } from 'react';
import { Link } from 'wouter';
import type { AssistantBehaviour, AssistantSkill } from '@bananasaurs/core';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { EmptyState } from '../ui/EmptyState.js';
import { PageHeader } from '../ui/PageHeader.js';
interface Activity {
  readonly id: string;
  readonly at: number;
  readonly behaviourId: string;
  readonly skillId: string;
  readonly outcome: string;
  readonly detail?: string;
}
interface Payload {
  readonly behaviours: readonly AssistantBehaviour[];
  readonly skills: readonly AssistantSkill[];
  readonly activity: readonly Activity[];
}
/**
 * `/assistant/activity`: the skill-activity ledger for this server, with
 * behaviour and skill ids resolved to the names the operator configured
 * (raw ids stay visible as a mono fallback when a row outlives its
 * behaviour). Refusals keep their recorded reason.
 */
export function AssistantActivityPage() {
  const session = useSession();
  const load = useCallback(() => session.read<Payload>('/api/assistant'), [session]);
  const activity = useResource('assistant skill activity', load);
  return (
    <>
      <PageHeader
        title="Assistant history"
        purpose="What the assistant tried (answers, tickets, refusals), which reviewed skill it used, and what happened."
        actions={
          <Link href="/assistant">
            <Button>Assistant</Button>
          </Link>
        }
      />
      <DataState
        resource={activity.resource}
        isEmpty={(data) => data.activity.length === 0}
        empty={
          <EmptyState
            title="No skill activity yet"
            detail="Activity appears after a permitted skill is attempted. Refusals are recorded with their reason."
          />
        }
      >
        {(data) => {
          const behaviourName = (id: string) =>
            data.behaviours.find((b) => b.id === id)?.name ?? id;
          const skillName = (id: string) => data.skills.find((s) => s.id === id)?.name ?? id;
          return (
            <DataTable
              caption="Assistant skill activity"
              rows={data.activity}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: 'time',
                  header: 'Time',
                  cell: (r) => new Date(r.at).toLocaleString('en-CA'),
                },
                {
                  key: 'behaviour',
                  header: 'Behaviour',
                  cell: (r) => {
                    const name = behaviourName(r.behaviourId);
                    return name === r.behaviourId ? (
                      <span className="font-mono text-xs">{r.behaviourId}</span>
                    ) : (
                      name
                    );
                  },
                },
                {
                  key: 'skill',
                  header: 'Skill',
                  cell: (r) => {
                    const name = skillName(r.skillId);
                    return name === r.skillId ? (
                      <span className="font-mono text-xs">{r.skillId}</span>
                    ) : (
                      name
                    );
                  },
                },
                {
                  key: 'outcome',
                  header: 'Outcome',
                  cell: (r) => (
                    <>
                      <Badge
                        tone={
                          r.outcome === 'refused'
                            ? 'hold'
                            : r.outcome === 'failed'
                              ? 'danger'
                              : 'ok'
                        }
                      >
                        {r.outcome}
                      </Badge>
                      {r.detail !== undefined && (
                        <span className="ml-2 text-xs text-ink-muted">{r.detail}</span>
                      )}
                    </>
                  ),
                },
              ]}
            />
          );
        }}
      </DataState>
    </>
  );
}
