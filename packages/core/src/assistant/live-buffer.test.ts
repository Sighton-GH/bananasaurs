import { describe, expect, it } from 'vitest';
import { createLiveBuffer, getLiveBuffer } from './live-buffer.js';

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

  it('keeps at most 50 runs, evicting the least recently written', () => {
    const buf = createLiveBuffer();
    for (let i = 0; i < 50; i++) buf.append(`run-${i}`, `a${i}`, '');
    buf.append('run-0', '+', ''); // run-0 is now the most recently written
    buf.append('run-50', 'new', ''); // 51st distinct run
    expect(buf.read('run-1')).toBeUndefined();
    expect(buf.read('run-0')?.answer).toBe('a0+');
    expect(buf.read('run-50')?.answer).toBe('new');
  });

  it('drops a run idle for 30 minutes on read', () => {
    let t = 1_000_000;
    const buf = createLiveBuffer({ now: () => t });
    buf.append('run-1', 'hello', 'why');
    t += 30 * 60 * 1000;
    expect(buf.read('run-1')).toBeUndefined();
  });
});

describe('getLiveBuffer', () => {
  it('scopes the same run id by guild: each guild reads only its own text', () => {
    const a = getLiveBuffer('guild-a-scope');
    const b = getLiveBuffer('guild-b-scope');
    try {
      a.append('same-run', 'answer a', 'thinking a');
      b.append('same-run', 'answer b', 'thinking b');
      expect(a.read('same-run')).toEqual({ answer: 'answer a', thinking: 'thinking a' });
      expect(b.read('same-run')).toEqual({ answer: 'answer b', thinking: 'thinking b' });
      a.drop('same-run');
      expect(a.read('same-run')).toBeUndefined();
      expect(b.read('same-run')).toEqual({ answer: 'answer b', thinking: 'thinking b' });
    } finally {
      a.drop('same-run');
      b.drop('same-run');
    }
  });
});
