import { describe, expect, it } from 'vitest';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import {
  LIST_ACTIONS_LIMIT_MAX,
  LIST_ACTIONS_TOOL_NAME,
  UNDO_ACTION_TOOL_NAME,
  listActionsText,
  undoActionText,
  type McpActionView,
  type McpActionsPort,
  type McpUndoOutcome,
  type McpUndoRefusal,
} from './actions.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

const principalWith = (reachable: readonly GuildId[]): McpPrincipal => ({
  accountId: 'acct_test',
  reachableGuilds: reachable,
  scopes: ['bananasaurs:read', 'bananasaurs:send'],
});

const stubPort = (over: Partial<McpActionsPort> = {}): McpActionsPort => ({
  undo: () =>
    Promise.resolve({
      status: 'done',
      actionId: 'undo-1',
      undoneActionId: 'act-1',
      kind: 'message.edit',
    }),
  list: () => [],
  ...over,
});

const UNDO_REFUSALS: readonly McpUndoRefusal[] = [
  'action-not-found',
  'already-undone',
  'action-dry-run',
  'action-failed',
  'action-incomplete',
  'not-undoable',
  'undo-in-progress',
  'target-unavailable',
  'killswitch',
  'breaker-open',
  'rate-cap',
];

describe('undo_action', () => {
  it('has its tool name', () => {
    expect(UNDO_ACTION_TOOL_NAME).toBe('undo_action');
  });

  it('refuses malformed arguments without consulting the guild gate', async () => {
    expect(await undoActionText(principalWith([GUILD_A]), stubPort(), {})).toEqual({
      ok: false,
      message: INVALID_ARGUMENTS_MESSAGE,
    });
    expect(
      await undoActionText(principalWith([GUILD_A]), stubPort(), {
        guildId: '111111111111111111',
      }),
    ).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
  });

  it('refuses a guild the caller cannot reach, including the second guild', async () => {
    const outcome = await undoActionText(principalWith([GUILD_A]), stubPort(), {
      guildId: '222222222222222222',
      actionId: 'act-1',
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it('answers a port throw as the shared refusal', async () => {
    const outcome = await undoActionText(
      principalWith([GUILD_A]),
      stubPort({
        undo: () => Promise.reject(new Error('discord down')),
      }),
      { guildId: '111111111111111111', actionId: 'act-1' },
    );
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it('names both action ids and the kind on success', async () => {
    const outcome = await undoActionText(principalWith([GUILD_A]), stubPort(), {
      guildId: '111111111111111111',
      actionId: 'act-1',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('act-1');
    expect(outcome.text).toContain('undo-1');
    expect(outcome.text).toContain('message.edit');
    expect(outcome.text).toContain('111111111111111111');
  });

  it('renders every refusal distinctly', async () => {
    const messages: string[] = [];
    for (const reason of UNDO_REFUSALS) {
      const outcome = await undoActionText(
        principalWith([GUILD_A]),
        stubPort({
          undo: () =>
            Promise.resolve({
              status: 'refused',
              reason,
              ...(reason === 'already-undone' ? { detail: 'undo-9' } : {}),
              ...(reason === 'not-undoable' ? { detail: 'message.send' } : {}),
            } satisfies McpUndoOutcome),
        }),
        { guildId: '111111111111111111', actionId: 'act-1' },
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      messages.push(outcome.message);
    }
    // No two reasons share a string.
    expect(new Set(messages).size).toBe(UNDO_REFUSALS.length);
    expect(messages.join('\n')).toContain('undo-9');
    expect(messages.join('\n')).toContain('message.send');
  });

  it('a dry-run undo reports what would be undone without changing anything', async () => {
    const outcome = await undoActionText(
      principalWith([GUILD_A]),
      stubPort({
        undo: () =>
          Promise.resolve({
            status: 'dry-run',
            actionId: 'undo-dry',
            undoneActionId: 'act-1',
            kind: 'message.pin',
          }),
      }),
      { guildId: '111111111111111111', actionId: 'act-1' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('Dry run');
    expect(outcome.text).toContain('act-1');
    expect(outcome.text).toContain('undo-dry');
    expect(outcome.text).toContain('no Discord call was made');
  });

  it('a failed undo reports the unknown result and the same action id', async () => {
    const outcome = await undoActionText(
      principalWith([GUILD_A]),
      stubPort({ undo: () => Promise.resolve({ status: 'failed' }) }),
      { guildId: '111111111111111111', actionId: 'act-1' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('unknown result');
    expect(outcome.message).toContain('act-1');
  });
});

describe('list_actions', () => {
  it('has its tool name and limit cap', () => {
    expect(LIST_ACTIONS_TOOL_NAME).toBe('list_actions');
    expect(LIST_ACTIONS_LIMIT_MAX).toBe(100);
  });

  it('refuses malformed arguments without consulting the guild gate', async () => {
    expect(await listActionsText(principalWith([GUILD_A]), stubPort(), {})).toEqual({
      ok: false,
      message: INVALID_ARGUMENTS_MESSAGE,
    });
    expect(
      await listActionsText(principalWith([GUILD_A]), stubPort(), {
        guildId: '111111111111111111',
        limit: 101,
      }),
    ).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
  });

  it('refuses a guild the caller cannot reach, including the second guild', async () => {
    const outcome = await listActionsText(principalWith([GUILD_A]), stubPort(), {
      guildId: String(GUILD_B),
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it('answers a port throw as the shared refusal', async () => {
    const outcome = await listActionsText(
      principalWith([GUILD_A]),
      stubPort({
        list: () => {
          throw new Error('db down');
        },
      }),
      { guildId: String(GUILD_A) },
    );
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it('renders kind, status, target ids, undoable and time — and nothing else', async () => {
    const views: readonly McpActionView[] = [
      {
        actionId: 'act-1',
        kind: 'message.edit',
        status: 'done',
        targetChannelId: '333333333333333333',
        resultMessageId: '444444444444444444',
        undoable: true,
        createdAt: 1_700_000_000_000,
      },
      {
        actionId: 'act-2',
        kind: 'message.send',
        status: 'done',
        targetChannelId: '333333333333333333',
        resultMessageId: '555555555555555555',
        undoable: false,
        createdAt: 1_700_000_001_000,
      },
    ];
    const outcome = await listActionsText(
      principalWith([GUILD_A]),
      stubPort({ list: () => views }),
      { guildId: String(GUILD_A) },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe(
      'MCP actions in guild 111111111111111111: 2 shown (newest first).\n' +
        'act-1 | message.edit | done | target 333333333333333333 | message 444444444444444444 | undoable yes | created 2023-11-14T22:13:20.000Z\n' +
        'act-2 | message.send | done | target 333333333333333333 | message 555555555555555555 | undoable no | created 2023-11-14T22:13:21.000Z',
    );
    // A structural read record: ids and the count, never content.
    expect(outcome.read).toMatchObject({ kind: 'structural', resultCount: 2 });
  });

  it('renders thread ids and the empty answer', async () => {
    const threaded = await listActionsText(
      principalWith([GUILD_A]),
      stubPort({
        list: () => [
          {
            actionId: 'act-3',
            kind: 'thread.create',
            status: 'done',
            targetChannelId: '333333333333333333',
            resultThreadId: '666666666666666666',
            undoable: false,
            createdAt: 1_700_000_002_000,
          },
        ],
      }),
      { guildId: String(GUILD_A) },
    );
    expect(threaded.ok).toBe(true);
    if (!threaded.ok) return;
    expect(threaded.text).toContain('thread 666666666666666666');

    const empty = await listActionsText(principalWith([GUILD_A]), stubPort(), {
      guildId: String(GUILD_A),
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.text).toContain('No MCP actions recorded in guild 111111111111111111.');
  });

  it('defaults the limit when the caller passes none', async () => {
    let seen: number | undefined;
    await listActionsText(
      principalWith([GUILD_A]),
      stubPort({
        list: (_guildId, input) => {
          seen = input.limit;
          return [];
        },
      }),
      { guildId: String(GUILD_A) },
    );
    expect(seen).toBe(20);
  });
});
