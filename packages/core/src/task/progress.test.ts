import { describe, expect, it } from 'vitest';
import { isProgressUpdate } from './progress.js';

describe('isProgressUpdate', () => {
  it.each([
    ['ok', false],
    ['Thanks!', false],
    ['👍', false],
    ['got it, will do', false],
    ['<@123456789012345678> ok', false],
    ['ok thanks', false],
    ['finished the wiring, waiting on parts', true],
    ['done', true],
    ['50% through the CAD', true],
    ['blocked on budget approval', true],
    ['ok, wiring is done', true],
    ['', false],
  ])('classifies %j as %s', (text, expected) => {
    expect(isProgressUpdate(text)).toBe(expected);
  });
});
