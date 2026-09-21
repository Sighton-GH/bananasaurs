import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { panelDefinitionSchema, parseGuildId, type PanelDefinition } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { managedRoles, panels as schemaPanels } from '../schema.js';
import { write } from '../write.js';
import { upsertGuild } from './guilds.js';
import { findManagedRole } from './roles.js';
import {
  createPanel,
  deletePanel,
  findPanel,
  findPanelByMessage,
  isPanelEnabled,
  listAdoptedPanels,
  listPanels,
  setAdoptionPassState,
  setPanelMessage,
  setPanelStatus,
} from './panels.js';

/**
 * The panel repository against the real migrations.
 *
 * `packages/core/src/panels/model.test.ts` proves the validator. This proves
 * the parts only SQL can: that the role allowlist really is a foreign key, that
 * a message hosts at most one panel, that the CHECK constraints really are
 * there behind the validator, and that guild scope is a partition rather than a
 * predicate everyone remembers to pass.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';
const ROLE_A = '555555555555555555';
const ROLE_B = '666666666666666666';
const BLOCKED = '777777777777777777';

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

const allowlistRole = (scope: GuildScope, roleId: string) =>
  write(scope, ({ db }) => {
    db.insert(managedRoles).values({ guildId: scope.guildId, roleId }).onConflictDoNothing().run();
  });

const definition = (over: Record<string, unknown> = {}): PanelDefinition =>
  panelDefinitionSchema.parse({
    panelId: 'roles',
    kind: 'adopted',
    channelId: CHANNEL,
    messageId: MESSAGE,
    behaviour: 'toggle',
    component: 'reaction',
    options: [
      { optionId: 'a', roleId: ROLE_A, emojiKey: 'u:1f9e0', position: 0 },
      { optionId: 'b', roleId: ROLE_B, emojiKey: 'u:2714', position: 1 },
    ],
    ...over,
  });

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild a', now: 0 });
  upsertGuild(b, { name: 'guild b', now: 0 });
  for (const scope of [a, b]) {
    allowlistRole(scope, ROLE_A);
    allowlistRole(scope, ROLE_B);
  }
});
afterEach(() => {
  t.close();
});

describe('createPanel', () => {
  it('round-trips a panel with its options', () => {
    createPanel(a, definition(), 1000);

    const panel = findPanel(a, 'roles');
    expect(panel?.kind).toBe('adopted');
    expect(panel?.behaviour).toBe('toggle');
    expect(panel?.messageId).toBe(MESSAGE);
    expect(panel?.options.map((o) => o.optionId).sort()).toEqual(['a', 'b']);
    expect(panel?.options.find((o) => o.optionId === 'a')?.emojiKey).toBe('u:1f9e0');
  });

  it('round-trips message content, and leaves it undefined when unset', () => {
    createPanel(a, definition({ content: 'Pick your colour below.' }), 1000);
    expect(findPanel(a, 'roles')?.content).toBe('Pick your colour below.');

    createPanel(b, definition(), 1000);
    expect(findPanel(b, 'roles')?.content).toBeUndefined();
  });

  it('round-trips blocked roles', () => {
    createPanel(a, definition({ blockedRoleIds: [BLOCKED] }), 1000);
    expect(findPanel(a, 'roles')?.blockedRoleIds).toEqual([BLOCKED]);
  });

  it('does not require a blocked role to be allowlisted', () => {
    // Blocking is about who may *use* the panel. The bot never mutates a
    // blocked role, so it has no business being in the role allowlist.
    expect(() => createPanel(a, definition({ blockedRoleIds: [BLOCKED] }), 1000)).not.toThrow();
  });

  it('starts an adopted panel owing an adoption pass', () => {
    createPanel(a, definition(), 1000);
    expect(findPanel(a, 'roles')?.adoptionPassState).toBe('pending');
    // Owing a pass is not the same as being blocked on one — ADR 0021. A
    // panel that has never been examined must still reconcile normally.
    expect(findPanel(a, 'roles')?.adoptionBlockedCount).toBe(0);
  });

  it('starts a managed panel with nothing to adopt', () => {
    createPanel(
      a,
      definition({
        kind: 'managed',
        component: 'button',
        messageId: undefined,
        options: [{ optionId: 'a', roleId: ROLE_A, label: 'Alpha', position: 0 }],
      }),
      1000,
    );
    expect(findPanel(a, 'roles')?.adoptionPassState).toBe('done');
    expect(findPanel(a, 'roles')?.messageId).toBeUndefined();
  });

  it('rolls back newly allowlisted roles when panel creation fails', () => {
    createPanel(a, definition(), 900);
    const role = '888888888888888888';
    const duplicatePanel = definition({
      options: [{ optionId: 'new', roleId: role, emojiKey: 'u:1f600', position: 0 }],
    });
    // The managed-role insert runs first, then the duplicate panel id fails.
    // Both belong to the same transaction, so the scope grant rolls back.
    expect(() => createPanel(a, duplicatePanel, 1000, [role])).toThrow(/UNIQUE/i);
    expect(findManagedRole(a, role)).toBeUndefined();
  });

  it('is atomic: a panel is never visible with only some of its options', () => {
    // The third option names a role that is not allowlisted, so the insert
    // fails partway. A panel visible with two of three options would converge
    // to "revoke the third", which is worse than not existing.
    const bad = definition({
      options: [
        { optionId: 'a', roleId: ROLE_A, emojiKey: 'u:1f9e0', position: 0 },
        { optionId: 'b', roleId: ROLE_B, emojiKey: 'u:2714', position: 1 },
        { optionId: 'c', roleId: '888888888888888888', emojiKey: 'u:1f600', position: 2 },
      ],
    });
    expect(() => createPanel(a, bad, 1000)).toThrow();
    expect(findPanel(a, 'roles')).toBeUndefined();
  });
});

describe('the role allowlist is a foreign key, not a guard clause', () => {
  it('refuses an option for a role that is not allowlisted', () => {
    const unlisted = definition({
      options: [{ optionId: 'a', roleId: '888888888888888888', emojiKey: 'u:1f9e0', position: 0 }],
    });
    expect(() => createPanel(a, unlisted, 1000)).toThrow(/FOREIGN KEY/i);
  });

  it('refuses a role allowlisted only in another guild', () => {
    allowlistRole(b, '888888888888888888');
    const other = definition({
      options: [{ optionId: 'a', roleId: '888888888888888888', emojiKey: 'u:1f9e0', position: 0 }],
    });
    expect(() => createPanel(a, other, 1000)).toThrow(/FOREIGN KEY/i);
  });
});

describe('the CHECK constraints are real, behind the validator', () => {
  /**
   * The validator refuses these with an explanation. These assert the database
   * would refuse them too, so a future caller that reaches SQL another way —
   * a migration, a repair script, a repository function written next year —
   * cannot create a panel the convergence code cannot handle.
   */
  const insertRaw = (scope: GuildScope, over: Record<string, unknown>) =>
    write(scope, ({ db }) =>
      db
        .insert(schemaPanels)
        .values({
          guildId: scope.guildId,
          panelId: 'raw',
          kind: 'adopted',
          channelId: CHANNEL,
          messageId: MESSAGE,
          behaviour: 'toggle',
          component: 'reaction',
          createdAt: 0,
          updatedAt: 0,
          ...over,
        })
        .run(),
    );

  it('refuses single_choice on an adopted panel', () => {
    expect(() => insertRaw(a, { behaviour: 'single_choice' })).toThrow(/CHECK/i);
  });

  it('refuses components on an adopted panel', () => {
    expect(() => insertRaw(a, { component: 'button' })).toThrow(/CHECK/i);
  });

  it('refuses a nonsense maxRoles', () => {
    expect(() => insertRaw(a, { maxRoles: 0 })).toThrow(/CHECK/i);
  });

  it('refuses an unknown behaviour', () => {
    expect(() => insertRaw(a, { behaviour: 'whatever' })).toThrow(/CHECK/i);
  });
});

