import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { parseConfig, type Config } from '@bananasaurs/core';
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
