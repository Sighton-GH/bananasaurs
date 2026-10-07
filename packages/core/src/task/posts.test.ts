import { describe, expect, it } from 'vitest';
import {
  staleTaskPostsEnvWarning,
  taskPostsBannerText,
  taskPostsMessage,
  taskPostsState,
} from './posts.js';

describe('taskPostsState', () => {
  it('is on only when the guild switch is on and dry run is off', () => {
    expect(taskPostsState({ switchOn: true, dryRun: false })).toEqual({ enabled: true });
    expect(taskPostsState({ switchOn: false, dryRun: false })).toEqual({
      enabled: false,
      offReason: 'switch',
    });
  });

  it('dry run wins over the switch', () => {
    for (const switchOn of [true, false]) {
      expect(taskPostsState({ switchOn, dryRun: true })).toEqual({
        enabled: false,
        offReason: 'dry-run',
      });
    }
  });
});

describe('taskPostsMessage', () => {
  it('says the announcement is posted when on', () => {
    expect(taskPostsMessage({ enabled: true }, 'announcement')).toBe(
      'Task posts are on: the announcement is posted to Discord within a minute.',
    );
    expect(taskPostsMessage({ enabled: true }, 'approval request')).toBe(
      'Task posts are on: the approval request is posted to Discord within a minute.',
    );
  });

  it('tells how to turn posts on when the switch is off', () => {
    const text = taskPostsMessage({ enabled: false, offReason: 'switch' }, 'announcement');
    expect(text).toContain('Nothing was posted to Discord');
    expect(text).toContain('task posts are off for this server');
    expect(text).toContain("Task posts switch on the dashboard's Tasks page");
    expect(text).toContain('Manage club tasks');
    expect(text).toContain('not sent later');
    expect(text).not.toContain('TASK_NUDGE_SEND_ENABLED');
  });

  it('names BANANASAURS_DRY_RUN=0 when dry run is the reason', () => {
    const text = taskPostsMessage({ enabled: false, offReason: 'dry-run' }, 'announcement');
    expect(text).toContain('BANANASAURS_DRY_RUN=0');
    expect(text).toContain('sudo systemctl restart bananasaurs');
  });
});

describe('taskPostsBannerText', () => {
  it('points at the Task posts switch, or names dry run', () => {
    expect(taskPostsBannerText('switch')).toContain('Task posts switch on the Tasks page');
    expect(taskPostsBannerText('dry-run')).toContain('BANANASAURS_DRY_RUN');
  });
});

describe('staleTaskPostsEnvWarning', () => {
  it('warns only when the retired variable is still set', () => {
    expect(staleTaskPostsEnvWarning({})).toBeUndefined();
    expect(staleTaskPostsEnvWarning({ TASK_NUDGE_SEND_ENABLED: '1' })).toContain(
      'turn task posts on per server in the dashboard',
    );
  });
});
