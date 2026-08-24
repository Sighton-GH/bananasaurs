import { describe, expect, it } from 'vitest';
import * as discordjs from 'discord.js';
import { Client, GatewayIntentBits, Options, Partials, type ClientOptions } from 'discord.js';
import {
  CACHE_LIMITS,
  PRIVILEGED_INTENTS,
  REQUIRED_INTENTS,
  UNLIMITABLE_CACHE_MANAGERS,
  assertClientOptions,
  buildCacheSettings,
  buildClientOptions,
  buildSweeperSettings,
} from './client.js';

/**
 * The `ClientOptions` assertion (`docs/19` §6.1, §7 slice 6).
 *
 * The configuration is *verified* here, not merely written down. Three real
 * failures discord.js will not report at startup:
 *
 *  - A dropped partial. Without `Partials.Message/Channel/Reaction`, a reaction
 *    on a message outside the (deliberately tiny) cache produces **no event at
 *    all** — the single most likely cause of "the panel looks dead"
 *    (`docs/REVIEWING_AGENT_OUTPUT.md`).
 *  - A cache limit that silently did not take. `Options.cacheWithLimits` looks
 *    a manager up **by name**, so `MesageManager: 25` is not an error anywhere:
 *    the setting never matches and the cache is unlimited. Measured against
 *    14.27.0 — see the session log. ADR 0008's memory budget then goes
 *    unenforced with nothing to show for it.
 *  - A limit on a manager discord.js does not support limiting. Contrary to
 *    `docs/19` §6.1 these do **not** throw on 14.27.0: they emit a
 *    `process.emitWarning` and apply the limit anyway, so guilds and channels
 *    start falling out of cache while the bot looks healthy.
 */

const botId = '999999999999999999';
const otherId = '123456789012345678';

describe('intents', () => {
  it.each([
    ['Guilds', GatewayIntentBits.Guilds],
    ['GuildMembers', GatewayIntentBits.GuildMembers],
    ['GuildMessages', GatewayIntentBits.GuildMessages],
    ['MessageContent', GatewayIntentBits.MessageContent],
    ['GuildMessageReactions', GatewayIntentBits.GuildMessageReactions],
    ['GuildModeration', GatewayIntentBits.GuildModeration],
  ])('requests %s', (_name, bit) => {
    expect(buildClientOptions(() => botId).intents).toContain(bit);
  });

  /**
   * Settled decision 1 in the slice 6 handoff, and a departure from ADR 0008
   * that `docs/19` §6.1 flags deliberately: Release 1 has no DM behaviour, and
   * `docs/09` says enable intents only where the design requires them. Asserted
   * so that re-adding it is a decision someone makes rather than one that
   * drifts in behind a copied snippet.
   */
  it('does not request DirectMessages', () => {
    expect(buildClientOptions(() => botId).intents).not.toContain(GatewayIntentBits.DirectMessages);
  });

  it('names both privileged intents, which doctor has to check at runtime', () => {
    expect([...PRIVILEGED_INTENTS]).toEqual([
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
    ]);
  });

  it('survives the round trip through discord.js, which resolves the bitfield', () => {
    const client = new Client(buildClientOptions(() => botId));
    for (const bit of REQUIRED_INTENTS) {
      expect(client.options.intents.has(bit)).toBe(true);
    }
    expect(client.options.intents.has(GatewayIntentBits.DirectMessages)).toBe(false);
  });
});

describe('partials', () => {
  it.each([
    ['Message', Partials.Message],
    ['Channel', Partials.Channel],
    ['Reaction', Partials.Reaction],
    ['User', Partials.User],
    // Beyond the four in the original kickoff: hierarchy checks need the bot's
    // own member, and a 50-entry member cache will not always hold it.
    ['GuildMember', Partials.GuildMember],
  ])('enables Partials.%s', (_name, partial) => {
    expect(buildClientOptions(() => botId).partials).toContain(partial);
  });

  it('rejects options with a partial dropped', () => {
    const built = buildClientOptions(() => botId);
    expect(() =>
      assertClientOptions({
        ...built,
        partials: (built.partials ?? []).filter((p) => p !== Partials.Reaction),
      }),
    ).toThrow(/Reaction/);
  });

  it('rejects options with an intent dropped', () => {
    const built = buildClientOptions(() => botId);
    expect(() =>
      assertClientOptions({
        ...built,
        intents: [...REQUIRED_INTENTS].filter((i) => i !== GatewayIntentBits.GuildMembers),
      }),
    ).toThrow(/GuildMembers/);
  });
});

