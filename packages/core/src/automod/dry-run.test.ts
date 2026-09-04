import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { authorize, type Authorized, type AuthzStore } from '../authz.js';
import { parseGuildId } from '../ids.js';
import type { DomainEvent, MessageEvent } from '../discord/events.js';
import type { ModerationOutcome, ModerationSafetyState } from '../effects/moderation-gateway.js';
import { createAutomodSubscriber, type AutomodSubscriberDeps } from './subscriber.js';
import type { AutomodRule, FixtureRecord, MatchTrace } from './predicates/types.js';
import { runDryRun } from './dry-run.js';
// Namespace import, not a named one, because `compileRule` needs to be
// spy-able on the same module object `evaluate.ts` calls through
// (`subscriber.test.ts`'s "does not recompile when nothing changed" uses
// the identical pattern).
import * as registry from './predicates/registry.js';

/**
 * Tests for `runDryRun`. The most important one in this file — the first
 * one, per the slice spec — is not about the dry run's own logic at all: it
 * proves the dry run and the live subscriber compute the *same* match for
 * the same content, because both go through `predicateInputFrom` and
 * `evaluateRule` in `evaluate.ts` and nowhere else.
 *
 * There is no exported `buildHarness`/`fakeDeps` helper to import: the one in
 * `subscriber.test.ts` is a private, unexported function in that file, and
 * this task's brief confines changes to `dry-run.ts`, this file, and
 * `index.ts` — so `subscriber.test.ts` is not touched to export it. The
 * helper below is a from-scratch, minimal `AutomodSubscriberDeps` fake built
 * to the same shape for the one thing this suite needs: a real subscriber
 * wired to fake ports, so its match can be compared against the dry run's.
 */

const GUILD_ID = '111111111111111111';
const GUILD = parseGuildId(GUILD_ID);
const AUTHOR = '400000000000000001';
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';

const permissiveAuthz: AuthzStore = { hasGrant: () => true };

/** `system` bypasses the grant check entirely, so no store setup is needed. */
const moderationAuth: Authorized<'moderation.act'> = (() => {
  const result = authorize(
    {
      store: permissiveAuthz,
      guildId: GUILD,
      actor: { type: 'system', id: undefined, roleIds: [] },
    },
    'moderation.act',
  );
  if (!result.ok) throw new Error('test setup: expected authorization to succeed');
  return result.value;
})();

const LIVE: ModerationSafetyState = { killswitch: false, breakerOpen: false, dryRun: false };

/** A minimal, fully-wired `AutomodSubscriberDeps` fake. Every port is inert. */
const fakeDeps = (): AutomodSubscriberDeps => ({
  logger: pino({ level: 'silent' }),
  moderationAuth,
  listRules: () => [],
  hasRoleExemption: () => false,
  isExempt: () => false,
  deleteMessage: async () => {},
  captureFixture: () => undefined,
  openOrResolveCase: () => ({ caseId: 'case-1', violationCount: 1 }),
  recordCaseEvent: () => {},
  readSafetyState: () => LIVE,
  nextEscalationTier: () => ({ action: undefined, timeoutMs: undefined }),
  moderationGateway: {
    applyAction: async (): Promise<ModerationOutcome> => ({ status: 'applied' }),
  },
  authorRoleIds: async () => [],
});

