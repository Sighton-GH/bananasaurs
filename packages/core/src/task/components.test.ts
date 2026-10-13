import { describe, expect, it } from 'vitest';
import * as components from './components.js';
import { buildTaskCustomId, parseTaskCustomId, TASK_CUSTOM_ID_PREFIX } from './components.js';

const TASK_ID = '123e4567-e89b-12d3-a456-426614174000';
const CHOICE_MESSAGE_ID = '777777777777777777';

describe('task custom ids', () => {
  it('round-trips approve with its version', () => {
    const raw = buildTaskCustomId({ action: 'approve', taskId: TASK_ID, version: 3 });
    expect(raw).toBe(`${TASK_CUSTOM_ID_PREFIX}:approve:${TASK_ID}:3`);
    expect(parseTaskCustomId(raw)).toEqual({ action: 'approve', taskId: TASK_ID, version: 3 });
  });
  it('round-trips reject with its version', () => {
    const raw = buildTaskCustomId({ action: 'reject', taskId: TASK_ID, version: 1 });
    expect(raw).toBe(`${TASK_CUSTOM_ID_PREFIX}:reject:${TASK_ID}:1`);
    expect(parseTaskCustomId(raw)).toEqual({ action: 'reject', taskId: TASK_ID, version: 1 });
  });
  it('round-trips pick with its choice message', () => {
    const raw = buildTaskCustomId({
      action: 'pick',
      choiceMessageId: CHOICE_MESSAGE_ID,
      taskId: TASK_ID,
    });
    expect(raw).toBe(`${TASK_CUSTOM_ID_PREFIX}:pick:${CHOICE_MESSAGE_ID}:${TASK_ID}`);
    expect(parseTaskCustomId(raw)).toEqual({
      action: 'pick',
      choiceMessageId: CHOICE_MESSAGE_ID,
      taskId: TASK_ID,
    });
  });
  it('round-trips complete', () => {
    const raw = buildTaskCustomId({ action: 'complete' });
    expect(raw).toBe(`${TASK_CUSTOM_ID_PREFIX}:complete`);
    expect(parseTaskCustomId(raw)).toEqual({ action: 'complete' });
  });
  it('rejects foreign, overlong, and malformed ids without throwing', () => {
    expect(parseTaskCustomId('bs.panel:x:y')).toBeUndefined();
    expect(parseTaskCustomId('a'.repeat(101))).toBeUndefined();
    expect(parseTaskCustomId(`${TASK_CUSTOM_ID_PREFIX}:approve:not-a-uuid:2`)).toBeUndefined();
    expect(parseTaskCustomId(`${TASK_CUSTOM_ID_PREFIX}:reject:${TASK_ID}:0`)).toBeUndefined();
    expect(parseTaskCustomId(`${TASK_CUSTOM_ID_PREFIX}:approve:${TASK_ID}`)).toBeUndefined();
    expect(parseTaskCustomId(`${TASK_CUSTOM_ID_PREFIX}:pick:12:${TASK_ID}`)).toBeUndefined();
    expect(parseTaskCustomId(`${TASK_CUSTOM_ID_PREFIX}:complete:extra`)).toBeUndefined();
    expect(
      parseTaskCustomId(`${TASK_CUSTOM_ID_PREFIX}:approve:${TASK_ID}:1000000001`),
    ).toBeUndefined();
    expect(parseTaskCustomId('')).toBeUndefined();
  });
});

describe('components module surface', () => {
  it('does not export the retired buildCompleteSelect helper', () => {
    expect(components).not.toHaveProperty('buildCompleteSelect');
  });
});

describe('start and update custom ids', () => {
  it('round-trips the start and update custom ids', () => {
    const taskId = '00000000-0000-4000-8000-000000000001';
    const start = buildTaskCustomId({ action: 'start', taskId, version: 3 });
    expect(start).toBe(`bs.task:start:${taskId}:3`);
    expect(parseTaskCustomId(start)).toEqual({ action: 'start', taskId, version: 3 });
    const update = buildTaskCustomId({ action: 'update', taskId });
    expect(update).toBe(`bs.task:update:${taskId}`);
    expect(parseTaskCustomId(update)).toEqual({ action: 'update', taskId });
    expect(parseTaskCustomId(`bs.task:update:${taskId}:extra`)).toBeUndefined();
    expect(parseTaskCustomId('bs.task:start:not-a-uuid:1')).toBeUndefined();
  });
});

describe('start and update custom id validation', () => {
  const taskId = '00000000-0000-4000-8000-000000000001';
  it('accepts versions 1 through 1e9 only', () => {
    for (const v of [1, 2, 1_000_000_000]) {
      expect(parseTaskCustomId(`bs.task:start:${taskId}:${v}`)).toEqual({
        action: 'start',
        taskId,
        version: v,
      });
    }
    for (const v of ['0', '1000000001', '-1', '1.5', '1e3', 'x', '', ' 1', '01x']) {
      expect(parseTaskCustomId(`bs.task:start:${taskId}:${v}`)).toBeUndefined();
    }
  });
  it('rejects a missing or extra part and a bad task id', () => {
    expect(parseTaskCustomId(`bs.task:start:${taskId}`)).toBeUndefined();
    expect(parseTaskCustomId(`bs.task:start:${taskId}:1:2`)).toBeUndefined();
    expect(parseTaskCustomId('bs.task:start')).toBeUndefined();
    expect(parseTaskCustomId('bs.task:update')).toBeUndefined();
    expect(parseTaskCustomId('bs.task:update:not-a-uuid')).toBeUndefined();
    expect(parseTaskCustomId(`bs.task:update:${taskId.toUpperCase()}x`)).toBeUndefined();
  });
});
