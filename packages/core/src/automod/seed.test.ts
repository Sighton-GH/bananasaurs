import { describe, expect, it, vi } from 'vitest';
import { seedDefaultWordList } from './seed.js';

describe('seedDefaultWordList', () => {
  it('adds one category and at least one term from the bundled dataset', () => {
    const addCategory = vi.fn();
    const addTerm = vi.fn();
    seedDefaultWordList({ addCategory, addTerm }, 'r1');

    expect(addCategory).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'r1', defaultAction: 'delete_and_case' }),
    );
    expect(addTerm.mock.calls.length).toBeGreaterThan(0);
  });
});