const messageEvent = (over: Partial<MessageEvent> = {}): DomainEvent => ({
  kind: 'messageCreate',
  guildId: GUILD,
  receivedAtMs: 1_000,
  channelId: CHANNEL,
  messageId: MESSAGE,
  authorId: AUTHOR,
  authorIsBot: false,
  content: '',
  editedTimestampMs: undefined,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

/** A `keyword_filter` rule named only by its word list, matching the brief's `ruleWith`. */
const ruleWith = (terms: readonly string[]): AutomodRule => ({
  ruleId: 'gate-rule',
  kind: 'keyword_filter',
  mode: 'test',
  config: '{}',
  terms: terms.map((text) => ({ text, categoryId: 'cat-1' })),
  allowlist: [],
  inviteAllowlist: [],
  linkDomains: [],
});

const fixture = (over: Partial<FixtureRecord> & { fixtureId: string }): FixtureRecord => ({
  content: 'nothing to see here',
  authorId: '400000000000000001',
  label: 'unlabelled',
  source: 'observed',
  createdAt: 1_000,
  attachments: [],
  ...over,
});

const FIXTURES: readonly FixtureRecord[] = [
  fixture({ fixtureId: '1:aaaa', content: 'a clean message', createdAt: 3_000 }),
  fixture({
    fixtureId: '2:bbbb',
    content: 'this has badword in it',
    createdAt: 1_000,
    label: 'should_match',
  }),
  fixture({
    fixtureId: '3:cccc',
    content: 'totally fine text',
    createdAt: 2_000,
    label: 'should_not_match',
  }),
  fixture({
    fixtureId: '4:dddd',
    content: 'also has badword here',
    createdAt: 4_000,
    label: 'should_not_match',
  }),
  fixture({
    fixtureId: '5:eeee',
    content: 'clean, but was expected to match',
    createdAt: 5_000,
    label: 'should_match',
  }),
];

describe('the one-code-path invariant', () => {
  it('produces byte-identical matches to the live subscriber, trace included', async () => {
    const rule = ruleWith(['badword']);
    const content = 'hello badword everyone';

    // Live path: a real subscriber, fake ports, one message event.
    const recorded: { trace?: MatchTrace; categoryId?: string; snippet?: string } = {};
    const subscriber = createAutomodSubscriber({
      ...fakeDeps(),
      listRules: () => [rule],
      recordCaseEvent: (input) => {
        recorded.trace = input.trace;
        recorded.categoryId = input.matchedCategory;
        recorded.snippet = input.matchedSnippet;
      },
    });
    await subscriber.handle(messageEvent({ content, receivedAtMs: 1_000 }));

    // Dry-run path: the same text as a fixture, replayed.
    const report = runDryRun({
      guildId: GUILD_ID,
      rule,
      fixtures: [
        {
          fixtureId: '300000000000000001:abcdef0123456789',
          content,
          authorId: '400000000000000001',
          label: 'unlabelled',
          source: 'observed',
          createdAt: 1_000,
          attachments: [],
        },
      ],
    });

    const replayed = report.results[0]?.match;
    expect(replayed).toBeDefined();
    expect(recorded.trace).toBeDefined();
    expect(replayed?.trace).toEqual(recorded.trace);
    expect(replayed?.categoryId).toEqual(recorded.categoryId);
    expect(replayed?.snippet).toEqual(recorded.snippet);
  });

  it('the dry run and the live subscriber agree on a message with attachments', async () => {
    // Obligation 3 of the slices 3-5 handoff. The gate above is a
    // behavioural comparison, so it can only see a divergence in a field some
    // shipped predicate reads — and keyword_filter reads only `content`. A
    // hand-built PredicateInput that skipped attachment reconstruction was
    // invisible to it. attachment_type is the first predicate to read a
    // second field, so this reaches that field from both the live subscriber
    // and the fixture replay.
    const rule: AutomodRule = {
      ruleId: 'attachments-rule',
      kind: 'attachment_type',
      mode: 'test',
      config: '{"blockedExtensions":["exe"]}',
      terms: [],
      allowlist: [],
      inviteAllowlist: [],
      linkDomains: [],
    };
    const attachments = [{ fileName: 'setup.exe', contentType: 'text/plain', sizeBytes: 4096 }];

    const recorded: { trace?: MatchTrace; categoryId?: string; snippet?: string } = {};
    const subscriber = createAutomodSubscriber({
      ...fakeDeps(),
      listRules: () => [rule],
      recordCaseEvent: (input) => {
        recorded.trace = input.trace;
        recorded.categoryId = input.matchedCategory;
        recorded.snippet = input.matchedSnippet;
      },
    });
    await subscriber.handle(
      messageEvent({ content: 'have a look', attachments, receivedAtMs: 1_000 }),
    );

    const report = runDryRun({
      guildId: GUILD_ID,
      rule,
      fixtures: [
        {
          fixtureId: '444444444444444444:abcdef0123456789',
          content: 'have a look',
          authorId: AUTHOR,
          label: 'unlabelled',
          source: 'observed',
          createdAt: 1_000,
          attachments,
        },
      ],
    });

    const replayed = report.results[0]?.match;
    expect(replayed).toBeDefined();
    expect(recorded.trace).toBeDefined();
    expect(replayed?.trace).toEqual(recorded.trace);
    expect(replayed?.categoryId).toEqual(recorded.categoryId);
    expect(replayed?.snippet).toEqual(recorded.snippet);
    // And it is a real match on both sides, not two identical nothings — a
    // comparison of two undefineds would pass under every implementation.
    expect(replayed?.trace.kind).toBe('attachment_type');
  });

  /**
   * Obligation 1 of the Slice 4 handoff: the gate above compares a single
   * message, so it cannot see either of Slice 4's two blind spots — a wrong
   * `atMs`, or a bypassed predicate cache — because nothing before this slice
   * read the clock or carried state across messages. `rapid_spam` reads both.
   *
   * PR-25 governs the two cases below: a differential gate only detects
   * *asymmetric* divergence, and only a sequence whose messages are spread
   * beyond the window can distinguish a correct replay clock from a wrong
   * one — a clustered burst produces the same verdict either way.
   */
  const rapidSpamRule = (ruleId: string): AutomodRule => ({
    ruleId,
    kind: 'rapid_spam',
    mode: 'test',
    config: '{"maxMessages":3,"windowMs":10000}',
    terms: [],
    allowlist: [],
    inviteAllowlist: [],
    linkDomains: [],
  });

  it('Case A — a rapid_spam burst clustered inside the window matches on both paths, and at the same message', async () => {
    const rule = rapidSpamRule('rapid-spam-case-a');
    const TIMESTAMPS = [1_000, 2_000, 3_000, 4_000];

    // Live path: one subscriber, four sequential handle() calls. The
    // instance-held predicateCache (`createAutomodSubscriber`'s closure) is
    // what lets the window's count carry across all four.
    let currentMs = 0;
    const liveMatchedAt: number[] = [];
    const subscriber = createAutomodSubscriber({
      ...fakeDeps(),
      listRules: () => [rule],
      recordCaseEvent: () => {
        liveMatchedAt.push(currentMs);
      },
    });
    for (const ms of TIMESTAMPS) {
      currentMs = ms;
      await subscriber.handle(
        messageEvent({ content: 'hello', receivedAtMs: ms, messageId: `live-a-${String(ms)}` }),
      );
    }
    // Not merely "something matched" — the fourth message specifically, the
    // "one too many" one. Two identical nothings would pass under every
    // implementation, including a broken cache.
    expect(liveMatchedAt).toEqual([4_000]);

    // Dry-run path: the same four timestamps as fixtures, replayed.
    const fixtures = TIMESTAMPS.map((ms) =>
      fixture({ fixtureId: `rapid-a:${String(ms)}`, content: 'hello', createdAt: ms }),
    );
    const report = runDryRun({ guildId: GUILD_ID, rule, fixtures });

    expect(report.results.map((r) => r.matched)).toEqual([false, false, false, true]);
    expect(report.results[3]?.fixtureId).toBe('rapid-a:4000');
    expect(report.matched).toBe(1);
  });

  it('Case B — a rapid_spam sequence spread beyond the window matches on neither path', async () => {
    const rule = rapidSpamRule('rapid-spam-case-b');
    // Each message ages out of the 10 000 ms window before the next one
    // arrives, so the correct answer on both paths is no match anywhere.
    // This is the shape PR-25 requires: a clustered `Date.now()` replay would
    // wrongly agree with a clustered burst (Case A), so only a spread-out
    // sequence like this one can catch a wrong clock.
    const TIMESTAMPS = [1_000, 20_000, 40_000, 60_000];

    const liveMatched: number[] = [];
    const subscriber = createAutomodSubscriber({
      ...fakeDeps(),
      listRules: () => [rule],
      recordCaseEvent: () => {
        liveMatched.push(1);
      },
    });
    for (const ms of TIMESTAMPS) {
      await subscriber.handle(
        messageEvent({ content: 'hello', receivedAtMs: ms, messageId: `live-b-${String(ms)}` }),
      );
    }
    expect(liveMatched).toEqual([]);

    const fixtures = TIMESTAMPS.map((ms) =>
      fixture({ fixtureId: `rapid-b:${String(ms)}`, content: 'hello', createdAt: ms }),
    );
    const report = runDryRun({ guildId: GUILD_ID, rule, fixtures });

    expect(report.results.map((r) => r.matched)).toEqual([false, false, false, false]);
    expect(report.matched).toBe(0);
  });
});

describe('runDryRun', () => {
  it('is deterministic across runs, and recompiles fresh rather than sharing a cache (ADR 0041 §6)', () => {
    // IMPORTANT-6: comparing two `runDryRun(...)` reports for equality
    // cannot prove per-run isolation on its own. With `keyword_filter` —
    // whose compiled artifact is an immutable `obscenity` matcher — report
    // equality holds whether or not the cache is shared across runs.
    // Verified by breaking it: replacing the per-run `createPredicateCache()`
    // inside `runDryRun` with a module-level shared one left all nine tests
    // in this file green, this one included.
    //
    // The spy on `compileRule` is what actually distinguishes "fresh cache
    // per run" from "reused across runs": a shared cache compiles once,
    // ever, no matter how many runs follow; a fresh cache recompiles every
    // run. That is exactly the property the window tier (Slice 4) needs —
    // its sliding-window state must not leak between runs.
    const spy = vi.spyOn(registry, 'compileRule');
    const args = { guildId: GUILD_ID, rule: ruleWith(['badword']), fixtures: FIXTURES };

    const first = runDryRun(args);
    expect(spy).toHaveBeenCalledTimes(1);

    const second = runDryRun(args);
    expect(spy).toHaveBeenCalledTimes(2);

    expect(first).toEqual(second);
    spy.mockRestore();
  });

  it('replays fixtures oldest first', () => {
    const rule = ruleWith(['badword']);
    // Deliberately passed out of order; the ids sort oldest-first by
    // `createdAt` so the assertion can check `results` came back that way.
    const shuffled = [...FIXTURES].reverse();
    const report = runDryRun({ guildId: GUILD_ID, rule, fixtures: shuffled });

    expect(report.results.map((r) => r.fixtureId)).toEqual(
      [...FIXTURES].sort((a, b) => a.createdAt - b.createdAt).map((f) => f.fixtureId),
    );
  });

  /**
   * The behavioural gate above has a ceiling, and it is worth naming rather
   * than discovering in Slice 4.
   *
   * It compares two real matches, so it can only detect a divergence in a
   * field some shipped predicate actually reads. `keyword_filter` is the only
   * one, and it reads `content`. So the gate catches a mangled `content` or a
   * dropped trace — verified — but a reviewer probing it found three
   * divergences it does **not** catch: a wrong `atMs`, a bypassed predicate
   * cache, and a hand-built `PredicateInput` that skips
   * `predicateInputFrom`'s mention and attachment reconstruction. All three
   * stay green today because nothing reads those fields yet, and all three
   * become live the moment the window tier ships.
   *
   * This test closes that gap from the other side. Rather than comparing
   * behaviour, it asserts the *structure* ADR 0041 §3 actually specifies:
   * that this module builds no `PredicateInput` of its own and performs no
   * evaluation of its own, and — closing the "bypassed predicate cache" gap
   * named above (IMPORTANT-6) — that it gets that cache from
   * `createPredicateCache()` in its own body rather than from a module-level
   * one a future edit could hoist out and share across runs. That is
   * checkable now, holds for fields no predicate has read yet, and fails the
   * moment someone inlines a second construction site or a shared cache —
   * which is precisely the drift the behavioural gate cannot see.
   *
   * Source-level assertions are an established shape here:
   * `packages/core/src/boundaries.test.ts` runs ESLint over sources to prove
   * the import boundaries are enforced rather than merely intended.
   */
  it('builds no PredicateInput of its own — the one-code-path invariant, structurally', () => {
    const source = readFileSync(new URL('./dry-run.ts', import.meta.url), 'utf8');

    // The two fields only a hand-rolled `PredicateInput` would ever set.
    // `predicateInputFrom` is the one place either belongs.
    expect(source).not.toMatch(/\beventKind\s*:/);
    expect(source).not.toMatch(/\batMs\s*:/);

    // And it must reach the shared path rather than the registry directly:
    // calling `compileRule` here would be a second evaluation site even if
    // every field of the input were correct.
    expect(source).toMatch(/predicateInputFrom/);
    expect(source).toMatch(/evaluateRule/);
    expect(source).not.toMatch(/\bcompileRule\b/);

    // And the cache itself must be constructed inside `runDryRun`, not
    // hoisted to module scope — a shared cache is exactly the drift
    // ADR 0041 §6 forbids, and the behavioural determinism test above cannot
    // see it while `keyword_filter` is the only predicate (IMPORTANT-6).
    expect(source).toMatch(/createPredicateCache\(/);
  });

  it('takes each fixture’s clock from its own created_at', () => {
    // `atMs` is genuinely unobservable through `DryRunReport` while
    // `keyword_filter` is the only predicate — it does not branch on the
    // clock, so no assertion on a report can distinguish a correct `atMs`
    // from a hardcoded one. An earlier version of this test asserted
    // `matched === true` and called that clock coverage; it passed with
    // `atMs` hardcoded to 0, which makes it decorative.
    //
    // The real, falsifiable coverage lives one layer down, on the function
    // that sets the field: `evaluate.test.ts`'s "takes the replay clock from
    // the fixture, never from the wall clock" asserts
    // `predicateInputFrom(...).atMs` directly and does go red when `atMs` is
    // hardcoded. What is left here is the ordering guarantee that clock
    // drives, which *is* observable from a report.
    const rule = ruleWith(['badword']);
    const out = runDryRun({
      guildId: GUILD_ID,
      rule,
      fixtures: [
        fixture({ fixtureId: '9:cccc', content: 'third badword', createdAt: 3_000 }),
        fixture({ fixtureId: '9:aaaa', content: 'first badword', createdAt: 1_000 }),
        fixture({ fixtureId: '9:bbbb', content: 'second badword', createdAt: 2_000 }),
      ],
    });

    expect(out.results.map((r) => r.fixtureId)).toEqual(['9:aaaa', '9:bbbb', '9:cccc']);
  });

  it('counts a should_not_match fixture that matched as a false positive', () => {
    const rule = ruleWith(['badword']);
    const report = runDryRun({ guildId: GUILD_ID, rule, fixtures: FIXTURES });

    // Fixture 4 is labelled should_not_match but contains "badword".
    const hit = report.results.find((r) => r.fixtureId === '4:dddd');
    expect(hit?.matched).toBe(true);
    expect(hit?.agreement).toBe('disagreed');
    expect(report.falsePositives).toBe(1);
  });

  it('counts a should_match fixture that did not match as a false negative', () => {
    const rule = ruleWith(['badword']);
    const report = runDryRun({ guildId: GUILD_ID, rule, fixtures: FIXTURES });

    // Fixture 5 is labelled should_match but contains no configured term.
    const miss = report.results.find((r) => r.fixtureId === '5:eeee');
    expect(miss?.matched).toBe(false);
    expect(miss?.agreement).toBe('disagreed');
    expect(report.falseNegatives).toBe(1);
  });

  it('marks an unlabelled fixture as neither, rather than guessing', () => {
    // The corpus is mostly unlabelled during the window; counting an
    // unlabelled non-match as a success would make every rule look perfect
    // on day one.
    const rule = ruleWith(['badword']);
    const report = runDryRun({ guildId: GUILD_ID, rule, fixtures: FIXTURES });

    const clean = report.results.find((r) => r.fixtureId === '1:aaaa');
    expect(clean?.matched).toBe(false);
    expect(clean?.agreement).toBe('unlabelled');
    expect(report.falsePositives).toBe(1);
    expect(report.falseNegatives).toBe(1);
  });

  it('reports an unusable rule instead of reporting zero matches', () => {
    // ADR 0040 §4's failure mode, in the dry run: a rule that cannot compile
    // matches nothing, and "0 matches" reads exactly like a well-behaved
    // rule. `usable: false` and the reason are what stop an operator
    // concluding the rule is clean.
    const report = runDryRun({ guildId: GUILD_ID, rule: ruleWith([]), fixtures: FIXTURES });
    expect(report.usable).toBe(false);
    expect(report.failure?.reason).toBe('no-terms');
    expect(report.matched).toBe(0);
  });

  describe('a predicate that throws (CRITICAL-1, IMPORTANT-5)', () => {
    // `node:vm`'s timeout is *designed* to throw at evaluate time (plan
    // ruling PR-12), so this is not a hypothetical: `regex` is the first
    // predicate that does it. Forcing it here through a `compileRule` spy
    // rather than an actual catastrophic-backtracking pattern keeps this
    // suite fast — `regex.test.ts`'s Obligation 1 gate already proves the
    // real thing takes multiple seconds.
    const throwingCompile = (): ReturnType<typeof registry.compileRule> => ({
      ok: true,
      compiled: {
        evaluate: () => {
          throw new Error('boom');
        },
      },
    });

    it('scores a fixture the predicate threw on as unlabelled, never agreed, and counts the throw', () => {
      const spy = vi.spyOn(registry, 'compileRule').mockImplementation(throwingCompile);
      try {
        const rule = ruleWith(['badword']);
        // FIXTURES has both a should_match and a should_not_match fixture;
        // before this fix a throw was folded into `matched: false`, which
        // scores a should_not_match fixture 'agreed' — exactly the false
        // reassurance CRITICAL-1 is about.
        const report = runDryRun({ guildId: GUILD_ID, rule, fixtures: FIXTURES });

        expect(report.threw).toBeGreaterThan(0);
        for (const result of report.results) {
          expect(result.outcome).toBe('threw');
          expect(result.matched).toBe(false);
          expect(result.match).toBeUndefined();
          expect(result.agreement).toBe('unlabelled');
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('does not count a thrown fixture as a false negative or a false positive', () => {
      // Re-review residual 1. CRITICAL-1's fix hardened `agreement` so a
      // thrown fixture is never 'agreed'/'disagreed', and stopped there: the
      // sibling `falsePositives`/`falseNegatives` tallies still keyed on
      // `matched`, which is `false` for a throw. So a `should_match` fixture
      // that *threw* was counted as a miss it never actually took.
      //
      // The human-facing CLI text is unaffected (`automod dryrun` returns on
      // `threw > 0` before printing a summary), which is precisely why this
      // needs a test: the wrong number survives in `data.falseNegatives`,
      // and Slice 6's false-positive gate is a *machine* reader of exactly
      // that field. A rate computed over fixtures the predicate never
      // actually judged is the ADR 0039 shape wearing yet another coat.
      const spy = vi.spyOn(registry, 'compileRule').mockImplementation(throwingCompile);
      try {
        const report = runDryRun({
          guildId: GUILD_ID,
          rule: ruleWith(['badword']),
          fixtures: FIXTURES,
        });

        // FIXTURES carries both a should_match and a should_not_match
        // fixture, which is the ambiguity this needs: with only one label
        // present, one of the two tallies would read 0 under the bug too.
        expect(FIXTURES.some((f) => f.label === 'should_match')).toBe(true);
        expect(FIXTURES.some((f) => f.label === 'should_not_match')).toBe(true);

        expect(report.threw).toBeGreaterThan(0);
        expect(report.falseNegatives).toBe(0);
        expect(report.falsePositives).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('abandons the replay after five throws rather than paying the whole corpus (IMPORTANT-5)', () => {
      const spy = vi.spyOn(registry, 'compileRule').mockImplementation(throwingCompile);
      try {
        const rule = ruleWith(['badword']);
        const corpus = Array.from({ length: 20 }, (_, i) =>
          fixture({
            fixtureId: `many:${String(i)}`,
            content: `fixture ${String(i)}`,
            createdAt: i,
          }),
        );
        const report = runDryRun({ guildId: GUILD_ID, rule, fixtures: corpus });

        // Exactly five throws, and evaluation stopped there — not 20.
        expect(report.threw).toBe(5);
        expect(report.total).toBe(5);
        // But the corpus that exists is still reported, so an operator can
        // tell the run was abandoned rather than having replayed everything.
        expect(report.corpusSize).toBe(20);
      } finally {
        spy.mockRestore();
      }
    });

    it('does not abandon a run where the predicate throws on fewer than five fixtures', () => {
      // Abandonment must be triggered by the throw count, not merely by any
      // throw occurring — a single malformed fixture must not truncate an
      // otherwise-informative replay of the rest of the corpus.
      //
      // `compileRule` is memoised per rule fingerprint (`evaluate.ts`), so it
      // is called once for this whole run and its `compiled.evaluate` reused
      // for every fixture — the mock has to vary its *own* behaviour per
      // call to produce "some throw, some do not", rather than varying which
      // `compileRule` call wins.
      let evaluations = 0;
      const spy = vi.spyOn(registry, 'compileRule').mockReturnValue({
        ok: true,
        compiled: {
          evaluate: () => {
            evaluations += 1;
            if (evaluations <= 2) throw new Error('boom');
            return undefined;
          },
        },
      });
      try {
        const rule = ruleWith(['badword']);
        const report = runDryRun({ guildId: GUILD_ID, rule, fixtures: FIXTURES });
        expect(report.threw).toBe(2);
        // Not abandoned: every fixture in the 5-fixture corpus was still
        // evaluated, because two throws is below `MAX_THROWS_BEFORE_ABANDON`.
        expect(report.total).toBe(FIXTURES.length);
        expect(report.corpusSize).toBe(FIXTURES.length);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
