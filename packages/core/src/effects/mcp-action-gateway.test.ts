import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { parseGuildId } from '../ids.js';
import {
  argsHashFor,
  MCP_ACTION_CAPS,
  MCP_ACTION_WINDOW_MS,
  runMcpAction,
  type McpActionLedgerRow,
  type McpActionAuditInput,
  type McpActionClaim,
  type McpActionCompletion,
  type McpActionDeps,
  type McpActionIntent,
} from './mcp-action-gateway.js';

/**
 * `runMcpAction` (`mcp-action-gateway.ts`) tested against fake ports, no
 * database and no network — the same shape as `message-gateway.test.ts`.
 * The fake ledger mirrors `claimAction`'s INSERT OR IGNORE semantics so
 * replay/collision behaviour is real, not asserted against a mock.
 *
 * Content (`CONTENT` below) must never reach the audit rows or the logs:
 * several cases below scan both for it.
 */

const GUILD = parseGuildId('111111111111111111');
const TOKEN_ID = 'tok_testrow000000000000000000000001';
const CHANNEL = '222222222222222222';
const CONTENT = 'pineapple-standup-content-s3cr3t-marker';
const KIND = 'message.send';

type StoredStatus = 'claimed' | 'done' | 'dry_run' | 'failed';

interface StoredRow {
  actionId: string;
  idempotencyKey: string;
  kind: string;
  capGroup: 'message' | 'edit' | 'thread' | 'pin_react';
  argsHash: string;
  status: StoredStatus;
  tokenId: string;
  targetChannelId: string | undefined;
  resultMessageId: string | undefined;
  resultThreadId: string | undefined;
  createdAt: number;
}

/** In-memory `mcp_actions`: INSERT OR IGNORE on the key, rows carry createdAt. */
class FakeLedger {
  rows = new Map<string, StoredRow>();
  /** When set, the next claim loses the race: a rival row lands first. */
  rivalOnNextClaim: StoredRow | undefined;

  find(key: string): McpActionLedgerRow | undefined {
    const row = this.rows.get(key);
    if (row === undefined) return undefined;
    const out: McpActionLedgerRow = { actionId: row.actionId, argsHash: row.argsHash };
    return {
      ...out,
      ...(row.resultMessageId !== undefined ? { resultMessageId: row.resultMessageId } : {}),
      ...(row.resultThreadId !== undefined ? { resultThreadId: row.resultThreadId } : {}),
    };
  }

  claim(row: McpActionClaim): { readonly claimed: boolean } {
    if (this.rivalOnNextClaim !== undefined) {
      this.rows.set(row.idempotencyKey, this.rivalOnNextClaim);
      this.rivalOnNextClaim = undefined;
      return { claimed: false };
    }
    if (this.rows.has(row.idempotencyKey)) return { claimed: false };
    this.rows.set(row.idempotencyKey, {
      actionId: row.actionId,
      idempotencyKey: row.idempotencyKey,
      kind: row.kind,
      capGroup: row.capGroup,
      argsHash: row.argsHash,
      status: row.dryRun ? 'dry_run' : 'claimed',
      tokenId: row.tokenId,
      targetChannelId: row.targetChannelId,
      resultMessageId: undefined,
      resultThreadId: undefined,
      createdAt: row.now,
    });
    return { claimed: true };
  }

  complete(actionId: string, result: McpActionCompletion): void {
    for (const [key, row] of this.rows) {
      if (row.actionId === actionId) {
        this.rows.set(key, {
          ...row,
          status: result.status,
          resultMessageId: result.resultMessageId ?? row.resultMessageId,
          resultThreadId: result.resultThreadId ?? row.resultThreadId,
        });
      }
    }
  }

  /** Mirrors storage: claimed, done and dry_run rows count; failed rows do not. */
  countSince(capGroup: StoredRow['capGroup'], sinceMs: number): number {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.capGroup === capGroup && row.createdAt >= sinceMs && row.status !== 'failed') {
        n += 1;
      }
    }
    return n;
  }

  recentSameContent(argsHash: string, channelId: string | undefined, sinceMs: number): boolean {
    for (const row of this.rows.values()) {
      if (
        row.argsHash === argsHash &&
        row.targetChannelId === channelId &&
        row.createdAt >= sinceMs
      ) {
        return true;
      }
    }
    return false;
  }

  /** Seed a claimed row directly, for cap tests. */
  seedClaimed(index: number, atMs: number): void {
    this.rows.set(`seed-key-${index}`, {
      actionId: `seed-action-${index}`,
      idempotencyKey: `seed-key-${index}`,
      kind: KIND,
      capGroup: 'message',
      argsHash: `seed-hash-${index}`,
      status: 'claimed',
      tokenId: TOKEN_ID,
      targetChannelId: CHANNEL,
      resultMessageId: undefined,
      resultThreadId: undefined,
      createdAt: atMs,
    });
  }
}

