import { useEffect, useRef, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { TaskCreatePage } from '../pages/tasks/new.js';
import { TaskDetailPage } from '../pages/tasks/detail/index.js';
import { TaskTeamsPage } from '../pages/tasks/teams/index.js';
import { TasksPage } from '../pages/tasks/index.js';
import { KitPage } from '../pages/kit.js';
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
import { AssistantBehaviourDetailPage } from '../pages/behaviours/detail.js';
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
import { Icon } from '../ui/icons.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { TooltipProvider } from '../ui/Tooltip.js';
import { CrashBoundary } from './CrashBoundary.js';
import { HealthProvider, useHealth } from './health.js';
import { JumpNav } from './JumpNav.js';
import { activeNavPath, GROUPS, pageTitle, visibleNav } from './routes.js';
import { useSession } from './session.js';
import { CommandPalette } from './CommandPalette.js';
import { PaletteProvider } from './palette-context.js';
import { AccountMenu, GuildIdentity, SearchButton, ShellFooter } from './shell-chrome.js';
import { SystemBanner } from './SystemBanner.js';

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
    <div className="hidden min-h-16 items-center justify-between gap-4 border-b border-line bg-canvas/82 px-6 backdrop-blur lg:flex">
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
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        <SearchButton variant="desktop" />
        <div className="text-right">
          <p className="text-xs font-medium text-ink">{freshness}</p>
        </div>
        <ThemeToggle />
        <AccountMenu />
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
  // Detail routes (a task, a rule, a trace) highlight their parent entry:
  // one shared longest-prefix rule with the jump sheet and the tab title.
  const activePath = activeNavPath(location);
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
                className="mb-1 px-2 text-caption font-semibold uppercase tracking-wider text-ink-muted"
              >
                {group}
              </h2>
              <ul className="grid gap-0.5">
                {groupEntries.map((entry) => {
                  const active = activePath === entry.path;
                  return (
                    <li key={entry.path}>
                      <Link
                        href={entry.path}
                        aria-current={active ? 'page' : undefined}
                        className={`flex min-h-9 items-center gap-2.5 rounded-control px-2.5 text-body transition-colors ${
                          active
                            ? 'bg-accent-bg font-medium text-accent'
                            : 'text-ink-muted hover:bg-sunk hover:text-ink'
                        }`}
                      >
                        <Icon icon={entry.icon} />
                        <span>{entry.label}</span>
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
  const [location] = useLocation();
  return (
    // A crash in one page must leave navigation working (Task 10): the
    // boundary sits inside `main`, and the location resetKey clears the
    // crash when the operator picks another page from the rail.
    <CrashBoundary scope="page" resetKey={location}>
      <Switch>
        <Route path="/" component={OverviewPage} />
        <Route path="/tasks/new" component={TaskCreatePage} />
        <Route path="/tasks/teams" component={TaskTeamsPage} />
        <Route path="/tasks/:taskId" component={TaskDetailPage} />
        <Route path="/tasks" component={TasksPage} />
        <Route path="/docs" component={DocsPage} />
        <Route path="/kit" component={KitPage} />
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
        <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />
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
    </CrashBoundary>
  );
}

/** Responsive operator shell. Must render inside `SessionProvider` and a wouter `Router`. */
export function Shell() {
  const session = useSession();
  const [location] = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const previousLocation = useRef(location);

  useEffect(() => {
    // The owner-only kit has a title but deliberately no NAV entry.
    const label = location === '/kit' ? 'UI kit' : pageTitle(location);
    document.title = label === undefined ? 'Bananasaurs' : `${label} \u00b7 Bananasaurs`;
  }, [location]);

  // Move focus to the content on navigation, never on the first render, so a
  // page that focuses its own field keeps it.
  useEffect(() => {
    if (previousLocation.current === location) return;
    previousLocation.current = location;
    mainRef.current?.focus({ preventScroll: false });
  }, [location]);

  // The sticky mobile header covers the top of the viewport below lg, so
  // keyboard focus and in-page scrolling must clear its measured height (no
  // hardcoded px; it changes with zoom, wrapping and banners). Hidden header
  // (lg+) measures 0 and leaves scroll padding unset.
  useEffect(() => {
    const root = document.documentElement;
    const apply = (): void => {
      const header = document.querySelector('header');
      const bottom = header === null ? 0 : header.getBoundingClientRect().bottom;
      if (Number.isFinite(bottom) && bottom > 0) {
        root.style.scrollPaddingTop = `${Math.ceil(bottom) + 8}px`;
      } else {
        root.style.removeProperty('scroll-padding-top');
      }
    };
    apply();
    window.addEventListener('resize', apply);
    const header = document.querySelector('header');
    const observer =
      header !== null && typeof ResizeObserver === 'function'
        ? new ResizeObserver(apply)
        : undefined;
    if (header !== null) observer?.observe(header);
    return () => {
      window.removeEventListener('resize', apply);
      observer?.disconnect();
      root.style.removeProperty('scroll-padding-top');
    };
  }, []);

  // The composed backdrop anchors its leaves to the viewport corner; while
  // the shell is mounted they belong to the content canvas, clear of the
  // sidebar (see the `shell-with-sidebar` rule in styles.css).
  useEffect(() => {
    document.body.classList.add('shell-with-sidebar');
    return () => document.body.classList.remove('shell-with-sidebar');
  }, []);

  return (
    <CrashBoundary scope="app" resetKey="app">
      <TooltipProvider>
        <HealthProvider>
          <PaletteProvider>
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-panel focus:px-3 focus:py-2 focus:shadow-float"
              onClick={(event) => {
                event.preventDefault();
                mainRef.current?.focus();
              }}
            >
              Skip to content
            </a>
            <div className="min-h-screen lg:flex">
              {/* Two rows: brand plus the icon controls share the top row and wrap
                without overlapping at narrow widths; JumpNav gets the full
                second row so its full accessible name survives even when the
                visible label wraps. */}
              <header className="sticky top-0 z-30 flex flex-col items-stretch gap-2 border-b border-line bg-canvas/95 px-4 py-3 backdrop-blur lg:hidden [&>div:first-child_p:last-child]:break-words">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Brand />
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <ThemeToggle />
                    <SearchButton variant="mobile" />
                    <AccountMenu />
                  </div>
                </div>
                <div className="min-w-0 [&>button:last-child]:h-auto [&>button:last-child]:min-h-10 [&>button:last-child]:min-w-0 [&>button:last-child]:max-w-full [&>button:last-child]:py-2 [&>button:last-child>span]:min-w-0 [&>button:last-child>span]:whitespace-normal [&>button:last-child>span]:break-words">
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
                <DesktopHeader />
                <SystemBanner />
                <main
                  id="main"
                  tabIndex={-1}
                  ref={mainRef}
                  className="mx-auto outline-none w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7"
                >
                  <Pages />
                </main>
              </div>
            </div>
            <CommandPalette />
          </PaletteProvider>
        </HealthProvider>
      </TooltipProvider>
    </CrashBoundary>
  );
}
