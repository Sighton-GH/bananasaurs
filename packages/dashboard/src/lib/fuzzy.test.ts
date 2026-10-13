import { describe, expect, it } from 'vitest';
import { score } from './fuzzy.js';

describe('score', () => {
  it('matches a subsequence', () => expect(score('tsk', 'Tasks')).toBeGreaterThan(0));
  it('matches astral code points in noncontiguous subsequences', () => {
    expect(score('😀a', '😀xxa')).toBeGreaterThan(0);
    expect(score('a😀b', 'axx😀yyb')).toBeGreaterThan(0);
    expect(score('😀🚀', '😀xx🚀')).toBeGreaterThan(0);
    expect(score('ba', 'bxxa')).toBeGreaterThan(0);
    expect(score('😀b', '😀xxa')).toBe(0);
    expect(score('😀😀', '😀xxa')).toBe(0);
    expect(score('😀a', '😀abc')).toBeGreaterThan(score('😀a', '😀xxa'));
  });
  it('ranks a prefix above a subsequence', () =>
    expect(score('tasks', 'Tasks')).toBeGreaterThan(score('tsk', 'Tasks')));
  it('returns 0 for no match', () => expect(score('x', 'Tasks')).toBe(0));
  it('ignores case and accents in both directions', () => {
    expect(score('resume', 'Résumé')).toBeGreaterThan(0);
    expect(score('RÉSUMÉ', 'resume')).toBeGreaterThan(0);
  });
  it('trims the query and matches everything for an empty one', () => {
    expect(score('  tasks ', 'Tasks')).toBeGreaterThan(0);
    expect(score('   ', 'anything')).toBeGreaterThan(0);
  });
  it('orders prefix > word start > contiguous > subsequence', () => {
    const prefix = score('ta', 'Tasks');
    const word = score('ta', 'New task');
    const inner = score('as', 'Tasks');
    const sub = score('tk', 'Tasks');
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(0);
  });
  it('lets a shorter text win a tie within a category', () =>
    expect(score('ta', 'Tasks')).toBeGreaterThan(score('ta', 'Tasks and more things')));
  it.each([175, 200, 1000, 5000])(
    'keeps every real match positive and categories ordered at %i characters',
    (n) => {
      const pad = 'x'.repeat(n);
      const prefix = score('ta', `tasks ${pad}`);
      const word = score('ta', `${pad} task`);
      const inner = score('as', `${pad} tasks`);
      const sub = score('tk', `t${pad}k`);
      for (const s of [prefix, word, inner, sub]) expect(s).toBeGreaterThan(0);
      expect(prefix).toBeGreaterThan(word);
      expect(word).toBeGreaterThan(inner);
      expect(inner).toBeGreaterThan(sub);
    },
  );
  it('never exceeds 1000 and is deterministic', () => {
    expect(score('tasks', 'Tasks')).toBeLessThanOrEqual(1000);
    expect(score('tasks', 'Tasks')).toBe(score('tasks', 'Tasks'));
  });
});
