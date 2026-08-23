import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimDatabaseLock, DatabaseLockedError } from './lock.js';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnn-lock-'));
  lockPath = path.join(dir, 'test.db.lock');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A pid that is definitely not running, verified against /proc (Linux, ADR 0006). */
function deadPid(): number {
  for (let pid = 4_000_000; pid > 3_990_000; pid -= 1) {
    if (!fs.existsSync(`/proc/${pid}`)) return pid;
  }
  throw new Error('could not find an unused pid');
}

describe('claimDatabaseLock', () => {
  it('claims a free lock and records the holder', () => {
    const lock = claimDatabaseLock(lockPath, { socketPath: '/run/x.sock' });
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    expect(info['pid']).toBe(process.pid);
    expect(info['socketPath']).toBe('/run/x.sock');
    lock.release();
  });

  it('refuses when a live process holds it, and names that process', () => {
    // A pid that is certainly alive: our own.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 'x' }));
    expect(() => claimDatabaseLock(lockPath)).toThrow(DatabaseLockedError);
    try {
      claimDatabaseLock(lockPath);
    } catch (err) {
      expect((err as Error).message).toContain(String(process.pid));
      expect((err as Error).message).toContain('systemctl status bananasaurs');
    }
  });

  it('refuses using the real liveness probe, not an injected one', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 'x' }));
    // no isAlive override: exercises process.kill(pid, 0)
    expect(() => claimDatabaseLock(lockPath)).toThrow(DatabaseLockedError);
  });

  it('reclaims a lock whose holder is gone, and says why', () => {
    const gone = deadPid();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: gone, startedAt: 'x' }));
    const reasons: string[] = [];
    const lock = claimDatabaseLock(lockPath, { onStaleReclaim: (r) => reasons.push(r) });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(String(gone));
    expect((JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number }).pid).toBe(
      process.pid,
    );
    lock.release();
  });

  it('reclaims an empty lock file left by a crash between create and write', () => {
    fs.writeFileSync(lockPath, '');
    const reasons: string[] = [];
    const lock = claimDatabaseLock(lockPath, { onStaleReclaim: (r) => reasons.push(r) });
    expect(reasons[0]).toContain('empty or malformed');
    lock.release();
  });

  it('reclaims a malformed lock file rather than leaving the bot down', () => {
    fs.writeFileSync(lockPath, '{"pid": "not a number"}');
    const lock = claimDatabaseLock(lockPath, { onStaleReclaim: () => {} });
    expect((JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number }).pid).toBe(
      process.pid,
    );
    lock.release();
  });

  it('treats EPERM as alive, because "cannot tell" must fail safe', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: 'x' }));
    // pid 1 exists and is root-owned; probing it from a normal user gives EPERM.
    expect(() => claimDatabaseLock(lockPath)).toThrow(DatabaseLockedError);
  });

  it('releases by removing the file', () => {
    const lock = claimDatabaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release is idempotent and does not delete a lock we no longer hold', () => {
    const lock = claimDatabaseLock(lockPath);
    lock.release();
    // someone else claims it in the gap
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999, startedAt: 'y' }));
    lock.release(); // must not remove the other holder's file
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('a second claim succeeds after the first releases', () => {
    claimDatabaseLock(lockPath).release();
    const second = claimDatabaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    second.release();
  });

  it('creates the parent directory if it does not exist', () => {
    const nested = path.join(dir, 'a', 'b', 'test.db.lock');
    const lock = claimDatabaseLock(nested);
    expect(fs.existsSync(nested)).toBe(true);
    lock.release();
  });
});
