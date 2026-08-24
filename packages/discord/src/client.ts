import {
  Client,
  GatewayIntentBits,
  Options,
  Partials,
  type ClientOptions,
  type RESTOptions,
  type SweeperOptions,
} from 'discord.js';

/**
 * Client construction, per `docs/19` §6.1 and ADR 0008's mandatory discord.js
 * configuration.
 *
 * Exported separately from the client itself so the options can be asserted on
 * without connecting — which is the whole reason this slice can be tested at
 * all, since there is no token here and never will be.
 */

/** Something with an id. All these predicates read is the snowflake. */
interface Identified {
  readonly id: string;
}

/**
 * The gateway intents Release 1 actually uses.
 *
 * `DirectMessages` is deliberately absent — a flagged departure from ADR 0008,
 * because Release 1 has no DM behaviour and `docs/09` says to enable intents
 * only where the design requires them. Adding it later is one line.
 */
export const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds, // roles, channels, guild lifecycle
  GatewayIntentBits.GuildMembers, // PRIVILEGED — joins/leaves, member fetch
  GatewayIntentBits.GuildMessages, // message edit/delete events
  GatewayIntentBits.MessageContent, // PRIVILEGED — only if content logging is on
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildModeration, // audit-log-backed delete attribution
] as const;

/**
 * The two that need a toggle in the Developer Portal as well as a line of code.
 *
 * Configuring one is not the same as being granted it: a bot with the intent in
 * code and the toggle off connects perfectly well and then never sees a member
 * join. `doctor` asserts these were granted at runtime (slice 6d).
 */
export const PRIVILEGED_INTENTS = [
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.MessageContent,
] as const;

/**
 * Without these, a reaction on a message outside the (deliberately tiny) cache
 * produces **no event at all**, silently. `docs/REVIEWING_AGENT_OUTPUT.md` names
 * it as the single most likely cause of "the panel looks dead".
 */
export const REQUIRED_PARTIALS = [
  Partials.Message,
  Partials.Channel,
  Partials.Reaction,
  Partials.User,
  // Beyond the four in the original kickoff: hierarchy checks need the bot's own
  // member, and a 50-entry member cache will not always hold it.
  Partials.GuildMember,
] as const;

/**
 * Managers discord.js does not support having their cache overridden.
 *
 * Exactly the five entries commented out of discord.js's own `Caches` interface
 * (`typings/index.d.ts`), so naming one in `buildCacheSettings` is a type error
 * as well as an assertion failure.
 *
 * **`docs/19` §6.1 says these "throw when limited". They do not, on 14.27.0.**
 * They call `process.emitWarning(..., 'UnsupportedCacheOverwriteWarning')` and
 * then apply the limit anyway, so the bot starts, looks healthy, and quietly
 * drops guilds, channels and roles out of cache. Three of the five are
 * per-guild managers, so their warning does not even fire until a guild
 * arrives — after startup, into a process that logs through pino and not
 * through `process.on('warning')`. Verified by construction, not assumed.
 */
export const UNLIMITABLE_CACHE_MANAGERS = [
  'GuildManager',
  'ChannelManager',
  'GuildChannelManager',
  'RoleManager',
  'PermissionOverwriteManager',
] as const;

/**
 * The memory budget from ADR 0008, as data the assertion can iterate.
 *
 * A number here is only a *request*: `Options.cacheWithLimits` matches a manager
 * **by name**, so a misspelt key is not an error anywhere in discord.js — the
 * setting never matches and that cache is unlimited. That is why the assertion
 * reads each limit back out through the factory rather than trusting this list.
 */
export const CACHE_LIMITS: ReadonlyArray<{ manager: string; maxSize: number }> = [
  // The archive is the source of history, not the client cache.
  { manager: 'MessageManager', maxSize: 25 },
  { manager: 'ReactionManager', maxSize: 0 },
  { manager: 'ReactionUserManager', maxSize: 0 },
  { manager: 'PresenceManager', maxSize: 0 },
  { manager: 'VoiceStateManager', maxSize: 0 },
  { manager: 'GuildStickerManager', maxSize: 0 },
  { manager: 'GuildScheduledEventManager', maxSize: 0 },
  { manager: 'ThreadMemberManager', maxSize: 0 },
  // Fetch members on demand rather than keeping the guild resident.
  { manager: 'GuildMemberManager', maxSize: 50 },
];

/** The shape `buildCacheSettings` returns, narrowed so the tests need no casts. */
export interface CacheSettings {
  MessageManager: number;
  ReactionManager: number;
  ReactionUserManager: number;
  PresenceManager: number;
  VoiceStateManager: number;
  GuildStickerManager: number;
  GuildScheduledEventManager: number;
  ThreadMemberManager: number;
  GuildMemberManager: {
    maxSize: number;
    keepOverLimit: (member: Identified) => boolean;
  };
}

export interface SweeperSettings {
  messages: { interval: number; lifetime: number };
  users: { interval: number; filter: () => (user: Identified) => boolean };
}

/**
 * @param botUserId A **thunk**, not a value. `client.user` does not exist until
 * READY, and these settings are built before login, so the naive
 * `m.id === client.user.id` closure is a crash-on-startup footgun — and the
 * quieter variant, reading the id eagerly into a `const`, captures `undefined`
 * for the process lifetime and evicts the bot's own member from its own cache.
 */
