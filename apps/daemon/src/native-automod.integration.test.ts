import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createAutomodSubscriber,
  createNativeAutomodSubscriber,
  parseGuildId,
  parseSnowflakeId,
  Pipeline,
} from '@bananasaurs/core';
import {
  automodRuleRepo,
  guildRepo,
  pipelineRepo,
  read,
  schema,
  write,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';
import { nativeAutomodPortsFor } from './automod/native-wiring.js';
import { automodAuthorization, automodGatewayFor, automodPortsFor } from './automod/wiring.js';

/**
 * Native Discord AutoMod observability, end to end on the fake gateway
 * (Task 5, ADR 0038).
 *
 * The pipeline dispatches a real `autoModerationAction`, the native-automod
 * subscriber records it under the `native:` sentinel, and this proves every
 * layer that will run in production except the discord.js adapter itself:
 * the wiring's ports, the pipeline's dedupe gate, and the repository writes.
 * Mirrors `automod.integration.test.ts`'s setup style exactly.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL_ID = parseSnowflakeId('333333333333333333');
const MEMBER_ID = parseSnowflakeId('444444444444444444');

const RULE_ID = 'rule-1';
const CATEGORY_ID = 'cat-1';
const TERM_ID = 'term-1';

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let pipeline: Pipeline;

/**
 * Wires both the automod and the native-automod subscribers onto one
 * pipeline, exactly as `runtime/guild.ts` does (both are always wired
 * together in production — Task 6's property test needs the real ordering,
 * not a narrower fixture).
 */
const buildPipeline = (): Pipeline => {
  const now = () => discord.now();
  const automodGateway = automodGatewayFor(scope, discord, logger, now);
  const automodAuth = automodAuthorization(scope);
  const automodPorts = automodPortsFor(scope, discord, automodGateway, automodAuth, logger, now);
  const nativeAutomodPorts = nativeAutomodPortsFor(scope, logger, now);

  return new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: {
      firstSight: (input) => pipelineRepo.recordFirstSight(scope, input),
    },
    subscribers: [
      createAutomodSubscriber(automodPorts),
      createNativeAutomodSubscriber(nativeAutomodPorts),
    ],
    leaveGuild: async () => undefined,
    logger,
  });
};

/**
 * Lifted from `automod.integration.test.ts`'s `seedRule`, not imported: that
 * module exports no test helpers across files (Task 6 brief). Creates one
 * enabled `keyword_filter` rule, in `enforce` mode, matching `term`.
 */
const seedEnforcingKeywordRule = (term: string): void => {
  automodRuleRepo.createRule(scope, { ruleId: RULE_ID, name: 'test rule', now: discord.now() });
  automodRuleRepo.addCategory(scope, {
    categoryId: CATEGORY_ID,
    ruleId: RULE_ID,
    name: 'test category',
    defaultAction: 'delete_and_case',
  });
  automodRuleRepo.addTerm(scope, { termId: TERM_ID, categoryId: CATEGORY_ID, text: term });
  automodRuleRepo.setRuleMode(scope, { ruleId: RULE_ID, mode: 'enforce', now: discord.now() });
};

function findCase(memberId: string) {
  return read(scope, (db) =>
    db
      .select()
      .from(schema.modCases)
      .where(scope.only(schema.modCases))
      .all()
      .find((row) => row.memberId === memberId),
  );
}

function listCaseEvents(memberId: string) {
  return read(scope, (db) =>
    db
      .select()
      .from(schema.modCaseEvents)
      .where(scope.only(schema.modCaseEvents))
      .all()
      .filter((row) => row.memberId === memberId),
  );
}

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  // docs/18 Layer 4: an unconfigured guild is dry-run. The native subscriber
  // makes no Discord calls, so this is world-building parity with
  // `automod.integration.test.ts`, not a precondition this subscriber reads.
  write(scope, ({ db }) => {
    db.update(schema.guilds).set({ dryRun: 0 }).where(scope.only(schema.guilds)).run();
  });

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  discord.defineMember(MEMBER_ID, []);

  pipeline = buildPipeline();
  // Exactly what the discord.js adapter will do in production: every gateway
  // event goes through the pipeline, allowlist gate and dedupe gate included.
  discord.onEvent(async (event) => {
    await pipeline.dispatch(event);
  });
});

afterEach(() => {
  t.close();
});

