import { z } from 'zod';
import { parseMatchTrace, renderTrace } from '../../automod/trace.js';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';
import type { OpsReviewableMatch } from '../ports.js';
import type { JsonValue } from '../protocol.js';
import { OPS_AUDIT_ACTIONS } from '../audit-actions.js';

/** Indents every line of a rendered trace so it reads as nested under its match. */
const indented = (text: string, by = 4): string =>
  text
    .split('\n')
    .map((line) => `${' '.repeat(by)}${line}`)
    .join('\n');

/**
 * `automod review` / `automod verdict` (ADR 0041 §7, plan ruling PR-6): the
 * terminal review path beside the dashboard's Review page. Flags tune a rule
 * (ADR 0121).
 */

const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const DEFAULT_REVIEW_LIMIT = 20;
const MAX_REVIEW_LIMIT = 200;

const automodReviewArgs = z.object({
  rule: z.string().min(1).optional(),
  limit: z.number().int().positive().max(MAX_REVIEW_LIMIT).optional(),
});

/** `OpsReviewableMatch`, projected to plain `JsonValue`. */
const projectReviewableMatch = (match: OpsReviewableMatch): JsonValue => ({
  eventId: match.eventId,
  ruleId: match.ruleId,
  memberId: match.memberId,
  at: match.at,
  matchedCategory: match.matchedCategory,
  matchedSnippet: match.matchedSnippet,
  actionTaken: match.actionTaken,
  trace: match.trace ?? null,
});

/**
 * Renders one match for a human to rule on.
 *
 * The matched snippet is its own line, printed unconditionally, labelled
 * `matched` so it is never mistaken for the whole message — Bananasaurs keeps
 * no copy of that (ADR 0121). A trace `parseMatchTrace` rejects still renders
 * — as a reason, under the snippet — because stored JSON is untrusted input
 * (CLAUDE.md rule 3) and a trace this build cannot parse is still a match a
 * human must rule on.
 *
 * The follow-up `automod verdict` command is printed under every match: the
 * whole point of shipping this before the dashboard is that a human reviews
 * from a terminal, and making them compose that command by hand is where a
 * review workflow stops being used.
 */
const renderReviewableMatch = (match: OpsReviewableMatch): string => {
  const lines = [
    `${match.eventId}  rule ${match.ruleId}  member ${match.memberId}  ` +
      `${iso(match.at)}  ${match.actionTaken}`,
  ];

  // Padded to 16 columns, the same convention `renderTrace` uses for its own
  // field labels, so the two blend into one reading.
  lines.push(
    indented(`${'matched'.padEnd(16)}"${match.matchedSnippet}"  (${match.matchedCategory})`),
  );

  if (match.trace === undefined) {
    // Not reachable through `listUnreviewedMatches`'s own filter (plan
    // ruling PR-7), but the port's type does not promise it, so this is
    // handled rather than assumed away.
    lines.push(indented('trace could not be read: no trace was recorded for this match'));
  } else {
    const parsed = parseMatchTrace(match.trace);
    if (!parsed.ok) {
      lines.push(indented(`trace could not be read: ${parsed.detail}`));
    } else {
      lines.push(indented(renderTrace(parsed.trace)));
    }
  }

  lines.push(
    indented(
      `bananasaurs automod verdict ${match.eventId} <false_positive|true_positive|unclear> --confirm`,
    ),
  );

  return lines.join('\n');
};

export const automodReviewCommand = defineCommand<z.infer<typeof automodReviewArgs>>({
  name: 'automod review',
  write: false,
  summary: 'list automod matches nobody has ruled on yet, with the evidence',
  flags: [
    { name: 'rule', kind: 'string', describe: 'only matches from this rule' },
    {
      name: 'limit',
      kind: 'number',
      describe: `how many rows (default ${String(DEFAULT_REVIEW_LIMIT)}, max ${String(MAX_REVIEW_LIMIT)})`,
    },
  ],
  args: automodReviewArgs,
  run(ctx: OpsContext, args): OpsCommandResult {
    const matches = ctx.ports.listUnreviewedMatches({
      ...(args.rule === undefined ? {} : { ruleId: args.rule }),
      limit: args.limit ?? DEFAULT_REVIEW_LIMIT,
    });

    if (matches.length === 0) {
      return { text: 'nothing to review', data: [] };
    }

    return {
      text: matches.map(renderReviewableMatch).join('\n\n'),
      data: matches.map(projectReviewableMatch),
    };
  },
});

