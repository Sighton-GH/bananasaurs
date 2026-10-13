import * as Dialog from '@radix-ui/react-dialog';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { useLocation } from 'wouter';
import type { ModCase } from '../pages/cases.js';
import type { Snapshot } from '../pages/tasks/index.js';
import { Icon, IconSearch } from '../ui/icons.js';
import { InlineAlert } from '../ui/InlineAlert.js';
import { Kbd } from '../ui/Kbd.js';
import { Spinner } from '../ui/Spinner.js';
import { usePalette } from './palette-context.js';
import {
  PALETTE_SOURCES,
  SECTION_ORDER,
  memberItem,
  rank,
  staticItems,
  type PaletteItem,
  type CaseShape,
  type PaletteRead,
  type PaletteSection,
  type TaskSnapshotShape,
} from './palette-sources.js';
import { useSession, type Session } from './session.js';

// palette-sources.ts is a .ts file and cannot import these .tsx types, so it
// carries structural copies. These fail the build if the real shapes drift.
type Assert<T extends true> = T;
export type PaletteShapesConform = [
  Assert<Snapshot extends TaskSnapshotShape ? true : false>,
  Assert<ModCase extends CaseShape ? true : false>,
  Assert<Session['read'] extends PaletteRead ? true : false>,
];

type SourceState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly items: readonly PaletteItem[] }
  | { readonly state: 'error' };

interface Loaded {
  /** `<open count>|<scope>` the sections belong to; anything else is stale. */
  readonly run: string;
  readonly sections: Partial<Record<PaletteSection, SourceState>>;
}

const NOT_LOADED: Loaded = { run: '', sections: {} };

/** A DOM-safe, collision-free id fragment for an item id. */
const domId = (value: string): string =>
  Array.from(value, (c) => (/[A-Za-z0-9-]/.test(c) ? c : `_${c.charCodeAt(0).toString(16)}_`)).join(
    '',
  );

/**
 * Ctrl/Cmd-K palette on the installed Radix Dialog. Every item navigates; no
 * item runs a write. Pages and Actions show at once; each remote source loads
 * once per open, independently, and is discarded when the palette closes or
 * the session scope changes.
 */
