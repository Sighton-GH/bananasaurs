import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { archiveExpiryPayload } from '../jobs/kinds.js';
import { archiveExpiryHandler, type ExpiryPorts } from './expiry.js';

/**
 * The expiry job's own tests (Slice M1 Task 5, Step 2).
 *
 * Ports faked, one run at a time: the handler passes the current time to
 * `expireContent` and logs the purged count. The 30-day boundary itself is
 * proven end-to-end against the real repository — `archiveRepo.expireContent`
 * on the test database — in `apps/daemon/src/runtime/
 * archive-expiry-timer.test.ts`, which is where `core`'s boundary
 * (`packages/core` may not import `@bananasaurs/storage`, ADR 0014,
 * eslint-enforced) still allows a database to be reached. Task 3's
 * `packages/storage/src/repos/archive.test.ts` pins the same boundary at the
 * repository level.
 */

const NOW = 1_700_000_000_000;

/** A real pino instance over a captured stream, so the log fields are asserted, not mocked. */
const capturingLogger = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    logger: pino({ level: 'info' }, stream),
    records(): readonly Record<string, unknown>[] {
      return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
};

const harness = (over: { now?: number; purged?: number } = {}) => {
  const seen: number[] = [];
  const capture = capturingLogger();
  const ports: ExpiryPorts = {
    expireContent: (now) => {
      seen.push(now);
      return over.purged ?? 0;
    },
    now: () => over.now ?? NOW,
    logger: capture.logger,
  };
  return { ports, seen, records: () => capture.records() };
};

describe('archive expiry payload', () => {
  it('accepts a UTC day and refuses anything else', () => {
    expect(archiveExpiryPayload.parse({ day: '2026-09-13' })).toEqual({ day: '2026-09-13' });
    expect(() => archiveExpiryPayload.parse({ day: '2026-9-13' })).toThrow();
    expect(() => archiveExpiryPayload.parse({ day: 'not-a-day' })).toThrow();
    expect(() => archiveExpiryPayload.parse({})).toThrow();
  });
});

describe('archive expiry run', () => {
  it('expires at the current time and logs the job kind with the purged count', async () => {
    const h = harness({ purged: 3 });
    const handler = archiveExpiryHandler(h.ports);

    await handler.run({ day: '2026-09-13' }, { jobId: 1, attempts: 1, cursor: null, saveCursor: () => {} });

    expect(h.seen).toEqual([NOW]);
    const logged = h.records().find((r) => r['msg'] === 'archive: expiry run purged deleted content');
    expect(logged).toMatchObject({ jobKind: 'archive_expiry', count: 3 });
    // Rule 4: no member content, no channel — the only fields are the allowlisted ones.
    expect(logged?.['content']).toBeUndefined();
  });

  it('logs a zero count when nothing was due', async () => {
    const h = harness({ purged: 0 });

    await archiveExpiryHandler(h.ports).run(
      { day: '2026-09-13' },
      { jobId: 1, attempts: 1, cursor: null, saveCursor: () => {} },
    );

    const logged = h.records().find((r) => r['msg'] === 'archive: expiry run purged deleted content');
    expect(logged).toMatchObject({ jobKind: 'archive_expiry', count: 0 });
  });
});
