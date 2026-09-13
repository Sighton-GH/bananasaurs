import { Link, Route, Switch, useLocation } from 'wouter';
import { AuditPage } from '../pages/audit.js';
import { LoggingPage } from '../pages/logging.js';
import { NotFoundPage } from '../pages/not-found.js';
import { OverviewPage } from '../pages/overview.js';
import { PanelsPage } from '../pages/panels.js';
import { SafetyPage } from '../pages/safety.js';
import { Button } from '../ui/Button.js';
import { HealthProvider, useHealth } from './health.js';
import { NAV } from './routes.js';
import { useSession } from './session.js';
import { StateStrip } from './StateStrip.js';

function GuildIdentity() {
  const session = useSession();
  const health = useHealth();
  const name = health.resource.state === 'ready' ? health.resource.data.guildName : null;
  return (
    <div className="border-b border-line px-4 py-3">
      <p className="text-xs text-ink-muted">Bananasaurs</p>
      <p className="text-base font-medium">{name ?? 'Guild'}</p>
      <p className="text-xs text-ink-muted">{session.info.guildId}</p>
    </div>
  );
}

function Rail() {
  const [location] = useLocation();
  return (
    <nav aria-label="Areas" className="flex-1 py-2">
      <ul>
        {NAV.map((entry) => {
          const active = location === entry.path;
          return (
            <li key={entry.path}>
              <Link
                href={entry.path}
                aria-current={active ? 'page' : undefined}
                className={`block px-4 py-1.5 text-sm ${active ? 'bg-panel text-ink' : 'text-ink-muted hover:text-ink'}`}
              >
                {entry.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
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
      <Route component={NotFoundPage} />
    </Switch>
  );
}

/** Rail, header, state strip, page. Must render inside `SessionProvider` and a wouter `Router`. */
export function Shell() {
  const session = useSession();
  return (
    <HealthProvider>
      <div className="flex min-h-screen">
        <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-canvas">
          <GuildIdentity />
          <Rail />
          <div className="border-t border-line px-4 py-3">
            <Button onClick={() => void session.logout()}>Sign out</Button>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <StateStrip />
          <main className="w-full max-w-[1400px] px-6 py-5">
            <Pages />
          </main>
        </div>
      </div>
    </HealthProvider>
  );
}
