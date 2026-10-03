import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import { MCP_READ_GET_PANEL, MCP_READ_LIST_PANELS, type McpReadAuditPort } from '../read-audit.js';
import { createMcpServer } from '../server.js';
import type { McpHealthPort } from './health.js';
import type { McpArchivePort } from './archive.js';
import type { McpGuildPort } from './guild.js';
import type { McpRecordsPort } from './records.js';
import type { McpSendPort } from './send.js';
import type { McpThreadWritesPort } from './thread-writes.js';
import type { McpMessageWritesPort } from './message-writes.js';
import type { McpRoleWritesPort } from './role-writes.js';
import type { McpJobsPort } from './jobs.js';
import type { McpMembersPort } from './members.js';
import type { McpContextPort } from './context.js';
import type { McpResourcesPort } from './resources.js';
import type { McpThreadsPort } from './threads.js';
import {
  CREATE_PANEL_TOOL_NAME,
  createPanelText,
  DELETE_PANEL_TOOL_NAME,
  deletePanelText,
  EDIT_PANEL_TOOL_NAME,
  editPanelText,
  GET_PANEL_TOOL_NAME,
  getPanelText,
  LIST_PANELS_TOOL_NAME,
  listPanelsText,
  type McpPanelOutcome,
  type McpPanelRefusal,
  type McpPanelsPort,
} from './panels.js';

/**
 * Task 6b, tool layer: the five panel tools against a fake `McpPanelsPort` —
 * the same seam the daemon's panel wiring implements, so the guard behaviour
 * pinned here (guild gate, argument boundary, ref resolution, refusal
 * rendering, read records) holds whichever implementation sits behind it.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';
const CHANNEL_TWIN = '344444444444444444';
const ROLE = '522222222222222222';
const ROLE_TWIN = '533333333333333333';
const ACTION = 'act-00000000000000000000000001';
const PANEL = 'mcp-1a2b3c4d';
/** A display name no text under test may ever carry (no role names in answers). */
const SENTINEL_NAME = 'SentinelDisplayNamezz9';
/** An option label no refusal text may ever carry. */
const SENTINEL_LABEL = 'SentinelOptionLabelzz9';

const principalWith = (
  guilds: readonly GuildId[],
  scopes: readonly string[] = ['bananasaurs:roles'],
): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes,
});

const buttonOption = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: ROLE,
  label: 'Helpers',
  ...over,
});

const createArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channel: CHANNEL,
  title: 'Pick a role',
  behaviour: 'toggle',
  component: 'button',
  options: [buttonOption()],
  idempotencyKey: 'panel-k1',
  ...over,
});

const editArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  panelId: PANEL,
  title: 'Pick a role, updated',
  idempotencyKey: 'panel-k2',
  ...over,
});

const deleteArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  panelId: PANEL,
  idempotencyKey: 'panel-k3',
  ...over,
});

/** Channels and roles the fake guild port lists: twins on purpose (ambiguity). */
const fakeGuild = (): McpGuildPort => ({
  listChannels: () => [
    {
      id: CHANNEL,
      name: 'planning',
      type: 'GuildText',
      parentId: undefined,
      parentName: undefined,
      topic: undefined,
      archiveEnabled: false,
    },
    {
      id: CHANNEL_TWIN,
      name: 'planning',
      type: 'GuildText',
      parentId: undefined,
      parentName: undefined,
      topic: undefined,
      archiveEnabled: false,
    },
    {
      id: '355555555555555555',
      name: 'lounge',
      type: 'GuildText',
      parentId: undefined,
      parentName: undefined,
      topic: undefined,
      archiveEnabled: false,
    },
  ],
  listThreads: () => Promise.resolve([]),
  listRoles: () => [
    { id: ROLE, name: 'helpers', position: 4, color: 0, managedByBananasaurs: true },
    { id: ROLE_TWIN, name: 'helpers', position: 3, color: 0, managedByBananasaurs: true },
    { id: '544444444444444444', name: 'ushers', position: 2, color: 0, managedByBananasaurs: true },
  ],
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 0,
});

