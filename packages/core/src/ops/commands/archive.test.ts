import { describe, expect, it, vi } from 'vitest';
import { createDispatcher, type RegisteredCommand } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsPorts } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import {
  archiveDisableChannelCommand,
  archiveEnableChannelCommand,
  archiveLinkCaseCommand,
  archivePreserveCommand,
  archiveStatusCommand,
} from './archive.js';

const NOW = 1_700_000_000_000;
const CHANNEL = '222222222222222222';
const MESSAGE = '333333333333333333';

const drive = (
  command: RegisteredCommand,
  ports: Partial<OpsPorts>,
  args: Record<string, unknown> = {},
) =>
  createDispatcher({
    commands: [command],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts(ports),
    }),
    instance: fakeOpsInstance(),
  }).dispatch({ v: 1, command: command.name, args });

/**
 * Like `drive`, but for a write command: carries `--confirm` and the
 * claimed Unix user through to the dispatcher, the way
 * `automod.test.ts`'s `driveWrite` does — so a test also exercises the
 * machinery's own guarantees rather than calling `run` directly.
 */
const driveWrite = (
  command: RegisteredCommand,
  ports: Partial<OpsPorts>,
  args: Record<string, unknown> = {},
) =>
  createDispatcher({
    commands: [command],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts(ports),
    }),
    instance: fakeOpsInstance(),
  }).dispatch({ v: 1, command: command.name, args, confirm: true, unixUserClaimed: 'bryan' });

describe('archive commands are registered', () => {
  it('registers all five archive commands', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('archive enable-channel');
    expect(names).toContain('archive disable-channel');
    expect(names).toContain('archive status');
    expect(names).toContain('archive preserve');
    expect(names).toContain('archive link-case');
  });
});

describe('archive enable-channel', () => {
  it('enables the channel, enqueues its backfill, and audits the write', async () => {
    const audit: unknown[] = [];
    const backfilled: string[] = [];
    const res = await driveWrite(
      archiveEnableChannelCommand,
      {
        archiveEnableChannel: () => 'enabled',
        enqueueArchiveBackfill: (channelId) => {
          backfilled.push(channelId);
        },
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { channelId: CHANNEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain(CHANNEL);
    expect(res.text).toContain('backfill queued');
    expect(res.data).toMatchObject({ ok: true, channelId: CHANNEL, attachmentPolicy: 'none' });
    expect(backfilled).toEqual([CHANNEL]);
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'archive.channel_enabled',
        subjectType: 'archive_channel',
        subjectId: CHANNEL,
        after: { channelId: CHANNEL, attachmentPolicy: 'none' },
      }),
    ]);
  });

  it('passes an explicit --attachments none through to the port', async () => {
    let seen: unknown;
    const res = await driveWrite(
      archiveEnableChannelCommand,
      {
        archiveEnableChannel: (input) => {
          seen = input;
          return 'enabled';
        },
        enqueueArchiveBackfill: () => {},
        recordAudit: () => {},
      },
      { channelId: CHANNEL, attachments: 'none' },
    );
    expect(res.ok).toBe(true);
    expect(seen).toEqual({ channelId: CHANNEL, attachmentPolicy: 'none' });
  });

  it('refuses --attachments bytes before the port is ever called', async () => {
    const enable = vi.fn(() => 'enabled' as const);
    const backfill = vi.fn();
    const res = await driveWrite(
      archiveEnableChannelCommand,
      {
        archiveEnableChannel: enable,
        enqueueArchiveBackfill: backfill,
        recordAudit: () => {},
      },
      { channelId: CHANNEL, attachments: 'bytes' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'attachments-bytes-not-built' });
    expect(res.text).toContain('not built yet');
    // PR-67: `bytes` never reaches the port, so no `bytes` row can exist.
    expect(enable).not.toHaveBeenCalled();
    expect(backfill).not.toHaveBeenCalled();
  });

  it('refuses a guild that is not archive-enabled, naming the variable', async () => {
    const backfill = vi.fn();
    const res = await driveWrite(
      archiveEnableChannelCommand,
      {
        archiveEnableChannel: () => 'guild-not-archive-enabled',
        enqueueArchiveBackfill: backfill,
        recordAudit: () => {},
      },
      { channelId: CHANNEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      ok: false,
      reason: 'guild-not-archive-enabled',
      guildId: FIXTURE_GUILD_ID,
      variable: 'BANANASAURS_ARCHIVE_GUILDS',
    });
    expect(res.text).toContain('BANANASAURS_ARCHIVE_GUILDS');
    expect(backfill).not.toHaveBeenCalled();
  });

  it('reports already-enabled without queueing a second backfill', async () => {
    const backfill = vi.fn();
    const audit: unknown[] = [];
    const res = await driveWrite(
      archiveEnableChannelCommand,
      {
        archiveEnableChannel: () => 'already-enabled',
        enqueueArchiveBackfill: backfill,
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { channelId: CHANNEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'already-enabled' });
    expect(backfill).not.toHaveBeenCalled();
    // The dispatcher records every write-command invocation, even a no-op —
    // "no audit" would need a command the dispatcher cannot see.
    expect(audit).toHaveLength(1);
  });
});

