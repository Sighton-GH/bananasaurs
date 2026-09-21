import { and, eq } from 'drizzle-orm';
import {
  parseSnowflakeId,
  type AdoptionPassState,
  type PanelBehaviour,
  type PanelComponent,
  type PanelConfig,
  type PanelDefinition,
  type PanelKind,
  type PanelOption,
  type PanelStatus,
} from '@bananasaurs/core';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { panelBlockedRoles, panelOptions, panels } from '../schema.js';

/**
 * Panels, their options and their blocked roles.
 *
 * Three tables, one aggregate. Nothing outside this module assembles a
 * `PanelConfig` from parts, because a panel read without its options is a panel
 * that converges to "revoke everything" — the diff would see an empty desired
 * set and a member holding roles.
 *
 * Every function takes a `GuildScope` first, like every repository here. The
 * composite foreign keys `(guild_id, panel_id)` mean an option cannot belong to
 * another guild's panel even if a caller tried.
 *
 * **A write takes a `PanelDefinition`**, which is the output type of
 * `panelDefinitionSchema` and cannot be produced by an object literal without
 * parsing. So a panel arriving from the CLI, the dashboard or a config file
 * passes the validator before it can reach SQL (`CLAUDE.md` rule 3), and the
 * owner gets the explanation rather than SQLITE_CONSTRAINT_CHECK.
 */

const asOption = (row: {
  optionId: string;
  roleId: string;
  emojiKey: string | null;
  label: string | null;
  position: number;
}): PanelOption => ({
  optionId: row.optionId,
  // A row written by an older version of this process is input from outside
  // this function, exactly like a form submission. Parsed, not asserted.
  roleId: parseSnowflakeId(row.roleId),
  emojiKey: row.emojiKey ?? undefined,
  label: row.label ?? undefined,
  position: row.position,
});

const optionColumns = {
  optionId: panelOptions.optionId,
  roleId: panelOptions.roleId,
  emojiKey: panelOptions.emojiKey,
  label: panelOptions.label,
  position: panelOptions.position,
};

const panelColumns = {
  panelId: panels.panelId,
  kind: panels.kind,
  channelId: panels.channelId,
  messageId: panels.messageId,
  content: panels.content,
  behaviour: panels.behaviour,
  component: panels.component,
  maxRoles: panels.maxRoles,
  requiredRoleId: panels.requiredRoleId,
  status: panels.status,
  adoptionPassState: panels.adoptionPassState,
  adoptionBlockedCount: panels.adoptionBlockedCount,
};

type PanelHeaderRow = {
  panelId: string;
  kind: string;
  channelId: string;
  messageId: string | null;
  content: string | null;
  behaviour: string;
  component: string;
  maxRoles: number | null;
  requiredRoleId: string | null;
  status: string;
  adoptionPassState: string;
  adoptionBlockedCount: number;
};

/**
 * Assembles one panel from its three tables.
 *
 * Two extra queries per panel rather than a join, deliberately: a join across
 * options and blocked roles multiplies rows and needs de-duplicating in code,
 * which is where the bug would be. Release 1 has a handful of panels.
 */
const hydrate = (scope: GuildScope, row: PanelHeaderRow): PanelConfig =>
  read(scope, (db) => {
    const options = db
      .select(optionColumns)
      .from(panelOptions)
      .where(scope.only(panelOptions, eq(panelOptions.panelId, row.panelId)))
      .all()
      .map(asOption);

    const blocked = db
      .select({ roleId: panelBlockedRoles.roleId })
      .from(panelBlockedRoles)
      .where(scope.only(panelBlockedRoles, eq(panelBlockedRoles.panelId, row.panelId)))
      .all()
      .map((b) => parseSnowflakeId(b.roleId));

    return {
      panelId: row.panelId,
      kind: row.kind as PanelKind,
      channelId: parseSnowflakeId(row.channelId),
      messageId: row.messageId === null ? undefined : parseSnowflakeId(row.messageId),
      content: row.content ?? undefined,
      behaviour: row.behaviour as PanelBehaviour,
      component: row.component as PanelComponent,
      maxRoles: row.maxRoles ?? undefined,
      requiredRoleId:
        row.requiredRoleId === null ? undefined : parseSnowflakeId(row.requiredRoleId),
      blockedRoleIds: blocked,
      status: row.status as PanelStatus,
      adoptionPassState: row.adoptionPassState as AdoptionPassState,
      adoptionBlockedCount: row.adoptionBlockedCount,
      options,
    };
  });

/**
 * Creates a panel, its options and its blocked roles atomically.
 *
 * One `write()`, so a panel is never visible with half its options. That is not
 * tidiness: a panel read mid-insert has a smaller desired set than it should,
 * and convergence would revoke the roles whose options had not landed yet.
 */