/** Fake panels port: every call recorded, the outcome scripted per test. */
const fakePanelsPort = (
  outcome: McpPanelOutcome,
): McpPanelsPort & {
  readonly calls: number;
  readonly lastGuild: unknown;
  readonly lastCreate: unknown;
  readonly lastEdit: unknown;
  readonly lastRemove: unknown;
} => {
  let calls = 0;
  let lastGuild: unknown;
  let lastCreate: unknown;
  let lastEdit: unknown;
  let lastRemove: unknown;
  return {
    get calls(): number {
      return calls;
    },
    get lastGuild(): unknown {
      return lastGuild;
    },
    get lastCreate(): unknown {
      return lastCreate;
    },
    get lastEdit(): unknown {
      return lastEdit;
    },
    get lastRemove(): unknown {
      return lastRemove;
    },
    list: (guildId) => {
      calls += 1;
      lastGuild = guildId;
      return [];
    },
    get: (guildId, panelId) => {
      calls += 1;
      lastGuild = { guildId, panelId };
      return undefined;
    },
    create: (guildId, input) => {
      calls += 1;
      lastGuild = guildId;
      lastCreate = input;
      return Promise.resolve(outcome);
    },
    edit: (guildId, input) => {
      calls += 1;
      lastGuild = guildId;
      lastEdit = input;
      return Promise.resolve(outcome);
    },
    remove: (guildId, input) => {
      calls += 1;
      lastGuild = guildId;
      lastRemove = input;
      return Promise.resolve(outcome);
    },
  };
};

const doneCreate: McpPanelOutcome = { status: 'done', actionId: ACTION, panelId: PANEL };
const doneEdit: McpPanelOutcome = {
  status: 'done',
  actionId: ACTION,
  panelId: PANEL,
  messageId: '666666666666666666',
};
const doneDelete: McpPanelOutcome = {
  status: 'done',
  actionId: ACTION,
  panelId: PANEL,
  messageId: '666666666666666666',
};

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

describe('panel tool names', () => {
  it('are list_panels, get_panel, create_panel, edit_panel and delete_panel', () => {
    expect(LIST_PANELS_TOOL_NAME).toBe('list_panels');
    expect(GET_PANEL_TOOL_NAME).toBe('get_panel');
    expect(CREATE_PANEL_TOOL_NAME).toBe('create_panel');
    expect(EDIT_PANEL_TOOL_NAME).toBe('edit_panel');
    expect(DELETE_PANEL_TOOL_NAME).toBe('delete_panel');
  });
});

describe('panel guild gate (CLAUDE.md rule 2)', () => {
  const guild = fakeGuild();
  it.each([
    [
      'list_panels unreachable',
      () =>
        listPanelsText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), {
          guildId: '222222222222222222',
        }),
    ],
    [
      'get_panel unreachable',
      () =>
        getPanelText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), {
          guildId: '222222222222222222',
          panelId: PANEL,
        }),
    ],
    [
      'create_panel unreachable',
      () =>
        createPanelText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), guild, {
          ...createArgs(),
          guildId: '222222222222222222',
        }),
    ],
    [
      'edit_panel unreachable',
      () =>
        editPanelText(principalWith([GUILD_A]), fakePanelsPort(doneEdit), guild, {
          ...editArgs(),
          guildId: '222222222222222222',
        }),
    ],
    [
      'delete_panel unreachable',
      () =>
        deletePanelText(principalWith([GUILD_A]), fakePanelsPort(doneDelete), {
          ...deleteArgs(),
          guildId: '222222222222222222',
        }),
    ],
  ])('%s refuses an unreachable guild with the shared refusal', async (_label, call) => {
    expect(await call()).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it.each([
    [
      'list_panels malformed',
      () =>
        listPanelsText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), {
          guildId: 'not-a-snowflake',
        }),
    ],
    [
      'get_panel malformed',
      () =>
        getPanelText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), {
          guildId: 'not-a-snowflake',
          panelId: PANEL,
        }),
    ],
    [
      'create_panel malformed',
      () =>
        createPanelText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), guild, {
          ...createArgs(),
          guildId: 'not-a-snowflake',
        }),
    ],
    [
      'edit_panel malformed',
      () =>
        editPanelText(principalWith([GUILD_A]), fakePanelsPort(doneEdit), guild, {
          ...editArgs(),
          guildId: 'not-a-snowflake',
        }),
    ],
    [
      'delete_panel malformed',
      () =>
        deletePanelText(principalWith([GUILD_A]), fakePanelsPort(doneDelete), {
          ...deleteArgs(),
          guildId: 'not-a-snowflake',
        }),
    ],
  ])('%s refuses a malformed guild id identically', async (_label, call) => {
    expect(await call()).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it('refuses an empty reachable set identically', () => {
    const port = fakePanelsPort(doneCreate);
    expect(listPanelsText(principalWith([]), port, { guildId: '111111111111111111' })).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(port.calls).toBe(0);
  });

  it('two-guild gate: guild B is unreachable to a guild-A principal, reachable to a two-guild one', async () => {
    const port = fakePanelsPort(doneCreate);
    const refused = await createPanelText(principalWith([GUILD_A]), port, guild, {
      ...createArgs(),
      guildId: '222222222222222222',
    });
    expect(refused).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(port.calls).toBe(0);

    const allowed = await createPanelText(principalWith([GUILD_A, GUILD_B]), port, guild, {
      ...createArgs(),
      guildId: '222222222222222222',
    });
    expect(allowed.ok).toBe(true);
    expect(port.calls).toBe(1);
    expect(port.lastGuild).toBe(GUILD_B);
  });
});

