import { describe, expect, it } from 'vitest';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import {
  CREATE_ROLE_TOOL_NAME,
  createRoleText,
  EDIT_ROLE_TOOL_NAME,
  editRoleText,
  type McpRoleAdminOutcome,
  type McpRoleAdminRefusal,
  type McpRoleAdminPort,
} from './role-admin.js';

/**
 * Task 5, tool layer: `create_role` and `edit_role` against a fake
 * `McpRoleAdminPort` — the same seam the daemon's role-admin wiring
 * implements, so the guard behaviour pinned here (guild gate, argument
 * boundary, refusal rendering) holds whichever implementation sits behind
 * it.
 */

const GUILD_A = parseGuildId('111111111111111111');
const ROLE = '522222222222222222';
const ACTION = 'act-00000000000000000000000001';
/** A display name no text under test may ever carry (no role names in answers). */
const SENTINEL_NAME = 'SentinelDisplayNamezz9';

const principalWith = (guilds: readonly GuildId[]): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes: ['bananasaurs:roles'],
});

const createArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  name: 'helpers',
  idempotencyKey: 'create-k1',
  ...over,
});

const editArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  role: ROLE,
  name: 'helpers renamed',
  idempotencyKey: 'edit-k1',
  ...over,
});

/** Fake role-admin port: every call recorded, the outcome scripted per test. */
const fakeRolePort = (
  outcome: McpRoleAdminOutcome,
): McpRoleAdminPort & {
  readonly calls: number;
  readonly lastCreate: unknown;
  readonly lastEdit: unknown;
} => {
  let calls = 0;
  let lastCreate: unknown;
  let lastEdit: unknown;
  return {
    get calls(): number {
      return calls;
    },
    get lastCreate(): unknown {
      return lastCreate;
    },
    get lastEdit(): unknown {
      return lastEdit;
    },
    createRole: (_guildId, input) => {
      calls += 1;
      lastCreate = input;
      return Promise.resolve(outcome);
    },
    editRole: (_guildId, input) => {
      calls += 1;
      lastEdit = input;
      return Promise.resolve(outcome);
    },
  };
};

const doneCreate: McpRoleAdminOutcome = { status: 'done', actionId: ACTION, roleId: ROLE };
const doneEdit: McpRoleAdminOutcome = { status: 'done', actionId: ACTION, roleId: ROLE };

const textOf = (outcome: { readonly ok: boolean; readonly text?: string }): string => {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('expected ok:true');
  return (outcome as { readonly text: string }).text;
};

const messageOf = (outcome: { readonly ok: boolean; readonly message?: string }): string => {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected ok:false');
  return (outcome as { readonly message: string }).message;
};

describe('role-admin tool names', () => {
  it('are create_role and edit_role', () => {
    expect(CREATE_ROLE_TOOL_NAME).toBe('create_role');
    expect(EDIT_ROLE_TOOL_NAME).toBe('edit_role');
  });
});

