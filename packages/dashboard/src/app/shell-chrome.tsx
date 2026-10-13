import { Attribution } from '../ui/Attribution.js';
import { Button } from '../ui/Button.js';
import { DropdownMenu } from '../ui/DropdownMenu.js';
import { Icon, IconSearch } from '../ui/icons.js';
import { Kbd } from '../ui/Kbd.js';
import { isMac } from '../lib/platform.js';
import { usePalette } from './palette-context.js';
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

const SEARCH_LABEL = 'Search or jump to';

/**
 * Top-bar search opener. Desktop shows the visible prompt and shortcut hint;
 * mobile is icon-only. Both only open the palette state: the dialog and the
 * global shortcut arrive in Task 4.
 */
export function SearchButton({ variant }: { readonly variant: 'desktop' | 'mobile' }) {
  const palette = usePalette();
  if (variant === 'mobile') {
    return (
      <button
        type="button"
        aria-label={SEARCH_LABEL}
        onClick={palette.open}
        className="grid size-10 shrink-0 place-items-center rounded-sm border border-line-strong bg-panel text-ink hover:bg-sunk"
      >
        <Icon icon={IconSearch} size="md" />
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={SEARCH_LABEL}
      onClick={palette.open}
      className="flex min-h-9 min-w-0 max-w-full items-center gap-2 rounded-control border border-line bg-panel px-3 py-1.5 text-small text-ink-muted hover:bg-sunk"
    >
      <Icon icon={IconSearch} />
      <span aria-hidden="true" className="min-w-0 break-words">
        Search or jump to…
      </span>
      <Kbd>{isMac() ? '\u2318 K' : 'Ctrl K'}</Kbd>
    </button>
  );
}

/** Minimal authenticated account control: the signed-in account id and Sign out. */
export function AccountMenu() {
  const session = useSession();
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 break-all text-caption text-ink-muted">
        {session.info.accountId}
      </span>
      <DropdownMenu
        label={`Account menu for ${session.info.accountId}`}
        items={[{ label: 'Sign out', onSelect: () => void session.logout() }]}
      />
    </div>
  );
}
