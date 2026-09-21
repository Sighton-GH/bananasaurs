import { z } from 'zod';

import { panelDefinitionSchema, type PanelDefinition } from '../../panels/model.js';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';

/**
 * `panel create` — writes a validated panel definition, and nothing else.
 *
 * This is the command half of ADR 0053's builder. The dashboard's role-panel
 * builder submits the same JSON the `--definition` flag takes, so the CLI and
 * the dashboard share one code path and one validation schema, and every
 * creation — whichever surface drove it — lands in the audit trail as
 * `panel.created`.
 *
 * Deliberately absent: anything that reaches Discord. A created panel has no
 * message id and is invisible to members until `panel sync` publishes it,
 * which makes "a half-built panel went live" impossible by construction.
 */

const panelCreateArgs = z.object({
  definition: z
    .string()
    .min(2)
    .describe(
      'the panel definition as JSON — panelId, kind, channelId, behaviour, ' +
        'component and options, validated by the same schema the dashboard ' +
        'builder submits',
    ),
});

type PanelCreateArgs = z.infer<typeof panelCreateArgs>;

const DEFINITION_EXAMPLE =
  '{"panelId":"colour-roles","kind":"managed","channelId":"444444444444444444",' +
  '"behaviour":"toggle","component":"button",' +
  '"options":[{"optionId":"red","roleId":"333333333333333333","position":0}]}';

export const panelCreateCommand = defineCommand<PanelCreateArgs>({
  name: 'panel create',
  write: true,
  summary: 'create a managed role panel (definition only; publish with panel sync)',
  positional: [],
  flags: [
    {
      name: 'definition',
      kind: 'string',
      describe: `the panel definition as JSON, e.g. ${DEFINITION_EXAMPLE}`,
    },
  ],
  args: panelCreateArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const refuse = (reason: string, text: string): OpsWriteResult => ({
      text,
      data: { ok: false, reason },
      audit: {
        action: 'panel.created',
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

    // The one schema, shared with the dashboard builder (ADR 0053): a
    // definition the command would accept but the builder would reject — or
    // the reverse — is how "same capability, two surfaces" quietly forks.
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

    // Adoption is a deliberate ops flow (`adoption allow`, then sync), not a
    // builder input: an adopted panel is somebody else's message, and creating
    // one from a form would skip the checks that flow exists to make (ADR 0053).
    if (definition.kind !== 'managed') {
      return refuse(
        'adopted-not-buildable',
        "the builder creates managed panels only — an adopted panel is somebody else's " +
          'message, and attaching to it goes through the adoption flow, not a form',
      );
    }

    if (ctx.ports.findPanel(definition.panelId) !== undefined) {
      return refuse(
        'already-exists',
        `a panel named '${definition.panelId}' already exists in this guild — ` +
          'panel ids are immutable, so pick a new one',
      );
    }

    ctx.ports.createPanel(definition);

    const optionCount = definition.options.length;
    return {
      text:
        `created managed panel '${definition.panelId}' with ${optionCount} ` +
        `option${optionCount === 1 ? '' : 's'} (${definition.behaviour}, ` +
        `${definition.component}) in <#${definition.channelId}>. Nothing is live ` +
        `yet — publish it with \`panel sync ${definition.panelId} --confirm\` ` +
        'when you are ready.',
      data: { ok: true, panelId: definition.panelId, optionCount, published: false },
      audit: {
        action: 'panel.created',
        subjectType: 'panel',
        subjectId: definition.panelId,
        after: {
          channelId: definition.channelId,
          behaviour: definition.behaviour,
          component: definition.component,
          optionCount,
        },
      },
    };
  },
});
