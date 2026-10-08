import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { useResource } from '../hooks/useResource.js';
import { useSession } from '../app/session.js';
import { ApiError, mayManageTasks } from '../api.js';
import { describeError } from '../api/describe-error.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { inputClass } from '../lib/task-form.js';

type SetupTeam = { teamId: string; name: string; categoryId: string; issues: string[] };
type RoleCandidate = { roleId: string; name: string };
type Setup = {
  teams: SetupTeam[];
  presidentRoleCandidates: RoleCandidate[];
  presidentRoleId: string | null;
};
type GuildChannel = { channelId: string; name: string; kind: string; parentId?: string };
type GuildRole = { roleId: string; name: string };
type StoredMember = { discordUserId: string; kind: 'member' | 'lead'; displayName: string | null };
type DirectoryMember = {
  memberId: string;
  username: string;
  displayName: string;
  roleIds: string[];
};

/** Owner-only team setup. Members use Discord; nothing here posts to Discord. */
export function TaskTeamsPage() {
  const session = useSession();
  const setupLoad = useCallback(() => session.read<Setup>('/api/tasks/setup'), [session]);
  const setup = useResource('task setup', setupLoad);
  const channelsLoad = useCallback(
    () => session.read<{ channels: GuildChannel[] }>('/api/guild/channels'),
    [session],
  );
  const channels = useResource('channels', channelsLoad);
  const rolesLoad = useCallback(
    () => session.read<{ roles: GuildRole[] }>('/api/guild/roles'),
    [session],
  );
  const roles = useResource('roles', rolesLoad);

  if (!mayManageTasks(session.info)) {
    return (
      <>
        <PageHeader title="Teams & members" purpose="Set up the teams that own tasks." />
        <p role="status">
          Setting up teams needs the owner, or the Manage club tasks permission. Members use
          Discord.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Teams & members"
        purpose="Set up the teams that own tasks, and who belongs to each."
        actions={
          <Link href="/tasks" className="text-sm text-blue-700 underline">
            Back to tasks
          </Link>
        }
      />
      <div
        className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-slate-800"
        role="status"
      >
        Discord posts (announcements, reminders, review requests) go out only when the operator
        turns on task posts.
      </div>
      <DataState resource={setup.resource}>
        {(data) => (
          <>
            <PresidentSection
              candidates={data.presidentRoleCandidates}
              presidentRoleId={data.presidentRoleId}
              onChanged={setup.reload}
            />
            <DataState resource={channels.resource}>
              {(channelData) => (
                <DataState resource={roles.resource}>
                  {(roleData) => (
                    <>
                      <AddTeamForm
                        channels={channelData.channels}
                        roles={roleData.roles}
                        onCreated={setup.reload}
                      />
                      {data.teams.length === 0 ? (
                        <p className="rounded border border-line bg-panel p-4 text-sm">
                          No teams yet. Add the first one above.
                        </p>
                      ) : (
                        <div className="grid gap-3">
                          {data.teams.map((team) => (
                            <TeamCard
                              key={team.teamId}
                              team={team}
                              channels={channelData.channels}
                              roles={roleData.roles}
                              onChanged={setup.reload}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </DataState>
              )}
            </DataState>
          </>
        )}
      </DataState>
    </>
  );
}

function PresidentSection({
  candidates,
  presidentRoleId,
  onChanged,
}: {
  candidates: RoleCandidate[];
  presidentRoleId: string | null;
  onChanged: () => void;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const change = async (roleId: string) => {
    setBusy(true);
    try {
      if (roleId === '') {
        await session.write('/api/tasks/president-role', undefined, 'DELETE');
      } else {
        await session.write('/api/tasks/president-role', { roleId }, 'PUT');
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-3 rounded border border-line bg-panel px-3 py-2 text-sm">
      <label htmlFor="task-president-role" className="mr-2 font-medium">
        President role
      </label>
      <select
        id="task-president-role"
        disabled={busy}
        value={presidentRoleId ?? ''}
        onChange={(event) => void change(event.target.value)}
        className="min-h-10 rounded border border-line bg-panel px-2 py-1"
      >
        <option value="">Not selected</option>
        {candidates.map((role) => (
          <option key={role.roleId} value={role.roleId}>
            {role.name} ({role.roleId})
          </option>
        ))}
        {presidentRoleId && !candidates.some((role) => role.roleId === presidentRoleId) && (
          <option value={presidentRoleId}>Configured role (not in suggested list)</option>
        )}
      </select>
      <p className="mt-1 text-xs text-ink-muted">
        The saved role ID controls approval access, not the role name.
      </p>
    </section>
  );
}

function AddTeamForm({
  channels,
  roles,
  onCreated,
}: {
  channels: GuildChannel[];
  roles: GuildRole[];
  onCreated: () => void;
}) {
  const session = useSession();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'subteam' | 'exec'>('subteam');
  const [categoryId, setCategoryId] = useState('');
  const [announcementChannelId, setAnnouncementChannelId] = useState('');
  const [leadRoleId, setLeadRoleId] = useState('');
  const [memberRoleId, setMemberRoleId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const categories = channels.filter((c) => c.kind === 'category');
  const inCategory = channels.filter((c) => c.kind !== 'category' && c.parentId === categoryId);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter a team name.');
      return;
    }
    if (!categoryId) {
      setError('Choose a Discord category for the team.');
      return;
    }
    setBusy(true);
    setError('');
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
      onSubmit={(event) => void save(event)}
      className="mb-4 grid max-w-xl gap-3 rounded border border-line bg-panel p-4 text-sm"
    >
      <h2 className="font-semibold">Add team</h2>
      {error && <p role="alert">{error}</p>}
      <label className="grid gap-1">
        Team name
        <input
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="grid gap-1">
        Kind
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'subteam' | 'exec')}
          className={inputClass}
        >
          <option value="subteam">Subteam</option>
          <option value="exec">Exec</option>
        </select>
      </label>
      <label className="grid gap-1">
        Discord category
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className={inputClass}
        >
          <option value="">Choose category</option>
          {categories.map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        Announcements channel (optional)
        <select
          value={announcementChannelId}
          onChange={(e) => setAnnouncementChannelId(e.target.value)}
          className={inputClass}
        >
          <option value="">None</option>
          {inCategory.map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        Lead role (optional)
        <select
          value={leadRoleId}
          onChange={(e) => setLeadRoleId(e.target.value)}
          className={inputClass}
        >
          <option value="">None</option>
          {roles.map((r) => (
            <option key={r.roleId} value={r.roleId}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        Team role (optional)
        <select
          value={memberRoleId}
          onChange={(e) => setMemberRoleId(e.target.value)}
          className={inputClass}
        >
          <option value="">None</option>
          {roles.map((r) => (
            <option key={r.roleId} value={r.roleId}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="primary" busy={busy} className="min-h-10">
        Add team
      </Button>
    </form>
  );
}

function TeamCard({
  team,
  channels,
  roles,
  onChanged,
}: {
  team: SetupTeam;
  channels: GuildChannel[];
  roles: GuildRole[];
  onChanged: () => void;
}) {
  const session = useSession();
  const [name, setName] = useState(team.name);
  const [announcementChannelId, setAnnouncementChannelId] = useState('');
  const [leadRoleId, setLeadRoleId] = useState('');
  const [memberRoleId, setMemberRoleId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    setError('');
    try {
      await session.writeOrThrow(`/api/tasks/teams/${team.teamId}`, undefined, 'DELETE');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? describeError(err).message : 'Could not delete the team.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-line bg-panel p-3">
      <h2 className="text-base font-semibold">{team.name}</h2>
      {team.issues.length === 0 ? (
        <p className="mt-1 text-sm text-ink-muted">No setup issues.</p>
      ) : (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
          {team.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void save(event)} className="mt-3 grid max-w-xl gap-3 text-sm">
        <h3 className="font-medium">Edit team</h3>
        {error && <p role="alert">{error}</p>}
        <label className="grid gap-1">
          Team name
          <input
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1">
          Announcements channel
          <select
            value={announcementChannelId}
            onChange={(e) => setAnnouncementChannelId(e.target.value)}
            className={inputClass}
          >
            <option value="">None</option>
            {channels
              .filter((c) => c.kind !== 'category' && c.parentId === team.categoryId)
              .map((c) => (
                <option key={c.channelId} value={c.channelId}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label className="grid gap-1">
          Lead role
          <select
            value={leadRoleId}
            onChange={(e) => setLeadRoleId(e.target.value)}
            className={inputClass}
          >
            <option value="">None</option>
            {roles.map((r) => (
              <option key={r.roleId} value={r.roleId}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          Team role
          <select
            value={memberRoleId}
            onChange={(e) => setMemberRoleId(e.target.value)}
            className={inputClass}
          >
            <option value="">None</option>
            {roles.map((r) => (
              <option key={r.roleId} value={r.roleId}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" busy={busy} className="min-h-10">
            Save team
          </Button>
          <Button variant="danger" busy={busy} onClick={() => void remove()} className="min-h-10">
            Delete team
          </Button>
        </div>
        <p className="text-xs text-ink-muted">Clearing a channel or role sends nothing for it.</p>
      </form>
      <MembersSection teamId={team.teamId} teamName={team.name} />
    </section>
  );
}

function MembersSection({ teamId, teamName }: { teamId: string; teamName: string }) {
  const session = useSession();
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
    setBusy(true);
    setError('');
    try {
      await session.writeOrThrow(
        `/api/tasks/memberships/${teamId}/${discordUserId}`,
        undefined,
        'DELETE',
      );
      members.reload();
    } catch (err) {
      setError(
        err instanceof ApiError ? describeError(err).message : 'Could not remove the member.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <h3 className="text-sm font-medium">Members</h3>
      {error && (
        <p role="alert" className="mt-1 text-sm">
          {error}
        </p>
      )}
      <DataState resource={members.resource}>
        {(data) =>
          data.members.length === 0 ? (
            <p className="mt-1 text-sm text-ink-muted">No members yet.</p>
          ) : (
            <>
              <table className="mt-1 hidden w-full border-collapse text-sm sm:table">
                <caption className="sr-only">Members of {teamName}</caption>
                <thead>
                  <tr className="border-b border-line text-left">
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Member
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Role
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr key={m.discordUserId} className="border-b border-line last:border-0">
                      <td className="py-1 pr-3">{m.displayName ?? m.discordUserId}</td>
                      <td className="py-1 pr-3">{m.kind === 'lead' ? 'Lead' : 'Member'}</td>
                      <td className="py-1">
                        <Button
                          busy={busy}
                          onClick={() => void remove(m.discordUserId)}
                          className="min-h-10"
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="mt-1 space-y-2 sm:hidden">
                {data.members.map((m) => (
                  <li
                    key={m.discordUserId}
                    className="rounded border border-line px-3 py-2 text-sm"
                  >
                    <p className="font-medium">{m.displayName ?? m.discordUserId}</p>
                    <p className="text-xs text-ink-muted">
                      {m.kind === 'lead' ? 'Lead' : 'Member'}
                    </p>
                    <Button
                      busy={busy}
                      onClick={() => void remove(m.discordUserId)}
                      className="mt-2 min-h-10"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )
        }
      </DataState>
      <form onSubmit={(event) => void add(event)} className="mt-3 grid max-w-xl gap-2 text-sm">
        <h4 className="font-medium">Add member</h4>
        <label className="grid gap-1">
          Search the member directory
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPicked('');
            }}
            placeholder="Name or user id"
            className={inputClass}
          />
        </label>
        {query.trim() !== '' && (
          <DataState resource={directory.resource}>
            {() =>
              matches.length === 0 ? (
                <p className="text-sm text-ink-muted">No matches.</p>
              ) : (
                <label className="grid gap-1">
                  Choose member
                  <select
                    value={picked}
                    onChange={(e) => setPicked(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Choose member</option>
                    {matches.map((m) => (
                      <option key={m.memberId} value={m.memberId}>
                        {m.displayName} ({m.memberId})
                      </option>
                    ))}
                  </select>
                </label>
              )
            }
          </DataState>
        )}
        <label className="grid gap-1">
          Team role
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'member' | 'lead')}
            className={inputClass}
          >
            <option value="member">Member</option>
            <option value="lead">Lead</option>
          </select>
        </label>
        <Button type="submit" busy={busy} className="min-h-10">
          Add member
        </Button>
      </form>
    </div>
  );
}
