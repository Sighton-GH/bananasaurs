import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createNativeAutomodSubscriber,
  parseGuildId,
  parseSnowflakeId,
  Pipeline,
} from '@bananasaurs/core';
import {
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
const MEMBER_ID = parseSnowflakeId('444444444444444444');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let pipeline: Pipeline;

/** Wires the native-automod subscriber onto the pipeline, exactly as `guild.ts` will. */
const buildPipeline = (): Pipeline => {
  const nativeAutomodPorts = nativeAutomodPortsFor(scope, logger, () => discord.now());

  return new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: {
      firstSight: (input) => pipelineRepo.recordFirstSight(scope, input),
    },
    subscribers: [createNativeAutomodSubscriber(nativeAutomodPorts)],
    leaveGuild: async () => undefined,
    logger,
  });
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
