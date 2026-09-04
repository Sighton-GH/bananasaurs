/**
 * A bounded, guild-scoped sliding-window store (Release 2 Slice 4).
 *
 * The first state any predicate on this project has carried. Everything
 * before this slice was pure: compile a rule, evaluate a message, done. The
 * window tier (`rapid_spam`, `duplicate_message`) needs to remember recent
 * events per member, which is what this module holds — nothing else does or
 * should (plan ruling PR-21).
 *
 * **No `Date.now()` anywhere in this module.** Every method takes `atMs` from
 * its caller. `runDryRun` replays fixtures at their recorded timestamps
 * (ADR 0041 §6); a store that read the wall clock would make a replay's
 * result depend on when the replay ran, which breaks the determinism that
 * guarantee exists to provide. This is checked by a dedicated test below and
 * is not negotiable.
 *
 * **Lifetime:** this store is not module state. It is built inside a
 * predicate's `compile` and lives in the closure of the returned
 * `CompiledPredicate`, which the subscriber caches per `<guildId>:<ruleId>`
 * fingerprint (`evaluate.ts`'s `PredicateCache`, ADR 0040 §5) and a dry run
 * builds fresh per invocation (ADR 0041 §6). Editing a windowed rule's config
 * therefore resets its window — the fingerprint changes and the artifact
 * (this store included) is rebuilt from nothing. That is correct: a changed
 * threshold should not be judged against counts accrued under the old one
 * (plan ruling PR-21).
 */

export interface WindowKey {
  readonly guildId: string;
  readonly memberId: string;
  readonly ruleId: string;
}

/** One member's recent events for one rule, oldest first. */
export interface MemberWindow {
  /** Records an event at `atMs` and prunes anything older than `windowMs`. */
  record(atMs: number, value?: string): void;
  /** How many events fall inside `[atMs - windowMs, atMs]`. */
  countWithin(atMs: number, windowMs: number): number;
  /** How many recorded events inside the window carry exactly `value`. */
  countMatching(atMs: number, windowMs: number, value: string): number;
}

export interface WindowStore {
  for(key: WindowKey): MemberWindow;
  /** Members currently tracked. Exposed for the eviction test, not for callers. */
  size(): number;
}

interface Event {
  readonly atMs: number;
  readonly value: string | undefined;
}

/**
 * A guild+member+rule's ring buffer.
 *
 * Pruning needs a `windowMs`, and this object is constructed before it knows
 * which window any given `countWithin`/`countMatching` call will ask about —
 * a windowed predicate's config is only visible to its own `compile`, not to
 * this module. So pruning is lazy: `record` prunes against the **largest
 * window it has ever been asked about** (`maxObservedWindowMs`, updated as
 * `countWithin`/`countMatching` are called). This is safe because a caller's
 * own config schema bounds `windowMs` (Tasks 3-4's `duplicate_message` and
 * `rapid_spam` both cap it), so this buffer never needs to hold events older
 * than the one window its own rule actually uses.
 *
 * `onRecord` is invoked from `record()` — not from the read methods — because
 * recording is this member's only observable "activity" for eviction
 * purposes (see `createWindowStore`'s doc comment for why a read must not
 * trigger registration or eviction).
 */
class RingMemberWindow implements MemberWindow {
  private events: Event[] = [];
  private maxObservedWindowMs = 0;

  constructor(
    private readonly maxEventsPerMember: number,
    private readonly onRecord: () => void,
  ) {}

  record(atMs: number, value?: string): void {
    this.onRecord();
    this.events.push({ atMs, value });
    // Bound 1 of 2 (PR-22): never more than maxEventsPerMember events, for
    // this member, for this rule. Applied before the age-based prune below so
    // a flood cannot grow the array past the cap even for an instant.
    if (this.events.length > this.maxEventsPerMember) {
      this.events = this.events.slice(this.events.length - this.maxEventsPerMember);
    }
    this.pruneOlderThan(atMs, this.maxObservedWindowMs);
  }

  countWithin(atMs: number, windowMs: number): number {
    this.noteWindow(windowMs);
    const floor = atMs - windowMs;
    return this.events.filter((e) => e.atMs >= floor && e.atMs <= atMs).length;
  }

  countMatching(atMs: number, windowMs: number, value: string): number {
    this.noteWindow(windowMs);
    const floor = atMs - windowMs;
    return this.events.filter((e) => e.atMs >= floor && e.atMs <= atMs && e.value === value).length;
  }

