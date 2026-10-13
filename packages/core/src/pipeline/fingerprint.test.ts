import { describe, expect, it } from 'vitest';
import { fingerprintOf, isLevelTriggered } from './fingerprint.js';
import type {
  AuditLogEntryEvent,
  AutoModerationEvent,
  ConnectionEvent,
  DomainEvent,
  GuildEvent,
  InteractionEvent,
  MemberEvent,
  MessageEvent,
  ReactionEvent,
  RoleEvent,
  SlashCommandEvent,
} from '../discord/events.js';

/**
 * Helpers take `Partial<XEvent>` rather than `Partial<Extract<DomainEvent, {
 * kind: 'memberAdd' }>>`. The Extract form looks right and resolves to `never`,
 * because `MemberEvent['kind']` is itself a union and so `MemberEvent` is not
 * assignable to `{ kind: 'memberAdd' }`. Vitest ran happily against it — types
 * are erased — while `tsc` and eslint both failed. Worth remembering: a green
 * suite is not evidence the types are right.
 */

const GUILD = '111111111111111111';
const base = { guildId: GUILD, receivedAtMs: 1_700_000_000_000 };

const interaction = (over: Partial<InteractionEvent> = {}): DomainEvent => ({
  ...base,
  kind: 'interaction',
  interactionId: '900000000000000001',
  token: 'tok-900000000000000001',
  channelId: '222222222222222222',
  messageId: '333333333333333333',
  userId: '444444444444444444',
  customId: 'panel:opt',
  ...over,
});