const automodVerdictArgs = z.object({
  eventId: z.string().min(1),
  verdict: z.enum(['false_positive', 'true_positive', 'unclear']),
  note: z.string().max(1000).optional(),
});

/**
 * Records whether a recorded match was right (ADR 0041 §5, §7).
 *
 * A write command, so `--confirm` and an audit record are enforced by the
 * dispatcher rather than remembered by this handler (`dispatch.ts`).
 *
 * `reviewedBy` is provenance, not authorisation (plan ruling PR-9): the
 * socket's group permissions are the access control (ADR 0024), and the
 * audit row the dispatcher writes below is the authoritative record of who
 * ran this command. `ctx.actor.unixUserClaimed` is a claim, never verified
 * (ADR 0024 amendment 2, `authz.ts`), which is exactly why it is recorded
 * with the `cli:` prefix rather than laundered into a bare username.
 */
export const automodVerdictCommand = defineCommand<z.infer<typeof automodVerdictArgs>>({
  name: 'automod verdict',
  write: true,
  summary: 'record whether a recorded match was right',
  positional: [
    { name: 'eventId', required: true, describe: 'the match to rule on (from `automod review`)' },
    { name: 'verdict', required: true, describe: 'false_positive | true_positive | unclear' },
  ],
  flags: [{ name: 'note', kind: 'string', describe: 'why — shown to whoever reads this later' }],
  args: automodVerdictArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const reviewedBy = `cli:${ctx.actor.unixUserClaimed ?? 'unknown'}`;
    const outcome = ctx.ports.recordMatchVerdict({
      eventId: args.eventId,
      verdict: args.verdict,
      reviewedBy,
      ...(args.note === undefined ? {} : { note: args.note }),
    });

    if (outcome === 'no-such-event') {
      // Not thrown: an operator typing an event id at a terminal will
      // mistype one, and that is a usage answer, not a fault. An audit row
      // is still owed — "an operator tried to rule on a match that does not
      // exist" is a fact worth having (Task 9 brief, Step 3).
      return {
        text: `no match ${args.eventId} in this guild's review queue`,
        data: { ok: false, reason: 'no-such-event', eventId: args.eventId },
        audit: {
          action: OPS_AUDIT_ACTIONS.automodVerdictRecorded,
          subjectType: 'mod_case_event',
          subjectId: args.eventId,
          after: { outcome: 'no-such-event' },
        },
      };
    }

    return {
      text: `recorded ${args.verdict} for ${args.eventId} (${reviewedBy})`,
      data: {
        ok: true,
        eventId: args.eventId,
        verdict: args.verdict,
      },
      audit: {
        action: OPS_AUDIT_ACTIONS.automodVerdictRecorded,
        subjectType: 'mod_case_event',
        subjectId: args.eventId,
        after: { verdict: args.verdict },
      },
    };
  },
});

/**
 * `automod invite-allow` / `automod invite-deny` / `automod domain-add` /
 * `automod domain-rm` (plan ruling PR-19, Task 9 of the slices 3-5 plan).
 *
 * Task 6 built `invite`'s labelled code allowlist and `link_domain`'s
 * allow/deny lists in storage, and shipped no caller — nothing outside a test
 * could add the club's own invite code to the allowlist. That is not merely
 * untidy: an `invite` rule with an empty allowlist fires on the club's own
 * invite links every time a member posts one, so it cannot be switched On
 * until an operator can populate the list.
 *
 * Four commands under the existing `automod` namespace (plan ruling PR-6
 * named the precedent). Reads are not separate commands: this build has no
 * `automod rules` command to list a rule's own configuration, so each write
 * prints the resulting list itself — a list nobody can see is worse than one
 * nobody can edit, and inventing a fifth command to do only that would be
 * scope this task does not need.
 */

/** One line per invite allowlist entry, in the order the port already sorted them. */
const renderInviteAllowlist = (
  ruleId: string,
  entries: readonly { readonly code: string; readonly label: string }[],
): string =>
  entries.length === 0
    ? `rule ${ruleId}'s invite allowlist is now empty`
    : `rule ${ruleId}'s invite allowlist:\n` +
      entries.map((entry) => `  ${entry.code}  (${entry.label})`).join('\n');