describe('cache limits are the memory budget, so they are checked against discord.js itself', () => {
  /**
   * Every limit is read back through the very `makeCache` factory discord.js
   * will call, not out of our own settings object. A settings key that names
   * nothing — a typo, or a manager renamed in a minor upgrade — yields an
   * unlimited `Collection` here and fails. Asserting on the settings object
   * instead would agree with the typo.
   */
  it.each(CACHE_LIMITS)('limits $manager to $maxSize', ({ manager, maxSize }) => {
    const cache = callMakeCache(
      buildClientOptions(() => botId),
      managerClassByName(manager),
    );
    expect(cache.maxSize).toBe(maxSize);
  });

  it('never limits a manager discord.js refuses to have limited', () => {
    for (const { manager } of CACHE_LIMITS) {
      expect(UNLIMITABLE_CACHE_MANAGERS).not.toContain(manager);
    }
  });

  /**
   * The five in `UNLIMITABLE_CACHE_MANAGERS` are exactly the entries commented
   * out of discord.js's own `Caches` interface, which is why limiting one is
   * also a type error. This asserts the runtime list has not drifted away from
   * the library: each name must still resolve to a real exported class.
   */
  it.each([...UNLIMITABLE_CACHE_MANAGERS])('%s is still a real discord.js manager', (name) => {
    expect(typeof managerClassByName(name)).toBe('function');
  });

  it('constructs a real client without an UnsupportedCacheOverwriteWarning', async () => {
    const warnings: string[] = [];
    const capture = (w: Error): void => void warnings.push(`${w.name}: ${w.message}`);
    process.on('warning', capture);
    try {
      const client = new Client(buildClientOptions(() => botId));
      // process.emitWarning is asynchronous, so give it a turn to land.
      await new Promise((resolve) => setImmediate(resolve));
      expect(client.guilds.cache.constructor.name).toBe('Collection');
      expect(client.channels.cache.constructor.name).toBe('Collection');
    } finally {
      process.off('warning', capture);
    }
    expect(warnings.filter((w) => w.startsWith('UnsupportedCacheOverwriteWarning'))).toEqual([]);
  });

  it('rejects options whose limits silently did not take', () => {
    expect(() =>
      assertClientOptions({
        ...buildClientOptions(() => botId),
        // The typo case spelled out: the settings below are missing most of the
        // budget, which is not an error anywhere in discord.js — those caches
        // are simply unlimited.
        makeCache: Options.cacheWithLimits({ MessageManager: 25, ReactionManager: 0 }),
      }),
    ).toThrow(/ReactionUserManager/);
  });
});

describe('botUserId is a thunk, because client.user does not exist until READY', () => {
  /**
   * `docs/19` §6.1 and the slice 6 handoff both name the naive
   * `m.id === client.user.id` closure as a crash-on-startup footgun. Options are
   * built *before* login, so an eager read captures `undefined` for the process
   * lifetime — after which the bot's own member is evicted from a 50-entry
   * cache and every hierarchy check needs a fetch.
   */
  it('builds cleanly while the id is still unknown', () => {
    expect(() => buildClientOptions(() => undefined)).not.toThrow();
  });

  it('reads the id at call time, not at build time', () => {
    // Initialised explicitly: pre-READY the id genuinely is undefined, and the
    // closure below is captured while it still is. (It also keeps prefer-const
    // quiet, which cannot see the reassignment through the thunk.)
    let current: string | undefined = undefined;
    const keepOverLimit = buildCacheSettings(() => current).GuildMemberManager.keepOverLimit;

    expect(keepOverLimit({ id: botId })).toBe(false); // pre-READY: nothing to keep

    current = botId; // READY fires
    expect(keepOverLimit({ id: botId })).toBe(true);
    expect(keepOverLimit({ id: otherId })).toBe(false);
  });

  it('keeps the bot out of the user sweeper the same way', () => {
    let current: string | undefined = undefined;
    const filter = buildSweeperSettings(() => current).users.filter;

    current = botId;
    const sweep = filter();
    expect(sweep({ id: botId })).toBe(false);
    expect(sweep({ id: otherId })).toBe(true);
  });
});

describe('sweepers', () => {
  it('sweeps messages on a lifetime, keeping the archive as the source of history', () => {
    expect(buildClientOptions(() => botId).sweepers?.messages).toMatchObject({
      interval: 300,
      lifetime: 900,
    });
  });

  it('keeps the discord.js default thread sweeper rather than replacing it', () => {
    expect(buildClientOptions(() => botId).sweepers?.threads).toEqual(
      Options.DefaultSweeperSettings.threads,
    );
  });
});

describe('assertClientOptions accepts what buildClientOptions produces', () => {
  it('does not throw on the real thing', () => {
    expect(() => assertClientOptions(buildClientOptions(() => botId))).not.toThrow();
  });
});

// ── helpers ───────────────────────────────────────────────────────────────

/** Resolved through discord.js's own exports, so a renamed class fails here. */
function managerClassByName(name: string): unknown {
  return (discordjs as unknown as Record<string, unknown>)[name];
}

/**
 * `CacheFactory`'s declared type is unusable from outside discord.js — its own
 * typings carry the comment "This doesn't actually work the way it looks" — so
 * the cast is confined to this one helper.
 */
function callMakeCache(options: ClientOptions, managerClass: unknown): { maxSize?: number } {
  const factory = options.makeCache as unknown as (
    managerType: unknown,
    holds: unknown,
    manager: unknown,
  ) => { maxSize?: number };
  return factory(managerClass, null, managerClass);
}
