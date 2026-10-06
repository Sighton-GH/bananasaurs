import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useState, type ReactElement } from 'react';
import { Link, useLocation } from 'wouter';
import { GROUPS, NAV, visibleNav, type NavEntry } from './routes.js';
import { useSession } from './session.js';
import { GuildIdentity, ShellFooter } from './shell-chrome.js';

/**
 * Mobile jump navigation (ADR 0055). The desktop rail ports poorly to a
 * phone: one hamburger, then a full-height drawer that has to be scrolled
 * past the server block and footer to reach half the areas. The jump sheet
 * is the mobile-first counterpart - a trigger that names the current area
 * (so the sticky header always answers "where am I") opening a
 * bottom-anchored sheet with thumb-sized targets, the current area marked
 * in place. Radix supplies the focus trap, escape handling and scroll lock.
 */

/** The entry the current location belongs to. Detail routes (a case, a
 * rule, a member) sit under their list page: the longest prefix on a slash
 * boundary wins, so `/cases/42` still orients the operator to Cases. */
export function currentNavEntry(location: string): NavEntry | undefined {
  const exact = NAV.find((entry) => entry.path === location);
  if (exact !== undefined) return exact;
  return NAV.filter((entry) => entry.path !== '/' && location.startsWith(`${entry.path}/`)).sort(
    (a, b) => b.path.length - a.path.length,
  )[0];
}

function ChevronIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-4 shrink-0 text-ink-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CloseIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function JumpNav(): ReactElement {
  const session = useSession();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const current = currentNavEntry(location);
  const label = current?.label ?? 'Jump to';
  const entries = visibleNav(
    session.info.instanceOwner === true,
    session.info.canManageTasks === true,
  );

  // Opening orients to the current area: when it sits below the fold, the
  // sheet scrolls just enough to show its "Current" badge. `nearest` leaves
  // a top-of-list current alone.
  const scrollToCurrent = useCallback((node: HTMLDivElement | null) => {
    // jsdom (the test environment) does not implement scrollIntoView.
    node?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={`Open navigation - current page ${label}`}
          className="flex h-10 max-w-[11rem] items-center gap-1.5 rounded-sm border border-line bg-panel px-3 text-sm font-medium text-ink"
        >
          <span className="truncate">{label}</span>
          <ChevronIcon />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="shell-backdrop jumpnav-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="jumpnav-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[82dvh] flex-col rounded-t-xl border-t border-line bg-canvas text-ink"
        >
          <div
            aria-hidden="true"
            className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line"
          />
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
            <Dialog.Title className="text-base font-semibold">Jump to</Dialog.Title>
            <Dialog.Close
              aria-label="Close navigation"
              className="grid size-10 place-items-center rounded-sm border border-line bg-panel text-ink"
            >
              <CloseIcon />
            </Dialog.Close>
          </div>
          <div ref={scrollToCurrent} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <nav aria-label="Areas" className="px-3 py-3">
              {GROUPS.map((group) => {
                const groupEntries = entries.filter((entry) => entry.group === group);
                if (groupEntries.length === 0) return null;
                return (
                  <section
                    key={group}
                    className="mb-3"
                    aria-labelledby={`jumpnav-${group.replace(' ', '-')}`}
                  >
                    <h2
                      id={`jumpnav-${group.replace(' ', '-')}`}
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
                              onClick={() => setOpen(false)}
                              aria-current={active ? 'page' : undefined}
                              className={`flex min-h-11 items-center justify-between rounded-sm px-3 py-2 text-base transition-colors ${
                                active
                                  ? 'bg-panel font-medium text-ink shadow-[inset_2px_0_0_var(--color-ink)]'
                                  : 'text-ink-muted hover:bg-panel/60 hover:text-ink'
                              }`}
                            >
                              <span>{entry.label}</span>
                              {active ? (
                                <span className="rounded-sm border border-line px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-ink-muted">
                                  Current
                                </span>
                              ) : (
                                entry.status === 'stub' && (
                                  <span className="rounded-sm border border-line px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-ink-muted">
                                    Future
                                  </span>
                                )
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
            <div className="border-t border-line">
              <GuildIdentity />
              <ShellFooter onSignOut={() => void session.logout()} />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