describe('native automod, end to end on the fake gateway', () => {
  it('records a native block as a case event under the native sentinel', async () => {
    await discord.emitAutoModerationAction({
      ruleId: '222222222222222222',
      userId: MEMBER_ID,
      matchedKeyword: 'forbidden',
      content: 'a forbidden word',
    });

    const events = listCaseEvents(MEMBER_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ruleId: 'native:222222222222222222',
      actionTaken: 'native_blocked',
      matchedCategory: 'keyword',
      matchedSnippet: 'forbidden',
      actorId: null,
    });
  });

  it('leaves the violation counter at zero', async () => {
    await discord.emitAutoModerationAction({ ruleId: '222222222222222222', userId: MEMBER_ID });
    await discord.emitAutoModerationAction({
      ruleId: '222222222222222222',
      userId: MEMBER_ID,
      content: 'a different forbidden word',
    });

    expect(findCase(MEMBER_ID)?.violationCount).toBe(0);
  });

  it('makes no Discord calls at all', async () => {
    discord.resetCalls();
    await discord.emitAutoModerationAction({ ruleId: '222222222222222222', userId: MEMBER_ID });
    expect(discord.restCalls()).toEqual([]);
  });

  it('records only once when the gateway replays the dispatch', async () => {
    // Reconnects replay (CLAUDE.md rule 6). A blocked message carries no id, so
    // the pipeline's fingerprint is the content fallback — this asserts it
    // holds. The fallback buckets by `Math.floor(receivedAtMs / 60_000)`
    // (`packages/core/src/pipeline/fingerprint.ts`), and `FakeDiscord`'s
    // clock only moves when `advance()` is called — never implicitly between
    // two `emit*` calls — so both emissions below carry the identical
    // `receivedAtMs` and land in the same bucket without needing to reason
    // about a boundary at all.
    const payload = {
      ruleId: '222222222222222222',
      userId: MEMBER_ID,
      matchedKeyword: 'forbidden',
      content: 'a forbidden word',
    };
    await discord.emitAutoModerationAction(payload);
    await discord.emitAutoModerationAction(payload);

    expect(listCaseEvents(MEMBER_ID)).toHaveLength(1);
  });
});

describe('native AutoMod and Bananasaurs do not double-punish (ADR 0038)', () => {
  it('a blocked message produces a native record and no automod evaluation', async () => {
    // Native blocked it, so no messageCreate is ever dispatched — the whole
    // basis of the claim. Emitting only the auto-moderation event *is* the
    // fidelity: the gateway genuinely sends nothing else.
    seedEnforcingKeywordRule('badword');
    discord.resetCalls();

    await discord.emitAutoModerationAction({
      ruleId: '222222222222222222',
      userId: MEMBER_ID,
      matchedKeyword: 'badword',
      content: 'a badword here',
    });

    const events = listCaseEvents(MEMBER_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actionTaken).toBe('native_blocked');
    // No deletion was attempted: our rule never saw the message.
    expect(discord.restCalls('deleteMessage')).toEqual([]);
    expect(findCase(MEMBER_ID)?.violationCount).toBe(0);
  });

  it('an alert-only native rule leaves our rule free to enforce, once', async () => {
    // The one native configuration where both engines see the same content:
    // alert does not block, so the message posts and messageCreate follows.
    // Our rule enforces; native's alert is recorded. Two records, one
    // punishment — which is the behaviour, not a bug.
    //
    // 'badword' rather than the brief's 'forbidden': `obscenity`'s
    // `collapseDuplicatesTransformer` (`englishRecommendedTransformers`)
    // collapses a doubled letter in the *input* before matching but not in a
    // `parseRawPattern`-compiled term unless that letter is one of the six
    // custom-thresholded ones (b/e/o/l/s/g); 'forbidden' has a doubled 'd',
    // outside that set, so it silently never matches — confirmed directly
    // against `obscenity`, independent of anything this task changed.
    // 'badword' is `automod.integration.test.ts`'s own proven fixture term.
    seedEnforcingKeywordRule('badword');
    discord.resetCalls();

    await discord.emitAutoModerationAction({
      ruleId: '222222222222222222',
      userId: MEMBER_ID,
      actionType: 'alert',
      alertMessageId: '888888888888888888',
      messageId: '555555555555555555',
      matchedKeyword: 'badword',
      content: 'a badword here',
    });
    await discord.emitMessageCreate({
      channelId: CHANNEL_ID,
      messageId: '555555555555555555',
      authorId: MEMBER_ID,
      content: 'a badword here',
    });

    const taken = listCaseEvents(MEMBER_ID)
      .map((e) => e.actionTaken)
      .sort();
    expect(taken).toEqual(['deleted', 'native_alerted']);
    expect(discord.restCalls('deleteMessage')).toHaveLength(1);
  });
});
