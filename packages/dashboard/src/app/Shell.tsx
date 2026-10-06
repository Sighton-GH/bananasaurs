import { useEffect, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { TaskCreatePage } from '../pages/task-create.js';
import { TaskDetailPage } from '../pages/task-detail.js';
import { TaskTeamsPage } from '../pages/task-teams.js';
import { TasksPage } from '../pages/tasks.js';
import { DocsPage } from '../pages/docs.js';
import { AccountEditPage } from '../pages/account-edit.js';
import { AccountNewPage } from '../pages/account-new.js';
import { AccountsPage } from '../pages/accounts.js';
import { AssistantConversationPage } from '../pages/assistant-conversation.js';
import { AssistantConversationsPage } from '../pages/assistant-conversations.js';
import { AssistantHistoryDetailPage } from '../pages/assistant-history-detail.js';
import { AssistantHistoryPage } from '../pages/assistant-history.js';
import { AssistantPage } from '../pages/assistant.js';
import { AssistantPromptWizardPage } from '../pages/assistant-prompt-wizard.js';
import { AssistantTuningPage } from '../pages/assistant-tuning.js';
import { AssistantResourcesPage } from '../pages/assistant-resources.js';
import { AssistantSchedulesPage } from '../pages/assistant-schedules.js';
import { AssistantSkillPage } from '../pages/assistant-skill.js';
import { AssistantSkillsPage } from '../pages/assistant-skills.js';
import { AssistantMemoryPage } from '../pages/assistant-memory.js';
import { ArchivePage } from '../pages/archive.js';
import { AuditPage } from '../pages/audit.js';
import { BackupsPage } from '../pages/backups.js';
import { ConfigPage } from '../pages/config.js';
import { DoctorPage } from '../pages/doctor.js';
import { JobsPage } from '../pages/jobs.js';
import { McpPage } from '../pages/mcp.js';
import { ProvidersPage } from '../pages/providers.js';
import { SearchPage } from '../pages/search.js';
import { AutomodRulePage } from '../pages/automod-rule.js';
import { AutomodRulesPage } from '../pages/automod-rules.js';
import { CasePage } from '../pages/case.js';
import { CasesPage } from '../pages/cases.js';
import { LoggingPage } from '../pages/logging.js';
import { MemberPage } from '../pages/member.js';
import { MembersPage } from '../pages/members.js';
import { NotFoundPage } from '../pages/not-found.js';
import { OverviewPage } from '../pages/overview.js';
import { PanelsPage } from '../pages/panels.js';
import { ReviewPage } from '../pages/review.js';
import { SafetyPage } from '../pages/safety.js';
import { PermissionsPage } from '../pages/permissions.js';
import { Brand } from '../ui/Brand.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { HealthProvider, useHealth } from './health.js';
import { JumpNav } from './JumpNav.js';
import { GROUPS, visibleNav } from './routes.js';
import { useSession } from './session.js';
import { GuildIdentity, ShellFooter } from './shell-chrome.js';
import { StateStrip } from './StateStrip.js';

function DesktopHeader() {
  const session = useSession();
  const health = useHealth();
  const [refreshedAt, setRefreshedAt] = useState<Date | undefined>(undefined);

  useEffect(() => {
    if (health.resource.state === 'ready') setRefreshedAt(new Date());
  }, [health.resource]);

  const guildName =
    health.resource.state === 'ready'
      ? (health.resource.data.guildName ?? 'Unnamed server')
      : 'Loading server';
  const freshness =
    health.resource.state === 'loading'
      ? 'Refreshing data…'
      : health.resource.state === 'error'
        ? 'Data unavailable'
        : refreshedAt === undefined
          ? 'Current data'
          : `Updated ${refreshedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  return (
    <div className="hidden h-16 items-center justify-between border-b border-line bg-canvas/82 px-6 backdrop-blur lg:flex">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-ink">{guildName}</p>
          <span className="rounded-full border border-line px-2 py-0.5 text-[0.625rem] uppercase tracking-[0.1em] text-ink-muted">
            Active server
          </span>
        </div>
        <details className="mt-0.5 text-xs text-ink-muted">
          <summary className="cursor-pointer">Server details</summary>
          <p>{session.info.guildId}</p>
        </details>
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <p className="text-xs font-medium text-ink">{freshness}</p>
          <Link href="/safety" className="text-[0.6875rem] text-ink-muted underline">
            Safety mode: changes are logged, not applied
          </Link>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );
}

function Rail() {
  const [location] = useLocation();
  const session = useSession();
  const entries = visibleNav(
    session.info.instanceOwner === true,
    session.info.canManageTasks === true,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="Areas" className="flex-1 overflow-y-auto px-3 py-2">
        {GROUPS.map((group) => {
          const groupEntries = entries.filter((entry) => entry.group === group);
          if (groupEntries.length === 0) return null;
          return (
            <section
              key={group}
              className="mb-4"
              aria-labelledby={`nav-${group.replace(' ', '-')}`}
            >
              <h2
                id={`nav-${group.replace(' ', '-')}`}
                className="mb-1 px-2 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-ink-muted"
              >
                {group}
              </h2>
              <ul className="grid gap-0.5">
                {groupEntries.map((entry) => {
                  const active = location === entry.path;
                  return (
                    <li key={entry.path}>
                      <Link
                        href={entry.path}
                        aria-current={active ? 'page' : undefined}
                        className={`flex min-h-9 items-center justify-between rounded-sm px-2.5 py-1.5 text-sm transition-colors ${
                          active
                            ? 'bg-panel font-medium text-ink shadow-[inset_2px_0_0_var(--color-ink)]'
                            : 'text-ink-muted hover:bg-panel/60 hover:text-ink'
                        }`}
                      >
                        <span>{entry.label}</span>
                        {entry.status === 'stub' && (
                          <span className="rounded-sm border border-line px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-ink-muted">
                            Future
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </nav>
    </div>
  );
}

function Pages() {
  return (
    <Switch>
      <Route path="/" component={OverviewPage} />
      <Route path="/tasks/new" component={TaskCreatePage} />
      <Route path="/tasks/teams" component={TaskTeamsPage} />
      <Route path="/tasks/:taskId" component={TaskDetailPage} />
      <Route path="/tasks" component={TasksPage} />
      <Route path="/docs" component={DocsPage} />
      <Route path="/safety" component={SafetyPage} />
      <Route path="/permissions" component={PermissionsPage} />
      <Route path="/logging" component={LoggingPage} />
      <Route path="/panels" component={PanelsPage} />
      <Route path="/audit" component={AuditPage} />
      <Route path="/automod" component={AutomodRulesPage} />
      <Route path="/automod/:ruleId" component={AutomodRulePage} />
      <Route path="/review" component={ReviewPage} />
      <Route path="/cases" component={CasesPage} />
      <Route path="/cases/:caseId" component={CasePage} />
      <Route path="/members/:memberId" component={MemberPage} />
      <Route path="/members" component={MembersPage} />
      <Route path="/archive" component={ArchivePage} />
      <Route path="/search" component={SearchPage} />
      <Route path="/jobs" component={JobsPage} />
      <Route path="/doctor" component={DoctorPage} />
      <Route path="/backups" component={BackupsPage} />
      <Route path="/config" component={ConfigPage} />
      <Route path="/accounts" component={AccountsPage} />
      {/* /accounts/new must come before /accounts/:username or "new" reads as a username. */}
      <Route path="/accounts/new" component={AccountNewPage} />
      <Route path="/accounts/:username" component={AccountEditPage} />
      <Route path="/mcp" component={McpPage} />
      {/* /providers is an alias of the AI setup page; /assistant/setup is the NAV entry (Task 9). */}
      <Route path="/providers" component={ProvidersPage} />
      <Route path="/assistant/setup" component={ProvidersPage} />
      <Route path="/assistant/tuning" component={AssistantTuningPage} />
      <Route path="/assistant" component={AssistantPage} />
      <Route path="/assistant/behaviours/:id/wizard" component={AssistantPromptWizardPage} />
      {/* Task 19: the Conversations list, with the transcript right after it. */}
      <Route path="/assistant/conversations" component={AssistantConversationsPage} />
      <Route path="/assistant/conversations/:id" component={AssistantConversationPage} />
      <Route path="/assistant/skills" component={AssistantSkillsPage} />
      <Route path="/assistant/skills/:skillId" component={AssistantSkillPage} />
      <Route path="/assistant/schedules" component={AssistantSchedulesPage} />
      <Route path="/assistant/resources" component={AssistantResourcesPage} />
      <Route path="/assistant/history/:traceId" component={AssistantHistoryDetailPage} />
      <Route path="/assistant/history" component={AssistantHistoryPage} />
      <Route path="/assistant/activity" component={AssistantHistoryPage} />
      <Route path="/resources" component={AssistantResourcesPage} />
      <Route path="/memory" component={AssistantMemoryPage} />
      <Route path="/ai" component={AssistantPage} />
      <Route path="/proposals" component={AssistantPage} />
      <Route component={NotFoundPage} />
    </Switch>
  );
}

/** Responsive operator shell. Must render inside `SessionProvider` and a wouter `Router`. */
export function Shell() {
  const session = useSession();

  // The composed backdrop anchors its leaves to the viewport corner; while
  // the shell is mounted they belong to the content canvas, clear of the
  // sidebar (see the `shell-with-sidebar` rule in styles.css).
  useEffect(() => {
    document.body.classList.add('shell-with-sidebar');
    return () => document.body.classList.remove('shell-with-sidebar');
  }, []);

  return (
    <HealthProvider>
      <div className="min-h-screen lg:flex">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-2 border-b border-line bg-canvas/95 px-4 backdrop-blur lg:hidden">
          <Brand />
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <JumpNav />
          </div>
        </header>

        <aside className="hidden border-r border-line bg-canvas lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col">
          <div className="flex h-16 shrink-0 items-center border-b border-line px-4">
            <Brand />
          </div>
          <GuildIdentity />
          <Rail />
          <ShellFooter onSignOut={() => void session.logout()} />
        </aside>

        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <StateStrip />
          <DesktopHeader />
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
            <Pages />
          </main>
        </div>
      </div>
    </HealthProvider>
  );
}
