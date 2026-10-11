import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { InstanceScope } from '../scope.js';
import { addKey, removeKey } from './assistant-providers.js';
import { callsTodayForKeys, lastUsedAt, modelUsage, reserveModelCall } from './model-calls.js';

const GUILD_ID = '123456789012345678';
const MODEL = 'gemini-2.5-flash';
const DAY_START = 0;
const NEXT_DAY_START = 86400000;

let t: MigratedTestDatabase;
let scope: InstanceScope;
let keyId: string;

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.instance();
  keyId = addKey(scope, { provider: 'gemini', label: 'Key', apiKeyEnc: 'sealed', now: 0 });
});

afterEach(() => t.close());

const reserve = (over: {
  now: number;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  model?: string;
  key?: string;
  dayStart?: number;
  nextDayStart?: number;
}) =>
  reserveModelCall(scope, {
    keyId: over.key ?? keyId,
    model: over.model ?? MODEL,
    guildId: GUILD_ID,
    now: over.now,
    rpmLimit: over.rpmLimit ?? null,
    rpdLimit: over.rpdLimit ?? null,
    dayStart: over.dayStart ?? DAY_START,
    nextDayStart: over.nextDayStart ?? NEXT_DAY_START,
  });

const callCount = (): number =>
  (t.raw.prepare('SELECT COUNT(*) AS n FROM assistant_model_calls').get() as { n: number }).n;

describe('reserveModelCall rpm window', () => {
  it('rpm 2 allows two calls, refuses the third with availableAt, then allows after the window slides', () => {
    expect(reserve({ now: 0, rpmLimit: 2 })).toEqual({ ok: true });
    expect(reserve({ now: 1000, rpmLimit: 2 })).toEqual({ ok: true });
    expect(reserve({ now: 2000, rpmLimit: 2 })).toEqual({
      ok: false,
      limit: 'rpm',
      availableAt: 60000,
    });
    expect(reserve({ now: 60001, rpmLimit: 2 })).toEqual({ ok: true });
  });
});

describe('reserveModelCall rpd window', () => {
  it('rpd 3 allows three calls and refuses the fourth until the next day', () => {
    expect(reserve({ now: 1000, rpdLimit: 3 })).toEqual({ ok: true });
    expect(reserve({ now: 2000, rpdLimit: 3 })).toEqual({ ok: true });
    expect(reserve({ now: 3000, rpdLimit: 3 })).toEqual({ ok: true });
    expect(reserve({ now: 4000, rpdLimit: 3 })).toEqual({
      ok: false,
      limit: 'rpd',
      availableAt: NEXT_DAY_START,
    });
  });
});

describe('reserveModelCall with no limits', () => {
  it('allows 50 calls when both limits are null', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(reserve({ now: i * 1000 })).toEqual({ ok: true });
    }
    expect(callCount()).toBe(50);
  });
});

describe('reserveModelCall counters are per (key, model)', () => {
  it('a different model on the same key and a different key each have their own counters', () => {
    const otherKey = addKey(scope, {
      provider: 'gemini',
      label: 'Other',
      apiKeyEnc: 'sealed-other',
      now: 0,
    });
    expect(reserve({ now: 0, rpmLimit: 1 })).toEqual({ ok: true });
    // Same key, other model: free.
    expect(reserve({ now: 0, rpmLimit: 1, model: 'other-model' })).toEqual({ ok: true });
    // Other key, same model: free.
    expect(reserve({ now: 0, rpmLimit: 1, key: otherKey })).toEqual({ ok: true });
    // Same key and model: at the limit.
    expect(reserve({ now: 0, rpmLimit: 1 })).toEqual({
      ok: false,
      limit: 'rpm',
      availableAt: 60000,
    });
  });
});

describe('reserveModelCall last slot', () => {
  it('two reservations at the same now with rpm 1 yield exactly one ok', () => {
    const results = [reserve({ now: 5000, rpmLimit: 1 }), reserve({ now: 5000, rpmLimit: 1 })];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });
});

describe('reserveModelCall pruning', () => {
  it('a row inserted at now=0 is gone after a reserve at now=172800001', () => {
    expect(reserve({ now: 0 })).toEqual({ ok: true });
    expect(callCount()).toBe(1);
    expect(reserve({ now: 172800001 })).toEqual({ ok: true });
    expect(callCount()).toBe(1);
    const ats = (
      t.raw.prepare('SELECT at FROM assistant_model_calls').all() as { at: number }[]
    ).map((r) => r.at);
    expect(ats).toEqual([172800001]);
  });
});

describe('modelUsage', () => {
  it('counts lastMinute, today and oldestInMinute', () => {
    reserve({ now: 50000 });
    reserve({ now: 90000 });
    reserve({ now: 99500 });
    expect(modelUsage(scope, { keyId, model: MODEL, now: 100000, dayStart: DAY_START })).toEqual({
      lastMinute: 3,
      today: 3,
      oldestInMinute: 50000,
    });
  });

  it('excludes rows outside the windows and omits oldestInMinute when the minute is empty', () => {
    reserve({ now: 0 });
    const usage = modelUsage(scope, { keyId, model: MODEL, now: 120000, dayStart: DAY_START });
    expect(usage.lastMinute).toBe(0);
    expect(usage.today).toBe(1);
    expect(usage.oldestInMinute).toBeUndefined();
  });

  it('reports zeros for a key and model with no calls', () => {
    const usage = modelUsage(scope, { keyId, model: MODEL, now: 1000, dayStart: DAY_START });
    expect(usage.lastMinute).toBe(0);
    expect(usage.today).toBe(0);
    expect(usage.oldestInMinute).toBeUndefined();
  });
});

describe('removeKey cascade', () => {
  it('deleting the key removes its call rows', () => {
    expect(reserve({ now: 0 })).toEqual({ ok: true });
    expect(callCount()).toBe(1);
    removeKey(scope, keyId);
    expect(callCount()).toBe(0);
  });
});

describe('pool selection reads (ADR 0143)', () => {
  it('lastUsedAt is the newest call for the key and model, 0 when never used', () => {
    expect(lastUsedAt(scope, { keyId, model: MODEL })).toBe(0);
    reserve({ now: 100 });
    reserve({ now: 500 });
    reserve({ now: 300, model: 'other-model' });
    expect(lastUsedAt(scope, { keyId, model: MODEL })).toBe(500);
    expect(lastUsedAt(scope, { keyId, model: 'other-model' })).toBe(300);
  });
  it('callsTodayForKeys counts one bucket across keys, only the model and today', () => {
    const second = addKey(scope, { provider: 'gemini', label: 'Two', apiKeyEnc: 's2', now: 0 });
    const third = addKey(scope, { provider: 'gemini', label: 'Three', apiKeyEnc: 's3', now: 0 });
    reserve({ now: 1000 });
    reserve({ now: 2000, key: second });
    reserve({ now: 3000, key: third });
    reserve({ now: 4000, key: second, model: 'other-model' });
    reserve({ now: 5, key: second, dayStart: 0 });
    expect(callsTodayForKeys(scope, { keyIds: [keyId, second], model: MODEL, dayStart: 10 })).toBe(
      2,
    );
    expect(callsTodayForKeys(scope, { keyIds: [keyId, second], model: MODEL, dayStart: 0 })).toBe(
      3,
    );
    expect(callsTodayForKeys(scope, { keyIds: [], model: MODEL, dayStart: 0 })).toBe(0);
  });
});
