import { describe, expect, it } from 'vitest';
import { LOG_ACTION_CATALOG, LOG_ACTION_GROUPS } from './catalog.js';
import { LOG_EVENT_KINDS } from './subscriber.js';

describe('LOG_ACTION_CATALOG', () => {
  it('covers exactly LOG_EVENT_KINDS, with no missing, extra or duplicate kinds', () => {
    const catalogKinds = LOG_ACTION_CATALOG.map((a) => a.kind);
    expect([...catalogKinds].sort()).toEqual([...LOG_EVENT_KINDS].sort());
    expect(new Set(catalogKinds).size).toBe(catalogKinds.length);
  });

  it('uses only known groups', () => {
    for (const action of LOG_ACTION_CATALOG) {
      expect(LOG_ACTION_GROUPS).toContain(action.group);
    }
  });

  it('has non-empty unique labels', () => {
    const labels = LOG_ACTION_CATALOG.map((a) => a.label);
    for (const label of labels) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('lists automod_match in Moderation with a source channel', () => {
    expect(LOG_ACTION_CATALOG).toContainEqual({
      kind: 'automod_match',
      group: 'Moderation',
      label: 'Automod match',
      hasSourceChannel: true,
    });
  });
});
