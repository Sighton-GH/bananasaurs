import { describe, expect, it } from 'vitest';

import type { PanelDefinition } from '../../panels/model.js';
import { createDispatcher } from '../dispatch.js';
import type { OpsAuditWrite, OpsPanelDetail, OpsPorts } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';

/**
 * `panel create` — ADR 0053's builder command.
 *
 * The properties under test are the refusals: a builder that half-creates a
 * panel and says nothing is worse than one that fails loudly, because the
 * operator would go and check Discord rather than re-run it. Driven through
 * `createDispatcher` with the whole registry, so `--confirm` and the audit
 * row are exercised by the machinery that actually owns them.
 */

const MANAGED = {
  panelId: 'colour-roles',
  kind: 'managed',
  channelId: '444444444444444444',
  behaviour: 'toggle',
  component: 'button',
  options: [
    { optionId: 'red', roleId: '333333333333333333', label: 'Red', position: 0 },
    {
      optionId: 'blue',
      roleId: '333333333333333334',
      label: 'Blue',
      emojiKey: 'u:1f535',
      position: 1,
    },
  ],
} as const;

const ADOPTED = {
  panelId: 'legacy-roles',
  kind: 'adopted',
  channelId: '444444444444444444',
  messageId: '555555555555555555',
  behaviour: 'toggle',
  component: 'reaction',
  options: [{ optionId: 'red', roleId: '333333333333333333', emojiKey: 'u:1f534', position: 0 }],
} as const;

const existingPanel: OpsPanelDetail = {
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

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(args: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly created: PanelDefinition[];
}

const harness = (options: { existing?: boolean } = {}): Harness => {
  const audit: OpsAuditWrite[] = [];
  const created: PanelDefinition[] = [];

  const ports: Partial<OpsPorts> = {
    recordAudit: (input) => {
      audit.push(input);
    },
    findPanel: () => (options.existing === true ? existingPanel : undefined),
    createPanel: (definition) => {
      created.push(definition);
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
    created,
    run: (args, confirm = true) =>
      dispatcher.dispatch({ v: 1, command: 'panel create', args, confirm, unixUserClaimed: 'bryan' }),
  };
};

const json = (value: unknown): string => JSON.stringify(value);

describe('panel create', () => {
  it('is a write: refused without --confirm, and records nothing', async () => {
    const h = harness();
    const response = await h.run({ definition: json(MANAGED) }, false);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe('needs-confirm');
    expect(h.created).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('creates a managed panel and audits the write', async () => {
    const h = harness();
    const response = await h.run({ definition: json(MANAGED) });
    expect(response.ok).toBe(true);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      panelId: 'colour-roles',
      kind: 'managed',
      behaviour: 'toggle',
      component: 'button',
      blockedRoleIds: [],
    });
    // Emoji survive the shared schema untouched — the builder's emoji picker
    // and the CLI flag must produce the same stored key.
    expect(h.created[0]?.options[1]?.emojiKey).toBe('u:1f535');

    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'panel.created',
      subjectType: 'panel',
      subjectId: 'colour-roles',
      actorType: 'operator_cli',
      actorUnixUserClaimed: 'bryan',
      via: 'ssh',
    });
  });

  it('points the operator at panel sync — creating never publishes', async () => {
    const h = harness();
    const response = await h.run({ definition: json(MANAGED) });
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.text).toContain('panel sync colour-roles');
  });

  it('refuses malformed JSON before storage is touched', async () => {
    const h = harness();
    const response = await h.run({ definition: '{not json' });
    // A refusal is an audited answer, not a failed request: it rides back in
    // the data, where the CLI and the dashboard turn it into their error code.
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'invalid-json' });
      expect(response.text).toContain('not valid JSON');
    }
    expect(h.created).toEqual([]);
    expect(h.audit).toHaveLength(1);
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
    expect(h.created).toEqual([]);
    expect(h.audit[0]?.after).toMatchObject({ outcome: 'invalid-definition' });
  });

  it('refuses to build an adopted panel — adoption is the deliberate ops flow', async () => {
    const h = harness();
    const response = await h.run({ definition: json(ADOPTED) });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'adopted-not-buildable' });
      expect(response.text).toContain('managed panels only');
    }
    expect(h.created).toEqual([]);
    expect(h.audit[0]?.after).toMatchObject({ outcome: 'adopted-not-buildable' });
  });

  it('refuses a duplicate panel id', async () => {
    const h = harness({ existing: true });
    const response = await h.run({ definition: json(MANAGED) });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ ok: false, reason: 'already-exists' });
      expect(response.text).toContain('already exists');
    }
    expect(h.created).toEqual([]);
    expect(h.audit[0]?.after).toMatchObject({ outcome: 'already-exists' });
  });
});
