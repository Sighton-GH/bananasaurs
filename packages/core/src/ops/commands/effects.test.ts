import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type {
  OpsAuditWrite,
  OpsBatchRow,
  OpsPanelDetail,
  OpsPorts,
  OpsPublishResult,
  OpsUndoableCount,
} from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';

/**
 * `panel sync`, `undo`, `adoption allow` — the three commands that cause
 * Discord side effects (slice 13e).
 *
 * The property under test in most of these is a *refusal*, and specifically a
 * refusal that happens before anything is queued. A command that reports "42
 * effects queued" and queued nothing is worse than one that fails, because the
 * operator will go and check the audit trail rather than run it again.
 *
 * Driven through `createDispatcher` with the whole registry, so `--confirm` and
 * the audit row are exercised by the machinery that actually owns them.
 */

const BATCH = 'b-1111';
const PANEL = 'roles-panel';

const panel = (over: Partial<OpsPanelDetail> = {}): OpsPanelDetail => ({
  panelId: PANEL,
  kind: 'adopted',
  component: 'reaction',
  behaviour: 'multi_select',
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
  ...over,
});

const batch = (over: Partial<OpsBatchRow> = {}): OpsBatchRow => ({
  batchId: BATCH,
  source: 'reaction',
  actorType: 'system',
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_001_000,
  undoneAt: null,
  ...over,
});

const published = (over: Partial<OpsPublishResult> = {}): OpsPublishResult => ({
  action: 'not-managed',
  messageId: '555555555555555555',
  reactionsSeeded: 2,
  reactionsFailed: [],
  ...over,
});

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface HarnessOptions {
  readonly panel?: OpsPanelDetail | undefined;
  readonly batch?: OpsBatchRow | undefined;
  readonly counted?: OpsUndoableCount;
  readonly published?: OpsPublishResult;
  readonly allowance?: number;
}

interface Harness {
  run(command: string, args: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly reconciled: string[];
  readonly undone: { batchId: string; reason: string }[];
  readonly granted: number[];
  readonly publishedPanels: string[];
}

const harness = (options: HarnessOptions = {}): Harness => {
  const audit: OpsAuditWrite[] = [];
  const reconciled: string[] = [];
  const undone: { batchId: string; reason: string }[] = [];
  const granted: number[] = [];
  const publishedPanels: string[] = [];
  let allowance = options.allowance ?? 0;

  const ports: Partial<OpsPorts> = {
    recordAudit: (input) => {
      audit.push(input);
    },
    findPanel: () => options.panel,
    publishPanel: (panelId) => {
      publishedPanels.push(panelId);
      return Promise.resolve(options.published ?? published());
    },
    enqueueReconcile: (panelId) => {
      reconciled.push(panelId);
      return { enqueued: true, jobId: 12 };
    },
    findBatch: () => options.batch,
    countUndoable: () => options.counted ?? { total: 3, reversible: 2 },
    enqueueUndo: (input) => {
      undone.push(input);
      return { enqueued: true, jobId: 34 };
    },
    grantAdoptionAllowance: (count) => {
      granted.push(count);
      allowance += count;
    },
    adoptionAllowance: () => allowance,
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
    reconciled,
    undone,
    granted,
    publishedPanels,
    run: (command, args, confirm = true) =>
      dispatcher.dispatch({ v: 1, command, args, confirm, unixUserClaimed: 'bryan' }),
  };
};

const okText = (response: Dispatched): string => {
  if (!response.ok) throw new Error(`expected ok, got: ${response.message}`);
  return response.text;
};
const errMessage = (response: Dispatched): string => {
  if (response.ok) throw new Error(`expected a refusal, got: ${response.text}`);
  return response.message;
};

// --- the guarantees the machinery owns ---------------------------------------

describe('every 13e command is a write', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['panel sync', { panelId: PANEL }],
    ['undo', { batch: BATCH }],
    ['adoption allow', { count: '5' }],
  ];

  it.each(cases)('%s is refused without --confirm, and queues nothing', async (name, args) => {
    const h = harness({ panel: panel(), batch: batch() });
    const response = await h.run(name, args, false);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe('needs-confirm');
    expect(h.audit).toEqual([]);
    expect(h.reconciled).toEqual([]);
    expect(h.undone).toEqual([]);
    expect(h.granted).toEqual([]);
    expect(h.publishedPanels).toEqual([]);
  });

