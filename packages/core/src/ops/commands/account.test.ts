import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type {
  OpsAccount,
  OpsAccountDeleteResult,
  OpsAccountDisableResult,
  OpsAuditWrite,
  OpsPorts,
} from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import {
  accountDeleteCommand,
  accountDisableCommand,
  accountEnableCommand,
  accountGrantCommand,
  accountListCommand,
} from './account.js';

const NOW = 1_700_000_000_000;

const iso = (ms: number): string => new Date(ms).toISOString();

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(args?: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly seen: unknown[];
}

const harness = (grant: OpsPorts['grantAccountCapability']): Harness => {
  const audit: OpsAuditWrite[] = [];
  const seen: unknown[] = [];
  const dispatcher = createDispatcher({
    commands: [accountGrantCommand],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts({
        recordAudit: (input) => {
          audit.push(input);
        },
        grantAccountCapability: (input) => {
          seen.push(input);
          return grant(input);
        },
      }),
    }),
    instance: fakeOpsInstance(),
  });
  return {
    audit,
    seen,
    run: (args = {}, confirm = true) =>
      dispatcher.dispatch({ v: 1, command: 'account grant', args, confirm }),
  };
};

interface AccountStubs {
  accountList?: () => readonly OpsAccount[];
  accountSetDisabled?: (username: string, disabled: boolean) => OpsAccountDisableResult;
  accountDelete?: (username: string) => OpsAccountDeleteResult;
}

interface AccountHarness {
  run(command: string, args?: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly listCalls: number;
  readonly setDisabledCalls: Array<{ username: string; disabled: boolean }>;
  readonly deleteCalls: string[];
}

const accountHarness = (stubs: AccountStubs = {}): AccountHarness => {
  const audit: OpsAuditWrite[] = [];
  const setDisabledCalls: Array<{ username: string; disabled: boolean }> = [];
  const deleteCalls: string[] = [];
  let listCalls = 0;
  const dispatcher = createDispatcher({
    commands: [
      accountListCommand,
      accountDisableCommand,
      accountEnableCommand,
      accountDeleteCommand,
    ],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts({
        recordAudit: (input) => {
          audit.push(input);
        },
      }),
    }),
    instance: fakeOpsInstance({
      accountList: () => {
        listCalls += 1;
        return stubs.accountList?.() ?? [];
      },
      accountSetDisabled: (username, disabled) => {
        setDisabledCalls.push({ username, disabled });
        return stubs.accountSetDisabled?.(username, disabled) ?? 'no-such-account';
      },
      accountDelete: (username) => {
        deleteCalls.push(username);
        return stubs.accountDelete?.(username) ?? 'no-such-account';
      },
    }),
  });
  return {
    audit,
    setDisabledCalls,
    deleteCalls,
    get listCalls() {
      return listCalls;
    },
    run: (command, args = {}, confirm = true) =>
      dispatcher.dispatch({ v: 1, command, args, confirm }),
  };
};

describe('account grant is registered on the operator surface (ADR 0028)', () => {
  it('appears in the command list as a write', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toContain('account grant');
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'account grant')?.write).toBe(true);
  });
});

