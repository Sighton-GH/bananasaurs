import { useCallback, useRef, useState } from 'react';
import { useResource } from '../../../hooks/useResource.js';
import { useSession } from '../../../app/session.js';
import { ApiError } from '../../../api.js';
import { describeError } from '../../../api/describe-error.js';
import { useToast } from '../../../ui/Toast.js';
import { Button } from '../../../ui/Button.js';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js';
import { DataState } from '../../../ui/DataState.js';
import { DataTable } from '../../../ui/DataTable.js';
import { Field, Input } from '../../../ui/Field.js';
import { InlineAlert } from '../../../ui/InlineAlert.js';
import { Select } from '../../../ui/Select.js';
import { type StoredMember, type DirectoryMember } from './types.js';

export function MembersSection({ teamId, teamName }: { teamId: string; teamName: string }) {
  const session = useSession();
  const toast = useToast();
  // apiFetch returns undefined for HTTP 204, so every HTTP refusal must throw
  // here instead of sharing Session's handled-error/undefined return value.
  const deleteFailureStatuses = Array.from({ length: 300 }, (_, i) => i + 300);
  const toastDeleteRefusal = (err: unknown): boolean => {
    if (!(err instanceof ApiError) || err.status === 400 || err.status === 409) return false;
    // Session already displayed the expired-session notice and logged out.
    if (err.status === 401 && err.body.error === 'unauthenticated') return true;
    const d = describeError(err);
    const cancelled = err.status === 401 && err.body.error === 'reauth-required';
    const rejectedPassword = err.status === 401 && err.body.error === 'invalid-credentials';
    toast({
      tone: cancelled ? 'neutral' : err.status === 503 ? 'hold' : 'danger',
      title: cancelled
        ? 'Cancelled'
        : rejectedPassword
          ? 'Password not accepted'
          : err.status === 503
            ? 'This instance is read-only'
            : d.title,
      message: cancelled
        ? 'Nothing was changed.'
        : rejectedPassword
          ? 'Nothing was changed. Try again.'
          : [d.message, d.hint].filter(Boolean).join(' '),
      ...(cancelled
        ? {}
        : {
            detail: [
              d.code,
              `HTTP ${err.status}`,
              d.requestId !== undefined ? `request ${d.requestId}` : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
          }),
    });
    return true;
  };
  const membersLoad = useCallback(
    () => session.read<{ members: StoredMember[] }>(`/api/tasks/teams/${teamId}/members`),
    [session, teamId],
  );
  const members = useResource(`members of ${teamName}`, membersLoad);
  const directoryLoad = useCallback(
    () => session.read<{ members: DirectoryMember[] }>('/api/guild/members?limit=100'),
    [session],
  );
  const directory = useResource('member directory', directoryLoad);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState('');
  const [kind, setKind] = useState<'member' | 'lead'>('member');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<StoredMember | undefined>(undefined);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const removedRef = useRef(false);

  // The member directory answers GET /api/guild/members (paged, no search
  // query), so the search box filters that page client-side by name or id.
  const matches =
    directory.resource.state === 'ready' && query.trim() !== ''
      ? directory.resource.data.members
          .filter((m) => {
            const q = query.trim().toLowerCase();
            return (
              m.displayName.toLowerCase().includes(q) ||
              m.username.toLowerCase().includes(q) ||
              m.memberId.includes(q)
            );
          })
          .slice(0, 10)
      : [];

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!picked) {
      setError('Search the directory and choose a member to add.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await session.writeOrThrow('/api/tasks/memberships', {
        teamId,
        discordUserId: picked,
        kind,
      });
      if (result === undefined) return;
      setQuery('');
      setPicked('');
      members.reload();
    } catch (err) {
      setError(err instanceof ApiError ? describeError(err).message : 'Could not add the member.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (discordUserId: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await session.writeOrThrow(
        `/api/tasks/memberships/${teamId}/${discordUserId}`,
        undefined,
        'DELETE',
        deleteFailureStatuses,
      );
      removedRef.current = true;
      members.reload();
    } catch (err) {
      if (toastDeleteRefusal(err)) return;
      setError(
        err instanceof ApiError ? describeError(err).message : 'Could not remove the member.',
      );
    } finally {
      setPendingRemove(undefined);
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <h2 ref={headingRef} tabIndex={-1} className="text-section font-semibold">
        Members of {teamName}
      </h2>
      {error && (
        <InlineAlert tone="danger" title="That did not work">
          {error}
        </InlineAlert>
      )}
      <DataState resource={members.resource}>
        {(data) =>
          data.members.length === 0 ? (
            <p className="text-body text-ink-muted">No members yet.</p>
          ) : (
            <DataTable
              caption={`Members of ${teamName}`}
              rows={data.members}
              rowKey={(m) => m.discordUserId}
              columns={[
                { key: 'member', header: 'Member', cell: (m) => m.displayName ?? m.discordUserId },
                {
                  key: 'role',
                  header: 'Role',
                  cell: (m) => (m.kind === 'lead' ? 'Lead' : 'Member'),
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  mobileLabel: 'Actions',
                  cell: (m) => (
                    <Button busy={busy} onClick={() => setPendingRemove(m)}>
                      Remove
                    </Button>
                  ),
                },
              ]}
            />
          )
        }
      </DataState>
      <form onSubmit={(event) => void add(event)} className="grid max-w-xl gap-3" noValidate>
        <h3 className="text-section font-semibold">Add member</h3>
        <Field label="Search the member directory">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPicked('');
            }}
            placeholder="Name or user id"
          />
        </Field>
        {query.trim() !== '' && (
          <DataState resource={directory.resource}>
            {() =>
              matches.length === 0 ? (
                <p className="text-body text-ink-muted">No matches.</p>
              ) : (
                <Field label="Choose member">
                  <Select
                    value={picked === '' ? undefined : picked}
                    placeholder="Choose member"
                    onValueChange={setPicked}
                    options={matches.map((m) => ({
                      value: m.memberId,
                      label: `${m.displayName} (${m.memberId})`,
                    }))}
                  />
                </Field>
              )
            }
          </DataState>
        )}
        <Field label="Team role">
          <Select
            value={kind}
            onValueChange={(value) => setKind(value as 'member' | 'lead')}
            options={[
              { value: 'member', label: 'Member' },
              { value: 'lead', label: 'Lead' },
            ]}
          />
        </Field>
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Add member
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={pendingRemove !== undefined}
        title={`Remove ${pendingRemove?.displayName ?? pendingRemove?.discordUserId ?? ''} from ${teamName}?`}
        scope={<p>They are taken off this team's member list. You can add them again later.</p>}
        confirmLabel="Remove member"
        danger
        busy={busy}
        onConfirm={() => {
          if (pendingRemove !== undefined) void remove(pendingRemove.discordUserId);
        }}
        onCancel={() => {
          if (!busy) setPendingRemove(undefined);
        }}
        returnFocus={() => {
          if (!removedRef.current) return null;
          removedRef.current = false;
          return headingRef.current;
        }}
      />
    </div>
  );
}
