import { z } from 'zod';
import { snowflakeIdSchema } from '../../ids.js';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';

/**
 * The `scope read …` surface (ADR 0126).
 *
 * Five commands over the three `OpsPorts` read-scope members: allowing a
 * channel or a category for Read, removing one, and listing the scope.
 * Guild-scoped throughout — the scope is partitioned by guild, so these read
 * `ctx.ports`, not `ctx.instance`.
 *
 * Mirrors `mcp-allowlist.ts` exactly, including the usage-answer shape: an
 * id that is not a channel (or not a category, for the category verbs) of
 * this guild is refused before any write, and the wrong verb on the other
 * kind's row is `wrong-kind`, never a silent delete. Never message content
 * anywhere here: the list renders ids and kinds, and the audit rows name the
 * channel, never what was read (rule 4).
 */

const iso = (ms: number): string => new Date(ms).toISOString();

const channelIdArg = snowflakeIdSchema;

// --- scope read enable-channel -------------------------------------------------

const enableChannelArgs = z.object({ channelId: channelIdArg });

export const readScopeEnableChannelCommand = defineCommand<z.infer<typeof enableChannelArgs>>({
  name: 'scope read enable-channel',
  write: true,
  summary:
    'allow Read in a channel of this guild. Read lets Bananasaurs look up recent messages live from Discord in this channel',
  positional: [{ name: 'channelId', required: true, describe: 'the channel to allow Read in' }],
  args: enableChannelArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.readScopeAllow({ channelId: args.channelId, scopeKind: 'channel' });

    if (outcome === 'no-such-channel') {
      // A usage answer, not a fault — but a write command must return an
      // audit record (the type enforces it), so the row says what happened:
      // the id is not a channel of this guild the bot can read, and nothing
      // changed. A DM-shaped id lands here: a DM is never in the guild's
      // channel cache.
      return {
        text: `channel ${args.channelId} is not a channel of this guild the bot can read; nothing changed`,
        data: { ok: false, reason: 'no-such-channel', channelId: args.channelId },
        audit: {
          action: 'read_scope.allow',
          subjectType: 'read_scope_channel',
          subjectId: args.channelId,
          after: { outcome: 'no-such-channel', channelId: args.channelId },
        },
      };
    }

    if (outcome === 'already-allowed') {
      // A usage answer, not a fault — but a write command must return an
      // audit record (the type enforces it), so the row says what happened:
      // the channel was already readable, and nothing changed.
      return {
        text: `channel ${args.channelId} is already readable by Bananasaurs; nothing changed`,
        data: { channelId: args.channelId, readable: true, changed: false },
        audit: {
          action: 'read_scope.allow',
          subjectType: 'read_scope_channel',
          subjectId: args.channelId,
          before: { readable: true },
          after: { readable: true, changed: false },
        },
      };
    }

    return {
      text: `channel ${args.channelId} may now be read by Bananasaurs`,
      data: { channelId: args.channelId, readable: true, changed: true },
      audit: {
        action: 'read_scope.allow',
        subjectType: 'read_scope_channel',
        subjectId: args.channelId,
        before: { readable: false },
        after: { readable: true, changed: true },
      },
    };
  },
});

// --- scope read disable-channel ------------------------------------------------

const disableChannelArgs = z.object({ channelId: channelIdArg });

export const readScopeDisableChannelCommand = defineCommand<z.infer<typeof disableChannelArgs>>({
  name: 'scope read disable-channel',
  write: true,
  summary:
    "remove a channel from this guild's Read scope. Read lets Bananasaurs look up recent messages live from Discord in this channel",
  positional: [
    { name: 'channelId', required: true, describe: 'the channel to remove from the Read scope' },
  ],
  args: disableChannelArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.readScopeDisallow({
      channelId: args.channelId,
      scopeKind: 'channel',
    });

    if (outcome === 'wrong-kind') {
      return {
        text: `channel ${args.channelId} is readable as a category; use scope read disable-category`,
        data: { channelId: args.channelId, readable: true, changed: false },
        audit: {
          action: 'read_scope.disallow',
          subjectType: 'read_scope_channel',
          subjectId: args.channelId,
          before: { readable: true },
          after: { readable: true, changed: false },
        },
      };
    }

    if (outcome === 'not-allowed') {
      return {
        text: `channel ${args.channelId} was not readable by Bananasaurs; nothing changed`,
        data: { channelId: args.channelId, readable: false, changed: false },
        audit: {
          action: 'read_scope.disallow',
          subjectType: 'read_scope_channel',
          subjectId: args.channelId,
          before: { readable: false },
          after: { readable: false, changed: false },
        },
      };
    }

    return {
      text: `channel ${args.channelId} is no longer readable by Bananasaurs`,
      data: { channelId: args.channelId, readable: false, changed: true },
      audit: {
        action: 'read_scope.disallow',
        subjectType: 'read_scope_channel',
        subjectId: args.channelId,
        before: { readable: true },
        after: { readable: false, changed: true },
      },
    };
  },
});