describe('account grant', () => {
  it('refuses without --confirm before argument validation', async () => {
    const h = harness(() => 'granted');
    // A deliberately invalid capability: the error must still be
    // needs-confirm, because the dispatcher checks confirmation first.
    const response = await h.run({ username: 'owner', capability: 'mcp.admin' }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
  });

  it('grants the capability and audits the write', async () => {
    const h = harness(() => 'granted');
    const response = await h.run({ username: 'owner', capability: 'mcp.authorize' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe(
      `granted mcp.authorize to owner in guild ${FIXTURE_GUILD_ID}`,
    );
    expect(h.seen).toEqual([
      { username: 'owner', capability: 'mcp.authorize', grantedBy: expect.any(String) },
    ]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'account.capability.granted',
      subjectType: 'account',
      subjectId: 'owner',
      before: { held: false },
      after: { held: true, capability: 'mcp.authorize' },
    });
  });

  it('reports already-held as a usage answer with an audit row marked unchanged', async () => {
    const h = harness(() => 'already-held');
    const response = await h.run({ username: 'owner', capability: 'mcp.authorize' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('already holds');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'account.capability.granted',
      subjectType: 'account',
      subjectId: 'owner',
    });
    expect((h.audit[0]?.after as { changed?: boolean } | undefined)?.changed).toBe(false);
  });

  it('throws for an account that does not exist, and audits nothing', async () => {
    const h = harness(() => 'no-such-account');
    const response = await h.run({ username: 'ghost', capability: 'mcp.authorize' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('ghost');
    expect(h.audit).toHaveLength(0);
  });

  it('throws for an account that cannot reach this guild, and audits nothing', async () => {
    const h = harness(() => 'no-guild-access');
    const response = await h.run({ username: 'owner', capability: 'mcp.authorize' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('owner');
    expect(h.audit).toHaveLength(0);
  });

  it('refuses an unknown capability by naming the valid set', async () => {
    const h = harness(() => 'granted');
    const response = await h.run({ username: 'owner', capability: 'mcp.admin' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('bad-request');
    // The validator is `z.enum(CAPABILITIES)`, so the refusal names what was
    // expected — including the capability this grant path is for.
    expect(response.ok === false && response.message).toContain('mcp.authorize');
  });
});

describe('account lifecycle --confirm gate (test 1)', () => {
  it('refuses account disable without --confirm and never reaches the instance', async () => {
    const h = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'owner',
        isOwner: true,
        disabled: true,
        lockedUntil: null,
        enabledOwnersRemaining: 1,
      }),
    });
    const response = await h.run('account disable', { username: 'owner' }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(h.setDisabledCalls).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it('refuses account enable without --confirm and never reaches the instance', async () => {
    const h = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'owner',
        isOwner: true,
        disabled: false,
        lockedUntil: null,
        enabledOwnersRemaining: 1,
      }),
    });
    const response = await h.run('account enable', { username: 'owner' }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(h.setDisabledCalls).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it('refuses account delete without --confirm and never reaches the instance', async () => {
    const h = accountHarness({
      accountDelete: () => ({
        username: 'owner',
        accountId: 'acc-1',
        wasOwner: true,
        tokensRevoked: 0,
        codesDeleted: 0,
        enabledOwnersRemaining: 1,
        accountsRemaining: 1,
      }),
    });
    const response = await h.run('account delete', { username: 'owner' }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(h.deleteCalls).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });
});

describe('account lifecycle commands are registered (test 2)', () => {
  it('lists all four with list as a read and the other three as writes', () => {
    for (const name of ['account list', 'account disable', 'account enable', 'account delete']) {
      expect(OPERATOR_COMMANDS.map((c) => c.name)).toContain(name);
    }
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'account list')?.write).toBe(false);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'account disable')?.write).toBe(true);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'account enable')?.write).toBe(true);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'account delete')?.write).toBe(true);
  });
});

describe('account list (tests 3-5)', () => {
  it('renders no dashboard accounts for an empty instance', async () => {
    const h = accountHarness({ accountList: () => [] });
    const response = await h.run('account list', {});
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe('no dashboard accounts');
    expect(response.ok && response.data).toEqual([]);
  });

  it('renders owner/member, DISABLED/enabled, and locked until only for a future lockout', async () => {
    const future = NOW + 3_600_000;
    const past = NOW - 3_600_000;
    const h = accountHarness({
      accountList: () => [
        {
          accountId: 'id-alice',
          username: 'alice',
          isOwner: true,
          disabled: true,
          lockedUntil: future,
          createdAt: NOW - 100_000,
        },
        {
          accountId: 'id-bob',
          username: 'bob',
          isOwner: false,
          disabled: false,
          lockedUntil: past,
          createdAt: NOW - 50_000,
        },
      ],
    });
    const response = await h.run('account list', {});
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain(
      `alice  id-alice  owner  DISABLED  created ${iso(NOW - 100_000)}`,
    );
    expect(response.ok && response.text).toContain(
      `bob  id-bob  member  enabled  created ${iso(NOW - 50_000)}`,
    );
    expect(response.ok && response.text).toContain(`locked until ${iso(future)}`);
    // The past lockout is elapsed, so it is not a fact about the account any
    // more: exactly one locked-until line, the future one.
    const occurrences = response.ok === false ? 0 : response.text.split('locked until').length - 1;
    expect(occurrences).toBe(1);
    // Order follows accountList().
    if (response.ok) {
      expect(response.text.indexOf('alice')).toBeLessThan(response.text.indexOf('bob'));
    }
  });

  it('omits locked until when the only lockout already elapsed', async () => {
    const past = NOW - 3_600_000;
    const h = accountHarness({
      accountList: () => [
        {
          accountId: 'id-bob',
          username: 'bob',
          isOwner: false,
          disabled: false,
          lockedUntil: past,
          createdAt: NOW - 50_000,
        },
      ],
    });
    const response = await h.run('account list', {});
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).not.toContain('locked until');
  });

  it('succeeds without --confirm because it is a read', async () => {
    const h = accountHarness({ accountList: () => [] });
    const response = await h.run('account list', {}, false);
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe('no dashboard accounts');
  });
});

