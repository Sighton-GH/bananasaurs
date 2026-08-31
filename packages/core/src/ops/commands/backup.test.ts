import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditWrite, OpsBackupListing, OpsBackupRunResult, OpsInstance } from '../ports.js';
import { backupListCommand, backupNowCommand } from './backup.js';
import { OPERATOR_COMMANDS } from '../registry.js';

const NOW = 1_700_000_000_000;

const SUCCESS: OpsBackupRunResult = {
  ok: true,
  fileName: 'bananasaurs-20260830T153702123Z.db',
  sizeBytes: 12_345,
  sha256: 'a'.repeat(64),
  prunedCount: 0,
};

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(command: string, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
}

const harness = (over: Partial<OpsInstance> = {}): Harness => {
  const audit: OpsAuditWrite[] = [];
  const dispatcher = createDispatcher({
    commands: [backupNowCommand, backupListCommand],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts({
        recordAudit: (input) => {
          audit.push(input);
        },
      }),
    }),
    instance: fakeOpsInstance({
      backupNow: () => SUCCESS,
      backupList: () => [],
      ...over,
    }),
  });
  return {
    audit,
    run: (command, confirm = true) => dispatcher.dispatch({ v: 1, command, args: {}, confirm }),
  };
};

describe('backup now / backup list are registered on the operator surface (ADR 0034)', () => {
  it('both appear in the command list', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toEqual(
      expect.arrayContaining(['backup now', 'backup list']),
    );
  });

  it('backup now is a write; backup list is not', () => {
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'backup now')?.write).toBe(true);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'backup list')?.write).toBe(false);
  });

  it('there is no restore command — restore never runs against a live daemon', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).not.toContain('backup restore');
    expect(OPERATOR_COMMANDS.map((c) => c.name).some((n) => n.includes('restore'))).toBe(false);
  });
});

describe('backup now', () => {
  it('refuses without --confirm', async () => {
    const h = harness();
    const response = await h.run('backup now', false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
  });

  it('reports the filename, size and checksum on success', async () => {
    const h = harness();
    const response = await h.run('backup now');
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain(SUCCESS.fileName);
    expect(response.ok && response.text).toContain(SUCCESS.sha256);
  });

  it('records an audit row naming the file that was written', async () => {
    const h = harness();
    await h.run('backup now');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]?.action).toBe('backup.created');
    expect(h.audit[0]?.subjectType).toBe('instance');
    expect(JSON.stringify(h.audit[0]?.after)).toContain(SUCCESS.fileName);
  });

  it('mentions retention when backups were pruned', async () => {
    const h = harness({ backupNow: () => ({ ...SUCCESS, prunedCount: 3 }) });
    const response = await h.run('backup now');
    expect(response.ok && response.text).toContain('removed 3 older backup(s)');
  });

  it('says retention removed nothing when it did not prune', async () => {
    const h = harness();
    const response = await h.run('backup now');
    expect(response.ok && response.text).toContain('retention removed nothing');
  });

  it('fails without an audit row when the backup itself failed', async () => {
    const h = harness({ backupNow: () => ({ ok: false, error: 'disk full' }) });
    const response = await h.run('backup now');
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('disk full');
    expect(h.audit).toHaveLength(0);
  });
});

describe('backup list', () => {
  const listing: OpsBackupListing = {
    fileName: 'bananasaurs-20260830T153702123Z.db',
    sizeBytes: 2048,
    createdAtMs: NOW,
    hasChecksum: true,
  };

  it('says so plainly when there are no backups yet', async () => {
    const h = harness({ backupList: () => [] });
    const response = await h.run('backup list');
    expect(response.ok && response.text).toMatch(/no backups yet/i);
  });

  it('lists each backup with its filename and size', async () => {
    const h = harness({ backupList: () => [listing] });
    const response = await h.run('backup list');
    expect(response.ok && response.text).toContain(listing.fileName);
  });

  it('flags a backup missing its checksum sidecar', async () => {
    const h = harness({ backupList: () => [{ ...listing, hasChecksum: false }] });
    const response = await h.run('backup list');
    expect(response.ok && response.text).toContain('MISSING CHECKSUM');
  });

  it('does not flag a backup that has its checksum', async () => {
    const h = harness({ backupList: () => [listing] });
    const response = await h.run('backup list');
    expect(response.ok && response.text).not.toContain('MISSING CHECKSUM');
  });

  it('never asks for --confirm, since nothing changes', async () => {
    const h = harness({ backupList: () => [listing] });
    const response = await h.run('backup list', false);
    expect(response.ok).toBe(true);
  });
});
