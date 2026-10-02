import { describe, expect, it } from 'vitest';

import type { PanelDefinition } from '../../panels/model.js';
import { createDispatcher } from '../dispatch.js';
import type { OpsAuditWrite, OpsGuildRoleInfo, OpsPanelDetail, OpsPorts } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';

/**
 * `panel edit` — replaces a panel's definition, storage only.
 *
 * The properties under test are the refusals, like `panel create`'s: an edit
 * that half-applies and says nothing is worse than one that fails loudly.
 * The manageability check is the dashboard builder's panel-create check (a
 * new role joins the allowlist when the hierarchy permits), not the CLI
 * `create`'s outright refusal of every unlisted role. Driven through
 * `createDispatcher` with the whole registry, so `--confirm` and the audit
 * row are exercised by the machinery that actually owns them.
 */

const ROLE_LOW = '333333333333333333';
const ROLE_HIGH = '333333333333333334';
const ROLE_NEW = '333333333333333335';
const BOT_POSITION = 100;

const MANAGED = {
  panelId: 'colour-roles',
  kind: 'managed',
  channelId: '444444444444444444',
  behaviour: 'toggle',
  component: 'button',
  options: [
    { optionId: 'red', roleId: ROLE_LOW, label: 'Red', position: 0 },
    { optionId: 'blue', roleId: ROLE_NEW, label: 'Blue', position: 1 },
  ],
} as const;

const existingManaged: OpsPanelDetail = {
  panelId: 'colour-roles',
  kind: 'managed',
  component: 'button',
  behaviour: 'toggle',
  status: 'enabled',
  messageId: '555555555555555555',
  optionCount: 2,
  channelId: '444444444444444444',
  maxRoles: undefined,
  requiredRoleId: undefined,
  blockedRoleIds: [],
  adoptionPassState: 'done',
  adoptionBlockedCount: 0,
  options: [],
};

const existingAdopted: OpsPanelDetail = {
  ...existingManaged,
  panelId: 'legacy-roles',
  kind: 'adopted',
  component: 'reaction',
};

const ADOPTED_EDIT = {
  panelId: 'legacy-roles',
  kind: 'adopted',
  channelId: '444444444444444444',
  messageId: '555555555555555555',
  behaviour: 'toggle',
  component: 'reaction',
  options: [{ optionId: 'red', roleId: ROLE_LOW, emojiKey: 'u:1f534', position: 0 }],
} as const;

const guildRoles = (over: Partial<OpsGuildRoleInfo> = {}): OpsGuildRoleInfo[] => [
  { roleId: ROLE_LOW, name: 'Red', colour: 0, position: 1, managed: false },
  { roleId: ROLE_HIGH, name: 'High', colour: 0, position: 200, managed: false },
  { roleId: ROLE_NEW, name: 'Blue', colour: 0, position: 2, managed: false, ...over },
];

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(args: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly updated: { definition: PanelDefinition; newlyAllowlisted: readonly string[] }[];
}

const harness = (
  options: {
    panel?: OpsPanelDetail | undefined;
    managedRoleIds?: readonly string[];
    roles?: OpsGuildRoleInfo[];
    botPosition?: number | undefined;
  } = {},
): Harness => {
  const audit: OpsAuditWrite[] = [];
  const updated: Harness['updated'] = [];
  const managed = new Set(options.managedRoleIds ?? [ROLE_LOW]);

  const ports: Partial<OpsPorts> = {
    recordAudit: (input) => {
      audit.push(input);
    },
    findPanel: () => ('panel' in options ? options.panel : existingManaged),
    updatePanel: (definition, newlyAllowlistedRoleIds = []) => {
      updated.push({ definition, newlyAllowlisted: newlyAllowlistedRoleIds });
    },
    isManagedRole: (roleId) => managed.has(roleId),
    listGuildRoles: () => options.roles ?? guildRoles(),
    botHighestRolePosition: () => options.botPosition ?? BOT_POSITION,
  };

  const dispatcher = createDispatcher({
    commands: OPERATOR_COMMANDS,
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => 1_700_000_000_000,
      ports: fakeOpsPorts(ports),
    }),
    instance: fakeOpsInstance(),
  });

  return {
    audit,
    updated,
    run: (args, confirm = true) =>
      dispatcher.dispatch({
        v: 1,
        command: 'panel edit',
        args,
        confirm,
        unixUserClaimed: 'bryan',
      }),
  };
};

const json = (value: unknown): string => JSON.stringify(value);