interface Harness {
  deps: McpActionDeps;
  ledger: FakeLedger;
  audits: McpActionAuditInput[];
  completions: { actionId: string; result: McpActionCompletion }[];
  logText(): string;
  state: { killswitch: boolean; breakerOpen: boolean; dryRun: boolean };
  guildKnown: { value: boolean };
  readCalls: { value: number };
  nowMs: { value: number };
  actionSeq: { value: number };
  executeCalls: { value: number };
}

const build = (): Harness => {
  const state = { killswitch: false, breakerOpen: false, dryRun: false };
  const guildKnown = { value: true };
  const readCalls = { value: 0 };
  const nowMs = { value: 1_700_000_000_000 };
  const actionSeq = { value: 0 };
  const executeCalls = { value: 0 };
  const ledger = new FakeLedger();
  const audits: McpActionAuditInput[] = [];
  const completions: { actionId: string; result: McpActionCompletion }[] = [];
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ level: 'debug' }, sink);

  const deps: McpActionDeps = {
    guildId: GUILD,
    logger,
    now: () => nowMs.value,
    newActionId: () => {
      actionSeq.value += 1;
      return `action-${actionSeq.value}`;
    },
    state: {
      // Deliberately only `read`: this pipeline must never trip the breaker,
      // so there is no `tripBreaker` to call. The tests below fail if anyone
      // threads one through here (M5-D12, carried over by ADR 0116 §1).
      read: () => {
        readCalls.value += 1;
        if (!guildKnown.value) return undefined;
        return { ...state };
      },
    },
    ledger: {
      find: (key) => ledger.find(key),
      claim: (row) => ledger.claim(row),
      complete: (actionId, result) => {
        completions.push({ actionId, result });
        ledger.complete(actionId, result);
      },
      countSince: (capGroup, sinceMs) => ledger.countSince(capGroup, sinceMs),
      recentSameContent: (argsHash, channelId, sinceMs) =>
        ledger.recentSameContent(argsHash, channelId, sinceMs),
    },
    audit: {
      record: (input) => {
        audits.push(input);
      },
    },
  };

  return {
    deps,
    ledger,
    audits,
    completions,
    logText: () => chunks.join(''),
    state,
    guildKnown,
    readCalls,
    nowMs,
    actionSeq,
    executeCalls,
  };
};

const hashForContent = (content: string = CONTENT): string =>
  argsHashFor(KIND, { channelId: CHANNEL, content });

const intent = (over: Partial<McpActionIntent> = {}): McpActionIntent => ({
  kind: KIND,
  capGroup: 'message',
  idempotencyKey: 'key-1',
  tokenId: TOKEN_ID,
  argsHash: hashForContent(),
  targetChannelId: CHANNEL,
  dryRun: false,
  duplicateContentGuard: true,
  ...over,
});

const succeedingExecute = (h: Harness) => async () => {
  h.executeCalls.value += 1;
  return { resultMessageId: '444444444444444445' };
};

