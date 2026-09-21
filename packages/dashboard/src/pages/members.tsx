import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import type { GuildMemberPage } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

/**
 * `/members`: the member directory — the MCP `list_members` tool as a page
 * (ADR 0051). The server pages Discord 25 members at a time (a paginated
 * REST read, not the truncated gateway cache), and this page walks that
 * cursor. Each row links to the member's case history, which is the question
 * the directory usually answers next.
 */
export function MembersPage() {
  const session = useSession();
  // The cursor for the current page, and the stack of cursors that got here
  // so "previous" can walk back without Discord supporting backwards paging.
  const [after, setAfter] = useState<string | undefined>(undefined);
  const [trail, setTrail] = useState<readonly (string | undefined)[]>([]);

  const load = useCallback(
    () =>
      session.read<GuildMemberPage>(
        after === undefined ? '/api/guild/members' : `/api/guild/members?after=${after}`,
      ),
    [session, after],
  );
  const directory = useResource('the member directory', load);

  return (
    <>
      <PageHeader
        title="Members"
        purpose="Everyone in the server, 25 at a time: who they are, when they joined, and their case history one click away."
      />
      <DataState
        resource={directory.resource}
        isEmpty={(p) => p.members.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No members came back — the guild may not have reached the bot yet.
          </p>
        }
      >
        {(page) => (
          <>
            <DataTable
              caption="Guild members"
              rows={page.members}
              rowKey={(m) => m.memberId}
              columns={[
                {
                  key: 'member',
                  header: 'Member',
                  cell: (m) => (
                    <span>
                      {m.displayName} <span className="text-xs text-ink-muted">@{m.username}</span>
                    </span>
                  ),
                },
                { key: 'id', header: 'ID', cell: (m) => m.memberId },
                {
                  key: 'joined',
                  header: 'Joined',
                  cell: (m) =>
                    m.joinedAt === null ? (
                      <span className="text-ink-muted">unknown</span>
                    ) : (
                      new Date(m.joinedAt).toISOString().slice(0, 10)
                    ),
                },
                {
                  key: 'roles',
                  header: 'Roles',
                  cell: (m) => m.roleIds.length,
                  numeric: true,
                },
                {
                  key: 'actions',
                  header: '',
                  cell: (m) => <Link href={`/members/${m.memberId}`}>Case history</Link>,
                },
              ]}
            />
            {(page.nextAfter !== undefined || trail.length > 0) && (
              <div className="mt-3 flex gap-2">
                <Button
                  disabled={trail.length === 0}
                  onClick={() => {
                    const previous = trail[trail.length - 1];
                    setTrail((t) => t.slice(0, -1));
                    setAfter(previous);
                  }}
                >
                  Previous page
                </Button>
                <Button
                  disabled={page.nextAfter === undefined}
                  onClick={() => {
                    setTrail((t) => [...t, after]);
                    setAfter(page.nextAfter);
                  }}
                >
                  Next page
                </Button>
              </div>
            )}
          </>
        )}
      </DataState>
    </>
  );
}