// --- scope read list -----------------------------------------------------------

export const readScopeListCommand = defineCommand<Record<string, never>>({
  name: 'scope read list',
  write: false,
  summary:
    "the channels this guild's assistant may read. Read lets Bananasaurs look up recent messages live from Discord in this channel",
  args: z.object({}),

  run(ctx: OpsContext): OpsCommandResult {
    const rows = ctx.ports.readScopeList();
    if (rows.length === 0) {
      return { text: 'no channels are readable by Bananasaurs', data: [] };
    }
    return {
      text: rows
        .map(
          (row) =>
            `${row.channelId}  ${row.scopeKind === 'category' ? 'category  ' : ''}${iso(row.addedAt)}`,
        )
        .join('\n'),
      data: rows.map((row) => ({
        channelId: row.channelId,
        scopeKind: row.scopeKind,
        addedAt: row.addedAt,
      })),
    };
  },
});

const categoryArgs = z.object({ channelId: channelIdArg });

export const readScopeEnableCategoryCommand = defineCommand<z.infer<typeof categoryArgs>>({
  name: 'scope read enable-category',
  write: true,
  summary:
    'allow Read in channels dynamically covered by a category. Read lets Bananasaurs look up recent messages live from Discord in this channel',
  positional: [{ name: 'channelId', required: true, describe: 'the category to allow' }],
  args: categoryArgs,
  run(ctx, args): OpsWriteResult {
    const outcome = ctx.ports.readScopeAllow({ channelId: args.channelId, scopeKind: 'category' });
    if (outcome === 'no-such-channel') {
      return {
        text: `category ${args.channelId} is not a category of this guild; nothing changed`,
        data: { ok: false, reason: 'no-such-channel', channelId: args.channelId },
        audit: {
          action: 'read_scope.allow',
          subjectType: 'read_scope_category',
          subjectId: args.channelId,
          after: { outcome: 'no-such-channel', channelId: args.channelId },
        },
      };
    }
    return {
      text:
        outcome === 'allowed'
          ? `category ${args.channelId} may now authorize Read`
          : `category ${args.channelId} is already readable; nothing changed`,
      data: { channelId: args.channelId, outcome },
      audit: {
        action: 'read_scope.allow',
        subjectType: 'read_scope_category',
        subjectId: args.channelId,
        after: { outcome },
      },
    };
  },
});

export const readScopeDisableCategoryCommand = defineCommand<z.infer<typeof categoryArgs>>({
  name: 'scope read disable-category',
  write: true,
  summary:
    'remove a category from the Read scope. Read lets Bananasaurs look up recent messages live from Discord in this channel',
  positional: [{ name: 'channelId', required: true, describe: 'the category to remove' }],
  args: categoryArgs,
  run(ctx, args): OpsWriteResult {
    const outcome = ctx.ports.readScopeDisallow({
      channelId: args.channelId,
      scopeKind: 'category',
    });
    return {
      text:
        outcome === 'removed'
          ? `category ${args.channelId} can no longer authorize Read`
          : outcome === 'wrong-kind'
            ? `category ${args.channelId} is readable as a channel; use scope read disable-channel`
            : `category ${args.channelId} was not readable; nothing changed`,
      data: { channelId: args.channelId, removed: outcome === 'removed' },
      audit: {
        action: 'read_scope.disallow',
        subjectType: 'read_scope_category',
        subjectId: args.channelId,
        after: { removed: outcome === 'removed' },
      },
    };
  },
});