describe('findPanelByMessage', () => {
  it('finds the panel hosted on a message', () => {
    createPanel(a, definition(), 1000);
    expect(findPanelByMessage(a, CHANNEL, MESSAGE)?.panelId).toBe('roles');
  });

  it('returns nothing for a message with no panel', () => {
    createPanel(a, definition(), 1000);
    expect(findPanelByMessage(a, CHANNEL, '999999999999999999')).toBeUndefined();
  });

  it('refuses a second panel on the same message', () => {
    createPanel(a, definition(), 1000);
    expect(() => createPanel(a, definition({ panelId: 'other' }), 1000)).toThrow(/UNIQUE/i);
  });
});

describe('guild scope', () => {
  it("does not find another guild's panel by id", () => {
    createPanel(a, definition(), 1000);
    expect(findPanel(b, 'roles')).toBeUndefined();
  });

  it("does not find another guild's panel by message", () => {
    createPanel(a, definition(), 1000);
    expect(findPanelByMessage(b, CHANNEL, MESSAGE)).toBeUndefined();
  });

  it('permits the same panel id in two guilds, as separate panels', () => {
    createPanel(a, definition(), 1000);
    createPanel(b, definition({ behaviour: 'add_only' }), 1000);
    expect(findPanel(a, 'roles')?.behaviour).toBe('toggle');
    expect(findPanel(b, 'roles')?.behaviour).toBe('add_only');
  });

  it("lists only this guild's panels", () => {
    createPanel(a, definition(), 1000);
    createPanel(b, definition({ panelId: 'theirs' }), 1000);
    expect(listPanels(a).map((p) => p.panelId)).toEqual(['roles']);
  });
});

