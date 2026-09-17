import { z } from 'zod';
import { snowflakeIdSchema } from '../../ids.js';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';
import { parseDuration } from './reads.js';

/**
 * The `mcp …` allowlist surface (slice M5, ADR 0044 §4).
 *
 * Four commands over the four `OpsPorts` send members: allowing a channel for
 * MCP sends, removing one, listing the allowlist, and listing recent sends.
 * Guild-scoped throughout — the allowlist is partitioned by guild, so these
 * read `ctx.ports`, not `ctx.instance` (unlike their `mcp clients` neighbours
 * in `mcp.ts`, which are instance-level because a client carries no guild).
 *
 * The `accountId` the allow write records is the operator's claim
 * (`ctx.actor.unixUserClaimed`), the same claim-not-identity `account grant`
 * records as `grantedBy`: the CLI has no verified account to put there (ADR
 * 0024 amendment 2), and `'operator_cli'` when the socket did not name one.
 * Never message content anywhere here: `mcp sends` renders ids and outcomes,
 * and the audit rows name the channel, never what was posted (rule 4).
 */

const iso = (ms: number): string => new Date(ms).toISOString();

const channelIdArg = snowflakeIdSchema;

// --- mcp allow-channel ---------------------------------------------------------

const allowChannelArgs = z.object({ channelId: channelIdArg });

export const mcpAllowChannelCommand = defineCommand<z.infer<typeof allowChannelArgs>>({
  name: 'mcp allow-channel',
  write: true,
  summary: 'allow the MCP connector to post into a channel in this guild',
  positional: [{ name: 'channelId', required: true, describe: 'the channel to allow sends to' }],
  args: allowChannelArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const added = ctx.ports.allowSendChannel({
      channelId: args.channelId,
      accountId: ctx.actor.unixUserClaimed ?? 'operator_cli',
    });

    if (!added) {
      // A usage answer, not a fault — but a write command must return an
      // audit record (the type enforces it), so the row says what happened:
      // the channel was already allowlisted, and nothing changed.
      return {
        text: `channel ${args.channelId} is already allowlisted for MCP sends; nothing changed`,
        data: { channelId: args.channelId, allowed: true, changed: false },
        audit: {
          action: 'mcp.send_channel.allowed',
          subjectType: 'mcp_send_channel',
          subjectId: args.channelId,
          before: { allowed: true },
          after: { allowed: true, changed: false },
        },
      };
    }

    return {
      text: `channel ${args.channelId} may now receive MCP sends`,
      data: { channelId: args.channelId, allowed: true, changed: true },
      audit: {
        action: 'mcp.send_channel.allowed',
        subjectType: 'mcp_send_channel',
        subjectId: args.channelId,
        before: { allowed: false },
        after: { allowed: true, changed: true },
      },
    };
  },
});

// --- mcp disallow-channel ------------------------------------------------------

const disallowChannelArgs = z.object({ channelId: channelIdArg });

export const mcpDisallowChannelCommand = defineCommand<z.infer<typeof disallowChannelArgs>>({
  name: 'mcp disallow-channel',
  write: true,
  summary: "remove a channel from this guild's MCP send allowlist",
  positional: [
    { name: 'channelId', required: true, describe: 'the channel to remove from the allowlist' },
  ],
  args: disallowChannelArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const removed = ctx.ports.disallowSendChannel(args.channelId);

    if (!removed) {
      return {
        text: `channel ${args.channelId} was not allowlisted for MCP sends; nothing changed`,
        data: { channelId: args.channelId, allowed: false, changed: false },
        audit: {
          action: 'mcp.send_channel.disallowed',
          subjectType: 'mcp_send_channel',
          subjectId: args.channelId,
          before: { allowed: false },
          after: { allowed: false, changed: false },
        },
      };
    }

    return {
      text: `channel ${args.channelId} can no longer receive MCP sends`,
      data: { channelId: args.channelId, allowed: false, changed: true },
      audit: {
        action: 'mcp.send_channel.disallowed',
        subjectType: 'mcp_send_channel',
        subjectId: args.channelId,
        before: { allowed: true },
        after: { allowed: false, changed: true },
      },
    };
  },
});

// --- mcp allowlist -------------------------------------------------------------

export const mcpAllowlistCommand = defineCommand<Record<string, never>>({
  name: 'mcp allowlist',
  write: false,
  summary: "the channels this guild's MCP connector may post to",
  args: z.object({}),

  run(ctx: OpsContext): OpsCommandResult {
    const rows = ctx.ports.listSendAllowlist();
    if (rows.length === 0) {
      return { text: 'no channels are allowlisted for MCP sends', data: [] };
    }
    return {
      text: rows
        .map((row) => `${row.channelId}  allowed by ${row.addedByAccountId}  ${iso(row.addedAt)}`)
        .join('\n'),
      data: rows.map((row) => ({
        channelId: row.channelId,
        addedByAccountId: row.addedByAccountId,
        addedAt: row.addedAt,
      })),
    };
  },
});

// --- mcp sends -----------------------------------------------------------------

const sendsArgs = z.object({
  since: z.string().min(1).optional(),
});

export const mcpSendsCommand = defineCommand<z.infer<typeof sendsArgs>>({
  name: 'mcp sends',
  write: false,
  summary:
    'recent MCP sends in this guild, newest first (channels and outcomes only — never content)',
  flags: [{ name: 'since', kind: 'string', describe: 'only sends newer than e.g. 2h, 45m, 7d' }],
  args: sendsArgs,

  run(ctx: OpsContext, args): OpsCommandResult {
    let sinceMs: number | undefined;
    if (args.since !== undefined) {
      const window = parseDuration(args.since);
      if (window === undefined) {
        throw new Error(`--since expects a duration like 2h, 45m or 7d, not "${args.since}"`);
      }
      sinceMs = ctx.now() - window;
    }

    const rows = ctx.ports.listSends({ sinceMs });

    if (rows.length === 0) {
      return {
        text:
          args.since === undefined
            ? 'no MCP sends recorded'
            : `no MCP sends recorded in the last ${args.since}`,
        data: [],
      };
    }
    return {
      text: rows
        .map(
          (row) =>
            `${iso(row.sentAt)}  ${row.outcome}  channel ${row.channelId}  ` +
            `token ${row.tokenId}` +
            `${row.messageId === undefined ? '' : `  message ${row.messageId}`}`,
        )
        .join('\n'),
      data: rows.map((row) => ({
        channelId: row.channelId,
        messageId: row.messageId ?? null,
        tokenId: row.tokenId,
        sentAt: row.sentAt,
        outcome: row.outcome,
      })),
    };
  },
});
