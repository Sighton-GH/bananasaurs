import { useCallback, useEffect, useRef, type ReactElement } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { type Capability } from '@bananasaurs/core';
import { type Account, type AccountsResponse } from '../../../api/ops.js';
import { useSession, type Session } from '../../../app/session.js';
import { useResource } from '../../../hooks/useResource.js';
import { Card } from '../../../ui/Card.js';
import { DataState } from '../../../ui/DataState.js';
import { PageHeader } from '../../../ui/PageHeader.js';
import { TabPanel, Tabs } from '../../../ui/Tabs.js';
import { SummaryCard } from './summary.js';
import {
  PermissionsSection,
  usePermissionsDrafts,
  type PermissionsDraftEntry,
  type PermissionsDraftPatch,
} from './permissions.js';
import { SetPasswordForm, PasswordSection } from './password.js';
import { SessionsSection } from './sessions.js';
import { DangerSection } from './danger.js';

const ACCOUNT_TABS = [
  { value: 'summary', label: 'Summary' },
  { value: 'permissions', label: 'Permissions' },
  { value: 'password', label: 'Password' },
  { value: 'sessions', label: 'Sessions and apps' },
] as const;

/**
 * `/accounts/:username`: one account and everything the owner may change about
 * it (ADR 0069). The page splits into Summary, Permissions, Password and
 * Sessions and apps tabs; the selected tab lives in `?tab=` so a link can
 * open it and Back works. The danger zone stays at the bottom of Summary as
 * a danger-bordered panel. Permission saves only send the difference — one
 * grant or revoke call per changed permission. An owner account shows only
 * its Summary (plus changing its own password when it is yours): the other
 * tabs stay hidden because nothing on them may touch an owner account.
 */
export function AccountEditPage() {
  const { username } = useParams<{ username: string }>();
  const session = useSession();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const load = useCallback(() => session.read<AccountsResponse>('/api/accounts'), [session]);
  const accounts = useResource('the accounts', load);

  const requestedTab = new URLSearchParams(search).get('tab');
  const selectTab = (next: string): void => {
    navigate(`${location}?tab=${next}`);
  };

  // The permissions drafts live above `DataState`: a sibling tab's action
  // reloads the accounts through a Loading state that unmounts everything
  // below, and unapplied choices must survive that. Entries are keyed by
  // username, so a save completing after the operator moved on writes only
  // its own account's entry. Moving between accounts prunes clean entries;
  // an in-flight save or an unseen refusal is kept so the server's answer
  // cannot vanish.
  const { store, clear, prune, update } = usePermissionsDrafts();
  const routeUsername = useRef(username);
  routeUsername.current = username;
  useEffect(() => {
    prune((entry) => entry.busy || entry.error !== undefined);
  }, [username, prune]);
  // An account whose save completes off-route needs a truthful baseline when
  // the operator returns; its refetch is deferred until that route visit.
  const staleAfterOffRouteSave = useRef<Set<string>>(new Set());
  // A successful permissions save reloads the accounts, which unmounts the
  // panel; the fresh mount checks this to land focus on the section heading.
  // Page-owned (above DataState) so it survives the reload and dies with
  // the page; only the saved account claims it, once.
  const savedFocusRef = useRef<string | undefined>(undefined);
  const reloadAccounts = accounts.reload;
  useEffect(() => {
    if (username !== undefined && staleAfterOffRouteSave.current.delete(username)) {
      reloadAccounts();
    }
  }, [username, reloadAccounts]);

  return (
    <>
      <PageHeader
        title={username === undefined ? 'Account' : `Account ${username}`}
        purpose="What this account may do on this server, and how to change it."
        crumbs={[{ label: 'Accounts', href: '/accounts' }]}
        actions={
          <Link
            href="/accounts"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-line bg-panel px-2.5 py-1 text-sm text-ink hover:border-ink-muted"
          >
            Back to accounts
          </Link>
        }
      />
      <DataState resource={accounts.resource}>
        {(r) => {
          const account = r.accounts.find((a) => a.username === username);
          if (account === undefined) {
            return (
              <p className="text-sm text-ink-muted">
                No such account. It may have been deleted —{' '}
                <Link href="/accounts" className="underline">
                  back to accounts
                </Link>
                .
              </p>
            );
          }
          const caps = (r.capabilities[account.accountId] ?? []) as readonly Capability[];
          // Ruling: SessionInfo carries no owner flag — the viewer is the
          // owner exactly when their own row says so.
          const isViewerOwner =
            r.accounts.find((a) => a.accountId === session.info.accountId)?.isOwner === true;
          const isOwnAccount = account.accountId === session.info.accountId;
          if (account.isOwner) {
            // An owner account has nothing here but its summary — plus its
            // own password change when the viewer is that owner. Tabs that
            // would touch it stay hidden; the summary explains why.
            if (!isOwnAccount) {
              return (
                <div className="grid max-w-2xl gap-4">
                  <SummaryCard account={account} caps={caps} />
                </div>
              );
            }
            const ownerTabs = [
              { value: 'summary', label: 'Summary' },
              { value: 'password', label: 'Password' },
            ];
            const selected =
              requestedTab !== null && ownerTabs.some((t) => t.value === requestedTab)
                ? requestedTab
                : 'summary';
            return (
              <Tabs
                aria-label="Account sections"
                value={selected}
                onValueChange={selectTab}
                tabs={ownerTabs}
              >
                <TabPanel value="summary">
                  <div className="grid max-w-2xl gap-4 pt-4">
                    <SummaryCard account={account} caps={caps} />
                  </div>
                </TabPanel>
                <TabPanel value="password">
                  <div className="grid max-w-2xl gap-4 pt-4">
                    <Card title="Change your password">
                      <SetPasswordForm
                        session={session}
                        username={account.username}
                        onPasswordSet={accounts.reload}
                      />
                    </Card>
                  </div>
                </TabPanel>
              </Tabs>
            );
          }
          return (
            <NonOwnerAccountSections
              key={account.username}
              session={session}
              account={account}
              caps={caps}
              isViewerOwner={isViewerOwner}
              isOwnAccount={isOwnAccount}
              requestedTab={requestedTab}
              onSelectTab={selectTab}
              draft={store[account.username]}
              onDraftChange={(patch) => update(account.username, caps, patch)}
              onSaved={() => {                // A successful save reconciles only its own account: drop its
                // entry (the server has the change) and reload the baseline
                // only when the route still shows that account. A late
                // completion for another account must not disturb the view,
                // so that account is marked stale and refetched when the
                // operator returns to it.
                savedFocusRef.current = account.username;
                clear(account.username);
                if (routeUsername.current === account.username) {
                  accounts.reload();
                } else {
                  staleAfterOffRouteSave.current.add(account.username);
                }
              }}
              onReload={accounts.reload}
              onDeleted={() => navigate('/accounts')}
              savedFocusRef={savedFocusRef}
            />
          );
        }}
      </DataState>
    </>
  );
}