const projectInviteAllowlist = (
  entries: readonly { readonly code: string; readonly label: string }[],
): JsonValue => entries.map((entry) => ({ code: entry.code, label: entry.label }));

/** One line per domain, in the order the port already sorted them. */
const renderLinkDomains = (
  ruleId: string,
  entries: readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[],
): string =>
  entries.length === 0
    ? `rule ${ruleId}'s domain lists are now empty`
    : `rule ${ruleId}'s domain lists:\n` +
      entries.map((entry) => `  ${entry.listType.padEnd(5)} ${entry.domain}`).join('\n');

const projectLinkDomains = (
  entries: readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[],
): JsonValue => entries.map((entry) => ({ domain: entry.domain, listType: entry.listType }));

/**
 * Says what an empty *active* list means for this rule, or `undefined` when
 * the active list — the one `config.mode` names — has at least one domain
 * (CRITICAL-2, review of Slices 3+5).
 *
 * "The domain lists are now empty" used to read as a completed tidy-up
 * regardless of which direction it failed in. It is either "this rule is now
 * inert" (`deny` with nothing on the deny list — ADR 0039's silent
 * non-matching) or "this rule now matches every link" (`allow` with nothing
 * on the allow list — the dangerous direction, since in `enforce` mode that
 * deletes every message containing a link). The command has the rule id and
 * now the port hands back `config.mode`, so it can say which.
 *
 * `mode` is `undefined` only if the rule's stored config failed to parse as
 * `{mode: 'allow' | 'deny'}` — a state `compileRule`/`doctor` already report
 * on their own path; this degrades to silence rather than guessing.
 */
const linkDomainStatusLine = (
  ruleId: string,
  mode: 'allow' | 'deny' | undefined,
  entries: readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[],
): string | undefined => {
  if (mode === undefined) return undefined;
  const activeCount = entries.filter((entry) => entry.listType === mode).length;
  if (activeCount > 0) return undefined;
  return mode === 'allow'
    ? `rule ${ruleId} is a whitelist (mode allow) and its allow list is empty, so it matches every link; add a domain or disable the rule`
    : `rule ${ruleId} is a blocklist (mode deny) and its deny list is empty, so it can never match; add a domain or disable the rule`;
};

/** Appends a status line, when there is one, on its own line. */
const withStatusLine = (text: string, statusLine: string | undefined): string =>
  statusLine === undefined ? text : `${text}\n${statusLine}`;

const automodInviteAllowArgs = z
  .object({
    ruleId: z.string().min(1),
    code: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
  })
  .strict();

export const automodInviteAllowCommand = defineCommand<z.infer<typeof automodInviteAllowArgs>>({
  name: 'automod invite-allow',
  write: true,
  summary: "add a code to a rule's invite allowlist",
  positional: [
    { name: 'ruleId', required: true, describe: 'the invite rule to edit' },
    { name: 'code', required: true, describe: 'the invite code, e.g. clubhouse' },
    {
      name: 'label',
      required: true,
      describe: 'what this code is, for whoever reads the list later',
    },
  ],
  args: automodInviteAllowArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.addInviteAllowlistEntry({
      ruleId: args.ruleId,
      code: args.code,
      label: args.label,
    });

    if (outcome === 'no-such-rule') {
      // A usage answer, not a fault: an operator at a terminal will mistype
      // a rule id, and the composite foreign key would otherwise surface an
      // opaque `FOREIGN KEY constraint failed`. An audit row is still owed —
      // "an operator tried to edit a rule that does not exist" is a fact
      // worth having, the same treatment `automod verdict` gives a mistyped
      // event id.
      return {
        text: `no rule ${args.ruleId} in this guild`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId, code: args.code },
        audit: {
          action: OPS_AUDIT_ACTIONS.automodInviteAllowlistAdded,
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'no-such-rule', code: args.code },
        },
      };
    }

    if (outcome === 'wrong-kind') {
      // IMPORTANT-7: `ruleExists` alone cannot tell a real-but-wrong-kind
      // rule id from the operator's intended one — without this, the write
      // below would succeed against e.g. a `keyword_filter` rule, whose
      // `compile` never reads `inviteAllowlist`. A usage answer, the same
      // treatment as `no-such-rule`, and an audit row for the same reason.
      return {
        text: `rule ${args.ruleId} is not an invite rule; invite-allow only edits invite rules`,
        data: { ok: false, reason: 'wrong-kind', ruleId: args.ruleId, code: args.code },
        audit: {
          action: OPS_AUDIT_ACTIONS.automodInviteAllowlistAdded,
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'wrong-kind', code: args.code },
        },
      };
    }

    const list = ctx.ports.listInviteAllowlist(args.ruleId);
    const alreadyPresent = outcome === 'already-present';

    return {
      text:
        (alreadyPresent
          ? `${args.code} was already on rule ${args.ruleId}'s invite allowlist`
          : `added ${args.code} (${args.label}) to rule ${args.ruleId}'s invite allowlist`) +
        '\n' +
        renderInviteAllowlist(args.ruleId, list),
      data: {
        ok: true,
        code: args.code,
        alreadyPresent,
        allowlist: projectInviteAllowlist(list),
      },
      audit: {
        action: OPS_AUDIT_ACTIONS.automodInviteAllowlistAdded,
        subjectType: 'mod_rule',
        subjectId: args.ruleId,
        after: { code: args.code, label: args.label, alreadyPresent },
      },
    };
  },
});