describe('account disable (tests 6-9)', () => {
  it('rejects an unknown account by name and writes no audit row', async () => {
    const h = accountHarness({ accountSetDisabled: () => 'no-such-account' });
    const response = await h.run('account disable', { username: 'ghost' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('ghost');
    expect(h.audit).toHaveLength(0);
  });

  it('answers already-disabled with changed:false in data and audit', async () => {
    const h = accountHarness({
      accountSetDisabled: () => ({
        changed: false,
        username: 'alice',
        isOwner: false,
        disabled: true,
        lockedUntil: null,
        enabledOwnersRemaining: 1,
      }),
    });
    const response = await h.run('account disable', { username: 'alice' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe('alice is already disabled; nothing changed');
    expect(response.ok && response.data).toMatchObject({
      username: 'alice',
      disabled: true,
      changed: false,
    });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'account.disabled',
      subjectType: 'account',
      subjectId: 'alice',
    });
    expect((h.audit[0]?.after as { changed?: boolean } | undefined)?.changed).toBe(false);
  });

  it('warns about the last enabled owner only at zero remaining', async () => {
    const last = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'owner',
        isOwner: true,
        disabled: true,
        lockedUntil: null,
        enabledOwnersRemaining: 0,
      }),
    });
    const lastResponse = await last.run('account disable', { username: 'owner' });
    expect(lastResponse.ok).toBe(true);
    expect(lastResponse.ok && lastResponse.text).toContain('disabled owner');
    expect(lastResponse.ok && lastResponse.text).toContain(
      'every dashboard session and every OAuth token this account approved ' +
        'stops verifying for as long as it stays disabled',
    );
    expect(lastResponse.ok && lastResponse.text).toContain(
      'WARNING: that was the last enabled owner account. Nobody can sign in to the dashboard.',
    );
    expect(lastResponse.ok && lastResponse.text).toContain(
      'bananasaurs account enable owner --confirm',
    );

    const spared = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'owner',
        isOwner: true,
        disabled: true,
        lockedUntil: null,
        enabledOwnersRemaining: 1,
      }),
    });
    const sparedResponse = await spared.run('account disable', { username: 'owner' });
    expect(sparedResponse.ok).toBe(true);
    expect(sparedResponse.ok && sparedResponse.text).not.toContain('WARNING');
  });

  it('audits disabled with before false and after true', async () => {
    const h = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'owner',
        isOwner: true,
        disabled: true,
        lockedUntil: null,
        enabledOwnersRemaining: 1,
      }),
    });
    const response = await h.run('account disable', { username: 'owner' });
    expect(response.ok).toBe(true);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'account.disabled',
      subjectType: 'account',
      subjectId: 'owner',
      before: { disabled: false },
      after: { disabled: true },
    });
  });
});

describe('account enable (test 10)', () => {
  it('notes a future lockout and omits the note when there is none', async () => {
    const future = NOW + 3_600_000;
    const locked = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'bob',
        isOwner: false,
        disabled: false,
        lockedUntil: future,
        enabledOwnersRemaining: 1,
      }),
    });
    const lockedResponse = await locked.run('account enable', { username: 'bob' });
    expect(lockedResponse.ok).toBe(true);
    expect(lockedResponse.ok && lockedResponse.text).toContain('enabled bob');
    expect(lockedResponse.ok && lockedResponse.text).toContain(
      `note: bob is locked out until ${iso(future)}; enabling an account does not clear a lockout`,
    );

    const clear = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'bob',
        isOwner: false,
        disabled: false,
        lockedUntil: null,
        enabledOwnersRemaining: 1,
      }),
    });
    const clearResponse = await clear.run('account enable', { username: 'bob' });
    expect(clearResponse.ok).toBe(true);
    expect(clearResponse.ok && clearResponse.text).toBe('enabled bob');
  });
});

