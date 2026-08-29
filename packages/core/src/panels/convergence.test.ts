import { describe, expect, it } from 'vitest';
import { parseSnowflakeId } from '../ids.js';
import type { PanelBehaviour, PanelConfig, PanelStatus } from './model.js';
import {
  intentsFor,
  isEmptyPlan,
  needsFullReactionState,
  planConvergence,
  type ConvergenceInput,
} from './convergence.js';

/**
 * Convergence is pure, so its tests are a table rather than a harness.
 *
 * Each case states a member's live roles and their selection, and asserts the
 * change list. That is the shape the adoption pass and reconciliation reuse —
 * `docs/19` §4's point that drift repair is the same code path, not a second
 * implementation.
 */

const ROLE = {
  a: parseSnowflakeId('111111111111111111'),
  b: parseSnowflakeId('222222222222222222'),
  c: parseSnowflakeId('333333333333333333'),
};
const REQUIRED = parseSnowflakeId('444444444444444444');
const BLOCKED = parseSnowflakeId('555555555555555555');
const UNRELATED = parseSnowflakeId('666666666666666666');

const panelWith = (over: Partial<PanelConfig> = {}): PanelConfig => ({
  panelId: 'roles',
  kind: 'adopted',
  channelId: parseSnowflakeId('777777777777777777'),
  messageId: parseSnowflakeId('888888888888888888'),
  behaviour: 'toggle',
  component: 'reaction',
  maxRoles: undefined,
  requiredRoleId: undefined,
  blockedRoleIds: [],
  status: 'enabled',
  adoptionPassState: 'done',
  adoptionBlockedCount: 0,
  options: [
    { optionId: 'a', roleId: ROLE.a, emojiKey: 'u:1', label: undefined, position: 0 },
    { optionId: 'b', roleId: ROLE.b, emojiKey: 'u:2', label: undefined, position: 1 },
    { optionId: 'c', roleId: ROLE.c, emojiKey: 'u:3', label: undefined, position: 2 },
  ],
  ...over,
});

const plan = (over: Partial<ConvergenceInput> & { panel?: PanelConfig } = {}) =>
  planConvergence({
    panel: over.panel ?? panelWith(),
    selectedOptionIds: over.selectedOptionIds ?? new Set(),
    currentRoleIds: over.currentRoleIds ?? new Set(),
    limitToOptionIds: over.limitToOptionIds,
  });

describe('toggle', () => {
  it('grants the selected role', () => {
    const result = plan({ selectedOptionIds: new Set(['a']) });
    expect(result.grants).toEqual([ROLE.a]);
    expect(result.revokes).toEqual([]);
  });

  it('revokes a held role that is no longer selected', () => {
    const result = plan({ currentRoleIds: new Set([ROLE.a]) });
    expect(result.revokes).toEqual([ROLE.a]);
    expect(result.grants).toEqual([]);
  });

  it('does nothing when the live roles already match the selection', () => {
    // The idempotence that makes a replayed reaction free: convergence run
    // twice produces the same state and the second pass issues no call.
    const result = plan({
      selectedOptionIds: new Set(['a', 'b']),
      currentRoleIds: new Set([ROLE.a, ROLE.b]),
    });
    expect(isEmptyPlan(result)).toBe(true);
  });

  it('never touches a role the panel does not offer', () => {
    const result = plan({ currentRoleIds: new Set([UNRELATED]) });
    expect(result.revokes).toEqual([]);
    expect(result.desiredRoleIds.has(UNRELATED)).toBe(false);
  });
});

describe('add_only never revokes, remove_only never grants', () => {
  const addOnly = panelWith({ behaviour: 'add_only' });
  const removeOnly = panelWith({ behaviour: 'remove_only' });

  it('add_only grants a new selection', () => {
    expect(plan({ panel: addOnly, selectedOptionIds: new Set(['a']) }).grants).toEqual([ROLE.a]);
  });

  it('add_only keeps a role whose selection was withdrawn', () => {
    const result = plan({ panel: addOnly, currentRoleIds: new Set([ROLE.a]) });
    expect(result.revokes).toEqual([]);
    expect(result.declined).toContainEqual({ optionId: 'a', reason: 'add-only' });
  });

  it('remove_only revokes a role whose selection was withdrawn', () => {
    expect(plan({ panel: removeOnly, currentRoleIds: new Set([ROLE.a]) }).revokes).toEqual([
      ROLE.a,
    ]);
  });

  it('remove_only refuses to grant a new selection', () => {
    const result = plan({ panel: removeOnly, selectedOptionIds: new Set(['a']) });
    expect(result.grants).toEqual([]);
    expect(result.declined).toContainEqual({ optionId: 'a', reason: 'remove-only' });
  });
});