describe('argsHashFor', () => {
  it('does not change when key order changes', () => {
    expect(argsHashFor(KIND, { b: 1, a: 2 })).toBe(argsHashFor(KIND, { a: 2, b: 1 }));
  });

  it('does not change when nested key order changes', () => {
    expect(argsHashFor(KIND, { outer: { z: 1, y: [3, { b: 1, a: 2 }] } })).toBe(
      argsHashFor(KIND, { outer: { y: [3, { a: 2, b: 1 }], z: 1 } }),
    );
  });

  it('changes when a value changes, and when the kind changes', () => {
    expect(argsHashFor(KIND, { a: 1 })).not.toBe(argsHashFor(KIND, { a: 2 }));
    expect(argsHashFor(KIND, { a: 1 })).not.toBe(argsHashFor('message.edit', { a: 1 }));
  });

  it('is a sha256 hex digest', () => {
    expect(argsHashFor(KIND, { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('runMcpAction layer order', () => {
  it('refuses a reused key with different args and never calls execute', async () => {
    const h = build();
    const first = await runMcpAction(h.deps, intent(), true, succeedingExecute(h));
    expect(first.status).toBe('done');

    const outcome = await runMcpAction(
      h.deps,
      intent({ argsHash: hashForContent('different content') }),
      true,
      async () => {
        h.executeCalls.value += 1;
        return {};
      },
    );

    expect(outcome).toEqual({ status: 'refused', reason: 'key-reused-with-other-args' });
    expect(h.executeCalls.value).toBe(1);
  });

  it('a failed claim still replays: execute throws once, the retry never calls it again', async () => {
    const h = build();
    let calls = 0;
    const failing = async (): Promise<{ resultMessageId?: string }> => {
      calls += 1;
      throw new Error('discord exploded');
    };

    const failed = await runMcpAction(h.deps, intent(), true, failing);
    expect(failed.status).toBe('failed');
    expect(calls).toBe(1);
    const failedActionId = failed.status === 'failed' ? failed.actionId : undefined;
    expect(failedActionId).toMatch(/^action-/);
    // The ledger row stays, so a retry finds it.
    expect(h.ledger.find('key-1')).toBeDefined();

    const replayed = await runMcpAction(h.deps, intent(), true, failing);
    expect(replayed).toEqual({ status: 'replayed', actionId: failedActionId });
    expect(calls).toBe(1);
    expect(h.audits[0]?.outcome).toBe('failed');
    for (const row of h.audits) {
      expect(JSON.stringify(row)).not.toContain(CONTENT);
    }
    expect(h.logText()).not.toContain(CONTENT);
  });

  it('refuses when the kill switch is on and never calls execute', async () => {
    const h = build();
    h.state.killswitch = true;
    const outcome = await runMcpAction(h.deps, intent(), true, succeedingExecute(h));
    expect(outcome).toEqual({ status: 'refused', reason: 'killswitch' });
    expect(h.executeCalls.value).toBe(0);
  });

  it('refuses when the breaker is open and never calls execute', async () => {
    const h = build();
    h.state.breakerOpen = true;
    const outcome = await runMcpAction(h.deps, intent(), true, succeedingExecute(h));
    expect(outcome).toEqual({ status: 'refused', reason: 'breaker-open' });
    expect(h.executeCalls.value).toBe(0);
  });

  it('refuses when state is unknown and never calls execute', async () => {
    const h = build();
    h.guildKnown.value = false;
    const outcome = await runMcpAction(h.deps, intent(), true, succeedingExecute(h));
    expect(outcome).toEqual({ status: 'refused', reason: 'guild-unknown' });
    expect(h.executeCalls.value).toBe(0);
  });

  it('exposes no dependency method that could open the breaker', () => {
    const h = build();
    expect('tripBreaker' in (h.deps.state as Record<string, unknown>)).toBe(false);
    expect(Object.keys(h.deps.state)).toEqual(['read']);
  });

  it('refuses at the cap with a reset-time detail, but still replays an existing key', async () => {
    const h = build();
    for (let i = 0; i < MCP_ACTION_CAPS.message; i += 1) {
      h.ledger.seedClaimed(i, h.nowMs.value);
    }
    // One existing key, claimed before the cap filled.
    const existingHash = hashForContent('already-claimed');
    h.ledger.rows.set('existing-key', {
      actionId: 'action-existing',
      idempotencyKey: 'existing-key',
      kind: KIND,
      capGroup: 'message',
      argsHash: existingHash,
      status: 'done',
      tokenId: TOKEN_ID,
      targetChannelId: CHANNEL,
      resultMessageId: '555555555555555555',
      resultThreadId: undefined,
      createdAt: h.nowMs.value,
    });

    const capped = await runMcpAction(
      h.deps,
      intent({ idempotencyKey: 'new-key' }),
      true,
      succeedingExecute(h),
    );
    expect(capped).toEqual({
      status: 'refused',
      reason: 'rate-cap',
      detail: new Date(h.nowMs.value + MCP_ACTION_WINDOW_MS).toISOString(),
    });
    expect(h.executeCalls.value).toBe(0);

    // A replay is not a new action: it answers from the ledger, cap or no cap.
    const replayed = await runMcpAction(
      h.deps,
      intent({ idempotencyKey: 'existing-key', argsHash: existingHash }),
      true,
      succeedingExecute(h),
    );
    expect(replayed).toEqual({
      status: 'replayed',
      actionId: 'action-existing',
      resultMessageId: '555555555555555555',
    });
    expect(h.executeCalls.value).toBe(0);
  });

  it('refuses duplicate content only when the guard is on', async () => {
    const h = build();
    const first = await runMcpAction(h.deps, intent(), true, succeedingExecute(h));
    expect(first.status).toBe('done');

    const guarded = await runMcpAction(
      h.deps,
      intent({ idempotencyKey: 'key-2' }),
      true,
      succeedingExecute(h),
    );
    expect(guarded).toEqual({ status: 'refused', reason: 'duplicate-content-recently' });

    const unguarded = await runMcpAction(
      h.deps,
      intent({ idempotencyKey: 'key-3', dryRun: true, duplicateContentGuard: false }),
      true,
      succeedingExecute(h),
    );
    expect(unguarded.status).toBe('dry-run');
    expect(h.executeCalls.value).toBe(1);
  });

  it('dry run (intent or state) claims without executing, holds cap room, and audits dry-run', async () => {
    for (const dryRun of [{ intentDryRun: true }, { intentDryRun: false }]) {
      const h = build();
      if (!dryRun.intentDryRun) h.state.dryRun = true;
      const outcome = await runMcpAction(
        h.deps,
        intent({ dryRun: dryRun.intentDryRun }),
        true,
        succeedingExecute(h),
      );
      expect(outcome.status).toBe('dry-run');
      expect(h.executeCalls.value).toBe(0);
      // The claim row exists, so the dry run still costs rate-cap room.
      expect(h.ledger.find('key-1')).toBeDefined();
      expect(h.ledger.countSince('message', h.nowMs.value - MCP_ACTION_WINDOW_MS)).toBe(1);
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]?.outcome).toBe('dry-run');
      expect(h.audits[0]?.dryRun).toBe(true);
      for (const row of h.audits) {
        expect(JSON.stringify(row)).not.toContain(CONTENT);
      }
      expect(h.logText()).not.toContain(CONTENT);
    }
  });

  it('refuses on target before reading state', async () => {
    const h = build();
    const outcome = await runMcpAction(h.deps, intent(), 'not-in-send-scope', succeedingExecute(h));
    expect(outcome).toEqual({
      status: 'refused',
      reason: 'target',
      detail: 'not-in-send-scope',
    });
    expect(h.readCalls.value).toBe(0);
    expect(h.executeCalls.value).toBe(0);
  });

  it('a lost claim race replays when the rival row holds the same hash', async () => {
    const h = build();
    h.ledger.rivalOnNextClaim = {
      actionId: 'action-rival',
      idempotencyKey: 'key-1',
      kind: KIND,
      capGroup: 'message',
      argsHash: hashForContent(),
      status: 'claimed',
      tokenId: TOKEN_ID,
      targetChannelId: CHANNEL,
      resultMessageId: undefined,
      resultThreadId: undefined,
      createdAt: h.nowMs.value,
    };
    const outcome = await runMcpAction(h.deps, intent(), true, succeedingExecute(h));
    expect(outcome).toEqual({ status: 'replayed', actionId: 'action-rival' });
    expect(h.executeCalls.value).toBe(0);
  });

  it('a lost claim race refuses when the rival row holds other args', async () => {
    const h = build();
    h.ledger.rivalOnNextClaim = {
      actionId: 'action-rival',
      idempotencyKey: 'key-1',
      kind: KIND,
      capGroup: 'message',
      argsHash: hashForContent('rival content'),
      status: 'claimed',
      tokenId: TOKEN_ID,
      targetChannelId: CHANNEL,
      resultMessageId: undefined,
      resultThreadId: undefined,
      createdAt: h.nowMs.value,
    };
    const outcome = await runMcpAction(h.deps, intent(), true, succeedingExecute(h));
    expect(outcome).toEqual({ status: 'refused', reason: 'key-reused-with-other-args' });
    expect(h.executeCalls.value).toBe(0);
  });

  it('success completes with the result ids, audits done, and leaks no content', async () => {
    const h = build();
    const outcome = await runMcpAction(h.deps, intent(), true, async () => {
      h.executeCalls.value += 1;
      return { resultMessageId: '444444444444444445', resultThreadId: '666666666666666666' };
    });

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') throw new Error('unreachable');
    expect(outcome.result).toEqual({
      resultMessageId: '444444444444444445',
      resultThreadId: '666666666666666666',
    });

    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]?.actionId).toBe(outcome.actionId);
    expect(h.completions[0]?.result.status).toBe('done');
    expect(h.completions[0]?.result.resultMessageId).toBe('444444444444444445');
    expect(h.completions[0]?.result.resultThreadId).toBe('666666666666666666');

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      outcome: 'done',
      actionId: outcome.actionId,
      resultMessageId: '444444444444444445',
      resultThreadId: '666666666666666666',
    });
    for (const row of h.audits) {
      expect(JSON.stringify(row)).not.toContain(CONTENT);
    }
    expect(h.logText()).not.toContain(CONTENT);
  });
});
