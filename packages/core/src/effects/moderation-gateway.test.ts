import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { authorize, type Actor, type Authorized, type AuthzStore } from '../authz.js';
import type {
  DiscordMember,
  DiscordMessageRef,
  DiscordPort,
  DiscordRole,
  Snowflake,
} from '../discord/port.js';
import { DiscordApiError } from '../discord/errors.js';
import { parseGuildId, parseSnowflakeId } from '../ids.js';
import {
  ModerationActionGateway,
  type ModerationGatewayDeps,
  type ModerationIntent,
} from './moderation-gateway.js';

/**
 * `ModerationActionGateway` is `EffectGateway` (`gateway.test.ts`'s sibling,
 * `packages/testkit/src/gateway.integration.test.ts`) with the target
 * narrowed from a role to a member. It cannot reuse `FakeDiscord` — that fake
 * lives in `packages/testkit`, which depends on `core`, not the other way
 * round (ADR 0014) — so this file carries its own minimal `DiscordPort` fake,
 * exercising only the handful of methods this gateway actually calls.
 */

const GUILD = parseGuildId('111111111111111111');
const USER = parseSnowflakeId('222222222222222222');
const ACTOR_ROLE = parseSnowflakeId('444444444444444444');
const MEMBER_ROLE = parseSnowflakeId('555555555555555555');

const logger = pino({ level: 'silent' });

const actor: Actor = { type: 'member', id: USER, roleIds: [ACTOR_ROLE] };

const permissiveAuthz: AuthzStore = { hasGrant: () => true };

const witnessFor = (store: AuthzStore = permissiveAuthz): Authorized<'moderation.act'> => {
  const result = authorize({ store, guildId: GUILD, actor }, 'moderation.act');
  if (!result.ok) throw new Error('test setup: expected authorization to succeed');
  return result.value;
};

interface FakeCall {
  method: string;
  args: readonly unknown[];
}

/**
 * The narrow slice of `DiscordPort` this gateway touches: the live hierarchy
 * fetch (mirrors `EffectGateway`'s layer 7) and the two moderation verbs.
 * Every other method throws — a call to one would mean this gateway reached
 * outside its documented surface.
 */
class MinimalModerationDiscord implements DiscordPort {
  async deferUpdate(): Promise<void> {
    throw new Error('not used');
  }
  async showModal(): Promise<void> {
    throw new Error('not used');
  }

  calls: FakeCall[] = [];
  private roles: DiscordRole[];
  private botPosition: number;
  private member: DiscordMember;

