import { z } from 'zod';

import { panelDefinitionSchema, type PanelDefinition } from '../../panels/model.js';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';

/**
 * `panel edit` — replaces an existing panel's definition, and nothing else.
 *
 * The command shape is `panel create`'s: the same `--definition` JSON through
 * the same `panelDefinitionSchema` the dashboard builder submits, the same
 * refusals-with-an-audit-outcome rather than thrown errors, and the same
 * storage-only write. What differs is identity: `create` refuses a panel id
 * that exists, `edit` refuses one that does not.
 *
 * Two fields are immutable, and the refusal says why rather than just saying
 * no. The posted message lives in its channel, so a new `channelId` would
 * orphan it; a new `kind` would change who owns the message. Either way the
 * answer is delete and recreate, not an edit that half-moves a panel.
 *
 * Deliberately absent, like `create`: anything that reaches Discord. An
 * edited panel keeps its `message_id` and its `status`, and the change goes
 * live with `panel sync` — so "I fixed a typo and half the server lost a
 * role" is impossible by construction.
 */

const panelEditArgs = z.object({
  definition: z
    .string()
    .min(2)
    .describe(
      'the replacement panel definition as JSON — same shape as `panel create`, ' +
        'naming the existing panelId whose definition it replaces',
    ),
});

type PanelEditArgs = z.infer<typeof panelEditArgs>;

const DEFINITION_EXAMPLE =
  '{"panelId":"colour-roles","kind":"managed","channelId":"444444444444444444",' +
  '"behaviour":"toggle","component":"button",' +
  '"options":[{"optionId":"red","roleId":"333333333333333333","position":0}]}';

export const panelEditCommand = defineCommand<PanelEditArgs>({
  name: 'panel edit',
  write: true,
  summary: 'replace a panel definition (storage only; publish with panel sync)',
  positional: [],
  flags: [
    {
      name: 'definition',
      kind: 'string',
      describe: `the replacement definition as JSON, e.g. ${DEFINITION_EXAMPLE}`,
    },
  ],
  args: panelEditArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const refuse = (reason: string, text: string): OpsWriteResult => ({
      text,
      data: { ok: false, reason },
      audit: {
        action: 'panel.edited',
        subjectType: 'panel',
        after: { outcome: reason },
      },
    });

    let raw: unknown;
    try {
      raw = JSON.parse(args.definition);
    } catch {
      return refuse(
        'invalid-json',
        `--definition is not valid JSON. Expected something like ${DEFINITION_EXAMPLE}`,
      );
    }

    // The one schema, shared with the dashboard builder and `panel create`
    // (ADR 0053): a definition one surface accepts and another rejects is how
    // "same capability, two surfaces" quietly forks.
    const parsed = panelDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .slice(0, 3)
        .map((issue) => {
          const where = issue.path.join('.');
          return where === '' ? issue.message : `${where}: ${issue.message}`;
        })
        .join('; ');
      return refuse('invalid-definition', `the definition failed validation — ${problems}`);
    }

    const definition: PanelDefinition = parsed.data;

    const existing = ctx.ports.findPanel(definition.panelId);
    if (existing === undefined) {
      return refuse(
        'unknown-panel',
        `no panel '${definition.panelId}' in this guild — ` +
          'see `panel list` for the ones that exist',
      );
    }

    // The posted message lives in its channel. A new channel would orphan it:
    // the row would name somewhere the message is not, and the next sync
    // would post a second message beside the live one.
    if (definition.channelId !== existing.channelId) {
      return refuse(
        'channel-change',
        `panel '${definition.panelId}' lives in <#${existing.channelId}>, and the new ` +
          `definition names <#${definition.channelId}> — a panel's channel is immutable, ` +
          'because the posted message lives in that channel and moving it would orphan it. ' +
          `Delete it (\`panel delete ${definition.panelId}\`) and recreate it instead.`,
      );
    }

    // Who owns the message is what `kind` means. Flipping it would either hand
    // the bot a message it cannot edit or strand one it posted.
    if (definition.kind !== existing.kind) {
      return refuse(
        'kind-change',
        `panel '${definition.panelId}' is ${existing.kind}, and the new definition says ` +
          `${definition.kind} — a panel's kind is immutable, because it decides who owns ` +
          'the message. ' +
          `Delete it (\`panel delete ${definition.panelId}\`) and recreate it instead.`,
      );
    }

    // The dashboard builder's panel-create check, not the CLI's: a role the
    // owner just picked joins the allowlist here, provided the live hierarchy
    // says the bot can manage it. The CLI's `create` refuses every unlisted
    // role outright; an edit that did that could never introduce a new role,
    // which is half of what editing is for.
    const botPosition = ctx.ports.botHighestRolePosition();
    const rolesById = new Map(ctx.ports.listGuildRoles().map((role) => [role.roleId, role]));
    const unmanageable = definition.options
      .filter((option) => !ctx.ports.isManagedRole(option.roleId))
      .filter((option) => {
        const role = rolesById.get(option.roleId);
        return (
          role === undefined ||
          role.managed ||
          botPosition === undefined ||
          role.position >= botPosition
        );
      })
      .map((option) => option.roleId);
    if (unmanageable.length > 0) {
      return refuse(
        'unmanageable-role',
        `the bot cannot manage these roles: ${unmanageable.join(', ')} — a panel option ` +
          'must sit below the bot and not be integration-managed. Pick roles it can ' +
          'manage, or move them below the bot in Discord first.',
      );
    }
    const newlyAllowlisted = definition.options
      .filter((option) => !ctx.ports.isManagedRole(option.roleId))
      .map((option) => option.roleId);

    ctx.ports.updatePanel(definition, newlyAllowlisted);

    const optionCount = definition.options.length;
    const allowlisted =
      newlyAllowlisted.length === 0
        ? ''
        : ` Allowlisted ${newlyAllowlisted.length} new role${newlyAllowlisted.length === 1 ? '' : 's'}: ` +
          `${newlyAllowlisted.join(', ')}.`;
    return {
      text:
        `updated panel '${definition.panelId}' with ${optionCount} ` +
        `option${optionCount === 1 ? '' : 's'} (${definition.behaviour}, ` +
        `${definition.component}).${allowlisted} Nothing is live ` +
        `yet — publish the change with \`panel sync ${definition.panelId} --confirm\` ` +
        'when you are ready.',
      data: {
        ok: true,
        panelId: definition.panelId,
        optionCount,
        published: false,
        newlyAllowlistedRoleIds: newlyAllowlisted,
      },
      audit: {
        action: 'panel.edited',
        subjectType: 'panel',
        subjectId: definition.panelId,
        before: {
          channelId: existing.channelId,
          kind: existing.kind,
        },
        after: {
          channelId: definition.channelId,
          behaviour: definition.behaviour,
          component: definition.component,
          optionCount,
          newlyAllowlistedRoleIds: newlyAllowlisted,
        },
      },
    };
  },
});
