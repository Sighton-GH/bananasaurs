import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../../app/session.js';
import { ApiError } from '../../../api.js';
import { describeError } from '../../../api/describe-error.js';
import { useToast } from '../../../ui/Toast.js';
import { Button } from '../../../ui/Button.js';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js';
import { Field, Input } from '../../../ui/Field.js';
import { InlineAlert } from '../../../ui/InlineAlert.js';
import { Select } from '../../../ui/Select.js';
import { type SetupTeam, type GuildChannel, type GuildRole } from './types.js';
const NONE = '__none';

export function TeamEditor({
  team,
  onClose,
  channels,
  roles,
  onChanged,
  consumeInitialFocus,
}: {
  team: SetupTeam;
  onClose: () => void;
  channels: GuildChannel[];
  roles: GuildRole[];
  onChanged: () => void;
  /** True once when this mount follows the Edit click (parent-held). */
  consumeInitialFocus: () => boolean;
}) {
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
  const [name, setName] = useState(team.name);
  const [announcementChannelId, setAnnouncementChannelId] = useState('');
  const [leadRoleId, setLeadRoleId] = useState('');
  const [memberRoleId, setMemberRoleId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const removedRef = useRef(false);
  // The editor opens from the team's Edit button; land in its first field.
  // Only for the Edit click itself: reloads (save, delete) remount a
  // still-open editor and must not yank focus back here.
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (consumeInitialFocus()) {
      sectionRef.current?.querySelector<HTMLElement>('input')?.focus();
    }
  }, [consumeInitialFocus]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter a team name.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await session.writeOrThrow(
        `/api/tasks/teams/${team.teamId}`,
        {
          name: name.trim(),
          announcementChannelId: announcementChannelId === '' ? null : announcementChannelId,
          leadRoleId: leadRoleId === '' ? null : leadRoleId,
          memberRoleId: memberRoleId === '' ? null : memberRoleId,
        },
        'PUT',
      );
      if (result === undefined) return;
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? describeError(err).message : 'Could not save the team.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await session.writeOrThrow(
        `/api/tasks/teams/${team.teamId}`,
        undefined,
        'DELETE',
        deleteFailureStatuses,
      );
      removedRef.current = true;
      onChanged();
    } catch (err) {
      if (toastDeleteRefusal(err)) return;
      setError(err instanceof ApiError ? describeError(err).message : 'Could not delete the team.');
    } finally {
      setConfirmingDelete(false);
      setBusy(false);
    }
  };

  return (
    <section ref={sectionRef} className="grid gap-3 rounded-panel border border-line bg-panel p-4">
      <h2 className="text-section font-semibold">Edit {team.name}</h2>
      {team.issues.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-body">
          {team.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void save(event)} className="grid max-w-xl gap-3">
        {error && (
          <InlineAlert tone="danger" title="That did not work">
            {error}
          </InlineAlert>
        )}
        <Field label="Team name">
          <Input
            id="edit-team-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Announcements channel">
          <Select
            value={announcementChannelId === '' ? NONE : announcementChannelId}
            onValueChange={(value) => setAnnouncementChannelId(value === NONE ? '' : value)}
            options={[
              { value: NONE, label: 'None' },
              ...channels
                .filter((c) => c.kind !== 'category' && c.parentId === team.categoryId)
                .map((c) => ({ value: c.channelId, label: c.name })),
            ]}
          />
        </Field>
        <Field label="Lead role">
          <Select
            value={leadRoleId === '' ? NONE : leadRoleId}
            onValueChange={(value) => setLeadRoleId(value === NONE ? '' : value)}
            options={[
              { value: NONE, label: 'None' },
              ...roles.map((r) => ({ value: r.roleId, label: r.name })),
            ]}
          />
        </Field>
        <Field label="Team role">
          <Select
            value={memberRoleId === '' ? NONE : memberRoleId}
            onValueChange={(value) => setMemberRoleId(value === NONE ? '' : value)}
            options={[
              { value: NONE, label: 'None' },
              ...roles.map((r) => ({ value: r.roleId, label: r.name })),
            ]}
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="primary" busy={busy}>
            Save team
          </Button>
          <Button variant="danger" busy={busy} onClick={() => setConfirmingDelete(true)}>
            Delete team
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
        <p className="text-caption text-ink-muted">
          Clearing a channel or role sends nothing for it.
        </p>
      </form>
      <ConfirmDialog
        open={confirmingDelete}
        title={`Delete team ${team.name}?`}
        scope={
          <p>
            The team is removed. A team that still has tasks cannot be deleted; the server refuses
            and nothing changes.
          </p>
        }
        confirmLabel="Delete team"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => {
          if (!busy) setConfirmingDelete(false);
        }}
        returnFocus={() => {
          if (!removedRef.current) return null;
          removedRef.current = false;
          const h1 = document.querySelector<HTMLElement>('main h1, h1');
          h1?.setAttribute('tabindex', '-1');
          return h1;
        }}
      />
    </section>
  );
}