  constructor(opts: { botPosition: number; member: DiscordMember; roles: DiscordRole[] }) {
    this.botPosition = opts.botPosition;
    this.member = opts.member;
    this.roles = opts.roles;
  }

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }
  callsFor(method: string): readonly FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async fetchMember(): Promise<DiscordMember> {
    this.record('fetchMember', []);
    return this.member;
  }
  async fetchRoles(): Promise<readonly DiscordRole[]> {
    this.record('fetchRoles', []);
    return this.roles;
  }
  async fetchBotHighestRolePosition(): Promise<number> {
    this.record('fetchBotHighestRolePosition', []);
    return this.botPosition;
  }
  async timeoutMember(
    guildId: Snowflake,
    userId: Snowflake,
    durationMs: number,
    reason: string,
  ): Promise<void> {
    this.record('timeoutMember', [guildId, userId, durationMs, reason]);
  }
  async kickMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    this.record('kickMember', [guildId, userId, reason]);
  }
  async banMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    this.record('banMember', [guildId, userId, reason]);
  }
  async unbanMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    this.record('unbanMember', [guildId, userId, reason]);
  }
  async untimeoutMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    this.record('untimeoutMember', [guildId, userId, reason]);
  }

  // --- unused by this gateway: any call here is a gateway that reached
  // outside its documented surface. -------------------------------------
  private notUsed(method: string): never {
    throw new Error(`ModerationActionGateway is not expected to call DiscordPort.${method}`);
  }
  async addRole(): Promise<void> {
    this.notUsed('addRole');
  }
  async removeRole(): Promise<void> {
    this.notUsed('removeRole');
  }
  async fetchMessage(): Promise<{ exists: true }> {
    this.notUsed('fetchMessage');
  }
  async listPublicThreads(): Promise<never> {
    this.notUsed('listPublicThreads');
  }
  async isThreadMember(): Promise<never> {
    this.notUsed('isThreadMember');
  }
  async fetchThreadInfo(): Promise<never> {
    this.notUsed('fetchThreadInfo');
  }
  async fetchMessageMeta(): Promise<never> {
    this.notUsed('fetchMessageMeta');
  }
  async pinMessage(): Promise<void> {
    this.notUsed('pinMessage');
  }
  async unpinMessage(): Promise<void> {
    this.notUsed('unpinMessage');
  }
  async deleteOwnReaction(): Promise<void> {
    this.notUsed('deleteOwnReaction');
  }
  async createThread(): Promise<never> {
    this.notUsed('createThread');
  }
  async addThreadMember(): Promise<void> {
    this.notUsed('addThreadMember');
  }
  async removeThreadMember(): Promise<void> {
    this.notUsed('removeThreadMember');
  }
  async createForumPost(): Promise<never> {
    this.notUsed('createForumPost');
  }
  async setThreadState(): Promise<void> {
    this.notUsed('setThreadState');
  }
  async createRole(): Promise<never> {
    this.notUsed('createRole');
  }
  async setRolePosition(): Promise<void> {
    this.notUsed('setRolePosition');
  }
  async editRole(): Promise<void> {
    this.notUsed('editRole');
  }
  async fetchMessageAuthor(): Promise<never> {
    this.notUsed('fetchMessageAuthor');
  }
  async listScheduledEvents(): Promise<never> {
    this.notUsed('listScheduledEvents');
  }
  async createScheduledEvent(): Promise<never> {
    this.notUsed('createScheduledEvent');
  }
  async editScheduledEvent(): Promise<void> {
    this.notUsed('editScheduledEvent');
  }
  async cancelScheduledEvent(): Promise<void> {
    this.notUsed('cancelScheduledEvent');
  }
  async createReaction(): Promise<void> {
    this.notUsed('createReaction');
  }
  async fetchReactionUsers(): Promise<never> {
    this.notUsed('fetchReactionUsers');
  }
  async sendMessage(): Promise<never> {
    this.notUsed('sendMessage');
  }
  async editMessage(): Promise<void> {
    this.notUsed('editMessage');
  }
  deleteError: Error | undefined = undefined;
  async deleteMessage(guildId: Snowflake, ref: DiscordMessageRef, reason: string): Promise<void> {
    this.record('deleteMessage', [guildId, ref, reason]);
    if (this.deleteError !== undefined) throw this.deleteError;
  }
  async bulkDeleteMessages(): Promise<void> {
    this.notUsed('bulkDeleteMessages');
  }
  async fetchRecentMessages(): Promise<never> {
    this.notUsed('fetchRecentMessages');
  }
  async deferInteraction(): Promise<void> {
    this.notUsed('deferInteraction');
  }
  async respondToInteraction(): Promise<never> {
    this.notUsed('respondToInteraction');
  }
  async editOriginalResponse(): Promise<void> {
    this.notUsed('editOriginalResponse');
  }
  async fetchMessageContent(): Promise<never> {
    this.notUsed('fetchMessageContent');
  }
  async fetchChannelMessages(): Promise<never> {
    this.notUsed('fetchChannelMessages');
  }
  async sendTyping(): Promise<void> {
    this.notUsed('sendTyping');
  }
  async fetchAuditLog(): Promise<never> {
    this.notUsed('fetchAuditLog');
  }
  async leaveGuild(): Promise<void> {
    this.notUsed('leaveGuild');
  }
}

interface SafetyState {
  killswitch: boolean;
  breakerOpen: boolean;
  dryRun: boolean;
}

interface Harness {
  discord: MinimalModerationDiscord;
  gateway: ModerationActionGateway;
  state: SafetyState;
  claimed: Set<string>;
  setState(patch: Partial<SafetyState>): void;
}

