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

/** Indents every line of a rendered trace so it reads as nested under its match. */
const indented = (text: string, by = 4): string =>
  text
    .split('\n')
    .map((line) => `${' '.repeat(by)}${line}`)
    .join('\n');

/**
 * `automod review` / `automod verdict` (ADR 0041 §7, plan ruling PR-6): the
 * headless review path the observe window's first fortnight runs on, before
 * Slice 9's dashboard screen exists.
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
  fixtureContent: match.fixtureContent ?? null,
});

/**
 * Renders one match for a human to rule on.
 *
 * CRITICAL-2: the message and the matched snippet are their own lines,
 * printed unconditionally, independent of whether a trace is present, parses,
 * or carries a span. Before this fix both were fetched, carried through
 * `OpsReviewableMatch`, projected into `data` — and only ever reached `text`
 * as a side effect of `renderTrace`'s excerpt line, which is gated on
 * `trace.span !== undefined`. That meant a malformed trace (case 1 below)
 * rendered with no evidence at all, and the first predicate with no natural
 * span — `rapid_spam`, `duplicate_message`, `mention_spam`, `attachment_type`,
 * all landing during this same observe window — would have produced a review
 * queue where no message was ever shown.
 *
 * Rendering rules, neither decorative:
 *
 * - `message` prints whenever `fixtureContent` is present; otherwise "message
 *   no longer stored" — never the matched snippet standing in for the whole
 *   message, because a reviewer judging a false positive from a fragment they
 *   think is the full text would judge wrong.
 * - `matched` prints unconditionally, from `matchedSnippet`/`matchedCategory`
 *   — the documented post-flip and post-`/forgetme` fallback (plan ruling
 *   PR-2, ADR 0041's consequences, `docs/reports/release2-slices-1-6-ledger.md`
 *   handoff item 5) — labelled distinctly from `message` so the two are never
 *   mistaken for each other.
 * - A trace `parseMatchTrace` rejects still renders — as a reason, under the
 *   message and the snippet, not instead of them — because stored JSON is
 *   untrusted input (CLAUDE.md rule 3) and a trace this build cannot parse is
 *   still a match a human must rule on.
 * - `renderTrace`'s excerpt (when a span exists) stays as an *addition* on
 *   top of `message`, highlighting where in it the rule matched — not the
 *   only route to the text itself.
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

  if (match.fixtureContent === undefined) {
    lines.push(
      indented(
        'message no longer stored (removed at the member’s request, or the rule was enforcing)',
      ),
    );
  } else {
    // Padded to 16 columns, the same convention `renderTrace` uses for its
    // own field labels, so the two blend into one reading rather than two
    // inconsistently-aligned ones.
    lines.push(indented(`${'message'.padEnd(16)}${match.fixtureContent}`));
  }

  // Always shown, and always distinct from `message` above: this is the
  // substring the rule matched on, not the whole message (CRITICAL-2).
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
      lines.push(indented(renderTrace(parsed.trace, match.fixtureContent)));
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
          action: 'automod.verdict_recorded',
          subjectType: 'mod_case_event',
          subjectId: args.eventId,
          after: { outcome: 'no-such-event' },
        },
      };
    }

    const conflicted = outcome === 'recorded-with-label-conflict';

    return {
      // The verdict is stored either way — this is a success line, not a
      // warning about a failure. But the reviewer has to be told when the
      // regression corpus gained nothing from their work, because from their
      // side the two cases look identical: they ruled on one match and
      // pressed on. A fixture's label has no rule dimension, so when another
      // rule's verdict on the same message implies the opposite label there
      // is no honest single answer and the label resets to unlabelled
      // (IMPORTANT-1). Saying so here is what stops that being invisible.
      text: conflicted
        ? `recorded ${args.verdict} for ${args.eventId} (${reviewedBy})\n` +
          `note: another rule’s verdict on this same message disagrees, so the saved ` +
          `example was reset to unlabelled rather than one verdict overwriting the ` +
          `other — your verdict still counts toward the rule’s false-positive rate, ` +
          `but this message is no longer part of the regression corpus`
        : `recorded ${args.verdict} for ${args.eventId} (${reviewedBy})`,
      data: {
        ok: true,
        eventId: args.eventId,
        verdict: args.verdict,
        fixtureLabelConflict: conflicted,
      },
      audit: {
        action: 'automod.verdict_recorded',
        subjectType: 'mod_case_event',
        subjectId: args.eventId,
        // The conflict goes in the audit row too: it is a change to the
        // corpus (a label removed) made as a side effect of this command,
        // and an audit trail that recorded only the verdict would not show
        // where the label went.
        after: { verdict: args.verdict, fixtureLabelConflict: conflicted },
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
 * untidy: `observe` mode never touches Discord, so an empty allowlist harms
 * nobody during the observe window, but an `invite` rule with an empty
 * allowlist fires on the club's own invite links every time a member posts
 * one, and Slice 6's release gate demands zero false positives for a rule
 * that feeds the escalation counter. That rule cannot pass its gate until an
 * operator can populate the list, so this is in Release 2 even though the
 * dashboard screen (Slice 8/9) is not.
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
          action: 'automod.invite_allowlist_added',
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
          action: 'automod.invite_allowlist_added',
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
        action: 'automod.invite_allowlist_added',
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
          action: 'automod.invite_allowlist_removed',
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
          action: 'automod.invite_allowlist_removed',
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
        action: 'automod.invite_allowlist_removed',
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
          action: 'automod.link_domain_added',
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
          action: 'automod.link_domain_added',
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
        action: 'automod.link_domain_added',
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
          action: 'automod.link_domain_removed',
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
          action: 'automod.link_domain_removed',
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
        action: 'automod.link_domain_removed',
        subjectType: 'mod_rule',
        subjectId: args.ruleId,
        after: { domain: args.domain, removed },
      },
    };
  },
});