const messageEvent = (
  kind: MessageEvent['kind'],
  over: Partial<MessageEvent> = {},
): DomainEvent => ({
  ...base,
  kind,
  channelId: '222222222222222222',
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageId: '333333333333333333',
  authorId: '444444444444444444',
  authorDisplayName: undefined,
  authorIsBot: false,
  content: undefined,
  editedTimestampMs: undefined,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

const member = (kind: MemberEvent['kind'], over: Partial<MemberEvent> = {}): DomainEvent => ({
  ...base,
  kind,
  userId: '444444444444444444',
  roleIds: [],
  previousRoleIds: undefined,
  joinedAtMs: undefined,
  ...over,
});

const reaction = (kind: ReactionEvent['kind']): DomainEvent => ({
  ...base,
  kind,
  channelId: '222222222222222222',
  messageId: '333333333333333333',
  userId: '444444444444444444',
  emoji: 'u:1f9e0',
  wasPartial: false,
});

const role = (kind: RoleEvent['kind'], roleId = '555555555555555555'): DomainEvent => ({
  ...base,
  kind,
  roleId,
  name: 'a-role',
});

const guildEvent = (kind: GuildEvent['kind']): DomainEvent => ({ ...base, kind });

const connection = (over: Partial<ConnectionEvent> = {}): DomainEvent => ({
  ...base,
  kind: 'connection',
  resumed: false,
  disconnectedAtMs: 1,
  ...over,
});

describe('interactions carry a real id', () => {
  it('uses it directly rather than hashing it', () => {
    expect(fingerprintOf(interaction())).toBe('900000000000000001');
  });

  it('distinguishes two clicks by the same user on the same component', () => {
    // Every click gets its own interaction id, which is what makes this the
    // one event kind that is genuinely, reliably unique.
    expect(fingerprintOf(interaction({ interactionId: '900000000000000002' }))).not.toBe(
      fingerprintOf(interaction()),
    );
  });

  /**
   * A slash command is an interaction too, and gets the same treatment: a
   * replayed `INTERACTION_CREATE` after a reconnect must not answer the member
   * twice. It is deliberately **not** level-triggered — unlike a reaction, there
   * is no state to reconverge toward, so a second dispatch is a duplicate rather
   * than a fresh hint.
   */
  it('deduplicates a slash command on its interaction id', () => {
    const slash = (over: Partial<SlashCommandEvent> = {}): DomainEvent => ({
      ...base,
      kind: 'slashCommand',
      interactionId: '900000000000000003',
      token: 'tok-900000000000000003',
      commandName: 'status',
      subcommandPath: [],
      options: [],
      channelId: '222222222222222222',
      userId: '444444444444444444',
      ...over,
    });

    expect(fingerprintOf(slash())).toBe('900000000000000003');
    expect(fingerprintOf(slash())).toBe(fingerprintOf(slash()));
    expect(fingerprintOf(slash({ interactionId: '900000000000000004' }))).not.toBe(
      fingerprintOf(slash()),
    );
    expect(isLevelTriggered(slash())).toBe(false);
  });
});

describe('message edits', () => {
  it('are the same event when the edit timestamp matches', () => {
    const a = messageEvent('messageUpdate', { editedTimestampMs: 1_700_000_000_500 });
    const b = messageEvent('messageUpdate', { editedTimestampMs: 1_700_000_000_500 });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('are different events when the message was edited again', () => {
    const first = messageEvent('messageUpdate', { editedTimestampMs: 1_700_000_000_500 });
    const second = messageEvent('messageUpdate', { editedTimestampMs: 1_700_000_001_500 });
    expect(fingerprintOf(first)).not.toBe(fingerprintOf(second));
  });
});

describe('message deletions', () => {
  it('are terminal, so the message id alone identifies them', () => {
    expect(fingerprintOf(messageEvent('messageDelete'))).toBe(
      fingerprintOf(messageEvent('messageDelete')),
    );
  });

  it('do not collide with an edit of the same message', () => {
    expect(fingerprintOf(messageEvent('messageDelete'))).not.toBe(
      fingerprintOf(messageEvent('messageUpdate')),
    );
  });
});

describe('message creations', () => {
  it('are terminal, so the message id alone identifies them', () => {
    expect(fingerprintOf(messageEvent('messageCreate'))).toBe(
      fingerprintOf(messageEvent('messageCreate')),
    );
  });

  it('distinguishes two different messages', () => {
    const a = messageEvent('messageCreate', { messageId: '333333333333333333' });
    const b = messageEvent('messageCreate', { messageId: '333333333333333334' });
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
  });

  it('is not level-triggered — a replayed MESSAGE_CREATE must not double-count', () => {
    // The automod subscriber increments a per-member violation counter with no
    // idempotency guard of its own, relying on the pipeline to drop a
    // gateway-reconnect replay before it gets there.
    expect(isLevelTriggered(messageEvent('messageCreate'))).toBe(false);
  });

  it('pins the messageCreate digest, as a smoke test only', () => {
    // `messageCreate` hashes a single part (the message id), so
    // `Array.prototype.join` never touches its separator here — this pin
    // cannot detect a change to how `digest()` joins multiple parts. Kept as
    // a cheap smoke test for the messageCreate case specifically; the
    // separator itself is guarded by the multi-part pins below
    // ('roles' and 'autoModerationAction fingerprints'), not by this one.
    expect(fingerprintOf(messageEvent('messageCreate'))).toBe(
      'bb07f2abd24d01dd1bdebd9bfe8fed436138f83461a13323b5695f1974560e79',
    );
  });
});

describe('message bulk deletions', () => {
  it('fingerprints the channel and the sorted set of ids', () => {
    const bulk = (channelId: string, messageIds: readonly string[]): DomainEvent => ({
      ...base,
      kind: 'messageDeleteBulk',
      channelId,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageIds,
    });
    expect(fingerprintOf(bulk('C', ['3', '1', '2']))).toBe(
      fingerprintOf(bulk('C', ['1', '2', '3'])),
    );
    expect(fingerprintOf(bulk('C', ['1', '2', '3']))).not.toBe(
      fingerprintOf(bulk('D', ['1', '2', '3'])),
    );
  });
});

describe('member joins and leaves', () => {
  it('are identified by the join timestamp when Discord provides it', () => {
    const a = member('memberAdd', { joinedAtMs: 1_699_000_000_000 });
    const b = member('memberAdd', {
      joinedAtMs: 1_699_000_000_000,
      receivedAtMs: 1_700_000_009_999,
    });
    // Same join, redelivered a different number of milliseconds later: still
    // one event.
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('separate a rejoin from the original join', () => {
    const first = member('memberAdd', { joinedAtMs: 1_699_000_000_000 });
    const rejoin = member('memberAdd', { joinedAtMs: 1_699_500_000_000 });
    expect(fingerprintOf(first)).not.toBe(fingerprintOf(rejoin));
  });

  it('do not confuse a join with a leave', () => {
    expect(fingerprintOf(member('memberAdd', { joinedAtMs: 1 }))).not.toBe(
      fingerprintOf(member('memberRemove', { joinedAtMs: 1 })),
    );
  });

  it('fall back to a time bucket when the join timestamp is absent', () => {
    // GUILD_MEMBER_REMOVE frequently arrives without joined_at. Two dispatches
    // within the same minute are the same leave.
    const a = member('memberRemove', { receivedAtMs: 1_700_000_000_000 });
    const b = member('memberRemove', { receivedAtMs: 1_700_000_030_000 });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('treats a much later dispatch as a new event rather than dropping it', () => {
    // The failure direction is deliberate: logging a leave twice is noise,
    // missing one is a hole in the record.
    const a = member('memberRemove', { receivedAtMs: 1_700_000_000_000 });
    const muchLater = member('memberRemove', { receivedAtMs: 1_700_000_600_000 });
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(muchLater));
  });
});

describe('roles', () => {
  it('fingerprint create and delete, which happen once per role id', () => {
    expect(fingerprintOf(role('roleCreate'))).toBeDefined();
    expect(fingerprintOf(role('roleDelete'))).toBeDefined();
    expect(fingerprintOf(role('roleCreate'))).not.toBe(fingerprintOf(role('roleDelete')));
  });

  it('do not fingerprint an update, which can recur legitimately', () => {
    expect(fingerprintOf(role('roleUpdate'))).toBeUndefined();
  });

  it('pins the exact multi-part digest, guarding the join separator', () => {
    // Golden value: rows already written to the `event_dedupe` table store
    // this exact hex string. Unlike a single-part digest, `roleCreate` joins
    // two parts (`event.kind`, `event.roleId`), so `Array.prototype.join`
    // genuinely exercises its separator here — a change to how `digest()`
    // joins its parts (a different character, or dropping the separator
    // entirely) changes this hash. If this test ever needs to change, stop:
    // that means the encoding changed, which invalidates every multi-part
    // fingerprint already stored (`memberAdd`, `memberRemove`, `roleCreate`,
    // `roleDelete`, `messageUpdate`, `autoModerationAction`'s fallback), not
    // a test to update.
    expect(fingerprintOf(role('roleCreate', '555555555555555555'))).toBe(
      'ac019cc4aa16e4acbcb1739c5712190a519f7dd844adbdad279fb11e46584d7a',
    );
  });
});

describe('the level-triggered kinds are not deduplicated at all', () => {
  /**
   * The load-bearing decision. `(message, user, emoji, action)` is not unique
   * over time — a member may add a reaction, remove it, and add it again, all
   * legitimately. Any time bucket would be a guess, and a wrong guess silently
   * drops a real action.
   *
   * So a reaction event is a hint that state may have changed, and convergence
   * recomputes. If someone ever "fixes" this by inventing a reaction
   * fingerprint, these fail.
   */
  it.each([
    ['reactionAdd', reaction('reactionAdd')],
    ['reactionRemove', reaction('reactionRemove')],
    ['memberUpdate', member('memberUpdate')],
    ['roleUpdate', role('roleUpdate')],
    ['guildCreate', guildEvent('guildCreate')],
    ['guildDelete', guildEvent('guildDelete')],
    ['connection', connection()],
  ])('%s carries no fingerprint', (_label, event) => {
    expect(fingerprintOf(event)).toBeUndefined();
    expect(isLevelTriggered(event)).toBe(true);
  });

  it('does not treat an interaction as level-triggered', () => {
    expect(isLevelTriggered(interaction())).toBe(false);
  });
});

const nativeEvent = (over: Partial<AutoModerationEvent> = {}): AutoModerationEvent => ({
  kind: 'autoModerationAction',
  guildId: '111111111111111111',
  receivedAtMs: 1_700_000_000_000,
  ruleId: '222222222222222222',
  triggerType: 'keyword',
  userId: '333333333333333333',
  actionType: 'block',
  channelId: '444444444444444444',
  messageId: undefined,
  alertMessageId: undefined,
  content: 'a forbidden word',
  matchedKeyword: 'forbidden',
  matchedContent: 'forbidden',
  ...over,
});

describe('autoModerationAction fingerprints', () => {
  it('uses the alert message id when Discord supplies one', () => {
    const a = nativeEvent({ actionType: 'alert', alertMessageId: '555555555555555555' });
    const b = nativeEvent({
      actionType: 'alert',
      alertMessageId: '555555555555555555',
      // A replay carries the same ids but is observed later; the later
      // observation must not create a second fingerprint.
      receivedAtMs: 1_700_000_090_000,
      content: 'different text entirely',
    });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('uses the message id when the action did not block', () => {
    const a = nativeEvent({ actionType: 'timeout', messageId: '666666666666666666' });
    const b = nativeEvent({
      actionType: 'timeout',
      messageId: '666666666666666666',
      receivedAtMs: 1_700_000_090_000,
    });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('separates two actions on the same message', () => {
    // One rule with both an alert and a timeout action produces two dispatches
    // carrying the same message id. They are two real events, not a replay.
    const alert = nativeEvent({ actionType: 'alert', messageId: '666666666666666666' });
    const timeout = nativeEvent({ actionType: 'timeout', messageId: '666666666666666666' });
    expect(fingerprintOf(alert)).not.toBe(fingerprintOf(timeout));
  });

  it('falls back to a content fingerprint when the message was blocked', () => {
    // No message id and no alert id: this is the common case, and the only
    // available identity is what was matched, by whom, under which rule.
    const a = nativeEvent();
    const b = nativeEvent({ receivedAtMs: 1_700_000_000_500 });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('treats a blocked repeat outside the bucket as a new event', () => {
    const a = nativeEvent();
    const b = nativeEvent({ receivedAtMs: 1_700_000_000_000 + 60_000 });
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
  });

  it('separates different members saying the same thing', () => {
    const a = nativeEvent();
    const b = nativeEvent({ userId: '777777777777777777' });
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
  });

  it('is never level-triggered', () => {
    expect(fingerprintOf(nativeEvent())).toBeDefined();
  });

  it('pins the exact six-part fallback digest, guarding the join separator', () => {
    // Golden value for this task's own new code: the fallback branch joins
    // six parts (kind, ruleId, userId, actionType, content, time bucket), so
    // this pin genuinely exercises `digest()`'s join separator, unlike a
    // one-part digest such as messageCreate's. Rows already written to the
    // `event_dedupe` table store this exact hex string for a blocked native
    // AutoMod action. If this test ever needs to change, stop: that means
    // the join encoding changed, which would invalidate every multi-part
    // fingerprint already stored, not just this one — an idempotency break
    // per CLAUDE.md rule 6.
    expect(fingerprintOf(nativeEvent())).toBe(
      '443761f4955d01db78d80350153a63627df479b6c6bfeb8d71154906188c0b1a',
    );
  });
});

const auditEntry = (over: Partial<AuditLogEntryEvent> = {}): DomainEvent => ({
  ...base,
  kind: 'auditLogEntry',
  entryId: '800000000000000001',
  action: 20,
  actorId: '444444444444444444',
  targetId: '555555555555555555',
  reason: undefined,
  changes: [],
  count: undefined,
  channelId: undefined,
  ...over,
});

describe('auditLogEntry fingerprints', () => {
  it('treats a replayed entry as the same event', () => {
    // A reconnect replay carries the same entry id but is observed later and
    // may render different mutable fields; the id is the identity.
    const replayed = auditEntry({ receivedAtMs: 1_700_000_090_000, reason: 'added later' });
    expect(fingerprintOf(auditEntry())).toBe(fingerprintOf(replayed));
  });

  it('separates two entries by id', () => {
    expect(fingerprintOf(auditEntry())).not.toBe(
      fingerprintOf(auditEntry({ entryId: '800000000000000002' })),
    );
  });

  it('is never level-triggered — a replayed entry must not double-log', () => {
    expect(isLevelTriggered(auditEntry())).toBe(false);
  });
});

it('identifies a modal submit by its interaction id', () => {
  expect(
    fingerprintOf({
      kind: 'modalSubmit',
      guildId: '111111111111111111',
      receivedAtMs: 1,
      interactionId: '777777777777777777',
      token: 't',
      channelId: '444444444444444444',
      messageId: undefined,
      userId: '333333333333333333',
      customId: 'bs.task:update:x',
      fields: { body: 'hi' },
    }),
  ).toBe('777777777777777777');
});