const build = (
  opts: {
    botPosition?: number;
    member?: Partial<DiscordMember>;
    deps?: Partial<ModerationGatewayDeps>;
  } = {},
): Harness => {
  const state: SafetyState = { killswitch: false, breakerOpen: false, dryRun: false };
  const member: DiscordMember = {
    userId: USER,
    roleIds: [],
    isGuildOwner: false,
    ...opts.member,
  };
  const discord = new MinimalModerationDiscord({
    botPosition: opts.botPosition ?? 100,
    member,
    roles: [{ id: MEMBER_ROLE, name: 'members', position: 10, managed: false }],
  });
  const claimed = new Set<string>();

  const deps: ModerationGatewayDeps = {
    guildId: GUILD,
    authz: permissiveAuthz,
    discord,
    logger,
    now: () => 1_700_000_000_000,
    state: { read: () => state },
    claims: {
      claim: (dedupeKey) => {
        if (claimed.has(dedupeKey)) return { claimed: false };
        claimed.add(dedupeKey);
        return { claimed: true };
      },
    },
    ...opts.deps,
  };

  return {
    discord,
    gateway: new ModerationActionGateway(deps),
    state,
    claimed,
    setState(patch) {
      Object.assign(state, patch);
    },
  };
};

const intent = (over: Partial<ModerationIntent> = {}): ModerationIntent => ({
  userId: USER,
  action: 'timeout',
  timeoutMs: 60_000,
  dedupeKey: 'dedupe-1',
  reason: 'automod: keyword filter, tier 1',
  ...over,
});

