import { Link, Route, Switch, useLocation } from 'wouter';
import { AuditPage } from '../pages/audit.js';
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
import { Button } from '../ui/Button.js';
import { HealthProvider, useHealth } from './health.js';
import { NAV } from './routes.js';
import { useSession } from './session.js';
import { StateStrip } from './StateStrip.js';

function GuildIdentity() {
  const session = useSession();
  const health = useHealth();
  const name = health.resource.state === 'ready' ? health.resource.data.guildName : null;
  const reachable = session.info.reachableGuilds;
  return (
    <div className="border-b border-line px-4 py-3">
      <p className="text-xs text-ink-muted">Bananasaurs</p>
      {reachable !== undefined && reachable.length > 1 ? (
        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Server</span>
          <select
            value={session.info.guildId}
            onChange={(e) => void session.switchGuild(e.target.value)}
            className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-base font-medium text-ink"
          >
            {reachable.map((guild) => (
              <option key={guild.guildId} value={guild.guildId}>
                {guild.name ?? guild.guildId}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-base font-medium">{name ?? 'Guild'}</p>
      )}
      <p className="text-xs text-ink-muted">{session.info.guildId}</p>
    </div>
  );
}

function Rail() {
  const [location] = useLocation();
  return (
    <>
      <nav aria-label="Areas" className="flex-1 py-2">
        <ul>
          {NAV.filter((entry) => entry.status === 'built').map((entry) => {
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
      <nav aria-label="Planned" className="border-t border-line py-2">
        <p className="px-4 py-1 text-xs text-ink-muted">Release 3</p>
        <ul>
          {NAV.filter((entry) => entry.status === 'stub').map((entry) => {
            const active = location === entry.path;
            return (
              <li key={entry.path}>
                <Link
                  href={entry.path}
                  aria-current={active ? 'page' : undefined}
                  className={`block px-4 py-1.5 text-sm ${active ? 'bg-panel text-ink' : 'text-ink-muted'}`}
                >
                  {entry.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

/** Ruling S10-D3: Archive and Search live in Release 2 as CLI/MCP only; the pages arrive with Release 3. */
const ARCHIVE_SEARCH_TODAY =
  'The archive and search exist in Release 2 as operator CLI commands (`archive`, `mcp`) and through the MCP connector; the page arrives with Release 3.';

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
      <Route path="/archive">
        {() => (
          <StubPage
            title="Archive"
            purpose="Every message from the channels the owner enabled, kept under the retention policy."
            availableToday={ARCHIVE_SEARCH_TODAY}
          />
        )}
      </Route>
      <Route path="/search">
        {() => (
          <StubPage
            title="Search"
            purpose="Full-text search over the archive, with citations."
            availableToday={ARCHIVE_SEARCH_TODAY}
          />
        )}
      </Route>
      <Route path="/resources">
        {() => (
          <StubPage
            title="Resources"
            purpose="Files, links and notes the club keeps, findable from Discord."
          />
        )}
      </Route>
      <Route path="/providers">
        {() => (
          <StubPage
            title="Providers"
            purpose="Which AI providers are configured, their eligibility and their cost."
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
