import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditWrite, OpsPanelDetail, OpsPorts } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';

/**
 * `panel delete` — the panel's Discord message first, then its rows.
 *
 * The property under test is ordering-by-construction: the command deletes
 * through `unpublishPanel`, whose daemon implementation removes the message
 * before the rows, so a Discord failure throws with the rows still in place
 * and a retry can finish. At this level that means a throwing port surfaces
 * as a failed request with nothing audited, and the text says which of the
 * three cases applied — managed and posted, adopted, or never posted.
 *
 * Driven through `createDispatcher` with the whole registry, so `--confirm`
 * and the audit row are exercised by the machinery that actually owns them.
 */

const PANEL = 'colour-roles';

const panel = (over: Partial<OpsPanelDetail> = {}): OpsPanelDetail => ({
  panelId: PANEL,
  kind: 'managed',
  component: 'button',
  behaviour: 'toggle',
  status: 'enabled',
  messageId: '555555555555555555',
  optionCount: 1,
  channelId: '444444444444444444',
  maxRoles: undefined,
  requiredRoleId: undefined,
  blockedRoleIds: [],
  adoptionPassState: 'done',
  adoptionBlockedCount: 0,
  options: [],
  ...over,
});

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(args: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly unpublished: string[];
}

const harness = (
  options: {
    panel?: OpsPanelDetail | undefined;
    unpublish?: (panelId: string) => Promise<void>;
  } = {},
): Harness => {
  const audit: OpsAuditWrite[] = [];
  const unpublished: string[] = [];

  const ports: Partial<OpsPorts> = {
    recordAudit: (input) => {
      audit.push(input);
    },
    findPanel: () => ('panel' in options ? options.panel : panel()),
    unpublishPanel: (panelId) => {
      unpublished.push(panelId);
      return options.unpublish?.(panelId) ?? Promise.resolve();
    },
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
    unpublished,
    run: (args, confirm = true) =>
      dispatcher.dispatch({
        v: 1,
        command: 'panel delete',
        args,
        confirm,
        unixUserClaimed: 'bryan',
      }),
  };
};

describe('panel delete', () => {
  it('is registered as a write on the operator surface', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toContain('panel delete');
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'panel delete')?.write).toBe(true);
  });

  it('is a write: refused without --confirm, and records nothing', async () => {
    const h = harness();
    const response = await h.run({ panelId: PANEL }, false);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe('needs-confirm');
    expect(h.unpublished).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('deletes a managed posted panel through the port and audits it', async () => {
    const h = harness();
    const response = await h.run({ panelId: PANEL });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.text).toContain('removed its Discord message 555555555555555555');
      expect(response.data).toMatchObject({
        panelId: PANEL,
        messageDeleted: true,
        messageId: '555555555555555555',
      });
    }

    expect(h.unpublished).toEqual([PANEL]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'panel.deleted',
      subjectType: 'panel',
      subjectId: PANEL,
      actorType: 'operator_cli',
      via: 'ssh',
      after: { messageDeleted: true },
    });
  });

  it('says the roles stay — deleting a panel revokes nothing', async () => {
    const h = harness();
    const response = await h.run({ panelId: PANEL });
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.text).toContain('revokes nothing');
  });

  it('deletes an adopted panel without its message, and says so', async () => {
    const h = harness({ panel: panel({ kind: 'adopted', component: 'reaction' }) });
    const response = await h.run({ panelId: PANEL });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.text).toContain('belongs to someone else');
      expect(response.data).toMatchObject({ panelId: PANEL, messageDeleted: false });
    }

    // The rows still go through the same port — the port is what knows an
    // adopted message must not be touched. The text above is the promise.
    expect(h.unpublished).toEqual([PANEL]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'panel.deleted',
      after: { messageDeleted: false },
    });
  });

  it('deletes an unposted panel with nothing to remove', async () => {
    const h = harness({ panel: panel({ messageId: undefined }) });
    const response = await h.run({ panelId: PANEL });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.text).toContain('never posted');
      expect(response.data).toMatchObject({ messageDeleted: false, messageId: null });
    }
    expect(h.unpublished).toEqual([PANEL]);
    expect(h.audit).toHaveLength(1);
  });

  it('throws for an unknown panel, reaching neither the port nor the audit trail', async () => {
    const h = harness({ panel: undefined });
    const response = await h.run({ panelId: 'no-such-panel' });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe('failed');
      expect(response.message).toContain('no panel no-such-panel');
    }
    expect(h.unpublished).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('a Discord failure throws with nothing audited, so a retry can finish', async () => {
    const h = harness({
      unpublish: () => Promise.reject(new Error('Discord 500: internal error')),
    });
    const response = await h.run({ panelId: PANEL });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe('failed');
      expect(response.message).toContain('Discord 500');
    }
    expect(h.audit).toEqual([]);
  });
});