  private noteWindow(windowMs: number): void {
    if (windowMs > this.maxObservedWindowMs) this.maxObservedWindowMs = windowMs;
  }

  private pruneOlderThan(atMs: number, windowMs: number): void {
    if (windowMs <= 0) return;
    const floor = atMs - windowMs;
    this.events = this.events.filter((e) => e.atMs >= floor);
  }
}

/**
 * Builds a bounded, guild-scoped window store.
 *
 * Two independent caps (plan ruling PR-22): `maxEventsPerMember` bounds one
 * member's own ring buffer, and `maxMembers` bounds how many members are
 * tracked at once across the whole guild, evicting the least-recently-active
 * past that cap. Both are needed — without the per-member cap a single
 * member's flood grows one buffer without limit; without the member cap a
 * guild-wide raid grows the map without limit.
 *
 * **Eviction, never refusal.** Dropping the oldest member's window means one
 * spammer may get one extra message through where refusing to track would
 * mean the rule silently stops working under exactly the load it exists for.
 * That is the safe direction, and it is bounded and documented rather than
 * silent.
 *
 * **`for()` never registers or evicts anything — only `record()` does.** A
 * member who has never posted (or whose window was already evicted) must be
 * queryable without side effects: `for(key)` on an absent key returns a
 * fresh, empty `MemberWindow` that is not inserted into the tracked map until
 * something is actually recorded on it. Registering on `for()` instead would
 * mean a caller merely *reading* an evicted member's count (as `doctor` or a
 * future admin surface might, and as this module's own eviction test does)
 * would itself evict a different, currently-active member to make room for
 * an empty placeholder — silently destroying live state to answer a read.
 * Tying registration to `record()` means only genuine activity can cost
 * another member their slot.
 */
export const createWindowStore = (options: {
  /** Per-member ring buffer capacity (PR-22). */
  readonly maxEventsPerMember: number;
  /** How many members to track before evicting the least recently active (PR-22). */
  readonly maxMembers: number;
}): WindowStore => {
  // Map iteration order is insertion order, and this store always re-inserts
  // (delete then set) on every `record()`, which moves that key to the end —
  // so "least recently active" is cheap to find: it's whichever key iterates
  // first.
  const members = new Map<string, RingMemberWindow>();

  const keyFor = (key: WindowKey): string =>
    // CLAUDE.md rule 2: guildId is named in the key even though the artifact
    // this store lives inside is already per-guild — the same defence in
    // depth `predicateCacheKey` (evaluate.ts) documents.
    `${key.guildId}:${key.memberId}:${key.ruleId}`;

  /** Registers (or re-touches) `k`, evicting the LRU member only if `k` is genuinely new. */
  const touch = (k: string, win: RingMemberWindow): void => {
    const wasTracked = members.delete(k);
    if (!wasTracked && members.size >= options.maxMembers) {
      const oldestKey = members.keys().next().value;
      if (oldestKey !== undefined) members.delete(oldestKey);
    }
    members.set(k, win);
  };

  return {
    for(key: WindowKey): MemberWindow {
      const k = keyFor(key);
      const existing = members.get(k);
      if (existing !== undefined) return existing;

      // `win` is referenced inside its own initialiser's closure, which is
      // safe: the closure only runs when something later calls `.record()`,
      // by which point this declaration has long since completed.
      const win: RingMemberWindow = new RingMemberWindow(options.maxEventsPerMember, () =>
        touch(k, win),
      );
      return win;
    },
    size(): number {
      return members.size;
    },
  };
};

/**
 * How many members one windowed rule tracks at once, before the least recently
 * active is evicted (PR-22).
 *
 * Exported as a constant, and imported by both windowed predicates, so the two
 * cannot drift to different undocumented numbers — each builds its own store,
 * because window state lives per compiled artifact (PR-21).
 *
 * 500 is deliberately modest: Bananasaurs serves **one** engineering-club guild
 * (`CLAUDE.md`), so 500 simultaneously-active posters is far beyond a realistic
 * burst, and the memory cost is one small ring buffer each. If a raid ever
 * exceeds it, PR-22's eviction is the documented behaviour rather than a
 * failure.
 */
export const DEFAULT_MAX_TRACKED_MEMBERS = 500;
