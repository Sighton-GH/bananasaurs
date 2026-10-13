import { useCallback, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useResource } from '../../../hooks/useResource.js';
import { useSession } from '../../../app/session.js';
import { mayManageTasks } from '../../../api.js';
import { Button } from '../../../ui/Button.js';
import { DataState } from '../../../ui/DataState.js';
import { DataTable } from '../../../ui/DataTable.js';
import { Field } from '../../../ui/Field.js';
import { PageHeader } from '../../../ui/PageHeader.js';
import { Select } from '../../../ui/Select.js';
import { TabPanel, Tabs } from '../../../ui/Tabs.js';
import { TaskPostsBanner } from '../../../ui/TaskPostsBanner.js';
import { type Setup, type GuildChannel, type GuildRole } from './types.js';
import { PresidentSection } from './president.js';
import { AddTeamForm } from './team-form.js';
import { TeamEditor } from './team-card.js';
import { MembersSection } from './members.js';

const TAB_IDS = ['teams', 'members'] as const;
type TabId = (typeof TAB_IDS)[number];

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
  const [location, navigate] = useLocation();
  const search = useSearch();
  const rawTab = new URLSearchParams(search).get('tab');
  const tab: TabId = TAB_IDS.includes(rawTab as TabId) ? (rawTab as TabId) : 'teams';
  const selectTab = (next: string) => {
    const params = new URLSearchParams(search);
    params.set('tab', next);
    const hash = typeof window === 'undefined' ? '' : window.location.hash;
    navigate(`${location}?${params.toString()}${hash}`);
  };
  const [editingId, setEditingId] = useState('');
  const [memberTeamId, setMemberTeamId] = useState('');

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
        crumbs={[{ label: 'Tasks', href: '/tasks' }]}
        actions={
          <Link href="/tasks" className="text-small text-accent underline underline-offset-2">
            Back to tasks
          </Link>
        }
      />
      <DataState resource={setup.resource}>
        {(data) => (
          <>
            <TaskPostsBanner posts={data.taskPosts} />
            <Tabs
              value={tab}
              onValueChange={selectTab}
              aria-label="Teams sections"
              tabs={[
                { value: 'teams', label: 'Teams' },
                { value: 'members', label: 'Members' },
              ]}
            >
              <TabPanel value="teams">
                <div className="mt-4 grid gap-4">
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
                              <p className="rounded-panel border border-line bg-panel p-4 text-body">
                                No teams yet. Add the first one above.
                              </p>
                            ) : (
                              <DataTable
                                caption="Teams"
                                rows={data.teams}
                                rowKey={(team) => team.teamId}
                                columns={[
                                  { key: 'name', header: 'Team', cell: (team) => team.name },
                                  {
                                    key: 'issues',
                                    header: 'Setup issues',
                                    cell: (team) =>
                                      team.issues.length === 0 ? (
                                        'No setup issues.'
                                      ) : (
                                        <ul className="list-disc space-y-1 pl-4">
                                          {team.issues.map((issue) => (
                                            <li key={issue}>{issue}</li>
                                          ))}
                                        </ul>
                                      ),
                                  },
                                  {
                                    key: 'actions',
                                    header: <span className="sr-only">Actions</span>,
                                    mobileLabel: 'Actions',
                                    cell: (team) => (
                                      <Button
                                        aria-label={`Edit ${team.name}`}
                                        onClick={() => setEditingId(team.teamId)}
                                      >
                                        Edit
                                      </Button>
                                    ),
                                  },
                                ]}
                              />
                            )}
                            {data.teams
                              .filter((team) => team.teamId === editingId)
                              .map((team) => (
                                <TeamEditor
                                  key={team.teamId}
                                  team={team}
                                  channels={channelData.channels}
                                  roles={roleData.roles}
                                  onClose={() => setEditingId('')}
                                  onChanged={setup.reload}
                                />
                              ))}
                          </>
                        )}
                      </DataState>
                    )}
                  </DataState>
                </div>
              </TabPanel>
              <TabPanel value="members">
                <div className="mt-4 grid gap-4">
                  {data.teams.length === 0 ? (
                    <p className="rounded-panel border border-line bg-panel p-4 text-body">
                      No teams yet. Add a team on the Teams tab first.
                    </p>
                  ) : (
                    <>
                      <div className="max-w-xl">
                        <Field label="Team">
                          <Select
                            value={memberTeamId === '' ? undefined : memberTeamId}
                            placeholder="Choose team"
                            onValueChange={setMemberTeamId}
                            options={data.teams.map((team) => ({
                              value: team.teamId,
                              label: team.name,
                            }))}
                          />
                        </Field>
                      </div>
                      {data.teams
                        .filter((team) => team.teamId === memberTeamId)
                        .map((team) => (
                          <MembersSection
                            key={team.teamId}
                            teamId={team.teamId}
                            teamName={team.name}
                          />
                        ))}
                    </>
                  )}
                </div>
              </TabPanel>
            </Tabs>
          </>
        )}
      </DataState>
    </>
  );
}