describe('single_choice', () => {
  const single = panelWith({ kind: 'managed', component: 'button', behaviour: 'single_choice' });

  it('swaps one role for another', () => {
    const result = plan({
      panel: single,
      selectedOptionIds: new Set(['b']),
      currentRoleIds: new Set([ROLE.a]),
    });
    expect(result.grants).toEqual([ROLE.b]);
    expect(result.revokes).toEqual([ROLE.a]);
  });

  it('collapses a multi-value selection to the first in display order', () => {
    // A select menu misconfigured with max_values > 1, or a replayed payload,
    // must not produce two roles from a single-choice panel.
    const result = plan({ panel: single, selectedOptionIds: new Set(['c', 'b']) });
    expect(result.grants).toEqual([ROLE.b]);
  });

  it('revokes everything when the selection is empty', () => {
    const result = plan({ panel: single, currentRoleIds: new Set([ROLE.a]) });
    expect(result.revokes).toEqual([ROLE.a]);
  });

  it('orders the revoke before the grant, so a swap frees its slot first', () => {
    const result = plan({
      panel: single,
      selectedOptionIds: new Set(['b']),
      currentRoleIds: new Set([ROLE.a]),
    });
    const intents = intentsFor(result, {
      panelId: 'roles',
      userId: parseSnowflakeId('999999999999999999'),
      triggerRef: 'i-1',
      source: 'interaction',
      batchId: 'batch-1',
      reason: 'test',
    });
    expect(intents.map((i) => i.action)).toEqual(['revoke', 'grant']);
  });
});

describe('max_roles', () => {
  const capped = panelWith({ maxRoles: 2 });

  it('clamps a selection larger than the ceiling', () => {
    const result = plan({ panel: capped, selectedOptionIds: new Set(['a', 'b', 'c']) });
    expect(result.grants).toEqual([ROLE.a, ROLE.b]);
    expect(result.declined).toContainEqual({ optionId: 'c', reason: 'max-roles' });
  });

  it('keeps roles the member already holds rather than reshuffling by position', () => {
    // Held-and-still-wanted wins. Clamping by display order alone would revoke
    // a role held for a month because a lower-positioned option was reacted to.
    const result = plan({
      panel: capped,
      selectedOptionIds: new Set(['a', 'b', 'c']),
      currentRoleIds: new Set([ROLE.b, ROLE.c]),
    });
    expect(result.revokes).toEqual([]);
    expect(result.grants).toEqual([]);
    expect(result.declined).toContainEqual({ optionId: 'a', reason: 'max-roles' });
  });

  it('is stable: running the pass again over its own result changes nothing', () => {
    const first = plan({ panel: capped, selectedOptionIds: new Set(['a', 'b', 'c']) });
    const second = planConvergence({
      panel: capped,
      selectedOptionIds: new Set(['a', 'b', 'c']),
      currentRoleIds: first.desiredRoleIds,
    });
    expect(isEmptyPlan(second)).toBe(true);
  });

  it('permits a selection at exactly the ceiling', () => {
    const result = plan({ panel: capped, selectedOptionIds: new Set(['a', 'b']) });
    expect(result.grants).toEqual([ROLE.a, ROLE.b]);
    expect(result.declined).toEqual([]);
  });
});

