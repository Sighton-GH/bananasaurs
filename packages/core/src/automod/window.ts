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
  /**
   * Records an event at `atMs`, dropping the oldest if the per-member cap is
   * already full. Does **not** drop events by age — the read methods filter by
   * window, so an out-of-window event is never counted anyway.
   */
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
 * **There is deliberately no age-based pruning, and the reason is worth
 * stating because an earlier draft had some.** Correctness does not come from
 * pruning: `countWithin` and `countMatching` filter by the window on *every*
 * call, so an event outside the window is never counted whether it is still in
 * the array or not. And memory is bounded by `maxEventsPerMember` alone, which
 * is applied on every `record`, so the array is capped at all times.
 *
 * That left pruning with **no observable effect** — which is exactly how it was
 * found: the plan required a "watch it fail" guard for it, and the implementer
 * reported honestly that disabling pruning changed nothing any test could see.
 * A mechanism whose guard cannot be written is a mechanism to justify or
 * delete, and this one could not be justified: it bought a slightly smaller
 * steady-state array inside an already-capped buffer, at the cost of tracking
 * the largest window ever observed so `record` had something to prune against.
 *
 * `onRecord` is invoked from `record()` — not from the read methods — because
 * recording is this member's only observable "activity" for eviction
 * purposes (see `createWindowStore`'s doc comment for why a read must not
 * trigger registration or eviction).
 */
class RingMemberWindow implements MemberWindow {
  private events: Event[] = [];

  constructor(
    private readonly maxEventsPerMember: number,
    private readonly onRecord: () => void,
  ) {}

  record(atMs: number, value?: string): void {
    this.onRecord();
    this.events.push({ atMs, value });
    // Bound 1 of 2 (PR-22): never more than maxEventsPerMember events, for
    // this member, for this rule. This is the *only* thing bounding the array,
    // and it runs on every record, so the array is capped at all times.
    if (this.events.length > this.maxEventsPerMember) {
      this.events = this.events.slice(this.events.length - this.maxEventsPerMember);
    }
  }

  countWithin(atMs: number, windowMs: number): number {
    const floor = atMs - windowMs;
    return this.events.filter((e) => e.atMs >= floor && e.atMs <= atMs).length;
  }

  countMatching(atMs: number, windowMs: number, value: string): number {
    const floor = atMs - windowMs;
    return this.events.filter((e) => e.atMs >= floor && e.atMs <= atMs && e.value === value).length;
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
 * **The real memory ceiling is a product, not this constant alone**
 * (whole-branch review, IMPORTANT-3): `(number of compiled windowed rules) ×
 * DEFAULT_MAX_TRACKED_MEMBERS × (that rule's own per-member cap) × (bytes per
 * event)`. The per-member cap is operator-controlled — `rapid_spam` sizes it
 * from `maxMessages` (up to 1 000 by schema) — and used to be true for
 * `duplicate_message` too before it stored a fixed-size hash instead of the
 * message text (see `DEFAULT_MAX_EVENTS_PER_MEMBER` below); this comment
 * previously reasoned about 500 members alone and concluded "one small ring
 * buffer each", which was only true for `rapid_spam`. 500 is still deliberately
 * modest for the member dimension: Bananasaurs serves **one** engineering-club
 * guild (`CLAUDE.md`), so 500 simultaneously-active posters is far beyond a
 * realistic burst. If a raid ever exceeds it, PR-22's eviction is the
 * documented behaviour rather than a failure. Nothing validates the product
 * across rules, and nothing bounds the rule count — a future rule kind with a
 * large per-member cap and unbounded event size should not assume this
 * constant alone protects it.
 */
export const DEFAULT_MAX_TRACKED_MEMBERS = 500;

/**
 * The per-member ring buffer capacity for `duplicate_message` (CRITICAL-1,
 * whole-branch review).
 *
 * **This must not be derived from `maxRepeats`.** `rapid_spam`'s buffer is
 * sized `maxMessages + 1` because it counts *every* event in the buffer
 * (`countWithin`) — a buffer of `maxMessages + 1` can always hold "one too
 * many". `duplicate_message` counts only the events whose `value` equals this
 * message's normalised text (`countMatching`), but `record` puts *every*
 * message a member posts into the same buffer, repeats and non-repeats alike.
 * Sizing that buffer `maxRepeats + 1` — the false analogy an earlier version
 * of this predicate drew — means the buffer holds enough events *in total*
 * but not enough *of one text*: a single other message the member posts
 * between repeats evicts a repeat before the count can ever exceed the
 * threshold, defeating the rule at every configuration against the ordinary
 * shape of the spam it exists to catch (the same text interleaved with other
 * chatter).
 *
 * Decoupling the two means `duplicate_message`'s buffer holds up to this many
 * of a member's most recent events (of any text), of which only the ones
 * matching a given text are ever counted. **The residual evasion this leaves:
 * a member who posts more than this many *distinct* messages between two
 * repeats will still evict the earlier repeat out of the buffer entirely.**
 * 50 is chosen to make that require a deliberate flood of unrelated messages,
 * not one "lol" between two repeats.
 */
export const DEFAULT_MAX_EVENTS_PER_MEMBER = 50;