/**
 * The four tabs of a non-owner account. The permissions draft is passed in
 * from above `DataState` so tab switches and sibling-tab reloads cannot drop
 * it. Keyed by username at the call site, so opening a different account
 * starts with that account's own entry (or its held baseline).
 */
function NonOwnerAccountSections({
  session,
  account,
  caps,
  isViewerOwner,
  isOwnAccount,
  requestedTab,
  onSelectTab,
  draft,
  onDraftChange,
  onSaved,
  onReload,
  onDeleted,
  savedFocusRef,
}: {
  readonly session: Session;
  readonly account: Account;
  readonly caps: readonly Capability[];
  readonly isViewerOwner: boolean;
  readonly isOwnAccount: boolean;
  readonly requestedTab: string | null;
  readonly onSelectTab: (next: string) => void;
  readonly draft: PermissionsDraftEntry | undefined;
  readonly onDraftChange: (patch: PermissionsDraftPatch) => void;
  readonly onSaved: () => void;
  readonly onReload: () => void;
  readonly onDeleted: () => void;
  readonly savedFocusRef: { current: string | undefined };
}): ReactElement {
  const selected =
    requestedTab !== null && ACCOUNT_TABS.some((t) => t.value === requestedTab)
      ? requestedTab
      : 'summary';
  return (
    <Tabs
      aria-label="Account sections"
      value={selected}
      onValueChange={onSelectTab}
      tabs={ACCOUNT_TABS}
    >
      <TabPanel value="summary">
        <div className="grid max-w-2xl gap-4 pt-4">
          <SummaryCard account={account} caps={caps} />
          <DangerSection
            session={session}
            account={account}
            isOwnAccount={isOwnAccount}
            onChanged={onReload}
            onDeleted={onDeleted}
          />
        </div>
      </TabPanel>
      <TabPanel value="permissions">
        <div className="grid max-w-2xl gap-4 pt-4">
          <PermissionsSection
            session={session}
            username={account.username}
            held={caps}
            draft={draft}
            onDraftChange={onDraftChange}
            onSaved={onSaved}
            savedFocusRef={savedFocusRef}
          />
        </div>
      </TabPanel>
      <TabPanel value="password">
        <div className="grid max-w-2xl gap-4 pt-4">
          <PasswordSection
            session={session}
            username={account.username}
            canReveal={isViewerOwner}
            revealable={account.revealable}
            onChanged={onReload}
          />
        </div>
      </TabPanel>
      <TabPanel value="sessions">
        <div className="grid max-w-2xl gap-4 pt-4">
          <SessionsSection session={session} username={account.username} onChanged={onReload} />
        </div>
      </TabPanel>
    </Tabs>
  );
}
