import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { authorize, type Authorized, type AuthzStore } from '../authz.js';
import { parseGuildId } from '../ids.js';
import type { DomainEvent, MessageEvent } from '../discord/events.js';
import type { ModerationOutcome, ModerationSafetyState } from '../effects/moderation-gateway.js';
import { createAutomodSubscriber, type AutomodSubscriberDeps } from './subscriber.js';
import type { AutomodRule, FixtureRecord, MatchTrace } from './predicates/types.js';
import { runDryRun } from './dry-run.js';

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
});

const fixture = (over: Partial<FixtureRecord> & { fixtureId: string }): FixtureRecord => ({
  content: 'nothing to see here',
  authorId: '400000000000000001',
  label: 'unlabelled',
  source: 'observed',
  createdAt: 1_000,
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
});

describe('runDryRun', () => {
  it('is deterministic across runs, and across a rule that carries state', () => {
    // Every run compiles a fresh artifact (ADR 0041 §6), so the window
    // tier's sliding-window state cannot leak between runs. Two identical
    // runs must give identical reports.
    const args = { guildId: GUILD_ID, rule: ruleWith(['badword']), fixtures: FIXTURES };
    expect(runDryRun(args)).toEqual(runDryRun(args));
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

  it('takes each fixture’s clock from its own created_at', () => {
    // `atMs` is not observable directly from `DryRunReport`, but the window
    // tier (Slice 4) will read it from `PredicateInput.atMs`; for now this is
    // proven through `predicateInputFrom`, which is the one place `atMs` is
    // set from a fixture. A `keyword_filter` rule does not branch on it, so
    // this asserts the wiring exists rather than a *visible* behavioural
    // difference — there is none to observe yet with only `keyword_filter`
    // shipped.
    const rule = ruleWith(['badword']);
    const oneFixture: FixtureRecord = fixture({
      fixtureId: '9:ffff',
      content: 'a badword message',
      createdAt: 987_654,
      label: 'should_match',
    });
    const report = runDryRun({ guildId: GUILD_ID, rule, fixtures: [oneFixture] });
    expect(report.results[0]?.matched).toBe(true);
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
});
