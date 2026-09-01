import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { authorize, type Actor, type Authorized, type AuthzStore } from '../authz.js';
import type { ModerationIntent, ModerationOutcome } from '../effects/moderation-gateway.js';
import { parseGuildId } from '../ids.js';
import { issueWarn, MANUAL_RULE_ID, type WarnCasePorts } from './warn.js';

const GUILD = '111111111111111111';
const MEMBER = '222222222222222222';
const MOD = '333333333333333333';
/** The warn's stable identity — the interaction id the real command passes. */
const WARN_ID = '777777777777777777';

const logger = pino({ level: 'silent' });

interface RecordedEvent {
  eventId: string;
  caseId: string;
  ruleId: string;
  memberId: string;
  at: number;
  matchedCategory: string;
  matchedSnippet: string;
  actionTaken: string;
  escalationAction?: string | undefined;
  refusalReason?: string | undefined;
  actorId: string | undefined;
}

/**
 * A fake `WarnCasePorts` over a tiny in-memory counter, so these tests pin
 * the *sequence* — with the storage-layer equality tests next door. The
 * gateway is faked separately (`ModerationGatewayPort` is a single method).
 */
const harness = (
  opts: {
    initialCount?: number;
    gateway?: (intent: ModerationIntent) => Promise<ModerationOutcome>;
  } = {},
) => {
  let violationCount = opts.initialCount ?? 0;
  const caseId = 'case-1';
  const events: RecordedEvent[] = [];
  const calls: ModerationIntent[] = [];

  const repo: WarnCasePorts = {
    openOrResolveCase: (input) => {
      if (input.countsAsViolation) violationCount += 1;
      return { caseId, violationCount };
    },
    recordCaseEvent: (input) => {
      events.push({ ...input, eventId: input.eventId, memberId: input.memberId });
    },
    nextEscalationTier: (count) => {
      if (count >= 6) return { tier: 2, action: 'kick', timeoutMs: undefined };
      if (count >= 3) return { tier: 1, action: 'timeout', timeoutMs: 600_000 };
      return { tier: 0, action: undefined, timeoutMs: undefined };
    },
    recordEscalationOutcome: (input) => {
      events.push({
        eventId: input.eventId,
        caseId: input.caseId,
        ruleId: input.ruleId,
        memberId: input.memberId,
        at: input.at,
        matchedCategory: input.matchedCategory,
        matchedSnippet: input.matchedSnippet,
        actionTaken: input.actionTaken,
        escalationAction: input.escalationAction,
        refusalReason: input.refusalReason,
        actorId: input.actorId,
      });
    },
  };

  const gateway = {
    applyAction: async (_auth: unknown, intent: ModerationIntent) => {
      calls.push(intent);
      return (opts.gateway ?? (async () => ({ status: 'applied' })))(intent);
    },
  };

  return { repo, gateway, calls, events, count: () => violationCount };
};

const modActor: Actor = { type: 'member', id: MOD, roleIds: [] };
const permissiveAuthz: AuthzStore = { hasGrant: () => true };
const auth: Authorized<'moderation.act'> = (() => {
  const result = authorize(
    { store: permissiveAuthz, guildId: parseGuildId(GUILD), actor: modActor },
    'moderation.act',
  );
  if (!result.ok) throw new Error('test setup: expected authorization to succeed');
  return result.value;
})();

describe('issueWarn — moderator warnings feed the ladder (ADR 0037)', () => {
  it('counts the warn as a violation and records a warned event with the actor', async () => {
    const h = harness();
    const result = await issueWarn(
      { guildId: GUILD, repo: h.repo, moderationGateway: h.gateway, logger },
      {
        guildId: GUILD,
        memberId: MEMBER,
        actorId: MOD,
        warnId: WARN_ID,
        reason: 'be nice',
        now: 1000,
        auth,
      },
    );

    expect(result.violationCount).toBe(1);
    expect(result.escalation).toBeUndefined();
    expect(h.count()).toBe(1);
    expect(h.events[0]).toMatchObject({
      ruleId: MANUAL_RULE_ID,
      memberId: MEMBER,
      at: 1000,
      matchedSnippet: 'be nice',
      actionTaken: 'warned',
      actorId: MOD,
    });
    expect(h.calls).toHaveLength(0);
  });

  it('triggers the ladder when the warn crosses tier 1, applied', async () => {
    const h = harness({ initialCount: 2 });
    const result = await issueWarn(
      { guildId: GUILD, repo: h.repo, moderationGateway: h.gateway, logger },
      {
        guildId: GUILD,
        memberId: MEMBER,
        actorId: MOD,
        warnId: WARN_ID,
        reason: 'third strike',
        now: 1000,
        auth,
      },
    );

    expect(result.violationCount).toBe(3);
    expect(result.escalation).toEqual({ status: 'applied' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.action).toBe('timeout');
    const actionEvents = h.events.filter((e) => e.actionTaken !== 'warned');
    expect(actionEvents[0]?.actionTaken).toBe('manual_applied');
    expect(actionEvents[0]?.escalationAction).toBe('timeout');
  });

  it('records a refused escalation with the reason', async () => {
    const h = harness({
      initialCount: 2,
      gateway: async () => ({ status: 'refused', reason: 'discord-owner' }),
    });
    await issueWarn(
      { guildId: GUILD, repo: h.repo, moderationGateway: h.gateway, logger },
      {
        guildId: GUILD,
        memberId: MEMBER,
        actorId: MOD,
        warnId: WARN_ID,
        reason: 'third strike',
        now: 1000,
        auth,
      },
    );

    const refused = h.events.find((e) => e.actionTaken === 'escalation_refused');
    expect(refused).toMatchObject({ escalationAction: 'timeout', refusalReason: 'discord-owner' });
  });

  it('is idempotent: a replay of the same crossing finds the claim taken and records escalation_skipped', async () => {
    // The dedupe key binds to the crossing warning's stable identity (guild, case, warnId) —
    // assert the shape, then prove a gateway `skipped` becomes the honest
    // `escalation_skipped` event rather than a second applied punishment.
    const claimed = new Set<string>();
    const h = harness({
      initialCount: 2,
      gateway: async (intent) => {
        if (claimed.has(intent.dedupeKey)) return { status: 'skipped', reason: 'already-applied' };
        claimed.add(intent.dedupeKey);
        return { status: 'applied' };
      },
    });
    const deps = { guildId: GUILD, repo: h.repo, moderationGateway: h.gateway, logger };
    const input = {
      guildId: GUILD,
      memberId: MEMBER,
      actorId: MOD,
      warnId: WARN_ID,
      reason: 'third',
      now: 1000,
      auth,
    };

    const first = await issueWarn(deps, input);
    // Replay the crossing under the same (caseId, count) — the second
    // invocation of the same warned member at the same counter is exactly
    // what a replayed dispatch produces.
    const second = await issueWarn(deps, input);

    expect(first.escalation).toEqual({ status: 'applied' });
    expect(second.escalation).toEqual({ status: 'skipped', reason: 'already-applied' });
    expect(h.calls).toHaveLength(2);
    // A resumed-replay of the same warn shares the key even though the counter has advanced.
    expect(h.calls[0]?.dedupeKey).toBe(h.calls[1]?.dedupeKey);
    expect(h.calls[0]?.dedupeKey).toMatch(
      new RegExp(`^mod:${GUILD}:warn-escalation:case-1:${WARN_ID}$`),
    );
    expect(h.events.filter((e) => e.actionTaken === 'manual_applied')).toHaveLength(1);
    expect(h.events.filter((e) => e.actionTaken === 'escalation_skipped')).toHaveLength(1);
  });
});
