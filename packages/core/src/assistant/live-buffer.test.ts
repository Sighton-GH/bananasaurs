import { describe, expect, it } from 'vitest';
import { createLiveBuffer } from './live-buffer.js';

describe('createLiveBuffer', () => {
  it('caps each side at 8000 chars and drops on finish', () => {
    const buf = createLiveBuffer();
    buf.append('run-1', 'a'.repeat(9000), 't'.repeat(9000));
    expect(buf.read('run-1')?.answer.length).toBe(8000);
    expect(buf.read('run-1')?.thinking.length).toBe(8000);
    buf.drop('run-1');
    expect(buf.read('run-1')).toBeUndefined();
  });

  it('accumulates across appends', () => {
    const buf = createLiveBuffer();
    buf.append('run-1', 'hel', 'why');
    buf.append('run-1', 'lo', ' not');
    expect(buf.read('run-1')).toEqual({ answer: 'hello', thinking: 'why not' });
  });

  it('reads unknown runs as undefined', () => {
    expect(createLiveBuffer().read('nope')).toBeUndefined();
  });

  it('retains the newest text independently on each side', () => {
    const buf = createLiveBuffer();
    buf.append('run-1', 'a'.repeat(8000), 't'.repeat(8000));
    buf.append('run-1', 'end', 'thought');
    expect(buf.read('run-1')).toEqual({
      answer: 'a'.repeat(7997) + 'end',
      thinking: 't'.repeat(7993) + 'thought',
    });
    buf.append('run-1', 'z'.repeat(9000) + 'last', 'short');
    expect(buf.read('run-1')?.answer).toBe('z'.repeat(7996) + 'last');
    expect(buf.read('run-1')?.thinking).toBe('t'.repeat(7988) + 'thoughtshort');
  });

  it('isolates runs, returns snapshots and allows idempotent drops', () => {
    const buf = createLiveBuffer();
    buf.append('run-1', 'hello', 'why');
    buf.append('run-2', 'other', 'thought');
    const snapshot = buf.read('run-1');
    buf.append('run-1', ' again', ' not');
    expect(snapshot).toEqual({ answer: 'hello', thinking: 'why' });
    buf.drop('run-1');
    buf.drop('run-1');
    buf.drop('missing');
    expect(buf.read('run-2')).toEqual({ answer: 'other', thinking: 'thought' });
  });
});
