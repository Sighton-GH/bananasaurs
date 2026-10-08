import { z } from 'zod';
import { snowflakeIdSchema } from '../../ids.js';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';
import { parseDuration } from './reads.js';
import { OPS_AUDIT_ACTIONS } from '../audit-actions.js';

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

/**
 * Owner decision 2026-10-03: rows the Write seed wrote carry no human
 * author. The sentinel value is `WRITE_SEED_ACCOUNT_ID` in
 * `packages/storage/src/repos/mcp-send.ts` (compared by value here —
 * `core` must not import `storage`); it renders as `Initial setup`, never
 * as the raw id.
 */
export const formatSendAllowlistAddedBy = (addedByAccountId: string): string =>
  addedByAccountId === 'system:write-seed' ? 'Initial setup' : addedByAccountId;

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
    const outcome = ctx.ports.allowSendChannel({
      channelId: args.channelId,
      accountId: ctx.actor.unixUserClaimed ?? 'operator_cli',
    });

    if (outcome === 'no-such-channel') {
      // A usage answer, not a fault — but a write command must return an
      // audit record (the type enforces it), so the row says what happened:
      // the id is not a channel of this guild the bot can post text into,
      // and nothing changed. A DM-shaped id lands here: a DM is never in the
      // guild's channel cache.
      return {
        text: `channel ${args.channelId} is not a channel of this guild the bot can post text into; nothing changed`,
        data: { ok: false, reason: 'no-such-channel', channelId: args.channelId },
        audit: {
          action: OPS_AUDIT_ACTIONS.mcpSendChannelAllowed,
          subjectType: 'mcp_send_channel',
          subjectId: args.channelId,
          after: { outcome: 'no-such-channel', channelId: args.channelId },
        },
      };
    }

    if (outcome === 'already-allowed') {
      // A usage answer, not a fault — but a write command must return an
      // audit record (the type enforces it), so the row says what happened:
      // the channel was already allowlisted, and nothing changed.
      return {
        text: `channel ${args.channelId} is already allowlisted for MCP sends; nothing changed`,
        data: { channelId: args.channelId, allowed: true, changed: false },
        audit: {
          action: OPS_AUDIT_ACTIONS.mcpSendChannelAllowed,
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
        action: OPS_AUDIT_ACTIONS.mcpSendChannelAllowed,
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
    const outcome = ctx.ports.disallowSendChannel(args.channelId);

    if (outcome === 'wrong-kind') {
      return {
        text: `channel ${args.channelId} is allowlisted as a category; use mcp disallow-category`,
        data: { channelId: args.channelId, allowed: true, changed: false },
        audit: {
          action: OPS_AUDIT_ACTIONS.mcpSendChannelDisallowed,
          subjectType: 'mcp_send_channel',
          subjectId: args.channelId,
          before: { allowed: true },
          after: { allowed: true, changed: false },
        },
      };
    }

    if (outcome === 'not-allowed') {
      return {
        text: `channel ${args.channelId} was not allowlisted for MCP sends; nothing changed`,
        data: { channelId: args.channelId, allowed: false, changed: false },
        audit: {
          action: OPS_AUDIT_ACTIONS.mcpSendChannelDisallowed,
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
        action: OPS_AUDIT_ACTIONS.mcpSendChannelDisallowed,
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
        .map(
          (row) =>
            `${row.channelId}  ${row.scopeKind === 'category' ? `category, covers ${String(row.coverage ?? ctx.ports.sendScopeCoverage(row.channelId))} channels  ` : ''}allowed by ${formatSendAllowlistAddedBy(row.addedByAccountId)}  ${iso(row.addedAt)}`,
        )
        .join('\n'),
      // scopeKind and coverage ride the JSON exactly as the text line
      // renders them (review M4): a category row's blast radius must be
      // machine-readable, not text-only.
      data: rows.map((row) => ({
        channelId: row.channelId,
        addedByAccountId: row.addedByAccountId,
        addedAt: row.addedAt,
        scopeKind: row.scopeKind ?? 'channel',
        // A channel row covers exactly itself; only a category needs the
        // live coverage count.
        coverage:
          row.coverage ??
          ((row.scopeKind ?? 'channel') === 'category'
            ? ctx.ports.sendScopeCoverage(row.channelId)
            : 1),
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
    // N4: the ledger's outcome CHECK admits only `sent` and `dry_run`, so the
    // claim written before the Discord call stays `sent` when the call throws
    // — the `failed` outcome lives only in the audit trail. A `sent` row with
    // no message id must not render as a plain success: no migration, just
    // honest text and a note saying what the row means.
    const unconfirmed = rows.some((row) => row.outcome === 'sent' && row.messageId === undefined);
    const lines = rows.map((row) => {
      const outcome =
        row.outcome === 'sent' && row.messageId === undefined
          ? 'sent (no message id recorded)'
          : row.outcome;
      return (
        `${iso(row.sentAt)}  ${outcome}  channel ${row.channelId}  ` +
        `token ${row.tokenId}` +
        `${row.messageId === undefined ? '' : `  message ${row.messageId}`}`
      );
    });
    if (unconfirmed) {
      lines.push(
        "A 'sent (no message id recorded)' row means the Discord call did not return a message id, " +
          'so the message may or may not have posted.',
      );
    }
    return {
      text: lines.join('\n'),
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

const categoryArgs = z.object({ channelId: channelIdArg });

export const mcpAllowCategoryCommand = defineCommand<z.infer<typeof categoryArgs>>({
  name: 'mcp allow-category',
  write: true,
  summary: 'allow MCP sends to channels dynamically covered by a category',
  positional: [{ name: 'channelId', required: true, describe: 'the category to allow' }],
  args: categoryArgs,
  run(ctx, args): OpsWriteResult {
    const outcome = ctx.ports.allowSendCategory({
      channelId: args.channelId,
      accountId: ctx.actor.unixUserClaimed ?? 'operator_cli',
    });
    if (outcome === 'no-such-channel') {
      return {
        text: `category ${args.channelId} is not a category of this guild; nothing changed`,
        data: { ok: false, reason: 'no-such-channel', channelId: args.channelId },
        audit: {
          action: OPS_AUDIT_ACTIONS.mcpSendCategoryAllowed,
          subjectType: 'mcp_send_category',
          subjectId: args.channelId,
          after: { outcome: 'no-such-channel', channelId: args.channelId },
        },
      };
    }
    return {
      text:
        outcome === 'allowed'
          ? `category ${args.channelId} may now authorize MCP sends`
          : `category ${args.channelId} is already allowlisted; nothing changed`,
      data: { channelId: args.channelId, outcome },
      audit: {
        action: OPS_AUDIT_ACTIONS.mcpSendCategoryAllowed,
        subjectType: 'mcp_send_category',
        subjectId: args.channelId,
        after: { outcome },
      },
    };
  },
});

export const mcpDisallowCategoryCommand = defineCommand<z.infer<typeof categoryArgs>>({
  name: 'mcp disallow-category',
  write: true,
  summary: 'remove a category from the MCP send allowlist',
  positional: [{ name: 'channelId', required: true, describe: 'the category to remove' }],
  args: categoryArgs,
  run(ctx, args): OpsWriteResult {
    const outcome = ctx.ports.disallowSendCategory(args.channelId);
    return {
      text:
        outcome === 'removed'
          ? `category ${args.channelId} can no longer authorize MCP sends`
          : outcome === 'wrong-kind'
            ? `category ${args.channelId} is allowlisted as a channel; use mcp disallow-channel`
            : `category ${args.channelId} was not allowlisted; nothing changed`,
      data: { channelId: args.channelId, removed: outcome === 'removed' },
      audit: {
        action: OPS_AUDIT_ACTIONS.mcpSendCategoryDisallowed,
        subjectType: 'mcp_send_category',
        subjectId: args.channelId,
        after: { removed: outcome === 'removed' },
      },
    };
  },
});
