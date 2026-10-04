import { describe, expect, it } from 'vitest';
import { createChannelAccess, type ChannelAccessDeps, type ChannelFacts } from './access.js';

interface World {
  facts: Map<string, ChannelFacts>;
  excluded: Set<string>;
  readOwn: Set<string>;
  readCat: Set<string>;
  writeOwn: Set<string>;
  writeCat: Set<string>;
  recordOwn: Set<string>;
  recordCat: Set<string>;
  pausedOwn: Set<string>;
  noThreads: Set<string>;
  archived: Set<string>;
  resolves: number;
}

const chan = (channelId: string, over: Partial<ChannelFacts> = {}): [string, ChannelFacts] => [
  channelId,
  { channelId, parentChannelId: undefined, categoryId: undefined, isPrivateThread: false, ...over },
];

const world = (entries: [string, ChannelFacts][]): { w: World; deps: ChannelAccessDeps } => {
  const w: World = {
    facts: new Map(entries),
    excluded: new Set(),
    readOwn: new Set(),
    readCat: new Set(),
    writeOwn: new Set(),
    writeCat: new Set(),
    recordOwn: new Set(),
    recordCat: new Set(),
    pausedOwn: new Set(),
    noThreads: new Set(),
    archived: new Set(),
    resolves: 0,
  };
  const deps: ChannelAccessDeps = {
    resolve: async (id) => {
      w.resolves += 1;
      return w.facts.get(id);
    },
    isExcluded: (id) => w.excluded.has(id),
    read: { hasOwnRow: (id) => w.readOwn.has(id), hasCategoryRow: (id) => w.readCat.has(id) },
    write: { hasOwnRow: (id) => w.writeOwn.has(id), hasCategoryRow: (id) => w.writeCat.has(id) },
    record: {
      hasOwnRow: (id) => w.recordOwn.has(id),
      hasCategoryRow: (id) => w.recordCat.has(id),
      hasPausedOwnRow: (id) => w.pausedOwn.has(id),
      parentIncludesThreads: (id) => !w.noThreads.has(id),
    },
    hasArchivedChannel: (id) => w.archived.has(id),
  };
  return { w, deps };
};

describe('createChannelAccess', () => {
  it('check(read) grants via the category row and reports grantedBy = categoryId', async () => {
    const { w, deps } = world([chan('C', { categoryId: 'CAT' })]);
    w.readCat.add('CAT');
    expect(await createChannelAccess(deps).check('read', 'C')).toEqual({
      allowed: true,
      grantedBy: 'CAT',
    });
  });

  it('check(read) on a thread whose CATEGORY is excluded is no-access even when the parent has its own read row', async () => {
    const { w, deps } = world([chan('T', { parentChannelId: 'P', categoryId: 'CAT' })]);
    w.readOwn.add('P');
    w.excluded.add('CAT');
    expect(await createChannelAccess(deps).check('read', 'T')).toEqual({
      allowed: false,
      reason: 'no-access',
    });
  });

  it('check(read) is not-granted when nothing grants', async () => {
    const { deps } = world([chan('C')]);
    expect(await createChannelAccess(deps).check('read', 'C')).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('check(write) uses the write predicates, never the read ones', async () => {
    const { w, deps } = world([chan('C')]);
    const access = createChannelAccess(deps);
    w.readOwn.add('C');
    expect(await access.check('write', 'C')).toEqual({ allowed: false, reason: 'not-granted' });
    w.readOwn.delete('C');
    w.writeOwn.add('C');
    expect(await access.check('write', 'C')).toEqual({ allowed: true, grantedBy: 'C' });
    expect(await access.check('read', 'C')).toEqual({ allowed: false, reason: 'not-granted' });
  });

  it('check(record) honours parentIncludesThreads=false for threads', async () => {
    const { w, deps } = world([chan('T', { parentChannelId: 'P' })]);
    w.recordOwn.add('P');
    const access = createChannelAccess(deps);
    expect(await access.check('record', 'T')).toEqual({ allowed: true, grantedBy: 'P' });
    w.noThreads.add('P');
    expect(await access.check('record', 'T')).toEqual({ allowed: false, reason: 'not-granted' });
    // read and write ignore the flag
    w.readOwn.add('P');
    expect(await access.check('read', 'T')).toEqual({ allowed: true, grantedBy: 'P' });
  });

  it('check(record) denies a paused own row under a collecting category; read and write are untouched', async () => {
    const { w, deps } = world([chan('C', { categoryId: 'CAT' })]);
    w.recordCat.add('CAT');
    w.pausedOwn.add('C');
    const access = createChannelAccess(deps);
    expect(await access.check('record', 'C')).toEqual({ allowed: false, reason: 'not-granted' });
    w.pausedOwn.delete('C');
    w.recordOwn.add('C');
    expect(await access.check('record', 'C')).toEqual({ allowed: true, grantedBy: 'C' });
  });

  it('check(*) on an unresolvable channel is unknown-channel', async () => {
    const { deps } = world([]);
    const access = createChannelAccess(deps);
    for (const purpose of ['read', 'write', 'record'] as const)
      expect(await access.check(purpose, 'X')).toEqual({
        allowed: false,
        reason: 'unknown-channel',
      });
  });

  it('canSearchArchived: archived + not excluded → true; archived + category excluded → false; no archive row → false', async () => {
    const { w, deps } = world([chan('C', { categoryId: 'CAT' })]);
    const access = createChannelAccess(deps);
    expect(await access.canSearchArchived('C')).toBe(false);
    w.archived.add('C');
    expect(await access.canSearchArchived('C')).toBe(true);
    w.excluded.add('CAT');
    expect(await access.canSearchArchived('C')).toBe(false);
  });

  it('canSearchArchived on an unresolvable channel with an archive row is true unless the id itself is excluded', async () => {
    const { w, deps } = world([]);
    const access = createChannelAccess(deps);
    w.archived.add('GONE');
    expect(await access.canSearchArchived('GONE')).toBe(true);
    w.excluded.add('GONE');
    expect(await access.canSearchArchived('GONE')).toBe(false);
  });

  it('isNoAccess: resolves levels, and falls back to own exclusion when unresolvable', async () => {
    const { w, deps } = world([chan('T', { parentChannelId: 'P', categoryId: 'CAT' })]);
    const access = createChannelAccess(deps);
    expect(await access.isNoAccess('T')).toBe(false);
    w.excluded.add('CAT');
    expect(await access.isNoAccess('T')).toBe(true);
    expect(await access.isNoAccess('GONE')).toBe(false);
    w.excluded.add('GONE');
    expect(await access.isNoAccess('GONE')).toBe(true);
  });

  it('a channel whose facts change between calls is re-resolved every call (no caching)', async () => {
    const { w, deps } = world([chan('C')]);
    w.readCat.add('CAT');
    const access = createChannelAccess(deps);
    expect((await access.check('read', 'C')).allowed).toBe(false);
    w.facts.set(...chan('C', { categoryId: 'CAT' }));
    expect((await access.check('read', 'C')).allowed).toBe(true);
    w.facts.delete('C');
    expect(await access.check('read', 'C')).toEqual({ allowed: false, reason: 'unknown-channel' });
    expect(w.resolves).toBe(3);
  });
});
