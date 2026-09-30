import { describe, expect, it } from 'vitest';
import {
  buildCompleteSelect,
  buildPickComponents,
  buildReviewComponents,
  buildTaskCustomId,
  parseTaskCustomId,
  TASK_CUSTOM_ID_PREFIX,
} from './components.js';

const TASK_ID = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_TASK_ID = '123e4567-e89b-12d3-a456-426614174001';
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

describe('buildReviewComponents', () => {
  it('renders Approve and Send back buttons whose ids parse back', () => {
    const rows = buildReviewComponents(TASK_ID, 2) as {
      type: number;
      components: { type: number; style: number; custom_id: string; label: string }[];
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(1);
    expect(rows[0]?.components.map((c) => [c.label, c.type, c.style])).toEqual([
      ['Approve', 2, 3],
      ['Send back', 2, 2],
    ]);
    const [approve, reject] = rows[0]?.components ?? [];
    expect(parseTaskCustomId(approve?.custom_id ?? '')).toEqual({
      action: 'approve',
      taskId: TASK_ID,
      version: 2,
    });
    expect(parseTaskCustomId(reject?.custom_id ?? '')).toEqual({
      action: 'reject',
      taskId: TASK_ID,
      version: 2,
    });
  });
});

describe('buildPickComponents', () => {
  it('caps at 5 primary buttons and trims long labels', () => {
    const candidates = Array.from({ length: 7 }, (_, i) => ({
      taskId: OTHER_TASK_ID,
      title: `  Task ${i} ${'x'.repeat(100)}  `,
    }));
    const rows = buildPickComponents(CHOICE_MESSAGE_ID, candidates) as {
      type: number;
      components: { type: number; style: number; custom_id: string; label: string }[];
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(1);
    expect(rows[0]?.components).toHaveLength(5);
    for (const button of rows[0]?.components ?? []) {
      expect(button.type).toBe(2);
      expect(button.style).toBe(1);
      expect(button.label.length).toBeLessThanOrEqual(80);
      expect(button.label.startsWith('Task ')).toBe(true);
      expect(parseTaskCustomId(button.custom_id)).toEqual({
        action: 'pick',
        choiceMessageId: CHOICE_MESSAGE_ID,
        taskId: OTHER_TASK_ID,
      });
    }
  });
  it('labels a blank title as Task', () => {
    const rows = buildPickComponents(CHOICE_MESSAGE_ID, [{ taskId: TASK_ID, title: '   ' }]) as {
      components: { label: string }[];
    }[];
    expect(rows[0]?.components[0]?.label).toBe('Task');
  });
});

describe('buildCompleteSelect', () => {
  it('renders one select with up to 25 options', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      taskId: TASK_ID,
      title: `Task ${i}`,
      dueLabel: `Sep ${i}, 5:00 PM`,
    }));
    const rows = buildCompleteSelect(tasks) as {
      type: number;
      components: {
        type: number;
        custom_id: string;
        placeholder: string;
        options: { label: string; value: string; description: string }[];
      }[];
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(1);
    const select = rows[0]?.components[0];
    expect(select?.type).toBe(3);
    expect(select?.custom_id).toBe(buildTaskCustomId({ action: 'complete' }));
    expect(select?.placeholder).toBe('Choose a task');
    expect(select?.options).toHaveLength(25);
    expect(select?.options[0]).toEqual({
      label: 'Task 0',
      value: TASK_ID,
      description: 'Sep 0, 5:00 PM',
    });
  });
  it('trims option labels and descriptions to 100 chars', () => {
    const rows = buildCompleteSelect([
      { taskId: TASK_ID, title: `  ${'y'.repeat(150)}  `, dueLabel: 'd'.repeat(150) },
    ]) as { components: { options: { label: string; description: string }[] }[] }[];
    expect(rows[0]?.components[0]?.options[0]?.label).toHaveLength(100);
    expect(rows[0]?.components[0]?.options[0]?.description).toHaveLength(100);
  });
});