const automodInviteDenyArgs = z
  .object({
    ruleId: z.string().min(1),
    code: z.string().min(1),
  })
  .strict();

export const automodInviteDenyCommand = defineCommand<z.infer<typeof automodInviteDenyArgs>>({
  name: 'automod invite-deny',
  write: true,
  summary: "remove a code from a rule's invite allowlist",
  positional: [
    { name: 'ruleId', required: true, describe: 'the invite rule to edit' },
    { name: 'code', required: true, describe: 'the invite code to remove' },
  ],
  args: automodInviteDenyArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.removeInviteAllowlistEntry({ ruleId: args.ruleId, code: args.code });

    if (outcome === 'no-such-rule') {
      return {
        text: `no rule ${args.ruleId} in this guild`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId, code: args.code },
        audit: {
          action: OPS_AUDIT_ACTIONS.automodInviteAllowlistRemoved,
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'no-such-rule', code: args.code },
        },
      };
    }

    if (outcome === 'wrong-kind') {
      return {
        text: `rule ${args.ruleId} is not an invite rule; invite-deny only edits invite rules`,
        data: { ok: false, reason: 'wrong-kind', ruleId: args.ruleId, code: args.code },
        audit: {
          action: OPS_AUDIT_ACTIONS.automodInviteAllowlistRemoved,
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'wrong-kind', code: args.code },
        },
      };
    }

    const list = ctx.ports.listInviteAllowlist(args.ruleId);
    const removed = outcome === 'removed';

    return {
      text:
        (removed
          ? `removed ${args.code} from rule ${args.ruleId}'s invite allowlist`
          : `${args.code} was not on rule ${args.ruleId}'s invite allowlist`) +
        '\n' +
        renderInviteAllowlist(args.ruleId, list),
      data: { ok: true, code: args.code, removed, allowlist: projectInviteAllowlist(list) },
      audit: {
        action: OPS_AUDIT_ACTIONS.automodInviteAllowlistRemoved,
        subjectType: 'mod_rule',
        subjectId: args.ruleId,
        after: { code: args.code, removed },
      },
    };
  },
});

const automodDomainAddArgs = z
  .object({
    ruleId: z.string().min(1),
    domain: z.string().min(1),
    listType: z.enum(['allow', 'deny']),
  })
  .strict();