describe('panel-level refusals keep what the member already has', () => {
  const cases: { name: string; panel: PanelConfig; current: string[]; reason: string }[] = [
    {
      name: 'a disabled panel',
      panel: panelWith({ status: 'disabled_by_doctor' as PanelStatus }),
      current: [ROLE.a],
      reason: 'panel-disabled',
    },
    {
      name: 'a member without the required role',
      panel: panelWith({ requiredRoleId: REQUIRED }),
      current: [ROLE.a],
      reason: 'missing-required-role',
    },
    {
      name: 'a member holding a blocked role',
      panel: panelWith({ blockedRoleIds: [BLOCKED] }),
      current: [ROLE.a, BLOCKED],
      reason: 'blocked-role',
    },
  ];

  for (const { name, panel, current, reason } of cases) {
    it(`${name} produces no changes, with reason '${reason}'`, () => {
      const result = plan({
        panel,
        selectedOptionIds: new Set(['b']),
        currentRoleIds: new Set(current),
      });
      expect(result.refusedBecause).toBe(reason);
      expect(isEmptyPlan(result)).toBe(true);
    });

    it(`${name} does not strip roles the panel already granted`, () => {
      // Refusing is "this member may not use the panel right now", not "this
      // member should hold nothing from it". Stripping would turn acquiring a
      // blocked role into a silent mass revocation.
      const result = plan({ panel, currentRoleIds: new Set(current) });
      expect(result.revokes).toEqual([]);
      expect(result.desiredRoleIds.has(ROLE.a)).toBe(true);
    });
  }

  it('permits a member who holds the required role', () => {
    const result = plan({
      panel: panelWith({ requiredRoleId: REQUIRED }),
      selectedOptionIds: new Set(['a']),
      currentRoleIds: new Set([REQUIRED]),
    });
    expect(result.refusedBecause).toBeUndefined();
    expect(result.grants).toEqual([ROLE.a]);
  });
});

describe('limitToOptionIds — amendment 6, the single-emoji path', () => {
  it('grants the option the event carried', () => {
    const result = plan({
      selectedOptionIds: new Set(['a']),
      limitToOptionIds: new Set(['a']),
    });
    expect(result.grants).toEqual([ROLE.a]);
  });

  it('does not revoke roles from options it never looked at', () => {
    // The whole point. Without the limit, a reaction on 'a' would compute an
    // empty selection for 'b' and 'c' and revoke both — every reaction would
    // strip every other role on the panel.
    const result = plan({
      selectedOptionIds: new Set(['a']),
      currentRoleIds: new Set([ROLE.b, ROLE.c]),
      limitToOptionIds: new Set(['a']),
    });
    expect(result.revokes).toEqual([]);
    expect(result.grants).toEqual([ROLE.a]);
    expect(result.desiredRoleIds.has(ROLE.b)).toBe(true);
    expect(result.desiredRoleIds.has(ROLE.c)).toBe(true);
  });

  it('revokes the option the event carried when its reaction was removed', () => {
    const result = plan({
      selectedOptionIds: new Set(),
      currentRoleIds: new Set([ROLE.a, ROLE.b]),
      limitToOptionIds: new Set(['a']),
    });
    expect(result.revokes).toEqual([ROLE.a]);
    expect(result.desiredRoleIds.has(ROLE.b)).toBe(true);
  });

  it('a full pass with no limit does revoke what is no longer selected', () => {
    const result = plan({
      selectedOptionIds: new Set(['a']),
      currentRoleIds: new Set([ROLE.b, ROLE.c]),
    });
    expect([...result.revokes].sort()).toEqual([ROLE.b, ROLE.c].sort());
  });
});

describe('needsFullReactionState — which panels cost N REST calls', () => {
  const behaviours: PanelBehaviour[] = ['toggle', 'add_only', 'remove_only'];

  it.each(behaviours)('%s without max_roles is decidable from one emoji', (behaviour) => {
    expect(needsFullReactionState(panelWith({ behaviour }))).toBe(false);
  });

  it.each(behaviours)('%s with max_roles needs the whole set', (behaviour) => {
    expect(needsFullReactionState(panelWith({ behaviour, maxRoles: 2 }))).toBe(true);
  });
});

describe('intentsFor', () => {
  it('carries the panel, trigger and batch onto every intent', () => {
    const result = plan({ selectedOptionIds: new Set(['a']) });
    const [only] = intentsFor(result, {
      panelId: 'roles',
      userId: parseSnowflakeId('999999999999999999'),
      triggerRef: 'pass-7',
      source: 'reaction',
      batchId: 'batch-9',
      reason: 'reaction on panel roles',
    });
    expect(only).toMatchObject({
      panelId: 'roles',
      triggerRef: 'pass-7',
      source: 'reaction',
      batchId: 'batch-9',
      action: 'grant',
      roleId: ROLE.a,
    });
  });

  it('produces nothing for an empty plan', () => {
    const result = plan({});
    expect(
      intentsFor(result, {
        panelId: 'roles',
        userId: parseSnowflakeId('999999999999999999'),
        triggerRef: 'pass-7',
        source: 'reaction',
        batchId: 'batch-9',
        reason: 'nothing to do',
      }),
    ).toEqual([]);
  });
});