  it.each(cases)('%s records exactly one audit row', async (name, args) => {
    const h = harness({ panel: panel(), batch: batch() });
    await h.run(name, args);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      actorType: 'operator_cli',
      actorId: undefined,
      actorUnixUserClaimed: 'bryan',
      via: 'ssh',
    });
  });
});

// --- panel sync --------------------------------------------------------------

describe('panel sync', () => {
  it('publishes and then queues the reconciliation, rather than awaiting it', async () => {
    // ADR 0026: the bounded half now, the rate-capped half as a job. A
    // synchronous pass over a 250-reactor panel takes twelve minutes and the
    // CLI gives up after thirty seconds.
    const h = harness({ panel: panel() });
    const text = okText(await h.run('panel sync', { panelId: PANEL }));
    expect(h.publishedPanels).toEqual([PANEL]);
    expect(h.reconciled).toEqual([PANEL]);
    expect(text).toContain('Queued as job 12');
    expect(text).toContain('jobs list');
  });

  it('reconciles the named panel only, never the whole guild', async () => {
    const h = harness({ panel: panel() });
    await h.run('panel sync', { panelId: PANEL });
    // The assertion behind ADR 0026's `panelId` on the payload: a command that
    // names one panel and reconciles every panel is over-reach an operator
    // finds out about from the audit trail afterwards.
    expect(h.reconciled).toEqual([PANEL]);
    expect(h.audit[0]?.subjectId).toBe(PANEL);
  });

  it('queues no reconciliation for a managed panel, which has nothing to drift', async () => {
    // `reconcileGuild` walks reactions. A button or select-menu panel carries
    // no reaction state, so a pass over it would visit nothing.
    const h = harness({
      panel: panel({ kind: 'managed', component: 'button', messageId: undefined }),
      published: published({ action: 'posted' }),
    });
    const text = okText(await h.run('panel sync', { panelId: PANEL }));
    expect(h.publishedPanels).toEqual([PANEL]);
    expect(h.reconciled).toEqual([]);
    expect(text).toContain('Posted panel');
  });

  it('refuses a disabled panel rather than putting it back in front of members', async () => {
    const h = harness({ panel: panel({ status: 'disabled_by_doctor' }) });
    const message = errMessage(await h.run('panel sync', { panelId: PANEL }));
    expect(message).toContain('disabled_by_doctor');
    expect(message).toContain('Re-enable it first');
    expect(h.publishedPanels).toEqual([]);
    expect(h.reconciled).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('refuses a panel that does not exist, and publishes nothing', async () => {
    const h = harness({ panel: undefined });
    expect(errMessage(await h.run('panel sync', { panelId: 'nope' }))).toContain('no panel nope');
    expect(h.publishedPanels).toEqual([]);
  });

  it('reports an emoji Discord refused rather than claiming a clean seed', async () => {
    const h = harness({
      panel: panel(),
      published: published({
        reactionsSeeded: 1,
        reactionsFailed: [{ emojiKey: 'custom:1234', error: 'DiscordApiError: 10014' }],
      }),
    });
    const text = okText(await h.run('panel sync', { panelId: PANEL }));
    expect(text).toContain('custom:1234');
    expect(text).toContain('10014');
  });

  it('says plainly that an adopted message cannot be rewritten', async () => {
    const h = harness({ panel: panel(), published: published({ action: 'not-managed' }) });
    const text = okText(await h.run('panel sync', { panelId: PANEL }));
    expect(text).toContain('belongs to someone else');
  });
});

// --- undo --------------------------------------------------------------------

describe('undo', () => {
  it('reports the size before queuing, so the operator sees what it will do', async () => {
    const h = harness({ batch: batch(), counted: { total: 42, reversible: 39 } });
    const text = okText(await h.run('undo', { batch: BATCH }));
    expect(text).toContain('39 of 42');
    expect(text).toContain('Queued as job 34');
    expect(h.undone).toHaveLength(1);
    expect(h.undone[0]?.batchId).toBe(BATCH);
  });

  it('says the reversal is still subject to every gateway layer', async () => {
    // Undo is a replay of the inverse through `applyRoleEffect`, not a special
    // path with its own permissions. An operator who thought otherwise would
    // be surprised when the kill switch stopped their undo.
    const h = harness({ batch: batch() });
    const text = okText(await h.run('undo', { batch: BATCH }));
    expect(text).toContain('kill switch');
    expect(text).toContain('rate cap');
  });

  it('refuses a batch that does not exist, and names where batch ids come from', async () => {
    const h = harness({ batch: undefined });
    const message = errMessage(await h.run('undo', { batch: 'b-nope' }));
    expect(message).toContain('no batch b-nope');
    expect(message).toContain('audit tail');
    expect(h.undone).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('refuses a batch already undone, because the inverse of the inverse re-applies it', async () => {
    const h = harness({ batch: batch({ undoneAt: 1_700_000_500_000 }) });
    const message = errMessage(await h.run('undo', { batch: BATCH }));
    expect(message).toContain('already undone');
    expect(message).toContain('re-apply');
    expect(h.undone).toEqual([]);
  });

  it('refuses a batch with nothing reversible, and says why nothing is', async () => {
    // The `had_role_before` case: we granted a role the member already had, so
    // we changed nothing and reversing would strip a role that was never ours.
    const h = harness({ batch: batch(), counted: { total: 4, reversible: 0 } });
    const message = errMessage(await h.run('undo', { batch: BATCH }));
    expect(message).toContain('nothing to undo');
    expect(message).toContain('already held the role');
    expect(h.undone).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('carries the operator reason onto the reversal', async () => {
    const h = harness({ batch: batch() });
    await h.run('undo', { batch: BATCH, reason: 'wrong panel, sorry' });
    expect(h.undone[0]?.reason).toBe('wrong panel, sorry');
  });

  it('supplies a reason when none was given, so no effect is unexplained', async () => {
    const h = harness({ batch: batch() });
    await h.run('undo', { batch: BATCH });
    expect(h.undone[0]?.reason).toContain(BATCH);
  });

  it('records the request, not the reversal', async () => {
    // The reversals are audited one at a time by the gateway when the job runs.
    // This row is who asked and when, and claiming more would be a lie the
    // trail cannot support if the job never runs.
    const h = harness({ batch: batch() });
    await h.run('undo', { batch: BATCH });
    expect(h.audit[0]).toMatchObject({
      action: 'batch.undo_requested',
      subjectType: 'batch',
      subjectId: BATCH,
    });
  });
});

// --- adoption allow ----------------------------------------------------------

describe('adoption allow', () => {
  it('grants against the live limiter and reports the new total', async () => {
    const h = harness({ allowance: 5 });
    const text = okText(await h.run('adoption allow', { count: '250' }));
    expect(h.granted).toEqual([250]);
    expect(text).toContain('Approved 250');
    expect(text).toContain('now 255');
  });

  it('says the allowance is lost on restart, because it lives in memory', async () => {
    // The property that makes this command possible at all — only the live
    // process holds the limiter (ADR 0013) — is the same property that makes it
    // fragile, and an operator must not have to discover the second half.
    const h = harness();
    expect(okText(await h.run('adoption allow', { count: '10' }))).toContain('restart');
  });

  it('says an allowance is a count and does not renew', async () => {
    const h = harness();
    const text = okText(await h.run('adoption allow', { count: '10' }));
    expect(text).toContain('not a rate');
    expect(text).toContain('does not renew');
  });

  it('refuses zero and a negative, which would look like a grant and be none', async () => {
    const h = harness();
    expect(errMessage(await h.run('adoption allow', { count: '0' }))).toContain('count');
    expect(errMessage(await h.run('adoption allow', { count: '-5' }))).toContain('count');
    expect(h.granted).toEqual([]);
  });

  it('refuses an implausibly large grant', async () => {
    // An allowance is a change list a human previewed and approved. Nobody
    // previews a hundred thousand, and a typo in this command is a typo that
    // turns the rate cap off.
    const h = harness();
    expect(errMessage(await h.run('adoption allow', { count: '100000' }))).toContain('count');
    expect(h.granted).toEqual([]);
  });

  it('records the allowance before and after, so a grant is reconstructable', async () => {
    const h = harness({ allowance: 3 });
    await h.run('adoption allow', { count: '7' });
    expect(h.audit[0]).toMatchObject({
      action: 'adoption.allowance_granted',
      before: { allowance: 3 },
      after: { allowance: 10 },
    });
  });
});