describe('account delete (tests 11-12)', () => {
  it('renders token and code counts, warning only at zero owners remaining', async () => {
    const last = accountHarness({
      accountDelete: () => ({
        username: 'owner',
        accountId: 'acc-1',
        wasOwner: true,
        tokensRevoked: 3,
        codesDeleted: 2,
        enabledOwnersRemaining: 0,
        accountsRemaining: 0,
      }),
    });
    const lastResponse = await last.run('account delete', { username: 'owner' });
    expect(lastResponse.ok).toBe(true);
    expect(lastResponse.ok && lastResponse.text).toContain('deleted owner (acc-1)');
    expect(lastResponse.ok && lastResponse.text).toContain(
      'revoked 3 OAuth token(s) and removed 2 unexchanged authorization code(s)',
    );
    expect(lastResponse.ok && lastResponse.text).toContain(
      'WARNING: that was the last enabled owner account and the last account of any kind. ' +
        'Nobody can sign in to the dashboard.',
    );
    expect(lastResponse.ok && lastResponse.text).toContain('bootstrap reissue');

    const spared = accountHarness({
      accountDelete: () => ({
        username: 'member',
        accountId: 'acc-2',
        wasOwner: false,
        tokensRevoked: 1,
        codesDeleted: 0,
        enabledOwnersRemaining: 1,
        accountsRemaining: 2,
      }),
    });
    const sparedResponse = await spared.run('account delete', { username: 'member' });
    expect(sparedResponse.ok).toBe(true);
    expect(sparedResponse.ok && sparedResponse.text).not.toContain('WARNING');
  });

  it('audits the delete with the port counts in after', async () => {
    const h = accountHarness({
      accountDelete: () => ({
        username: 'owner',
        accountId: 'acc-1',
        wasOwner: true,
        tokensRevoked: 3,
        codesDeleted: 2,
        enabledOwnersRemaining: 1,
        accountsRemaining: 1,
      }),
    });
    const response = await h.run('account delete', { username: 'owner' });
    expect(response.ok).toBe(true);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'account.deleted',
      subjectType: 'account',
      subjectId: 'owner',
      before: { exists: true, isOwner: true },
      after: { exists: false, tokensRevoked: 3, codesDeleted: 2 },
    });
    expect((h.audit[0]?.after as { tokensRevoked?: number } | undefined)?.tokensRevoked).toBe(3);
  });
});

describe('account delete ownerless warning branches on rows remaining (M3b-R9)', () => {
  it('prints the bootstrap reissue wording only when accountsRemaining === 0', async () => {
    const last = accountHarness({
      accountDelete: () => ({
        username: 'owner',
        accountId: 'acc-1',
        wasOwner: true,
        tokensRevoked: 0,
        codesDeleted: 0,
        enabledOwnersRemaining: 0,
        accountsRemaining: 0,
      }),
    });
    const response = await last.run('account delete', { username: 'owner' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('bootstrap reissue --confirm');
    expect(response.ok && response.data).toMatchObject({ accountsRemaining: 0 });
  });

  it('prints the will-refuse wording when accountsRemaining > 0', async () => {
    const h = accountHarness({
      accountDelete: () => ({
        username: 'owner',
        accountId: 'acc-1',
        wasOwner: true,
        tokensRevoked: 0,
        codesDeleted: 0,
        enabledOwnersRemaining: 0,
        accountsRemaining: 2,
      }),
    });
    const response = await h.run('account delete', { username: 'owner' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).not.toContain('bootstrap reissue --confirm');
    expect(response.ok && response.text).toContain(
      'will refuse while the remaining 2 account(s) exist',
    );
    expect(response.ok && response.data).toMatchObject({ accountsRemaining: 2 });
  });
});

describe('account warnings are gated on the target having been an owner (M3b-R10)', () => {
  it('disable of a non-owner at zero owners warns nothing and notes instead', async () => {
    const h = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'member',
        isOwner: false,
        disabled: true,
        lockedUntil: null,
        enabledOwnersRemaining: 0,
      }),
    });
    const response = await h.run('account disable', { username: 'member' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).not.toContain('WARNING');
    expect(response.ok && response.text).toContain(
      'note: no enabled owner account remains on this instance; ' +
        'member is not an owner, so enabling it would not restore dashboard sign-in.',
    );
  });

  it('delete of a non-owner at zero owners warns nothing and notes instead', async () => {
    const h = accountHarness({
      accountDelete: () => ({
        username: 'member',
        accountId: 'acc-2',
        wasOwner: false,
        tokensRevoked: 0,
        codesDeleted: 0,
        enabledOwnersRemaining: 0,
        accountsRemaining: 1,
      }),
    });
    const response = await h.run('account delete', { username: 'member' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).not.toContain('WARNING');
    expect(response.ok && response.text).toContain(
      'note: no enabled owner account remains on this instance; ' +
        'member is not an owner, so re-creating it would not restore dashboard sign-in.',
    );
  });
});

describe('account disable states the pause, not a rotation (M3b-R11)', () => {
  it('success text contains the pause-not-rotation line', async () => {
    const h = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'owner',
        isOwner: true,
        disabled: true,
        lockedUntil: null,
        enabledOwnersRemaining: 1,
      }),
    });
    const response = await h.run('account disable', { username: 'owner' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain(
      'every dashboard session and every OAuth token this account approved ' +
        'stops verifying for as long as it stays disabled',
    );
    expect(response.ok && response.text).toContain(
      'this is a pause, not a rotation: `account enable` restores every one of those ' +
        'credentials intact. To end them for good, use `account delete`.',
    );
  });
});

