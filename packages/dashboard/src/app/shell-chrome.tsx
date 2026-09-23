import { Attribution } from '../ui/Attribution.js';
import { Button } from '../ui/Button.js';
import { useHealth } from './health.js';
import { useSession } from './session.js';

/**
 * The shell's guild identity block, shared by the desktop rail and the
 * mobile jump sheet. Names the active server and, when the account can
 * reach more than one, offers the switcher.
 */
export function GuildIdentity() {
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
      <details className="mt-0.5 text-xs text-ink-muted">
        <summary className="cursor-pointer">Server details</summary>
        <p>{session.info.guildId}</p>
      </details>
    </div>
  );
}

/** Sign-out plus the owner-mandated credit, shared by rail and jump sheet. */
export function ShellFooter({ onSignOut }: { readonly onSignOut: () => void }) {
  return (
    <div className="border-t border-line px-4 py-3">
      <Button className="w-full justify-center" onClick={onSignOut}>
        Sign out
      </Button>
      <Attribution className="mt-3 text-center text-[0.6875rem] text-ink-muted" />
    </div>
  );
}
