import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../../app/session.js';
import { ApiError } from '../../../api.js';
import { describeError } from '../../../api/describe-error.js';
import { Button } from '../../../ui/Button.js';
import { ErrorSummary } from '../../../ui/ErrorSummary.js';
import { Field, Input } from '../../../ui/Field.js';
import { InlineAlert } from '../../../ui/InlineAlert.js';
import { Select } from '../../../ui/Select.js';
import { type GuildChannel, type GuildRole } from './types.js';

const NONE = '__none';

export function AddTeamForm({
  channels,
  roles,
  onCreated,
  consumeCreatedFocus,
}: {
  channels: GuildChannel[];
  roles: GuildRole[];
  onCreated: () => void;
  /** True once when the fresh mount follows a successful create (parent-held). */
  consumeCreatedFocus?: () => boolean;
}) {
  const session = useSession();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'subteam' | 'exec'>('subteam');
  const [categoryId, setCategoryId] = useState('');
  const [announcementChannelId, setAnnouncementChannelId] = useState('');
  const [leadRoleId, setLeadRoleId] = useState('');
  const [memberRoleId, setMemberRoleId] = useState('');
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<readonly { fieldId: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const categories = channels.filter((c) => c.kind === 'category');
  const inCategory = channels.filter((c) => c.kind !== 'category' && c.parentId === categoryId);
  // After a successful create the list reload remounts this form; land in
  // its first field for the next team. Mount-only otherwise.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (consumeCreatedFocus?.() === true) {
      formRef.current?.querySelector<HTMLElement>('input')?.focus();
    }
  }, [consumeCreatedFocus]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter a team name.');
      setProblems([{ fieldId: 'add-team-name', message: 'Enter a team name.' }]);
      return;
    }
    if (!categoryId) {
      setError('Choose a Discord category for the team.');
      setProblems([
        { fieldId: 'add-team-category', message: 'Choose a Discord category for the team.' },
      ]);
      return;
    }
    setBusy(true);
    setError('');
    setProblems([]);
    try {
      const result = await session.writeOrThrow<{ teamId: string }>('/api/tasks/teams', {
        name: name.trim(),
        categoryId,
        kind,
        ...(announcementChannelId ? { announcementChannelId } : {}),
        ...(leadRoleId ? { leadRoleId } : {}),
        ...(memberRoleId ? { memberRoleId } : {}),
      });
      if (result === undefined) return;
      setName('');
      setCategoryId('');
      setAnnouncementChannelId('');
      setLeadRoleId('');
      setMemberRoleId('');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? describeError(err).message : 'Could not save the team.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void save(event)}
      className="mb-4 grid max-w-xl gap-3 rounded-panel border border-line bg-panel p-4"
    >
      <h2 className="text-section font-semibold">Add team</h2>
      <ErrorSummary errors={problems} />
      {error && (
        <InlineAlert tone="danger" title="The team was not added">
          {error}
        </InlineAlert>
      )}
      <Field label="Team name">
        <Input
          id="add-team-name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Kind">
        <Select
          value={kind}
          onValueChange={(value) => setKind(value as 'subteam' | 'exec')}
          options={[
            { value: 'subteam', label: 'Subteam' },
            { value: 'exec', label: 'Exec' },
          ]}
        />
      </Field>
      <Field label="Discord category">
        <Select
          id="add-team-category"
          value={categoryId === '' ? undefined : categoryId}
          placeholder="Choose category"
          onValueChange={setCategoryId}
          options={categories.map((c) => ({ value: c.channelId, label: c.name }))}
        />
      </Field>
      <Field label="Announcements channel (optional)">
        <Select
          value={announcementChannelId === '' ? NONE : announcementChannelId}
          onValueChange={(value) => setAnnouncementChannelId(value === NONE ? '' : value)}
          options={[
            { value: NONE, label: 'None' },
            ...inCategory.map((c) => ({ value: c.channelId, label: c.name })),
          ]}
        />
      </Field>
      <Field label="Lead role (optional)">
        <Select
          value={leadRoleId === '' ? NONE : leadRoleId}
          onValueChange={(value) => setLeadRoleId(value === NONE ? '' : value)}
          options={[
            { value: NONE, label: 'None' },
            ...roles.map((r) => ({ value: r.roleId, label: r.name })),
          ]}
        />
      </Field>
      <Field label="Team role (optional)">
        <Select
          value={memberRoleId === '' ? NONE : memberRoleId}
          onValueChange={(value) => setMemberRoleId(value === NONE ? '' : value)}
          options={[
            { value: NONE, label: 'None' },
            ...roles.map((r) => ({ value: r.roleId, label: r.name })),
          ]}
        />
      </Field>
      <div>
        <Button type="submit" variant="primary" busy={busy}>
          Add team
        </Button>
      </div>
    </form>
  );
}