describe('archive disable-channel', () => {
  it('disables the channel and audits the write', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      archiveDisableChannelCommand,
      {
        archiveDisableChannel: () => 'disabled',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { channelId: CHANNEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, channelId: CHANNEL });
    expect(audit).toEqual([
      expect.objectContaining({ action: 'archive.channel_disabled', subjectId: CHANNEL }),
    ]);
  });

  it('reports not-enabled as a usage answer', async () => {
    const res = await driveWrite(
      archiveDisableChannelCommand,
      {
        archiveDisableChannel: () => 'not-enabled',
        recordAudit: () => {},
      },
      { channelId: CHANNEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'not-enabled' });
  });
});

describe('archive status', () => {
  it('is a read, so it needs no --confirm', () => {
    expect(archiveStatusCommand.write).toBe(false);
  });

  it('prints one line per channel with backfill state, cursor and count', async () => {
    const res = await drive(
      archiveStatusCommand,
      {
        archiveStatus: () => [
          {
            channelId: CHANNEL,
            attachmentPolicy: 'none',
            enabledAt: NOW,
            cursorMessageId: undefined,
            backfillState: 'pending',
            messageCount: 0,
          },
          {
            channelId: '444444444444444444',
            attachmentPolicy: 'none',
            enabledAt: NOW,
            cursorMessageId: '555555555555555555',
            backfillState: 'running',
            messageCount: 120,
          },
        ],
      },
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain(`${CHANNEL}  none  backfill:pending  cursor:-  messages:0`);
    expect(res.text).toContain(
      '444444444444444444  none  backfill:running  cursor:555555555555555555  messages:120',
    );
  });

  it('says so plainly when no channel is enabled', async () => {
    const res = await drive(archiveStatusCommand, { archiveStatus: () => [] }, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('no archive channels are enabled');
  });
});

describe('archive preserve', () => {
  it('preserves the message and audits with the message as the subject', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      archivePreserveCommand,
      {
        archivePreserve: () => 'preserved',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { messageId: MESSAGE },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, messageId: MESSAGE });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'archive.message_preserved',
        subjectType: 'archive_message',
        subjectId: MESSAGE,
      }),
    ]);
  });

  it.each([['no-such-message'], ['already-preserved']] as const)(
    'reports %s as a usage answer',
    async (reason) => {
      const res = await driveWrite(
        archivePreserveCommand,
        {
          archivePreserve: () => reason,
          recordAudit: () => {},
        },
        { messageId: MESSAGE },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data).toMatchObject({ ok: false, reason });
    },
  );
});

describe('archive link-case', () => {
  it('links the message and audits with the case in `after`', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      archiveLinkCaseCommand,
      {
        archiveLinkCase: () => 'linked',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { messageId: MESSAGE, caseId: 'case-1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, messageId: MESSAGE, caseId: 'case-1' });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'archive.message_linked_to_case',
        subjectType: 'archive_message',
        subjectId: MESSAGE,
        after: { caseId: 'case-1' },
      }),
    ]);
  });

  it.each([['no-such-message'], ['no-such-case'], ['case-closed'], ['already-linked']] as const)(
    'reports %s as a usage answer',
    async (reason) => {
      const res = await driveWrite(
        archiveLinkCaseCommand,
        {
          archiveLinkCase: () => reason,
          recordAudit: () => {},
        },
        { messageId: MESSAGE, caseId: 'case-1' },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data).toMatchObject({ ok: false, reason });
    },
  );
});
