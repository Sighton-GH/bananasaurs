import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACCOUNT_ROLES,
  roleForCapabilities,
  type AccountRoleId,
  type Capability,
} from '@bananasaurs/core';
import { type Session } from '../../../app/session.js';
import { Button } from '../../../ui/Button.js';
import { Card } from '../../../ui/Card.js';
import { ErrorNotice } from '../../../ui/ErrorNotice.js';
import { RoleCards } from '../../../ui/RoleCards.js';
import { useToast } from '../../../ui/Toast.js';

/**
 * The permissions drafts and their save lifecycles (selection, busy,
 * refusal), held above the tab panels and above `DataState`: switching tabs
 * unmounts the panel, and a sibling tab's action reloads the accounts
 * through a Loading state — neither may discard unapplied choices or lose an
 * in-flight save's outcome. Drafts are keyed by username, so a save that
 * completes after the operator moved to another account writes only its own
 * entry and can never wipe or re-seed the viewed account's draft. An entry
 * with an in-flight save or an unseen refusal survives route changes; a
 * clean entry is pruned on navigation (the page owns that rule). A
 * successful save clears its own entry and reloads only when the route still
 * shows that account.
 */
export interface PermissionsDraftEntry {
  readonly role: AccountRoleId;
  readonly customCaps: readonly Capability[];
  readonly busy: boolean;
  readonly error: unknown;
}

export type PermissionsDraftPatch = Partial<PermissionsDraftEntry>;

// The username whose save just succeeded. The reload that follows unmounts
// the permissions panel, so the fresh mount checks this to land focus on
// the section heading instead of leaving it on <body>.
let pendingSavedFocus: string | undefined;

export function usePermissionsDrafts(): {
  readonly store: Readonly<Record<string, PermissionsDraftEntry>>;
  readonly clear: (username: string) => void;
  /** Drop every entry the predicate rejects; in-flight saves and unseen refusals are kept. */
  readonly prune: (keep: (entry: PermissionsDraftEntry) => boolean) => void;
  readonly update: (
    username: string,
    held: readonly Capability[],
    patch: PermissionsDraftPatch,
  ) => void;
} {
  const [store, setStore] = useState<Readonly<Record<string, PermissionsDraftEntry>>>({});
  const clear = useCallback((username: string) => {
    setStore((cur) => {
      if (!(username in cur)) return cur;
      const next = { ...cur };
      delete next[username];
      return next;
    });
  }, []);
  const prune = useCallback((keep: (entry: PermissionsDraftEntry) => boolean) => {
    setStore((cur) => {
      const next: Record<string, PermissionsDraftEntry> = {};
      let changed = false;
      for (const [name, entry] of Object.entries(cur)) {
        if (keep(entry)) next[name] = entry;
        else changed = true;
      }
      return changed ? next : cur;
    });
  }, []);
  const update = useCallback(
    (username: string, held: readonly Capability[], patch: PermissionsDraftPatch) => {
      setStore((cur) => {
        const base: PermissionsDraftEntry = cur[username] ?? {
          role: roleForCapabilities(held),
          customCaps: held,
          busy: false,
          error: undefined,
        };
        return { ...cur, [username]: { ...base, ...patch } };
      });
    },
    [],
  );
  return { store, clear, prune, update };
}

export function PermissionsSection({
  session,
  username,
  held,
  draft,
  onDraftChange,
  onSaved,
}: {
  readonly session: Session;
  readonly username: string;
  readonly held: readonly Capability[];
  readonly draft: PermissionsDraftEntry | undefined;
  readonly onDraftChange: (patch: PermissionsDraftPatch) => void;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const role = draft?.role ?? roleForCapabilities(held);
  const customCaps = draft?.customCaps ?? held;
  const busy = draft?.busy ?? false;
  const error = draft?.error;
  // A successful save reloads the accounts, which unmounts this panel; the
  // fresh mount lands focus on the section heading instead of leaving it on
  // <body>. Only the account just saved claims it, and only once.
  const sectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pendingSavedFocus === undefined) return;
    const mine = pendingSavedFocus === username;
    pendingSavedFocus = undefined;
    if (!mine) return;
    const heading = sectionRef.current?.querySelector<HTMLElement>('h2');
    if (heading === undefined || heading === null) return;
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }, [username]);
  // The in-flight Save disables, which drops focus to <body> in a real
  // browser. When a refusal leaves focus there, put it back on Save; when
  // the operator moved elsewhere mid-flight, leave them alone. Deferred
  // past the busy update's commit: until it lands the button is still
  // disabled and cannot take focus.
  const saveWrapRef = useRef<HTMLDivElement>(null);
  const recoverSaveFocus = (): void => {
    if (document.activeElement !== document.body) return;
    window.setTimeout(() => {
      if (document.activeElement !== document.body) return;
      saveWrapRef.current?.querySelector<HTMLElement>('button')?.focus();
    }, 0);
  };

  const selected: readonly Capability[] =
    role === 'custom' ? customCaps : (ACCOUNT_ROLES.find((r) => r.id === role)?.capabilities ?? []);
  const grants = selected.filter((c) => !held.includes(c));
  const revokes = held.filter((c) => !selected.includes(c));
  const unchanged = grants.length === 0 && revokes.length === 0;

  const save = async (): Promise<void> => {
    if (unchanged || busy) return;
    onDraftChange({ busy: true, error: undefined });
    const name = encodeURIComponent(username);
    try {
      for (const capability of grants) {
        const result = await session.writeOrThrow<{ outcome: string }>(
          `/api/accounts/${name}/capabilities`,
          { capability },
        );
        if (result === undefined) {
          onDraftChange({ busy: false });
          recoverSaveFocus();
          return;
        }
      }
      for (const capability of revokes) {
        const result = await session.writeOrThrow<{ outcome: string }>(
          `/api/accounts/${name}/capabilities/${capability}`,
          undefined,
          'DELETE',
        );
        if (result === undefined) {
          onDraftChange({ busy: false });
          recoverSaveFocus();
          return;
        }
      }
      toast({
        tone: 'ok',
        title: `Permissions saved for ${username}`,
        ...(grants.length === 0 && revokes.length === 0
          ? {}
          : {
              message: `Granted ${String(grants.length)}, revoked ${String(revokes.length)}.`,
            }),
      });
      // A successful save reconciles deliberately: the page clears the draft
      // and reloads, so the fresh response becomes the baseline.
      pendingSavedFocus = username;
      onSaved();
    } catch (err) {
      // writeOrThrow lets the server's 400/409 answers through; everything
      // else already became a toast. Render the answer rather than
      // translating the refusal here — even if the operator has since
      // switched tabs, the draft above the panels keeps it.
      onDraftChange({ busy: false, error: err });
      recoverSaveFocus();
    }
  };

  return (
    <div ref={sectionRef}>
      <Card title="Permissions on this server">
        <RoleCards
          value={role}
          capabilities={selected}
          onChange={(nextRole, nextCaps) => {
            onDraftChange(
              nextRole === 'custom' ? { role: nextRole, customCaps: nextCaps } : { role: nextRole },
            );
          }}
        />
        {error !== undefined && (
          <div className="mt-2">
            <ErrorNotice error={error} />
          </div>
        )}
        <div className="mt-3" ref={saveWrapRef}>
          <Button variant="primary" busy={busy} disabled={unchanged} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </Card>
    </div>
  );
}
