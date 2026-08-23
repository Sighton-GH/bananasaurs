import { describe, expect, it } from 'vitest';
import { fingerprintOf, isLevelTriggered } from './fingerprint.js';
import type {
  ConnectionEvent,
  DomainEvent,
  GuildEvent,
  InteractionEvent,
  MemberEvent,
  MessageEvent,
  ReactionEvent,
  RoleEvent,
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
  messageId: '333333333333333333',
  authorId: '444444444444444444',
  content: undefined,
  editedTimestampMs: undefined,
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