export const automodDomainAddCommand = defineCommand<z.infer<typeof automodDomainAddArgs>>({
  name: 'automod domain-add',
  write: true,
  summary: "add a domain to a rule's allow or deny list",
  positional: [
    { name: 'ruleId', required: true, describe: 'the link_domain rule to edit' },
    { name: 'domain', required: true, describe: 'the domain, e.g. example.com' },
    { name: 'listType', required: true, describe: 'allow | deny' },
  ],
  args: automodDomainAddArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.addLinkDomain({
      ruleId: args.ruleId,
      domain: args.domain,
      listType: args.listType,
    });

    if (outcome.outcome === 'no-such-rule') {
      return {
        text: `no rule ${args.ruleId} in this guild`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId, domain: args.domain },
        audit: {
          action: OPS_AUDIT_ACTIONS.automodLinkDomainAdded,
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'no-such-rule', domain: args.domain },
        },
      };
    }

    if (outcome.outcome === 'wrong-kind') {
      // IMPORTANT-7, same reasoning as invite-allow above: a rule id that
      // exists but is not a `link_domain` rule would otherwise accept a
      // write its own `compile` never reads.
      return {
        text: `rule ${args.ruleId} is not a link_domain rule; domain-add only edits link_domain rules`,
        data: { ok: false, reason: 'wrong-kind', ruleId: args.ruleId, domain: args.domain },
        audit: {
          action: OPS_AUDIT_ACTIONS.automodLinkDomainAdded,
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'wrong-kind', domain: args.domain },
        },
      };
    }

    const list = ctx.ports.listLinkDomains(args.ruleId);
    const alreadyPresent = outcome.outcome === 'already-present';
    // IMPORTANT-1: the primary key is (guild, rule, domain), so re-adding a
    // domain under the *other* listType is a no-op — the port reports the
    // listType actually stored, which may differ from what the operator
    // asked for. Naming the requested one here would assert a state that is
    // false, with the real state printed right below it in `renderLinkDomains`.
    const storedListType = alreadyPresent ? outcome.listType : args.listType;
    const mainLine = alreadyPresent
      ? `${args.domain} is already on rule ${args.ruleId}'s ${storedListType} list; nothing changed` +
        (storedListType === args.listType
          ? ''
          : ` (remove it first to move it to ${args.listType})`)
      : `added ${args.domain} to rule ${args.ruleId}'s ${args.listType} list`;

    return {
      text: withStatusLine(
        `${mainLine}\n${renderLinkDomains(args.ruleId, list)}`,
        linkDomainStatusLine(args.ruleId, outcome.mode, list),
      ),
      data: {
        ok: true,
        domain: args.domain,
        listType: storedListType,
        alreadyPresent,
        domains: projectLinkDomains(list),
      },
      audit: {
        action: OPS_AUDIT_ACTIONS.automodLinkDomainAdded,
        subjectType: 'mod_rule',
        subjectId: args.ruleId,
        after: { domain: args.domain, listType: storedListType, alreadyPresent },
      },
    };
  },
});

const automodDomainRmArgs = z
  .object({
    ruleId: z.string().min(1),
    domain: z.string().min(1),
  })
  .strict();

export const automodDomainRmCommand = defineCommand<z.infer<typeof automodDomainRmArgs>>({
  name: 'automod domain-rm',
  write: true,
  summary: "remove a domain from a rule's allow or deny list",
  positional: [
    { name: 'ruleId', required: true, describe: 'the link_domain rule to edit' },
    { name: 'domain', required: true, describe: 'the domain to remove' },
  ],
  args: automodDomainRmArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.removeLinkDomain({ ruleId: args.ruleId, domain: args.domain });

    if (outcome.outcome === 'no-such-rule') {
      return {
        text: `no rule ${args.ruleId} in this guild`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId, domain: args.domain },
        audit: {
          action: OPS_AUDIT_ACTIONS.automodLinkDomainRemoved,
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'no-such-rule', domain: args.domain },
        },
      };
    }

    if (outcome.outcome === 'wrong-kind') {
      return {
        text: `rule ${args.ruleId} is not a link_domain rule; domain-rm only edits link_domain rules`,
        data: { ok: false, reason: 'wrong-kind', ruleId: args.ruleId, domain: args.domain },
        audit: {
          action: OPS_AUDIT_ACTIONS.automodLinkDomainRemoved,
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'wrong-kind', domain: args.domain },
        },
      };
    }

    const list = ctx.ports.listLinkDomains(args.ruleId);
    const removed = outcome.outcome === 'removed';
    // CRITICAL-2: "the domain lists are now empty" used to read as a
    // completed tidy-up regardless of which direction it failed in.
    // `linkDomainStatusLine` says which, using the rule's own `config.mode`.
    const mainLine = removed
      ? `removed ${args.domain} from rule ${args.ruleId}'s domain lists`
      : `${args.domain} was not on rule ${args.ruleId}'s domain lists`;

    return {
      text: withStatusLine(
        `${mainLine}\n${renderLinkDomains(args.ruleId, list)}`,
        linkDomainStatusLine(args.ruleId, outcome.mode, list),
      ),
      data: { ok: true, domain: args.domain, removed, domains: projectLinkDomains(list) },
      audit: {
        action: OPS_AUDIT_ACTIONS.automodLinkDomainRemoved,
        subjectType: 'mod_rule',
        subjectId: args.ruleId,
        after: { domain: args.domain, removed },
      },
    };
  },
});
