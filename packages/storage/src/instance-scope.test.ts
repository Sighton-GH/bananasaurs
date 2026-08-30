import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from './test-support.js';
import { readInstance, writeInstance, ReadonlyError } from './write.js';
import type { InstanceScope } from './scope.js';
import { dashboardAccounts } from './schema.js';

/**
 * ADR 0027. The point of a second scope type is that a repository function's
 * *first parameter* says whether its query is guild-partitioned, so these tests
 * are as much about what `InstanceScope` cannot do as about what it can.
 */

let t: MigratedTestDatabase;
let instance: InstanceScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  instance = t.scopes.instance();
});
afterEach(() => {
  t.close();
});

const seed = (accountId: string): void => {
  writeInstance(instance, ({ db }) => {
    db.insert(dashboardAccounts)
      .values({ accountId, username: accountId, passwordHash: 'x', createdAt: 0 })
      .run();
  });
};

describe('an instance scope reaches the database without a guild', () => {
  it('writes and reads back', () => {
    seed('acct_00000000000000000000000000000001');
    expect(readInstance(instance, (db) => db.select().from(dashboardAccounts).all())).toHaveLength(
      1,
    );
  });

  it('returns the callback value, like write() does', () => {
    expect(writeInstance(instance, () => 42)).toBe(42);
  });

  it('rolls back when the callback throws', () => {
    expect(() =>
      writeInstance(instance, ({ db }) => {
        db.insert(dashboardAccounts)
          .values({ accountId: 'acct_a', username: 'a', passwordHash: 'x', createdAt: 0 })
          .run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(readInstance(instance, (db) => db.select().from(dashboardAccounts).all())).toHaveLength(
      0,
    );
  });

  it('rejects an async callback, the same way write() does', () => {
    // Checked by `npm run typecheck`, not at runtime. An await inside a
    // transaction is exactly as wrong on an instance-level table.
    // @ts-expect-error Promise<T> resolves to never, so this does not compile
    expect(() => writeInstance(instance, async () => Promise.resolve(1))).toBeDefined();
  });

  it('carries no only(), because there is no predicate to forget', () => {
    // The whole reason this is a separate type. A GuildScope passed to an
    // instance-level repository would make "did this query lose its guild
    // predicate?" a question you answer by reading the body.
    //
    // Checked by `npm run typecheck`: if `only` ever appears on InstanceScope,
    // the `@ts-expect-error` becomes the error.
    // @ts-expect-error InstanceScope has no only()
    const absent: unknown = instance.only;
    expect(absent).toBeUndefined();
  });

  it('refuses a fabricated scope rather than reaching an arbitrary database', () => {
    const forged = {} as InstanceScope;
    expect(() => readInstance(forged, (db) => db.select().from(dashboardAccounts).all())).toThrow(
      /not produced by createScopeFactory/,
    );
  });
});

describe('readonly mode applies to instance-level writes', () => {
  it('refuses writeInstance', () => {
    const ro = t.readonlyScopes.instance();
    expect(() => writeInstance(ro, () => 1)).toThrow(ReadonlyError);
  });

  it('names what it refused, so the log line is actionable', () => {
    const ro = t.readonlyScopes.instance();
    expect(() => writeInstance(ro, () => 1)).toThrow(/BANANASAURS_READONLY/);
  });

  it('still allows readInstance, which is the point of the mode', () => {
    seed('acct_00000000000000000000000000000002');
    const ro = t.readonlyScopes.instance();
    expect(readInstance(ro, (db) => db.select().from(dashboardAccounts).all())).toHaveLength(1);
  });

  it('throws the same ReadonlyError class the dispatcher already recognises', () => {
    // dispatch.ts matches on `err.name === 'ReadonlyError'` across the ADR 0014
    // boundary. A second error class would be a second thing to recognise.
    const ro = t.readonlyScopes.instance();
    try {
      writeInstance(ro, () => 1);
      expect.unreachable('writeInstance should have refused');
    } catch (err) {
      expect((err as Error).name).toBe('ReadonlyError');
    }
  });
});
