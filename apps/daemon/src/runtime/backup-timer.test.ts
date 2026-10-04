import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { parseConfig, type Config, type Logger } from '@bananasaurs/core';
import { listBackups, openTestDatabase } from '@bananasaurs/storage';
import { createBackupTimer } from './backup-timer.js';

const logger = pino({ level: 'silent' });

let dir: string;
let db: ReturnType<typeof openTestDatabase>;

const config = (over: Record<string, string> = {}): Config =>
  parseConfig({
    DISCORD_BOT_TOKEN: 'not.a.real.token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: '234567890123456789',
    BANANASAURS_OWNER_USER_ID: '345678901234567890',
    DASHBOARD_SESSION_SECRET: 'a'.repeat(32),
    BANANASAURS_BACKUP_DIR: dir,
    ...over,
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnn-backup-timer-'));
  db = openTestDatabase();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('createBackupTimer', () => {
  it('runOnce backs up and prunes synchronously, and reports what it did', () => {
    const timer = createBackupTimer({ raw: db.raw, config: config(), logger });
    const result = timer.runOnce();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.backup.fileName).toMatch(/^bananasaurs-.*\.db$/);
    expect(listBackups(dir)).toHaveLength(1);
  });

  it('reports failure rather than throwing when the backup cannot be written', () => {
    // A file where the destination directory should be: mkdirSync fails.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a directory');

    const timer = createBackupTimer({ raw: db.raw, config: config(), logger });
    const result = timer.runOnce();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBeTruthy();
  });

  it('start() backs up immediately rather than waiting for the first interval', () => {
    vi.useFakeTimers();
    const timer = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_INTERVAL_MIN: '1440' }),
      logger,
    });

    timer.start();
    expect(listBackups(dir)).toHaveLength(1);

    timer.stop();
  });

  it('start() then schedules the recurring interval at the configured cadence', () => {
    vi.useFakeTimers();
    const timer = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_INTERVAL_MIN: '60' }),
      logger,
    });

    timer.start();
    expect(listBackups(dir)).toHaveLength(1); // the immediate one

    vi.advanceTimersByTime(59 * 60_000);
    expect(listBackups(dir)).toHaveLength(1); // not yet

    vi.advanceTimersByTime(1 * 60_000);
    expect(listBackups(dir)).toHaveLength(2); // the interval fired

    timer.stop();
  });

  it('start() backs up immediately when the newest backup is older than the interval', () => {
    vi.useFakeTimers();
    const setup = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_INTERVAL_MIN: '60' }),
      logger,
    });
    setup.runOnce();
    expect(listBackups(dir)).toHaveLength(1);

    vi.advanceTimersByTime(61 * 60_000);

    const timer = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_INTERVAL_MIN: '60' }),
      logger,
    });
    timer.start();
    expect(listBackups(dir)).toHaveLength(2);

    timer.stop();
  });

  it('start() skips the immediate backup when the newest backup is younger than the interval', () => {
    vi.useFakeTimers();
    const setup = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_INTERVAL_MIN: '1440' }),
      logger,
    });
    setup.runOnce();
    expect(listBackups(dir)).toHaveLength(1);

    // A restart one hour into a 24 h interval: nothing is due for 23 h.
    vi.advanceTimersByTime(60 * 60_000);

    const timer = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_INTERVAL_MIN: '1440' }),
      logger,
    });
    timer.start();
    expect(listBackups(dir)).toHaveLength(1);

    vi.advanceTimersByTime(23 * 60 * 60_000 - 1);
    expect(listBackups(dir)).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(listBackups(dir)).toHaveLength(2);

    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(listBackups(dir)).toHaveLength(3);

    timer.stop();
  });

  it('start() backs up now and keeps the interval when the backup directory cannot be listed', () => {
    vi.useFakeTimers();
    // A regular file where the destination directory should be: listBackups'
    // readdirSync throws ENOTDIR, which must not escape start() and kill the
    // daemon (systemd restart loop) — runOnce logs its own 'backup failed'.
    const badFile = path.join(dir, 'not-a-directory');
    fs.writeFileSync(badFile, 'not a directory');
    const warns: string[] = [];
    const errors: string[] = [];
    const capture = {
      info() {},
      warn(_fields: unknown, msg: string) {
        warns.push(msg);
      },
      error(_fields: unknown, msg: string) {
        errors.push(msg);
      },
      debug() {},
      fatal() {},
      trace() {},
    } as unknown as Logger;

    const timer = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_DIR: badFile, BANANASAURS_BACKUP_INTERVAL_MIN: '60' }),
      logger: capture,
    });
    expect(() => timer.start()).not.toThrow();
    expect(warns).toEqual(['backup: could not list existing backups; backing up now']);
    expect(errors).toEqual(['backup failed']); // the immediate runOnce

    vi.advanceTimersByTime(60 * 60_000);
    expect(errors).toEqual(['backup failed', 'backup failed']); // the recurring tick

    timer.stop();
  });

  it('stop() before the delayed first run means no backup ever appears', () => {
    vi.useFakeTimers();
    const setup = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_INTERVAL_MIN: '1440' }),
      logger,
    });
    setup.runOnce();
    expect(listBackups(dir)).toHaveLength(1);

    vi.advanceTimersByTime(60 * 60_000);

    const timer = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_INTERVAL_MIN: '1440' }),
      logger,
    });
    timer.start();
    timer.stop();
    vi.advanceTimersByTime(48 * 60 * 60_000);

    expect(listBackups(dir)).toHaveLength(1);
  });

  it('stop() cancels the interval, so no further backups appear', () => {
    vi.useFakeTimers();
    const timer = createBackupTimer({
      raw: db.raw,
      config: config({ BANANASAURS_BACKUP_INTERVAL_MIN: '60' }),
      logger,
    });

    timer.start();
    timer.stop();
    vi.advanceTimersByTime(10 * 60 * 60_000);

    expect(listBackups(dir)).toHaveLength(1); // only the immediate one from start()
  });
});