export function buildCacheSettings(botUserId: () => string | undefined): CacheSettings {
  return {
    MessageManager: 25,
    ReactionManager: 0,
    ReactionUserManager: 0,
    PresenceManager: 0,
    VoiceStateManager: 0,
    GuildStickerManager: 0,
    GuildScheduledEventManager: 0,
    ThreadMemberManager: 0,
    GuildMemberManager: {
      maxSize: 50,
      // Keep our own member resident: every hierarchy check needs it.
      keepOverLimit: (member) => member.id === botUserId(),
    },
  };
}

export function buildSweeperSettings(botUserId: () => string | undefined): SweeperSettings {
  return {
    messages: { interval: 300, lifetime: 900 },
    users: { interval: 3600, filter: () => (user) => user.id !== botUserId() },
  };
}

/**
 * ADR 0018: the REST client refuses rather than retries or waits.
 *
 * `@discordjs/rest` defaults to `retries: 3` and `rejectOnRateLimit: null`, so
 * out of the box it does both of the things `docs/19` §6.1's rule forbids —
 * retries a 5xx three times against a rate cap that authorised one call, and
 * *waits out* a rate limit rather than reporting it, which the circuit breaker
 * above can never count.
 *
 * These belong on the client rather than on a REST instance of the port's own,
 * because the port shares `client.rest`: two REST instances would keep separate
 * buckets and race each other past Discord's global cap.
 */
export const REST_OPTIONS = {
  retries: 0,
  // Every route, not only global. Per-route buckets are where role mutations
  // land, and a silent four-second wait on the interaction defer costs a dead
  // token and a member-visible failure with nothing in the log to explain it.
  rejectOnRateLimit: () => true,
} as const satisfies Partial<RESTOptions>;

/** Exported separately so a test can assert on it without connecting. */
export function buildClientOptions(botUserId: () => string | undefined): ClientOptions {
  return {
    intents: [...REQUIRED_INTENTS],
    partials: [...REQUIRED_PARTIALS],
    rest: { ...REST_OPTIONS },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      ...buildCacheSettings(botUserId),
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      ...buildSweeperSettings(botUserId),
    } satisfies SweeperOptions,
  };
}

export class ClientOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientOptionsError';
  }
}

/**
 * Refuses to start on a client configuration that would fail silently.
 *
 * Called from the composition root before login as well as from the test, so a
 * misconfiguration is a startup failure with a message rather than a bot that
 * connects and then does nothing. Every check here corresponds to a failure
 * discord.js itself reports either not at all or only as a process warning.
 */
export function assertClientOptions(options: ClientOptions): void {
  const problems: string[] = [];

  const intents = new Set<number>(asNumbers(options.intents));
  for (const bit of REQUIRED_INTENTS) {
    if (!intents.has(bit)) problems.push(`missing intent ${GatewayIntentBits[bit]}`);
  }

  const partials = new Set<number>(options.partials ?? []);
  for (const partial of REQUIRED_PARTIALS) {
    if (!partials.has(partial)) {
      problems.push(
        `missing Partials.${Partials[partial]} — reactions on uncached messages would produce no event at all`,
      );
    }
  }

  for (const { manager, maxSize } of CACHE_LIMITS) {
    if ((UNLIMITABLE_CACHE_MANAGERS as readonly string[]).includes(manager)) {
      problems.push(`${manager} does not support a cache limit; discord.js warns and breaks`);
      continue;
    }
    const actual = effectiveMaxSize(options, manager);
    if (actual !== maxSize) {
      problems.push(
        `${manager} should cache at most ${maxSize}, but the configured factory gives ` +
          `${actual === undefined ? 'an unlimited Collection' : String(actual)} — ` +
          `cacheWithLimits matches by name, so a manager it does not recognise is silently unlimited`,
      );
    }
  }

  if (problems.length > 0) {
    throw new ClientOptionsError(
      `the Discord client is misconfigured:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

/** Constructs the client. Options are asserted first, always. */
export function createDiscordClient(botUserId: () => string | undefined): Client {
  const options = buildClientOptions(botUserId);
  assertClientOptions(options);
  return new Client(options);
}

// ── internals ─────────────────────────────────────────────────────────────

/** `intents` accepts several resolvable shapes; only the plain one is ours. */
function asNumbers(intents: ClientOptions['intents']): number[] {
  if (Array.isArray(intents)) return intents.map(Number);
  return [];
}

/**
 * What discord.js will *actually* do for this manager, obtained by calling the
 * configured factory the same way `CachedManager` does. `undefined` means an
 * unlimited `Collection`, which is what a name discord.js does not recognise
 * produces — the failure this whole assertion exists to catch.
 */
function effectiveMaxSize(options: ClientOptions, manager: string): number | undefined {
  const cls = { name: manager };
  // `CacheFactory`'s declared type is unusable from outside the library; its own
  // typings carry the comment "This doesn't actually work the way it looks".
  const factory = options.makeCache as unknown as
    ((managerType: unknown, holds: unknown, manager: unknown) => { maxSize?: number }) | undefined;
  if (!factory) return undefined;
  return factory(cls, null, cls).maxSize;
}