describe('mutating a panel', () => {
  beforeEach(() => createPanel(a, definition(), 1000));

  it('records the message a managed panel was posted as', () => {
    setPanelMessage(a, 'roles', '999999999999999999', 2000);
    expect(findPanel(a, 'roles')?.messageId).toBe('999999999999999999');
  });

  it('disables a panel, which the effect gateway reads as layer 4', () => {
    expect(isPanelEnabled(a, 'roles')).toBe(true);
    setPanelStatus(a, 'roles', 'disabled_by_doctor', 'message deleted', 2000);
    expect(isPanelEnabled(a, 'roles')).toBe(false);
    expect(findPanel(a, 'roles')?.status).toBe('disabled_by_doctor');
  });

  it('reports an unknown panel as not enabled', () => {
    // The gateway's layer 4 must refuse for a panel that does not exist, not
    // fall through to permitting it.
    expect(isPanelEnabled(a, 'no-such-panel')).toBe(false);
  });

  it("does not disable another guild's panel of the same name", () => {
    createPanel(b, definition(), 1000);
    setPanelStatus(a, 'roles', 'disabled_by_owner', undefined, 2000);
    expect(isPanelEnabled(b, 'roles')).toBe(true);
  });

  it('advances the adoption pass state', () => {
    setAdoptionPassState(a, 'roles', 'done', 0, 2000);
    expect(findPanel(a, 'roles')?.adoptionPassState).toBe('done');
  });

  it('records the blocked count alongside the state — ADR 0021', () => {
    setAdoptionPassState(a, 'roles', 'pending', 7, 2000);
    const panel = findPanel(a, 'roles');
    expect(panel?.adoptionPassState).toBe('pending');
    expect(panel?.adoptionBlockedCount).toBe(7);
  });

  it('deletes a panel and its options together', () => {
    deletePanel(a, 'roles');
    expect(findPanel(a, 'roles')).toBeUndefined();
    expect(listPanels(a)).toEqual([]);
  });
});

describe('listAdoptedPanels', () => {
  it('returns adopted panels only — the ones that miss events while offline', () => {
    createPanel(a, definition(), 1000);
    createPanel(
      a,
      definition({
        panelId: 'buttons',
        kind: 'managed',
        component: 'button',
        messageId: undefined,
        options: [{ optionId: 'a', roleId: ROLE_A, label: 'Alpha', position: 0 }],
      }),
      1000,
    );
    expect(listAdoptedPanels(a).map((p) => p.panelId)).toEqual(['roles']);
  });
});
