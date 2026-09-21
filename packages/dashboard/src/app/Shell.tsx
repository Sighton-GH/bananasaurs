import { useEffect, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { AccountsPage } from '../pages/accounts.js';
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
import { CutoverPage } from '../pages/cutover.js';
import { LoggingPage } from '../pages/logging.js';
import { MemberPage } from '../pages/member.js';
import { NotFoundPage } from '../pages/not-found.js';
import { OverviewPage } from '../pages/overview.js';
import { PanelsPage } from '../pages/panels.js';
import { ReviewPage } from '../pages/review.js';
import { SafetyPage } from '../pages/safety.js';
import { StubPage } from '../pages/stub.js';
import { Attribution } from '../ui/Attribution.js';
import { Brand } from '../ui/Brand.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { Button } from '../ui/Button.js';
import { HealthProvider, useHealth } from './health.js';
import { NAV } from './routes.js';
import { useSession } from './session.js';
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
        <p className="mt-0.5 truncate text-xs text-ink-muted">{session.info.guildId}</p>
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <p className="text-xs font-medium text-ink">{freshness}</p>
          <p className="text-[0.6875rem] text-ink-muted">Health summary · Observe-first controls</p>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );
}

function GuildIdentity() {
  const session = useSession();
  const health = useHealth();
  const name = health.resource.state === 'ready' ? health.resource.data.guildName : null;
  const reachable = session.info.reachableGuilds;
  return (
    <div className="px-4 py-4">
      <p className="mb-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-ink-muted">
        Active server
      </p>
      {reachable !== undefined && reachable.length > 1 ? (
        <label className="block">
          <span className="sr-only">Server</span>
          <select
            value={session.info.guildId}
            onChange={(e) => void session.switchGuild(e.target.value)}
            className="block w-full rounded-sm border border-line bg-panel px-2.5 py-2 text-sm font-medium text-ink"
          >
            {reachable.map((guild) => (
              <option key={guild.guildId} value={guild.guildId}>
                {guild.name ?? guild.guildId}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="truncate text-sm font-medium">{name ?? 'Guild'}</p>
      )}
      <p className="mt-0.5 truncate text-xs text-ink-muted">{session.info.guildId}</p>
    </div>
  );
}

// ADR 0051 D6's rail groups, in order. Empty groups (Archive until the
// operator pages land) render nothing rather than a bare heading.
const GROUPS = ['Operate', 'Moderation', 'Archive', 'Instance', 'Release 3'] as const;

function Rail({ onNavigate }: { readonly onNavigate?: () => void }) {
  const [location] = useLocation();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="Areas" className="flex-1 overflow-y-auto px-3 py-2">
        {GROUPS.map((group) => {
          const entries = NAV.filter((entry) => entry.group === group);
          if (entries.length === 0) return null;
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
                {entries.map((entry) => {
                  const active = location === entry.path;
                  return (
                    <li key={entry.path}>
                      <Link
                        href={entry.path}
                        onClick={onNavigate}
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
      <Route path="/safety" component={SafetyPage} />
      <Route path="/logging" component={LoggingPage} />
      <Route path="/panels" component={PanelsPage} />
      <Route path="/audit" component={AuditPage} />
      <Route path="/automod" component={AutomodRulesPage} />
      <Route path="/automod/:ruleId" component={AutomodRulePage} />
      <Route path="/review" component={ReviewPage} />
      <Route path="/cases" component={CasesPage} />
      <Route path="/cases/:caseId" component={CasePage} />
      <Route path="/members/:memberId" component={MemberPage} />
      <Route path="/cutover" component={CutoverPage} />
      <Route path="/archive" component={ArchivePage} />
      <Route path="/search" component={SearchPage} />
      <Route path="/jobs" component={JobsPage} />
      <Route path="/doctor" component={DoctorPage} />
      <Route path="/backups" component={BackupsPage} />
      <Route path="/config" component={ConfigPage} />
      <Route path="/accounts" component={AccountsPage} />
      <Route path="/mcp" component={McpPage} />
      <Route path="/providers" component={ProvidersPage} />
      <Route path="/resources">
        {() => (
          <StubPage
            title="Resources"
            purpose="Files, links and notes the club keeps, findable from Discord."
          />
        )}
      </Route>
      <Route path="/memory">
        {() => (
          <StubPage
            title="Memory"
            purpose="What the assistant remembers about the server, and how to correct it."
          />
        )}
      </Route>
      <Route path="/ai">
        {() => (
          <StubPage
            title="AI workspace"
            purpose="Where the owner drafts and reviews AI-assisted actions before they run."
          />
        )}
      </Route>
      <Route path="/proposals">
        {() => (
          <StubPage
            title="Proposals"
            purpose="Changes the assistant proposes, waiting for a person to approve."
          />
        )}
      </Route>
      <Route component={NotFoundPage} />
    </Switch>
  );
}

function MenuIcon({ open }: { readonly open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      {open ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  );
}

function ShellFooter({ onSignOut }: { readonly onSignOut: () => void }) {
  return (
    <div className="border-t border-line px-4 py-3">
      <Button className="w-full justify-center" onClick={onSignOut}>
        Sign out
      </Button>
      <Attribution className="mt-3 text-center text-[0.6875rem] text-ink-muted" />
    </div>
  );
}

/** Responsive operator shell. Must render inside `SessionProvider` and a wouter `Router`. */
export function Shell() {
  const session = useSession();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The composed backdrop anchors its leaves to the viewport corner; while
  // the shell is mounted they belong to the content canvas, clear of the
  // sidebar (see the `shell-with-sidebar` rule in styles.css).
  useEffect(() => {
    document.body.classList.add('shell-with-sidebar');
    return () => document.body.classList.remove('shell-with-sidebar');
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [drawerOpen]);

  return (
    <HealthProvider>
      <div className="min-h-screen lg:flex">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-line bg-canvas/95 px-4 backdrop-blur lg:hidden">
          <Brand />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={drawerOpen}
              aria-controls="mobile-navigation"
              className="grid size-10 place-items-center rounded-sm border border-line bg-panel text-ink"
              onClick={() => setDrawerOpen((open) => !open)}
            >
              <MenuIcon open={drawerOpen} />
            </button>
          </div>
        </header>

        {drawerOpen && (
          <button
            type="button"
            aria-label="Close navigation"
            className="shell-backdrop fixed inset-0 z-30 bg-black/60 lg:hidden"
            onClick={() => setDrawerOpen(false)}
          />
        )}

        <aside
          id="mobile-navigation"
          className={`fixed inset-y-0 left-0 z-40 flex w-[min(19rem,88vw)] flex-col border-r border-line bg-canvas transition-transform lg:sticky lg:top-0 lg:h-screen lg:w-64 lg:translate-x-0 ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <div className="flex h-16 shrink-0 items-center border-b border-line px-4">
            <Brand />
          </div>
          <GuildIdentity />
          <Rail onNavigate={() => setDrawerOpen(false)} />
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
