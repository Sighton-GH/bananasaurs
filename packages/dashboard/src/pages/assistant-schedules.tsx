import { useCallback } from 'react';
import {
  ASSISTANT_URL,
  reminderCancelUrl,
  type AssistantData,
  type ReminderRow,
} from '../api/assistant.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { HelpTip } from '../ui/HelpTip.js';
import { PageHeader } from '../ui/PageHeader.js';
import { reminderTone } from './assistant-shared.js';

/**
 * `/assistant/schedules`: reminders with destination, run time, honest
 * status including failures, and cancellation (ADR 0060). Reminders are
 * created in Discord by asking the bot after the requester confirms; this page
 * reports and cancels, it does not create.
 */
export function AssistantSchedulesPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant schedules', load);
  return (
    <>
      <PageHeader
        title="Schedules"
        purpose="Reminders the assistant will post, and what already went out."
      />
      <DataState
        resource={assistant.resource}
        isEmpty={(data) => data.reminders.length === 0}
        empty={
          <Card title="Reminders">
            <p className="text-sm text-ink-muted">
              No reminders scheduled. Members set reminders by asking the bot after
              confirming the details; nothing here creates one.
            </p>
          </Card>
        }
      >
        {(data) => {
          const channelName = (id: string) => data.channels?.find((c) => c.id === id)?.name;
          const failed = data.reminders.filter((r) => r.status === 'failed').length;
          return (
            <Card title="Reminders">
              <p className="mb-3 text-sm text-ink-muted">
                Pending deliveries, destinations and honest delivery state.{' '}
                <HelpTip label="reminder status">
                  Scheduled means waiting for its time. Delivering means sending right now.
                  Delivered means it reached its destination. Failed means the bot gave up after
                  retrying; nothing else happens until a new reminder is created in Discord.
                </HelpTip>
                {failed > 0 && (
                  <span className="mt-1 block text-xs font-medium text-danger">
                    {failed} failed - the bot retried and gave up; no reminder is delivered
                  </span>
                )}
              </p>
              <DataTable
                caption="Assistant reminders"
                rows={[...data.reminders].sort((a, b) => a.dueAt - b.dueAt)}
                rowKey={(r: ReminderRow) => r.id}
                columns={[
                  { key: 'reminder', header: 'Reminder', cell: (r) => r.text },
                  {
                    key: 'when',
                    header: 'Runs at',
                    cell: (r) => new Date(r.dueAt).toLocaleString('en-CA'),
                  },
                  {
                    key: 'destination',
                    header: 'Destination',
                    cell: (r) => {
                      const name = channelName(r.destinationId);
                      return name === undefined ? (
                        <span className="font-mono text-xs">{r.destinationId}</span>
                      ) : (
                        `#${name}`
                      );
                    },
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    cell: (r) => <Badge tone={reminderTone(r.status)}>{r.status}</Badge>,
                  },
                  {
                    key: 'action',
                    header: 'Action',
                    cell: (r) =>
                      r.status === 'scheduled' ? (
                        <Button
                          onClick={() =>
                            void session
                              .write(reminderCancelUrl(r.id), {})
                              .then((result) => result !== undefined && assistant.reload())
                          }
                        >
                          Cancel
                        </Button>
                      ) : (
                        <span className="text-xs text-ink-muted">None</span>
                      ),
                  },
                ]}
              />
            </Card>
          );
        }}
      </DataState>
    </>
  );
}