describe('ModerationActionGateway', () => {
  it('applies a timeout and records it', async () => {
    const h = build();
    const outcome = await h.gateway.applyAction(witnessFor(), intent());

    expect(outcome).toEqual({ status: 'applied' });
    expect(h.discord.callsFor('timeoutMember')).toHaveLength(1);
    expect(h.discord.callsFor('timeoutMember')[0]?.args).toEqual([
      GUILD,
      USER,
      60_000,
      'automod: keyword filter, tier 1',
    ]);
  });

  it('refuses against the guild owner without calling Discord, reason discord-owner', async () => {
    const h = build({ member: { isGuildOwner: true } });
    const outcome = await h.gateway.applyAction(witnessFor(), intent());

    expect(outcome).toEqual({ status: 'refused', reason: 'discord-owner' });
    expect(h.discord.callsFor('timeoutMember')).toHaveLength(0);
    expect(h.discord.callsFor('kickMember')).toHaveLength(0);
  });

  it('refuses when the target outranks the bot, reason role-above-bot', async () => {
    // The member's only role sits at position 10; the bot's highest sits at 5.
    const h = build({ botPosition: 5, member: { roleIds: [MEMBER_ROLE] } });
    const outcome = await h.gateway.applyAction(witnessFor(), intent());

    expect(outcome).toEqual({ status: 'refused', reason: 'role-above-bot' });
    expect(h.discord.callsFor('timeoutMember')).toHaveLength(0);
    expect(h.discord.callsFor('kickMember')).toHaveLength(0);
  });

  it('refuses when the kill switch is on, reason killswitch, before any hierarchy check', async () => {
    const h = build();
    h.setState({ killswitch: true });
    const outcome = await h.gateway.applyAction(witnessFor(), intent());

    expect(outcome).toEqual({ status: 'refused', reason: 'killswitch' });
    // No hierarchy fetch at all — the kill switch refuses before the gateway
    // ever asks Discord who the target is.
    expect(h.discord.callsFor('fetchMember')).toHaveLength(0);
    expect(h.discord.callsFor('timeoutMember')).toHaveLength(0);
  });

  it('records dry-run without calling Discord', async () => {
    const h = build();
    h.setState({ dryRun: true });
    const outcome = await h.gateway.applyAction(witnessFor(), intent());

    expect(outcome).toEqual({ status: 'dry-run' });
    expect(h.discord.callsFor('timeoutMember')).toHaveLength(0);
    expect(h.discord.callsFor('kickMember')).toHaveLength(0);
  });

  it('is idempotent: a replayed intent with the same dedupe key is a no-op the second time', async () => {
    const h = build();
    const first = await h.gateway.applyAction(witnessFor(), intent());
    const second = await h.gateway.applyAction(witnessFor(), intent());

    expect(first).toEqual({ status: 'applied' });
    expect(second).toEqual({ status: 'skipped', reason: 'already-applied' });
    expect(h.discord.callsFor('timeoutMember')).toHaveLength(1);
  });

  describe('the ADR 0037 actions', () => {
    it('bans a member through the same hierarchy path as kick', async () => {
      const h = build();
      const outcome = await h.gateway.applyAction(
        witnessFor(),
        intent({ action: 'ban', dedupeKey: 'd-ban', reason: 'mod: confirmed ban' }),
      );

      expect(outcome).toEqual({ status: 'applied' });
      expect(h.discord.callsFor('banMember')).toHaveLength(1);
      expect(h.discord.callsFor('banMember')[0]?.args).toEqual([GUILD, USER, 'mod: confirmed ban']);
    });

    it('refuses to ban the owner: discord-owner, no call', async () => {
      const h = build({ member: { isGuildOwner: true } });
      const outcome = await h.gateway.applyAction(
        witnessFor(),
        intent({ action: 'ban', dedupeKey: 'd-ban-owner' }),
      );

      expect(outcome).toEqual({ status: 'refused', reason: 'discord-owner' });
      expect(h.discord.callsFor('banMember')).toHaveLength(0);
    });

    it('refuses to ban a member above the bot: role-above-bot, no call', async () => {
      const h = build({ botPosition: 5, member: { roleIds: [MEMBER_ROLE] } });
      const outcome = await h.gateway.applyAction(
        witnessFor(),
        intent({ action: 'ban', dedupeKey: 'd-ban-hierarchy' }),
      );

      expect(outcome).toEqual({ status: 'refused', reason: 'role-above-bot' });
      expect(h.discord.callsFor('banMember')).toHaveLength(0);
    });

    /**
     * The one action with no hierarchy block (ADR 0037): the target is not
     * a member — there is no member record to compare roles against — so
     * the gateway must not even ask.
     */
    it('unbans without fetching the member or the roles', async () => {
      const h = build();
      const outcome = await h.gateway.applyAction(
        witnessFor(),
        intent({ action: 'unban', dedupeKey: 'd-unban' }),
      );

      expect(outcome).toEqual({ status: 'applied' });
      expect(h.discord.callsFor('unbanMember')).toHaveLength(1);
      expect(h.discord.callsFor('fetchMember')).toHaveLength(0);
      expect(h.discord.callsFor('fetchRoles')).toHaveLength(0);
      expect(h.discord.callsFor('fetchBotHighestRolePosition')).toHaveLength(0);
    });

    it('untimeouts through the hierarchy path: the target is a member', async () => {
      const h = build();
      const outcome = await h.gateway.applyAction(
        witnessFor(),
        intent({ action: 'untimeout', dedupeKey: 'd-untimeout' }),
      );

      expect(outcome).toEqual({ status: 'applied' });
      expect(h.discord.callsFor('fetchMember')).toHaveLength(1);
      expect(h.discord.callsFor('untimeoutMember')).toHaveLength(1);
    });

    it('refuses to untimeout the owner, like any other member action', async () => {
      const h = build({ member: { isGuildOwner: true } });
      const outcome = await h.gateway.applyAction(
        witnessFor(),
        intent({ action: 'untimeout', dedupeKey: 'd-untimeout-owner' }),
      );

      expect(outcome).toEqual({ status: 'refused', reason: 'discord-owner' });
      expect(h.discord.callsFor('untimeoutMember')).toHaveLength(0);
    });

    it('records a dry-run without calling Discord for every new action', async () => {
      const h = build();
      h.setState({ dryRun: true });
      for (const [action, dedupeKey] of [
        ['ban', 'd-dry-ban'],
        ['unban', 'd-dry-unban'],
        ['untimeout', 'd-dry-untimeout'],
      ] as const) {
        const outcome = await h.gateway.applyAction(witnessFor(), intent({ action, dedupeKey }));
        expect(outcome).toEqual({ status: 'dry-run' });
      }
      expect(h.discord.callsFor('banMember')).toHaveLength(0);
      expect(h.discord.callsFor('unbanMember')).toHaveLength(0);
      expect(h.discord.callsFor('untimeoutMember')).toHaveLength(0);
    });

    it('is idempotent for every new action: the second claim skips', async () => {
      for (const [action, dedupeKey, method] of [
        ['ban', 'd-idem-ban', 'banMember'],
        ['unban', 'd-idem-unban', 'unbanMember'],
        ['untimeout', 'd-idem-untimeout', 'untimeoutMember'],
      ] as const) {
        const h = build();
        const first = await h.gateway.applyAction(witnessFor(), intent({ action, dedupeKey }));
        const second = await h.gateway.applyAction(witnessFor(), intent({ action, dedupeKey }));

        expect(first).toEqual({ status: 'applied' });
        expect(second).toEqual({ status: 'skipped', reason: 'already-applied' });
        expect(h.discord.callsFor(method)).toHaveLength(1);
      }
    });
  });

  describe('deleteMessage (ADR 0141 decision 7)', () => {
    const C = parseSnowflakeId('333333333333333333');
    const M = parseSnowflakeId('666666666666666666');
    const DEDUPE = 'mod:G:delete:intent-1';
    const REASON = 'Deleted from a log card';
    const deleteIntent = () => ({ channelId: C, messageId: M, dedupeKey: DEDUPE, reason: REASON });

    it('refuses when the authz store denies: unauthorized, no claim, no REST call', async () => {
      const h = build({ deps: { authz: { hasGrant: () => false } } });
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'refused', reason: 'unauthorized' });
      expect(h.claimed.size).toBe(0);
      expect(h.discord.callsFor('deleteMessage')).toHaveLength(0);
    });

    it('refuses when the witness guild differs from the gateway guild: unauthorized, no claim, no REST call', async () => {
      // The grant itself is valid (permissive store, authorized actor) — only
      // the guild binding is wrong, so `preflight`'s guild-identity half must
      // refuse before any claim is taken or REST call made.
      const h = build({ deps: { guildId: parseGuildId('999999999999999999') } });
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'refused', reason: 'unauthorized' });
      expect(h.claimed.size).toBe(0);
      expect(h.discord.callsFor('deleteMessage')).toHaveLength(0);
    });

    it('refuses when the guild is unknown: guild-unknown', async () => {
      const h = build({ deps: { state: { read: () => undefined } } });
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'refused', reason: 'guild-unknown' });
      expect(h.claimed.size).toBe(0);
      expect(h.discord.callsFor('deleteMessage')).toHaveLength(0);
    });

    it('refuses when the kill switch is on: killswitch, no REST call', async () => {
      const h = build();
      h.setState({ killswitch: true });
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'refused', reason: 'killswitch' });
      expect(h.claimed.size).toBe(0);
      expect(h.discord.callsFor('deleteMessage')).toHaveLength(0);
    });

    it('refuses when the breaker is open: breaker-open', async () => {
      const h = build();
      h.setState({ breakerOpen: true });
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'refused', reason: 'breaker-open' });
      expect(h.claimed.size).toBe(0);
      expect(h.discord.callsFor('deleteMessage')).toHaveLength(0);
    });

    it('never fetches the member, the roles or the bot position: no hierarchy layer', async () => {
      const h = build();
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'applied' });
      expect(h.discord.callsFor('fetchMember')).toHaveLength(0);
      expect(h.discord.callsFor('fetchRoles')).toHaveLength(0);
      expect(h.discord.callsFor('fetchBotHighestRolePosition')).toHaveLength(0);
    });

    it('skips when the claim is already taken: already-applied, no REST call', async () => {
      const h = build();
      h.claimed.add(DEDUPE);
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'skipped', reason: 'already-applied' });
      expect(h.discord.callsFor('deleteMessage')).toHaveLength(0);
    });

    it('records a dry run: dry-run, claim taken, no REST call', async () => {
      const h = build();
      h.setState({ dryRun: true });
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'dry-run' });
      expect(h.claimed.has(DEDUPE)).toBe(true);
      expect(h.discord.callsFor('deleteMessage')).toHaveLength(0);
    });

    it('deletes the message with the audit-log reason: applied', async () => {
      const h = build();
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'applied' });
      expect(h.discord.callsFor('deleteMessage')).toHaveLength(1);
      expect(h.discord.callsFor('deleteMessage')[0]?.args).toEqual([
        GUILD,
        { channelId: C, messageId: M },
        REASON,
      ]);
    });

    it('treats an already-deleted message as skipped: message-gone', async () => {
      const h = build();
      h.discord.deleteError = new DiscordApiError(404, 10008, 'Unknown Message');
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'skipped', reason: 'message-gone' });
    });

    it('reports a permission failure: failed with the error name, logged', async () => {
      const errorSpy = vi.fn();
      const h = build({
        deps: {
          logger: {
            warn: logger.warn.bind(logger),
            info: logger.info.bind(logger),
            error: errorSpy,
          } as unknown as typeof logger,
        },
      });
      h.discord.deleteError = new DiscordApiError(403, 50013, 'Missing Permissions');
      const outcome = await h.gateway.deleteMessage(witnessFor(), deleteIntent());

      expect(outcome).toEqual({ status: 'failed', code: 'DiscordApiError' });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({ component: 'moderation-effects' });
    });
  });
});