export const createPanel = (scope: GuildScope, definition: PanelDefinition, now: number): void =>
  write(scope, ({ db }) => {
    db.insert(panels)
      .values({
        guildId: scope.guildId,
        panelId: definition.panelId,
        kind: definition.kind,
        channelId: definition.channelId,
        messageId: definition.messageId ?? null,
        content: definition.content ?? null,
        behaviour: definition.behaviour,
        component: definition.component,
        maxRoles: definition.maxRoles ?? null,
        requiredRoleId: definition.requiredRoleId ?? null,
        // An adopted panel has existing reactions that are not yet roles, so it
        // starts owing an adoption pass. A managed panel is posted empty and
        // has nothing to adopt.
        adoptionPassState: definition.kind === 'adopted' ? 'pending' : 'done',
        // Nothing has run yet, so nothing is known to be blocked (ADR 0021).
        adoptionBlockedCount: 0,
        adoptedAt: definition.kind === 'adopted' ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    for (const option of definition.options) {
      db.insert(panelOptions)
        .values({
          guildId: scope.guildId,
          panelId: definition.panelId,
          optionId: option.optionId,
          roleId: option.roleId,
          emojiKey: option.emojiKey ?? null,
          label: option.label ?? null,
          position: option.position,
        })
        .run();
    }

    for (const roleId of definition.blockedRoleIds) {
      db.insert(panelBlockedRoles)
        .values({ guildId: scope.guildId, panelId: definition.panelId, roleId })
        .run();
    }
  });

export const findPanel = (scope: GuildScope, panelId: string): PanelConfig | undefined => {
  const row = read(scope, (db) =>
    db
      .select(panelColumns)
      .from(panels)
      .where(scope.only(panels, eq(panels.panelId, panelId)))
      .get(),
  );
  return row ? hydrate(scope, row) : undefined;
};

/**
 * The lookup a reaction event performs: which panel, if any, lives on this
 * message.
 *
 * Backed by `panels_message_once`, the unique index on
 * `(guild_id, channel_id, message_id)` — a message hosts at most one panel, so
 * this cannot return two.
 */
export const findPanelByMessage = (
  scope: GuildScope,
  channelId: string,
  messageId: string,
): PanelConfig | undefined => {
  const row = read(scope, (db) =>
    db
      .select(panelColumns)
      .from(panels)
      .where(
        scope.only(panels, and(eq(panels.channelId, channelId), eq(panels.messageId, messageId))),
      )
      .get(),
  );
  return row ? hydrate(scope, row) : undefined;
};

export const listPanels = (scope: GuildScope): PanelConfig[] => {
  const rows = read(scope, (db) =>
    db.select(panelColumns).from(panels).where(scope.only(panels)).all(),
  );
  return rows.map((row) => hydrate(scope, row));
};

/** Adopted panels are the ones that miss events while offline and need repair. */
export const listAdoptedPanels = (scope: GuildScope): PanelConfig[] => {
  const rows = read(scope, (db) =>
    db
      .select(panelColumns)
      .from(panels)
      .where(scope.only(panels, eq(panels.kind, 'adopted')))
      .all(),
  );
  return rows.map((row) => hydrate(scope, row));
};

/** Set once a managed panel has been posted and has a message to listen on. */
export const setPanelMessage = (
  scope: GuildScope,
  panelId: string,
  messageId: string,
  now: number,
): void =>
  write(scope, ({ db }) => {
    db.update(panels)
      .set({ messageId, updatedAt: now })
      .where(scope.only(panels, eq(panels.panelId, panelId)))
      .run();
  });

/**
 * Layer 4 of the effect gateway reads this. A disabled panel refuses every
 * effect it would produce, which is how the doctor takes a broken panel out of
 * service without deleting the configuration.
 */
export const setPanelStatus = (
  scope: GuildScope,
  panelId: string,
  status: PanelStatus,
  reason: string | undefined,
  now: number,
): void =>
  write(scope, ({ db }) => {
    db.update(panels)
      .set({ status, disabledReason: reason ?? null, updatedAt: now })
      .where(scope.only(panels, eq(panels.panelId, panelId)))
      .run();
  });

/**
 * `blockedCount` is a required parameter, not optional: the two fields must
 * move together (ADR 0021) or `reconcileGuild`'s selection reads a stale
 * count against a fresh state. Pass `0` explicitly wherever nothing is known
 * to be blocked.
 */
export const setAdoptionPassState = (
  scope: GuildScope,
  panelId: string,
  state: AdoptionPassState,
  blockedCount: number,
  now: number,
): void =>
  write(scope, ({ db }) => {
    db.update(panels)
      .set({ adoptionPassState: state, adoptionBlockedCount: blockedCount, updatedAt: now })
      .where(scope.only(panels, eq(panels.panelId, panelId)))
      .run();
  });

export const isPanelEnabled = (scope: GuildScope, panelId: string): boolean =>
  read(scope, (db) => {
    const row = db
      .select({ status: panels.status })
      .from(panels)
      .where(scope.only(panels, eq(panels.panelId, panelId)))
      .get();
    return row?.status === 'enabled';
  });

export const deletePanel = (scope: GuildScope, panelId: string): void =>
  write(scope, ({ db }) => {
    // Options and blocked roles cascade; `managed_role_assignments` cascades
    // too, which is right — the provenance record's whole content is "this
    // panel granted it", and the panel is gone.
    db.delete(panels)
      .where(scope.only(panels, eq(panels.panelId, panelId)))
      .run();
  });