describe('panel edit', () => {
  it('is registered as a write on the operator surface', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toContain('panel edit');
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'panel edit')?.write).toBe(true);
  });

  it('is a write: refused without --confirm, and records nothing', async () => {
    const h = harness();
    const response = await h.run({ definition: json(MANAGED) }, false);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe('needs-confirm');
    expect(h.updated).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('replaces the definition and audits the write', async () => {
    const h = harness({ managedRoleIds: [ROLE_LOW, ROLE_NEW] });
    const response = await h.run({ definition: json(MANAGED) });
    expect(response.ok).toBe(true);

    expect(h.updated).toHaveLength(1);
    expect(h.updated[0]?.definition).toMatchObject({
      panelId: 'colour-roles',
      behaviour: 'toggle',
      component: 'button',
    });
    expect(h.updated[0]?.definition.options.map((o) => o.optionId)).toEqual(['red', 'blue']);
    expect(h.updated[0]?.newlyAllowlisted).toEqual([]);

    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'panel.edited',
      subjectType: 'panel',
      subjectId: 'colour-roles',
      actorType: 'operator_cli',
      via: 'ssh',
    });
  });

  it('points the operator at panel sync — editing never publishes', async () => {
    const h = harness({ managedRoleIds: [ROLE_LOW, ROLE_NEW] });
    const response = await h.run({ definition: json(MANAGED) });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.text).toContain('panel sync colour-roles');
      expect(response.data).toMatchObject({ ok: true, published: false });
    }
  });

  it('allowlists a new role the bot can manage', async () => {
    const h = harness();
    const response = await h.run({ definition: json(MANAGED) });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: true, newlyAllowlistedRoleIds: [ROLE_NEW] });
      expect(response.text).toContain(ROLE_NEW);
    }
    expect(h.updated).toHaveLength(1);
    expect(h.updated[0]?.newlyAllowlisted).toEqual([ROLE_NEW]);
  });

  it('edits an adopted panel whose kind and channel are unchanged', async () => {
    const h = harness({ panel: existingAdopted });
    const response = await h.run({ definition: json(ADOPTED_EDIT) });
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.data).toMatchObject({ ok: true, panelId: 'legacy-roles' });
    expect(h.updated).toHaveLength(1);
  });

  it('refuses an unknown panel id with an audit outcome', async () => {
    const h = harness({ panel: undefined });
    const response = await h.run({ definition: json(MANAGED) });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'unknown-panel' });
      expect(response.text).toContain('no panel');
    }
    expect(h.updated).toEqual([]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'panel.edited',
      after: { outcome: 'unknown-panel' },
    });
  });

  it('refuses a channel change — moving would orphan the posted message', async () => {
    const h = harness({ managedRoleIds: [ROLE_LOW, ROLE_NEW] });
    const response = await h.run({
      definition: json({ ...MANAGED, channelId: '999999999999999999' }),
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'channel-change' });
      expect(response.text).toContain('orphan');
      expect(response.text).toContain('panel delete colour-roles');
    }
    expect(h.updated).toEqual([]);
    expect(h.audit[0]?.after).toMatchObject({ outcome: 'channel-change' });
  });

  it('refuses a kind change — it decides who owns the message', async () => {
    const h = harness({ managedRoleIds: [ROLE_LOW, ROLE_NEW] });
    const response = await h.run({
      definition: json({
        ...MANAGED,
        kind: 'adopted',
        component: 'reaction',
        messageId: '555555555555555555',
        options: [{ optionId: 'red', roleId: ROLE_LOW, emojiKey: 'u:1f534', position: 0 }],
      }),
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'kind-change' });
      expect(response.text).toContain('recreate');
    }
    expect(h.updated).toEqual([]);
    expect(h.audit[0]?.after).toMatchObject({ outcome: 'kind-change' });
  });

  it('refuses a role above the bot with an audit outcome', async () => {
    const h = harness();
    const response = await h.run({
      definition: json({
        ...MANAGED,
        options: [{ optionId: 'high', roleId: ROLE_HIGH, label: 'High', position: 0 }],
      }),
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'unmanageable-role' });
      expect(response.text).toContain(ROLE_HIGH);
    }
    expect(h.updated).toEqual([]);
    expect(h.audit[0]?.after).toMatchObject({ outcome: 'unmanageable-role' });
  });

  it('refuses a role Discord does not know', async () => {
    const h = harness();
    const response = await h.run({
      definition: json({
        ...MANAGED,
        options: [{ optionId: 'ghost', roleId: '999999999999999999', label: 'Ghost', position: 0 }],
      }),
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'unmanageable-role' });
    }
    expect(h.updated).toEqual([]);
  });

  it('refuses malformed JSON before storage is touched', async () => {
    const h = harness();
    const response = await h.run({ definition: '{not json' });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'invalid-json' });
    }
    expect(h.updated).toEqual([]);
    expect(h.audit[0]?.after).toMatchObject({ outcome: 'invalid-json' });
  });

  it('refuses a definition that fails the shared schema, naming the field', async () => {
    const h = harness();
    const response = await h.run({ definition: json({ ...MANAGED, options: [] }) });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'invalid-definition' });
      expect(response.text).toContain('options');
    }
    expect(h.updated).toEqual([]);
    expect(h.audit[0]?.after).toMatchObject({ outcome: 'invalid-definition' });
  });
});
