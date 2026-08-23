import type {
  DiscordMember,
  DiscordMessageRef,
  EmojiKey,
  ReactionUserPage,
  Snowflake,
} from '../discord/port.js';
import type { EffectOutcome, RoleIntent } from '../effects/gateway.js';
import type { EffectSource } from '../effects/rate-limit.js';
import type { PanelConfig } from './model.js';

/**
 * Everything panel code may do to Discord directly: **read state, and add a
 * reaction.** There is no `addRole` and no `removeRole` on this interface.
 *
 * That is the point. `DiscordPort` structurally satisfies this, so the daemon
 * hands over the same object it hands the effect gateway — but the type panel
 * code sees cannot mutate a role, so "panels change roles only through the
 * gateway" is a property of the signature rather than a rule to remember. It is
 * the same shape as the `Authorized` witness: make the mistake unrepresentable,
 * and keep the runtime control (ADR 0014's lint rule, and the gateway's own
 * re-verification) underneath it.
 *
 * `createReaction` is here because seeding a panel's emoji is a panel's job and
 * carries none of the risk role mutation does — the worst outcome is an
 * unwanted emoji on a message.
 */
export interface PanelDiscordReader {
  fetchMember(guildId: Snowflake, userId: Snowflake): Promise<DiscordMember>;
  fetchMessage(guildId: Snowflake, ref: DiscordMessageRef): Promise<{ exists: true }>;
  createReaction(guildId: Snowflake, ref: DiscordMessageRef, emoji: EmojiKey): Promise<void>;
  fetchReactionUsers(
    guildId: Snowflake,
    ref: DiscordMessageRef,
    emoji: EmojiKey,
    options?: { after?: Snowflake | undefined; limit?: number | undefined },
  ): Promise<ReactionUserPage>;
}

/**
 * Panel configuration, already scoped to one guild.
 *
 * The `GuildScope` was captured when the daemon built this, so panel code has
 * no way to name another guild's panels — the same shape `jobStoreFor` uses.
 */
export interface PanelStore {
  findPanelByMessage(channelId: Snowflake, messageId: Snowflake): PanelConfig | undefined;
  findPanel(panelId: string): PanelConfig | undefined;
  listAdoptedPanels(): readonly PanelConfig[];
}

/**
 * The effect side, as a port.
 *
 * `apply` is the effect gateway with its authorization witness already bound,
 * so panel code never holds a witness and cannot forge one. Everything the
 * gateway enforces — kill switch, breaker, panel status, allowlist, protected
 * target, live hierarchy, rate cap, idempotency, dry run — applies to every
 * intent that goes through here.
 */
export interface PanelEffects {
  openBatch(source: EffectSource): string;
  closeBatch(batchId: string): void;
  apply(intent: RoleIntent): Promise<EffectOutcome>;

  /**
   * Provenance, written after the fact: which panel granted this, when, under
   * which effect. **Never read to decide current state** — that is amendment 4,
   * and reading it would be the bug it exists to warn about.
   */
  recordGranted(input: {
    userId: Snowflake;
    roleId: Snowflake;
    panelId: string;
    effectId: string;
    now: number;
  }): void;
  forgetGranted(input: { userId: Snowflake; roleId: Snowflake }): void;
}