describe('account lifecycle outputs carry no secret (test 13)', () => {
  it('never renders a password hash in text, data, or audit', async () => {
    const accounts: OpsAccount[] = [
      {
        accountId: 'id-owner',
        username: 'owner',
        isOwner: true,
        disabled: false,
        lockedUntil: null,
        createdAt: NOW,
      },
    ];
    const texts: string[] = [];
    const payloads: string[] = [];

    const listHarness = accountHarness({ accountList: () => accounts });
    const listResponse = await listHarness.run('account list', {});
    expect(listResponse.ok).toBe(true);
    if (listResponse.ok) {
      texts.push(listResponse.text);
      payloads.push(JSON.stringify(listResponse.data));
    }
    payloads.push(JSON.stringify(listHarness.audit));

    const disableHarness = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'owner',
        isOwner: true,
        disabled: true,
        lockedUntil: null,
        enabledOwnersRemaining: 1,
      }),
    });
    const disableResponse = await disableHarness.run('account disable', { username: 'owner' });
    expect(disableResponse.ok).toBe(true);
    if (disableResponse.ok) {
      texts.push(disableResponse.text);
      payloads.push(JSON.stringify(disableResponse.data));
    }
    payloads.push(JSON.stringify(disableHarness.audit));

    const enableHarness = accountHarness({
      accountSetDisabled: () => ({
        changed: true,
        username: 'owner',
        isOwner: true,
        disabled: false,
        lockedUntil: null,
        enabledOwnersRemaining: 1,
      }),
    });
    const enableResponse = await enableHarness.run('account enable', { username: 'owner' });
    expect(enableResponse.ok).toBe(true);
    if (enableResponse.ok) {
      texts.push(enableResponse.text);
      payloads.push(JSON.stringify(enableResponse.data));
    }
    payloads.push(JSON.stringify(enableHarness.audit));

    const deleteHarness = accountHarness({
      accountDelete: () => ({
        username: 'owner',
        accountId: 'id-owner',
        wasOwner: true,
        tokensRevoked: 1,
        codesDeleted: 1,
        enabledOwnersRemaining: 1,
        accountsRemaining: 1,
      }),
    });
    const deleteResponse = await deleteHarness.run('account delete', { username: 'owner' });
    expect(deleteResponse.ok).toBe(true);
    if (deleteResponse.ok) {
      texts.push(deleteResponse.text);
      payloads.push(JSON.stringify(deleteResponse.data));
    }
    payloads.push(JSON.stringify(deleteHarness.audit));

    for (const text of texts) {
      expect(text).not.toContain('$argon2');
    }
    for (const payload of payloads) {
      expect(payload).not.toContain('$argon2');
    }
  });
});