describe('role-admin guild gate (CLAUDE.md rule 2)', () => {
  it.each([
    ['create_role unreachable', createRoleText, createArgs],
    ['edit_role unreachable', editRoleText, editArgs],
  ])('%s refuses an unreachable guild with the shared refusal', async (_label, handler, args) => {
    const port = fakeRolePort(doneCreate);
    const outcome = await handler(principalWith([GUILD_A]), port, {
      ...args(),
      guildId: '222222222222222222',
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it.each([
    ['create_role malformed', createRoleText, createArgs],
    ['edit_role malformed', editRoleText, editArgs],
  ])('%s refuses a malformed guild id identically', async (_label, handler, args) => {
    const port = fakeRolePort(doneCreate);
    const outcome = await handler(principalWith([GUILD_A]), port, {
      ...args(),
      guildId: 'not-a-snowflake',
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it.each([
    ['create_role empty set', createRoleText, createArgs],
    ['edit_role empty set', editRoleText, editArgs],
  ])('%s refuses an empty reachable set identically', async (_label, handler, args) => {
    const port = fakeRolePort(doneCreate);
    const outcome = await handler(principalWith([]), port, args());
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(port.calls).toBe(0);
  });
});

describe('create_role argument boundary (hard rule 3)', () => {
  it.each([
    ['empty name', createArgs({ name: '' })],
    ['whitespace-only name', createArgs({ name: '   ' })],
    ['name over 100 characters', createArgs({ name: 'x'.repeat(101) })],
    ['negative color', createArgs({ color: -1 })],
    ['color over 0xFFFFFF', createArgs({ color: 0x100_0000 })],
    ['non-integer color', createArgs({ color: 1.5 })],
    ['non-boolean hoist', createArgs({ hoist: 'yes' })],
    ['non-boolean mentionable', createArgs({ mentionable: 1 })],
    ['missing idempotency key', createArgs({ idempotencyKey: undefined })],
    ['missing guild id', createArgs({ guildId: undefined })],
    ['missing name', createArgs({ name: undefined })],
  ])('%s is the argument fault and the port was never called', async (_label, args) => {
    const port = fakeRolePort(doneCreate);
    const outcome = await createRoleText(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it('a permissions key is an argument fault and the port was never called', async () => {
    const port = fakeRolePort(doneCreate);
    const outcome = await createRoleText(principalWith([GUILD_A]), port, {
      ...createArgs(),
      permissions: '8',
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it('any other unknown key is an argument fault', async () => {
    const port = fakeRolePort(doneCreate);
    const outcome = await createRoleText(principalWith([GUILD_A]), port, {
      ...createArgs(),
      position: 3,
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it('a 100-character name and boundary colors reach the port', async () => {
    const port = fakeRolePort(doneCreate);
    const outcome = await createRoleText(principalWith([GUILD_A]), port, {
      ...createArgs({ name: 'x'.repeat(100), color: 0xff_ff_ff }),
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toBe(1);
  });

  it('the name is trimmed before the port call, so the hash and the call agree', async () => {
    const port = fakeRolePort(doneCreate);
    const outcome = await createRoleText(principalWith([GUILD_A]), port, {
      ...createArgs({ name: '  helpers  ' }),
    });
    expect(outcome.ok).toBe(true);
    expect(port.lastCreate).toMatchObject({ name: 'helpers' });
  });
});

describe('edit_role argument boundary (hard rule 3)', () => {
  it.each([
    ['no field at all', editArgs({ name: undefined })],
    ['empty name', editArgs({ name: '' })],
    ['whitespace-only name', editArgs({ name: '   ' })],
    ['name over 100 characters', editArgs({ name: 'x'.repeat(101) })],
    ['negative color', editArgs({ color: -1, name: undefined })],
    ['color over 0xFFFFFF', editArgs({ color: 0x100_0000, name: undefined })],
    ['non-integer color', editArgs({ color: 2.5, name: undefined })],
    ['non-boolean mentionable', editArgs({ mentionable: 'yes', name: undefined })],
    ['empty role ref', editArgs({ role: '' })],
    ['whitespace-only role ref', editArgs({ role: '   ' })],
    ['missing idempotency key', editArgs({ idempotencyKey: undefined })],
    ['missing guild id', editArgs({ guildId: undefined })],
  ])('%s is the argument fault and the port was never called', async (_label, args) => {
    const port = fakeRolePort(doneEdit);
    const outcome = await editRoleText(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it('a permissions key is an argument fault and the port was never called', async () => {
    const port = fakeRolePort(doneEdit);
    const outcome = await editRoleText(principalWith([GUILD_A]), port, {
      ...editArgs(),
      permissions: '0',
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it('each single field alone reaches the port', async () => {
    for (const args of [
      editArgs({ color: undefined, mentionable: undefined }),
      editArgs({ name: undefined, mentionable: undefined, color: 42 }),
      editArgs({ name: undefined, color: undefined, mentionable: true }),
    ]) {
      const port = fakeRolePort(doneEdit);
      const outcome = await editRoleText(principalWith([GUILD_A]), port, args);
      expect(outcome.ok).toBe(true);
      expect(port.calls).toBe(1);
    }
  });

  it('a path-traversal role ref is passed through untouched and refused daemon-side', async () => {
    const traversal = '../../etc/passwd';
    const port = fakeRolePort({ status: 'refused', reason: 'unknown-role' });
    const outcome = await editRoleText(principalWith([GUILD_A]), port, {
      ...editArgs({ role: traversal, name: 'x' }),
    });
    expect(outcome.ok).toBe(false);
    // The ref is data, never resolved as a path: it reaches the port
    // unchanged, and the refusal names no ref at all.
    expect(port.lastEdit).toMatchObject({ role: traversal });
    const message = messageOf(outcome);
    expect(message).not.toContain('..');
    expect(message).not.toContain('etc/passwd');
  });
});

describe('role-admin refusal texts', () => {
  const reasons: readonly McpRoleAdminRefusal[] = [
    'unknown-role',
    'ambiguous-role',
    'above-bot',
    'managed-or-everyone',
    'dangerous',
    'not-allowlisted',
    'unauthorized',
    'killswitch',
    'breaker-open',
    'rate-cap',
    'duplicate-key-different-content',
    'duplicate-content-recently',
  ];

  it('every refusal text is distinct, for both tools', async () => {
    const seen = new Set<string>();
    for (const reason of reasons) {
      const detail =
        reason === 'ambiguous-role'
          ? '111111111111111112, 111111111111111113'
          : ['above-bot', 'managed-or-everyone', 'dangerous', 'not-allowlisted'].includes(reason)
            ? ROLE
            : undefined;
      const createOutcome = await createRoleText(
        principalWith([GUILD_A]),
        fakeRolePort({
          status: 'refused',
          reason,
          ...(detail !== undefined ? { detail } : {}),
        }),
        createArgs(),
      );
      const editOutcome = await editRoleText(
        principalWith([GUILD_A]),
        fakeRolePort({
          status: 'refused',
          reason,
          ...(detail !== undefined ? { detail } : {}),
        }),
        editArgs(),
      );
      const createMessage = messageOf(createOutcome);
      const editMessage = messageOf(editOutcome);
      expect(createMessage.length).toBeGreaterThan(0);
      expect(editMessage.length).toBeGreaterThan(0);
      for (const message of [createMessage, editMessage]) {
        expect(seen.has(message)).toBe(false);
        seen.add(message);
      }
    }
    expect(seen.size).toBe(reasons.length * 2);
  });

  it('the unauthorized refusal names roles.mutate', async () => {
    const outcome = await createRoleText(
      principalWith([GUILD_A]),
      fakeRolePort({ status: 'refused', reason: 'unauthorized' }),
      createArgs(),
    );
    expect(messageOf(outcome)).toContain('roles.mutate');
  });

  it('grant-policy refusals name the role id, never a role name', async () => {
    for (const reason of [
      'above-bot',
      'managed-or-everyone',
      'dangerous',
      'not-allowlisted',
    ] as const) {
      const outcome = await editRoleText(
        principalWith([GUILD_A]),
        fakeRolePort({ status: 'refused', reason, detail: ROLE }),
        editArgs({ role: SENTINEL_NAME }),
      );
      const message = messageOf(outcome);
      expect(message).toContain(ROLE);
      expect(message).not.toContain(SENTINEL_NAME);
    }
  });
});

describe('role-admin outcomes', () => {
  it('the create answer names the role id, the lack of permissions and the allowlisting step', async () => {
    const outcome = await createRoleText(
      principalWith([GUILD_A]),
      fakeRolePort(doneCreate),
      createArgs(),
    );
    const text = textOf(outcome);
    expect(text).toContain(ROLE);
    expect(text).toContain(ACTION);
    expect(text).toContain('no permissions');
    expect(text).toContain('allowlist');
  });

  it('the edit answer names the role id and the undo', async () => {
    const outcome = await editRoleText(
      principalWith([GUILD_A]),
      fakeRolePort(doneEdit),
      editArgs(),
    );
    const text = textOf(outcome);
    expect(text).toContain(ROLE);
    expect(text).toContain(ACTION);
    expect(text).toContain('undo');
    expect(text).not.toContain(SENTINEL_NAME);
  });

  it('no answer text ever carries a role display name', async () => {
    const createOutcome = await createRoleText(
      principalWith([GUILD_A]),
      fakeRolePort(doneCreate),
      createArgs({ name: SENTINEL_NAME }),
    );
    expect(textOf(createOutcome)).not.toContain(SENTINEL_NAME);
    const editOutcome = await editRoleText(
      principalWith([GUILD_A]),
      fakeRolePort(doneEdit),
      editArgs({ role: SENTINEL_NAME }),
    );
    expect(textOf(editOutcome)).not.toContain(SENTINEL_NAME);
  });

  it('dry runs record without changing and name the action', async () => {
    const createOutcome = await createRoleText(
      principalWith([GUILD_A]),
      fakeRolePort({ status: 'dry-run', actionId: ACTION }),
      createArgs({ dryRun: true }),
    );
    const createText = textOf(createOutcome);
    expect(createText).toContain('Dry run');
    expect(createText).toContain(ACTION);

    const editOutcome = await editRoleText(
      principalWith([GUILD_A]),
      fakeRolePort({ status: 'dry-run', actionId: ACTION, roleId: ROLE }),
      editArgs({ dryRun: true }),
    );
    const editText = textOf(editOutcome);
    expect(editText).toContain('Dry run');
    expect(editText).toContain(ROLE);
    expect(editText).toContain(ACTION);
  });

  it('the dry-run flag reaches the port', async () => {
    const port = fakeRolePort({ status: 'dry-run', actionId: ACTION });
    await createRoleText(principalWith([GUILD_A]), port, createArgs({ dryRun: true }));
    expect(port.lastCreate).toMatchObject({ dryRun: true });
  });

  it('replays answer already-recorded without failure language', async () => {
    const createOutcome = await createRoleText(
      principalWith([GUILD_A]),
      fakeRolePort({ status: 'replayed', actionId: ACTION }),
      createArgs(),
    );
    const createText = textOf(createOutcome);
    expect(createText).toContain(ACTION);
    expect(createText).toContain('list_roles');

    const editOutcome = await editRoleText(
      principalWith([GUILD_A]),
      fakeRolePort({ status: 'replayed', actionId: ACTION, roleId: ROLE }),
      editArgs(),
    );
    expect(textOf(editOutcome)).toContain(ROLE);
  });

  it('a failed create after minting names the created role id', async () => {
    const outcome = await createRoleText(
      principalWith([GUILD_A]),
      fakeRolePort({ status: 'failed', roleId: ROLE }),
      createArgs(),
    );
    const message = messageOf(outcome);
    expect(message).toContain(ROLE);
    expect(message).toContain('unknown result');
    expect(message).toContain('same idempotency key');
  });

  it('a failed create before minting and a failed edit stay generic', async () => {
    const createOutcome = await createRoleText(
      principalWith([GUILD_A]),
      fakeRolePort({ status: 'failed' }),
      createArgs(),
    );
    expect(messageOf(createOutcome)).toContain('unknown result');
    const editOutcome = await editRoleText(
      principalWith([GUILD_A]),
      fakeRolePort({ status: 'failed', roleId: ROLE }),
      editArgs(),
    );
    expect(messageOf(editOutcome)).toContain('unknown result');
  });

  it('a throwing port is the shared refusal, never an exception', async () => {
    const throwing: McpRoleAdminPort = {
      createRole: () => Promise.reject(new Error('boom')),
      editRole: () => Promise.reject(new Error('boom')),
    };
    expect(await createRoleText(principalWith([GUILD_A]), throwing, createArgs())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(await editRoleText(principalWith([GUILD_A]), throwing, editArgs())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
  });
});