export function CommandPalette(): ReactElement {
  const palette = usePalette();
  const session = useSession();
  const [, navigate] = useLocation();
  const base = useId();
  const listId = `${base}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState<Loaded>(NOT_LOADED);

  const { info } = session;
  const scope = `${info.guildId}|${info.accountId}|${String(info.instanceOwner === true)}|${String(
    info.canManageTasks === true,
  )}`;
  const run = `${palette.openCount}|${scope}`;

  // The latest session.read and session info, read inside the load effect
  // without making it re-run on every render.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const read: PaletteRead = <T,>(url: string): Promise<T> => sessionRef.current.read<T>(url);
  const infoRef = useRef(info);
  infoRef.current = info;
  const liveRun = useRef<string | null>(null);
  const startedRun = useRef<string | null>(null);

  const sources = useMemo(
    () => PALETTE_SOURCES.filter((s) => s.visible(infoRef.current)),
    // `scope` captures every field `visible` reads.
    [scope],
  );

  useEffect(() => {
    if (!palette.isOpen) {
      liveRun.current = null;
      startedRun.current = null;
      setLoaded(NOT_LOADED);
      setQuery('');
      setActiveId(undefined);
      return;
    }
    liveRun.current = run;
    // StrictMode mounts the effect twice with the same run: load once.
    if (startedRun.current === run) return;
    startedRun.current = run;
    setLoaded({
      run,
      sections: Object.fromEntries(sources.map((s) => [s.section, { state: 'loading' }])),
    });
    const settle = (section: PaletteSection, next: SourceState): void => {
      if (liveRun.current !== run) return;
      setLoaded((prev) =>
        prev.run === run ? { run, sections: { ...prev.sections, [section]: next } } : prev,
      );
    };
    for (const source of sources) {
      source.load(read).then(
        (items) => settle(source.section, { state: 'ready', items }),
        // Never surface the error body: the section line is the whole message.
        () => settle(source.section, { state: 'error' }),
      );
    }
  }, [palette.isOpen, run, sources]);

  const current = loaded.run === run ? loaded.sections : {};
  const sectionState = (section: PaletteSection): SourceState =>
    current[section] ?? { state: 'loading' };

  const ranked = useMemo(() => {
    const all: PaletteItem[] = [...staticItems(infoRef.current)];
    for (const source of sources) {
      const s = current[source.section];
      if (s?.state === 'ready') all.push(...s.items);
    }
    const member = memberItem(query);
    if (member !== undefined) all.push(member);
    return rank(query, all);
  }, [query, loaded, run, sources]);

  const active = ranked.find((i) => i.id === activeId) ?? ranked[0];
  const optionId = (item: PaletteItem): string => `${base}-opt-${domId(item.id)}`;

  useEffect(() => {
    if (active === undefined) return;
    const el = listRef.current?.querySelector(`[id="${optionId(active)}"]`);
    // jsdom has no scrollIntoView; browsers always do.
    if (el instanceof HTMLElement && 'scrollIntoView' in el)
      el.scrollIntoView({ block: 'nearest' });
  }, [active?.id]);

  const go = (item: PaletteItem): void => {
    navigate(item.href);
    palette.closeForNavigation();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (ranked.length === 0) return;
      const at = active === undefined ? -1 : ranked.indexOf(active);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (at + step + ranked.length) % ranked.length;
      setActiveId(ranked[next]?.id);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (active !== undefined) go(active);
    }
  };

  const anyLoading = sources.some((s) => sectionState(s.section).state === 'loading');
  const trimmed = query.trim();

  return (
    <Dialog.Root
      open={palette.isOpen}
      onOpenChange={(next) => {
        if (!next) palette.close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="shell-backdrop fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // The provider owns the single restore; Radix would otherwise
            // race it (and the shell's main focus after a navigation).
            event.preventDefault();
            palette.restoreFocus();
          }}
          aria-modal="true"
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[calc(100dvh-12vh-0.5rem)] w-[min(640px,92vw)] -translate-x-1/2 flex-col overflow-y-auto rounded-panel border border-line bg-panel text-ink shadow-float"
        >
          <Dialog.Title className="sr-only">Search or jump to</Dialog.Title>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <Icon icon={IconSearch} className="shrink-0 text-ink-muted" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label="Search pages, tasks, cases and rules"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active === undefined ? undefined : optionId(active)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Search or jump to…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveId(undefined);
              }}
              onKeyDown={onKeyDown}
              className="min-h-9 min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-muted"
            />
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Results"
            className="@container max-h-[60vh] min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          >
            {SECTION_ORDER.map((section) => {
              const items = ranked.filter((i) => i.section === section);
              if (items.length === 0) return null;
              const headingId = `${base}-h-${domId(section)}`;
              return (
                <div key={section} role="group" aria-labelledby={headingId} className="py-1">
                  <div
                    id={headingId}
                    role="presentation"
                    className="px-2 pb-1 text-caption font-semibold uppercase tracking-wider text-ink-muted"
                  >
                    {section}
                  </div>
                  {items.map((item) => {
                    const selected = item.id === active?.id;
                    return (
                      <div
                        key={item.id}
                        id={optionId(item)}
                        role="option"
                        aria-selected={selected}
                        tabIndex={-1}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => {
                          if (!selected) setActiveId(item.id);
                        }}
                        onClick={() => go(item)}
                        className={`flex min-w-0 cursor-pointer flex-wrap items-start gap-x-2.5 gap-y-0.5 rounded-control px-2.5 py-2 text-body ${
                          selected ? 'bg-accent-bg text-accent' : 'text-ink'
                        }`}
                      >
                        <Icon icon={item.icon} className="mt-0.5 shrink-0" />
                        <span className="min-w-[8ch] flex-[1_1_8ch] [overflow-wrap:anywhere]">
                          {item.label}
                        </span>
                        {item.hint !== undefined && (
                          <span className="min-w-0 max-w-full basis-full pl-[calc(1rem+0.625rem)] text-left text-small text-ink-muted [overflow-wrap:anywhere] @md:max-w-[50%] @md:basis-auto @md:pl-0 @md:text-right">
                            {item.hint}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {SECTION_ORDER.some((section) => {
            const st = sources.some((x) => x.section === section)
              ? sectionState(section).state
              : undefined;
            return st === 'loading' || st === 'error';
          }) && (
            <div className="shrink-0 px-1 pb-1">
              {SECTION_ORDER.map((section) => {
                const state: SourceState | undefined = sources.some((x) => x.section === section)
                  ? sectionState(section)
                  : undefined;
                if (state?.state === 'loading') {
                  return (
                    <div key={section} className="flex items-center gap-2 px-2.5 py-2">
                      <Spinner />
                      <span role="status" className="text-small text-ink-muted">
                        Loading {section.toLowerCase()}…
                      </span>
                    </div>
                  );
                }
                if (state?.state === 'error') {
                  return (
                    <div key={section} className="px-1 py-1">
                      <InlineAlert tone="hold" title={`${section} couldn't load`} />
                    </div>
                  );
                }
                return null;
              })}
            </div>
          )}
          {trimmed !== '' && ranked.length === 0 && !anyLoading && (
            <p
              role="status"
              className="shrink-0 px-4 py-3 text-body text-ink-muted [overflow-wrap:anywhere]"
            >
              No results for &quot;{trimmed}&quot;
            </p>
          )}
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-caption text-ink-muted">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd> to open
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> to close
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