describe('create_panel argument boundary (hard rule 3)', () => {
  const guild = fakeGuild();
  it.each([
    ['empty title', createArgs({ title: '' })],
    ['whitespace-only title', createArgs({ title: '   ' })],
    ['whitespace-only body', createArgs({ body: '  ' })],
    [
      'title plus body over 2000 characters',
      createArgs({ title: 't'.repeat(1500), body: 'b'.repeat(600) }),
    ],
    ['no options', createArgs({ options: [] })],
    [
      'twenty-six options',
      createArgs({ options: Array.from({ length: 26 }, () => buttonOption()) }),
    ],
    [
      'label over 80 characters',
      createArgs({ options: [buttonOption({ label: 'x'.repeat(81) })] }),
    ],
    ['whitespace-only label', createArgs({ options: [buttonOption({ label: '  ' })] })],
    ['button without a label', createArgs({ options: [{ role: ROLE }] })],
    [
      'reaction without an emoji',
      createArgs({ component: 'reaction', options: [{ role: ROLE, label: 'x' }] }),
    ],
    ['unknown behaviour', createArgs({ behaviour: 'chaos' })],
    ['unknown component', createArgs({ component: 'carousel' })],
    ['empty channel', createArgs({ channel: '' })],
    ['empty idempotency key', createArgs({ idempotencyKey: '' })],
    [
      'missing idempotency key',
      (() => {
        const args = createArgs();
        delete args['idempotencyKey'];
        return args;
      })(),
    ],
    ['a permissions key', createArgs({ permissions: '0' })],
    ['a kind key', createArgs({ kind: 'managed' })],
    [
      'created name over 100 characters',
      createArgs({ options: [{ role: { create: { name: 'x'.repeat(101) } }, label: 'x' }] }),
    ],
    [
      'created blank name',
      createArgs({ options: [{ role: { create: { name: '   ' } }, label: 'x' }] }),
    ],
    [
      'created negative color',
      createArgs({ options: [{ role: { create: { name: 'x', color: -1 } }, label: 'x' }] }),
    ],
    [
      'created color over 0xFFFFFF',
      createArgs({ options: [{ role: { create: { name: 'x', color: 0x100_0000 } }, label: 'x' }] }),
    ],
  ])('%s is the argument fault with no port call', async (_label, args) => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(principalWith([GUILD_A]), port, guild, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it('a reaction option with an emoji and no label is accepted', async () => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      createArgs({
        component: 'reaction',
        options: [{ role: ROLE, emoji: '🎉' }],
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(port.calls).toBe(1);
  });
});

describe('edit_panel and delete_panel argument boundary (hard rule 3)', () => {
  const guild = fakeGuild();
  it.each([
    ['no change at all', editArgs({ title: undefined })],
    ['empty addOptions', editArgs({ title: undefined, addOptions: [] })],
    ['empty removeOptions', editArgs({ title: undefined, removeOptions: [] })],
    ['empty reorder', editArgs({ title: undefined, reorder: [] })],
    ['whitespace-only title', editArgs({ title: '  ' })],
    ['empty panel id', editArgs({ panelId: '' })],
    ['a kind key', editArgs({ kind: 'adopted' })],
  ])('%s is the argument fault with no port call', async (_label, args) => {
    const port = fakePanelsPort(doneEdit);
    const outcome = await editPanelText(principalWith([GUILD_A]), port, guild, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it.each([
    ['empty panel id', deleteArgs({ panelId: '' })],
    ['a body key', deleteArgs({ body: 'x' })],
  ])('delete_panel %s is the argument fault with no port call', async (_label, args) => {
    const port = fakePanelsPort(doneDelete);
    const outcome = await deletePanelText(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it.each([
    [
      'get_panel empty panel id',
      () =>
        getPanelText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), {
          guildId: '111111111111111111',
          panelId: '',
        }),
    ],
    [
      'list_panels extra key',
      () =>
        listPanelsText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), {
          guildId: '111111111111111111',
          limit: 5,
        }),
    ],
  ])('%s is the argument fault', (_label, call) => {
    expect(call()).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
  });
});

describe('panel refs resolve before any port call', () => {
  const guild = fakeGuild();
  it('create_panel refuses a path-traversal channel with no port call', async () => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      createArgs({
        channel: '../../../../guilds/111111111111111111/channels/333333333333333333',
      }),
    );
    expect(messageOf(outcome)).toContain('No channel');
    expect(port.calls).toBe(0);
  });

  it('create_panel refuses a path-traversal role with no port call', async () => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      createArgs({
        options: [buttonOption({ role: '1/../../guilds/111111111111111111' })],
      }),
    );
    expect(messageOf(outcome)).toContain('No role');
    expect(port.calls).toBe(0);
  });

  it('create_panel refuses an unknown channel name with no port call', async () => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      createArgs({ channel: 'nowhere' }),
    );
    expect(messageOf(outcome)).toContain('No channel named');
    expect(port.calls).toBe(0);
  });

  it('create_panel answers an ambiguous channel name with no port call', async () => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      createArgs({ channel: 'planning' }),
    );
    expect(messageOf(outcome)).toContain('2 channels');
    expect(port.calls).toBe(0);
  });

  it('create_panel refuses an unknown role name with no port call', async () => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      createArgs({
        options: [buttonOption({ role: 'janitors' })],
      }),
    );
    expect(messageOf(outcome)).toContain('No role named');
    expect(port.calls).toBe(0);
  });

  it('create_panel answers an ambiguous role name with no port call', async () => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      createArgs({
        options: [buttonOption({ role: 'helpers' })],
      }),
    );
    expect(messageOf(outcome)).toContain('2 roles');
    expect(port.calls).toBe(0);
  });

  it('a channel name and a role name resolve to ids at the port', async () => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      createArgs({
        channel: 'lounge',
        options: [buttonOption({ role: 'ushers' })],
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(port.lastCreate).toMatchObject({
      channel: '355555555555555555',
      options: [{ role: '544444444444444444', label: 'Helpers' }],
    });
  });

  it('a {create} spec travels to the port with its trimmed name', async () => {
    const port = fakePanelsPort(doneCreate);
    const outcome = await createPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      createArgs({
        options: [{ role: { create: { name: '  ushers  ', color: 12 } }, label: 'Ushers' }],
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(port.lastCreate).toMatchObject({
      options: [{ role: { create: { name: 'ushers', color: 12 } }, label: 'Ushers' }],
    });
  });

  it('edit_panel refuses a path-traversal added role with no port call', async () => {
    const port = fakePanelsPort(doneEdit);
    const outcome = await editPanelText(
      principalWith([GUILD_A]),
      port,
      guild,
      editArgs({
        title: undefined,
        addOptions: [buttonOption({ role: '../../etc/passwd' })],
      }),
    );
    expect(messageOf(outcome)).toContain('No role');
    expect(port.calls).toBe(0);
  });
});

describe('panel write outcomes render', () => {
  const guild = fakeGuild();
  it('a creation names the panel and says it cannot be undone', async () => {
    const port = fakePanelsPort({
      status: 'done',
      actionId: ACTION,
      panelId: PANEL,
      messageId: '666666666666666666',
    });
    const text = textOf(await createPanelText(principalWith([GUILD_A]), port, guild, createArgs()));
    expect(text).toContain(PANEL);
    expect(text).toContain('666666666666666666');
    expect(text).toContain('cannot be undone');
    expect(text).toContain('delete_panel');
  });

  it('an edit names the panel, the message and its irreversibility', async () => {
    const port = fakePanelsPort(doneEdit);
    const text = textOf(await editPanelText(principalWith([GUILD_A]), port, guild, editArgs()));
    expect(text).toContain(PANEL);
    expect(text).toContain('666666666666666666');
    expect(text).toContain('cannot be undone');
  });

  it('a deletion names the panel and keeps the roles allowlisted', async () => {
    const port = fakePanelsPort(doneDelete);
    const text = textOf(await deletePanelText(principalWith([GUILD_A]), port, deleteArgs()));
    expect(text).toContain(PANEL);
    expect(text).toContain('stay allowlisted');
    expect(text).toContain('cannot be undone');
  });

  it('a dry run records without changing', async () => {
    const create = textOf(
      await createPanelText(
        principalWith([GUILD_A]),
        fakePanelsPort({ status: 'dry-run', actionId: ACTION }),
        guild,
        createArgs({ dryRun: true }),
      ),
    );
    expect(create).toContain('Dry run');
    expect(create).toContain(ACTION);
    const edit = textOf(
      await editPanelText(
        principalWith([GUILD_A]),
        fakePanelsPort({ status: 'dry-run', actionId: ACTION }),
        guild,
        editArgs({ dryRun: true }),
      ),
    );
    expect(edit).toContain('Dry run');
    const remove = textOf(
      await deletePanelText(
        principalWith([GUILD_A]),
        fakePanelsPort({ status: 'dry-run', actionId: ACTION }),
        deleteArgs({ dryRun: true }),
      ),
    );
    expect(remove).toContain('Dry run');
  });

  it('a replay answers that nothing new changed', async () => {
    const text = textOf(
      await createPanelText(
        principalWith([GUILD_A]),
        fakePanelsPort({ status: 'replayed', actionId: ACTION }),
        guild,
        createArgs(),
      ),
    );
    expect(text).toContain('Already recorded');
    expect(text).toContain(ACTION);
  });

  it('a failure points at the listing and the same key', async () => {
    const message = messageOf(
      await createPanelText(
        principalWith([GUILD_A]),
        fakePanelsPort({ status: 'failed' }),
        guild,
        createArgs(),
      ),
    );
    expect(message).toContain('list_panels');
    expect(message).toContain('same idempotency key');
  });

  it('a port fault is the shared refusal, never a throw', async () => {
    const failing: McpPanelsPort = {
      list: () => {
        throw new Error('boom');
      },
      get: () => {
        throw new Error('boom');
      },
      create: () => Promise.reject(new Error('boom')),
      edit: () => Promise.reject(new Error('boom')),
      remove: () => Promise.reject(new Error('boom')),
    };
    expect(
      listPanelsText(principalWith([GUILD_A]), failing, { guildId: '111111111111111111' }),
    ).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(
      getPanelText(principalWith([GUILD_A]), failing, {
        guildId: '111111111111111111',
        panelId: PANEL,
      }),
    ).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(await createPanelText(principalWith([GUILD_A]), failing, guild, createArgs())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(await editPanelText(principalWith([GUILD_A]), failing, guild, editArgs())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(await deletePanelText(principalWith([GUILD_A]), failing, deleteArgs())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
  });
});

describe('panel refusals are distinct and content-free', () => {
  const reasons: readonly McpPanelRefusal[] = [
    'unknown-channel',
    'ambiguous-channel',
    'channel-not-allowlisted',
    'private-thread',
    'bot-lacks-permission',
    'unknown-role',
    'ambiguous-role',
    'unknown-panel',
    'unknown-emoji',
    'role-not-permitted',
    'create-not-allowed-in-allowlist-mode',
    'invalid-definition',
    'bad-reorder',
    'channel-change',
    'unauthorized',
    'killswitch',
    'breaker-open',
    'rate-cap',
    'duplicate-key-different-content',
    'duplicate-content-recently',
  ];
  const guild = fakeGuild();
  it('every reason renders a distinct string on every write tool', async () => {
    for (const [handler, args, kind] of [
      [createPanelText, createArgs, 'create'],
      [editPanelText, editArgs, 'edit'],
      [deletePanelText, deleteArgs, 'delete'],
    ] as const) {
      const seen = new Map<string, McpPanelRefusal>();
      for (const reason of reasons) {
        const outcome: McpPanelOutcome = { status: 'refused', reason, detail: ROLE };
        const port = fakePanelsPort(outcome);
        const result =
          kind === 'create'
            ? await handler(principalWith([GUILD_A]), port, guild, args())
            : kind === 'edit'
              ? await handler(principalWith([GUILD_A]), port, guild, args())
              : await handler(principalWith([GUILD_A]), port, args());
        const message = messageOf(result);
        expect(seen.get(message)).toBeUndefined();
        seen.set(message, reason);
        // Ids only: a role name or an option label never reaches a refusal,
        // even when the daemon names the role id in the detail.
        expect(message).not.toContain(SENTINEL_NAME);
        expect(message).not.toContain(SENTINEL_LABEL);
      }
      expect(seen.size).toBe(reasons.length);
    }
  });

  it('the grant-policy refusal names the specific cause', async () => {
    const cases = [
      ['above-bot', 'above'],
      ['managed-or-everyone', 'managed'],
      ['dangerous', 'dangerous'],
      ['not-allowlisted', 'grant allowlist'],
    ] as const;
    for (const [cause, marker] of cases) {
      const port = fakePanelsPort({
        status: 'refused',
        reason: 'role-not-permitted',
        detail: cause,
      });
      const message = messageOf(
        await createPanelText(principalWith([GUILD_A]), port, guild, createArgs()),
      );
      expect(message).toContain(marker);
    }
  });

  it('the grant-policy refusal names the failing option role', async () => {
    const port = fakePanelsPort({
      status: 'refused',
      reason: 'role-not-permitted',
      detail: 'above-bot:345678901234567890',
    });
    const message = messageOf(
      await createPanelText(principalWith([GUILD_A]), port, guild, createArgs()),
    );
    expect(message).toContain('Option role 345678901234567890');
    expect(message).toContain('above');
  });

  it('the authorization refusal names roles.mutate', async () => {
    const port = fakePanelsPort({ status: 'refused', reason: 'unauthorized' });
    expect(
      messageOf(await createPanelText(principalWith([GUILD_A]), port, guild, createArgs())),
    ).toContain('roles.mutate');
  });

  it('the channel-change refusal calls the channel immutable', async () => {
    const port = fakePanelsPort({ status: 'refused', reason: 'channel-change' });
    expect(
      messageOf(await editPanelText(principalWith([GUILD_A]), port, guild, editArgs())),
    ).toContain('immutable');
  });

  it('the allowlist-mode creation refusal points at create_role and the grant allowlist', async () => {
    const port = fakePanelsPort({
      status: 'refused',
      reason: 'create-not-allowed-in-allowlist-mode',
    });
    for (const message of [
      messageOf(await createPanelText(principalWith([GUILD_A]), port, guild, createArgs())),
      messageOf(await editPanelText(principalWith([GUILD_A]), port, guild, editArgs())),
    ]) {
      expect(message).toContain('allowlist');
      expect(message).toContain('create_role');
      expect(message).toContain('mcp allow-role');
      expect(message).toContain('--purpose grant');
      expect(message).toContain('by id');
    }
  });

  it('a post-mint failure names every minted role id', async () => {
    const minted = '633333333333333333, 644444444444444444';
    const create = messageOf(
      await createPanelText(
        principalWith([GUILD_A]),
        fakePanelsPort({ status: 'failed', panelId: PANEL, detail: minted }),
        guild,
        createArgs(),
      ),
    );
    expect(create).toContain('633333333333333333');
    expect(create).toContain('644444444444444444');
    expect(create).toContain('same idempotency key');
    const edit = messageOf(
      await editPanelText(
        principalWith([GUILD_A]),
        fakePanelsPort({ status: 'failed', panelId: PANEL, detail: '633333333333333333' }),
        guild,
        editArgs(),
      ),
    );
    expect(edit).toContain('633333333333333333');
    expect(edit).toContain('same idempotency key');
  });
});

describe('panel reads', () => {
  it('list_panels renders every panel and records a structural read', () => {
    const port: McpPanelsPort = {
      ...fakePanelsPort(doneCreate),
      list: () => [
        {
          panelId: 'colour-roles',
          title: 'Pick a colour',
          behaviour: 'toggle',
          component: 'button',
          status: 'enabled',
          messageId: '666666666666666666',
          optionCount: 2,
        },
        {
          panelId: 'game-night',
          title: 'Game night',
          behaviour: 'add_only',
          component: 'select',
          status: 'enabled',
          optionCount: 1,
        },
      ],
    };
    const outcome = listPanelsText(principalWith([GUILD_A]), port, {
      guildId: '111111111111111111',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.text).toContain('colour-roles');
    expect(outcome.text).toContain('Pick a colour');
    expect(outcome.text).toContain('game-night');
    expect(outcome.read).toEqual({
      kind: 'structural',
      action: MCP_READ_LIST_PANELS,
      guildIds: [GUILD_A],
      resultCount: 2,
    });
  });

  it('list_panels with no panels answers so and records an empty read', () => {
    const outcome = listPanelsText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), {
      guildId: '111111111111111111',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.text).toContain('No role panels');
    expect(outcome.read).toEqual({
      kind: 'structural',
      action: MCP_READ_LIST_PANELS,
      guildIds: [GUILD_A],
      resultCount: 0,
    });
  });

  it('get_panel renders ids, the title and the labels — never role names', () => {
    const port: McpPanelsPort = {
      ...fakePanelsPort(doneCreate),
      get: () => ({
        panelId: PANEL,
        channelId: CHANNEL,
        messageId: '666666666666666666',
        behaviour: 'toggle',
        component: 'button',
        status: 'enabled',
        title: 'Pick a role',
        body: 'React below, if you like.',
        options: [
          { optionId: 'option-1', roleId: ROLE, label: 'Helpers', emoji: undefined },
          { optionId: 'option-2', roleId: ROLE_TWIN, label: undefined, emoji: 'u:1f389' },
        ],
      }),
    };
    const outcome = getPanelText(principalWith([GUILD_A]), port, {
      guildId: '111111111111111111',
      panelId: PANEL,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.text).toContain(PANEL);
    expect(outcome.text).toContain(CHANNEL);
    expect(outcome.text).toContain(ROLE);
    expect(outcome.text).toContain('Helpers');
    expect(outcome.text).not.toContain(SENTINEL_NAME);
    expect(outcome.read).toEqual({
      kind: 'structural',
      action: MCP_READ_GET_PANEL,
      guildIds: [GUILD_A],
      resultCount: 1,
    });
  });

  it('get_panel on an unknown panel names list_panels', () => {
    const outcome = getPanelText(principalWith([GUILD_A]), fakePanelsPort(doneCreate), {
      guildId: '111111111111111111',
      panelId: 'nope',
    });
    expect(messageOf(outcome)).toContain('list_panels');
  });
});

const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

const stubHealth = (): McpHealthPort => ({
  startedAtMs: 1_700_000_000_000,
  readonly: false,
  env: 'test',
  gateway: () => ({ connected: true, pingMs: 42, guildCount: 1 }),
  now: () => 1_700_000_000_000,
  guilds: () => [],
});
const stubArchive = (): McpArchivePort => ({
  now: () => 1_700_000_000_000,
  listArchiveChannelIds: () => [],
  searchMessages: () => ({ total: 0, hits: [] }),
  findMessage: () => undefined,
  listChannelHistory: () => [],
  listMessagesSince: () => [],
  listUnansweredRoleMentions: () => [],
  messageMeta: () => Promise.resolve(undefined),
  botUserId: () => undefined,
});
const stubRecords = (): McpRecordsPort => ({
  listRecentCases: () => [],
  findCase: () => undefined,
  listCaseEvents: () => [],
  tailAudit: () => [],
  listRules: () => [],
  listPanels: () => [],
});
const stubSend = (): McpSendPort => ({
  send: () => Promise.resolve({ status: 'sent', messageId: 'mid', actionId: 'act' }),
});
const stubThreadWrites = (): McpThreadWritesPort => ({
  createThread: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  addThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  removeThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  createForumPost: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  setThreadState: () => Promise.resolve({ status: 'done', actionId: 'act' }),
});
const stubMessageWrites = (): McpMessageWritesPort => ({
  edit: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  delete: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  pin: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  unpin: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  addReaction: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  removeReaction: () => Promise.resolve({ status: 'done', actionId: 'act' }),
});
const stubRoleWrites = (): McpRoleWritesPort => ({
  grant: () => Promise.resolve({ status: 'done', actionId: 'act', alreadyHad: false }),
  remove: () => Promise.resolve({ status: 'done', actionId: 'act', alreadyHad: false }),
});
const stubJobs = (): McpJobsPort => ({
  listJobs: () => [],
  findJob: () => undefined,
});
const stubMembers = (): McpMembersPort => ({
  listAllMembers: () => Promise.resolve({ members: [], truncated: false }),
  lastMessageAt: () => new Map(),
  now: () => 1_700_000_000_000,
});
const stubContext = (): McpContextPort => ({
  serverCard: () => '',
  timeZone: 'America/Vancouver',
  now: () => 1_700_000_000_000,
  skills: () => [],
});
const stubResources = (): McpResourcesPort => ({
  listResources: () => [],
  searchChunks: () => [],
  resourceChunks: () => [],
});
const stubThreads = (): McpThreadsPort => ({
  archiveThread: () => [],
  threadInfo: () => Promise.resolve(undefined),
  privateThreadReadable: () => Promise.resolve(false),
  liveThreadMessages: () => Promise.resolve([]),
});
const stubPanels = (): McpPanelsPort => ({
  list: () => [],
  get: () => undefined,
  create: () => Promise.resolve({ status: 'done', actionId: 'act', panelId: PANEL }),
  edit: () => Promise.resolve({ status: 'done', actionId: 'act', panelId: PANEL }),
  remove: () => Promise.resolve({ status: 'done', actionId: 'act', panelId: PANEL }),
});

const connectPair = async (
  principal: McpPrincipal,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-panels-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal,
    health: stubHealth(),
    archive: stubArchive(),
    guild: fakeGuild(),
    records: stubRecords(),
    send: stubSend(),
    messageWrites: stubMessageWrites(),
    threadWrites: stubThreadWrites(),
    // Required for the four event tools; never called by the tools pinned here.
    eventWrites: {
      createEvent: () =>
        Promise.resolve({ status: 'done' as const, actionId: 'act-test', eventId: 'evt' }),
      editEvent: () => Promise.resolve({ status: 'done' as const, actionId: 'act-test' }),
      cancelEvent: () => Promise.resolve({ status: 'done' as const, actionId: 'act-test' }),
      createPoll: () =>
        Promise.resolve({ status: 'done' as const, actionId: 'act-test', messageId: 'mid' }),
    },
    // Required for the four schedule tools; never called by the tools pinned here.
    schedule: {
      scheduleMessage: () =>
        Promise.resolve({ status: 'done' as const, actionId: 'act-test', reminderId: 'rem' }),
      listScheduled: () => [],
      editScheduled: () =>
        Promise.resolve({ status: 'done' as const, actionId: 'act-test', reminderId: 'rem' }),
      cancelScheduled: () =>
        Promise.resolve({ status: 'done' as const, actionId: 'act-test', reminderId: 'rem' }),
    },
    roleWrites: stubRoleWrites(),
    panels: stubPanels(),
    readAudit: noopReadAudit,
    jobs: stubJobs(),
    members: stubMembers(),
    context: stubContext(),
    resources: stubResources(),
    threads: stubThreads(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

describe('panel scope filtering (ruling M4-D17, ADR 0114)', () => {
  it('a read-scope token sees list_panels and get_panel but no panel write', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:read']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain(LIST_PANELS_TOOL_NAME);
      expect(names).toContain(GET_PANEL_TOOL_NAME);
      expect(names).not.toContain(CREATE_PANEL_TOOL_NAME);
      expect(names).not.toContain(EDIT_PANEL_TOOL_NAME);
      expect(names).not.toContain(DELETE_PANEL_TOOL_NAME);
    } finally {
      await close();
    }
  });

  it('a roles-scope token sees the panel writes alongside the role writes, but no panel reads', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:roles']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        CREATE_PANEL_TOOL_NAME,
        DELETE_PANEL_TOOL_NAME,
        EDIT_PANEL_TOOL_NAME,
        'grant_role',
        'remove_role',
      ]);
    } finally {
      await close();
    }
  });

  it('a send-only token sees no panel tool', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:send']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain(LIST_PANELS_TOOL_NAME);
      expect(names).not.toContain(GET_PANEL_TOOL_NAME);
      expect(names).not.toContain(CREATE_PANEL_TOOL_NAME);
      expect(names).not.toContain(EDIT_PANEL_TOOL_NAME);
      expect(names).not.toContain(DELETE_PANEL_TOOL_NAME);
    } finally {
      await close();
    }
  });
});
