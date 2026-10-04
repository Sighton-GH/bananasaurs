import { describe, expect, it } from 'vitest';
import { createDispatcher, type RegisteredCommand } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsPorts, OpsReviewableMatch } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import {
  automodDomainAddCommand,
  automodDomainRmCommand,
  automodInviteAllowCommand,
  automodInviteDenyCommand,
  automodReviewCommand,
  automodVerdictCommand,
} from './automod.js';

const NOW = 1_700_000_000_000;

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
 * claimed Unix user through to the dispatcher, the way `writes.test.ts`'s
 * harness does — so a test also exercises the machinery's own guarantees
 * (`--confirm` required, an audit record filled by the dispatcher) rather
 * than calling `run` directly and bypassing them.
 */
const driveWrite = (
  command: RegisteredCommand,
  ports: Partial<OpsPorts>,
  args: Record<string, unknown> = {},
  options: { readonly confirm?: boolean; readonly unixUserClaimed?: string } = {},
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
  }).dispatch({
    v: 1,
    command: command.name,
    args,
    confirm: options.confirm ?? true,
    unixUserClaimed: options.unixUserClaimed ?? 'bryan',
  });

/** A reviewable match, with a trace and a fixture message present by default. */
const reviewableMatch = (
  over: Partial<OpsReviewableMatch> & { eventId: string },
): OpsReviewableMatch => ({
  ruleId: 'r1',
  memberId: '800000000000000001',
  at: NOW,
  matchedCategory: 'profanity',
  matchedSnippet: 'badword',
  actionTaken: 'would_delete',
  trace:
    '{"kind":"keyword_filter","matchedOn":"badword","span":[6,13],' +
    '"normalisations":["lowercased"],"detail":{}}',
  fixtureContent: 'hello badword everyone',
  ...over,
});

describe('removed staged-rollout commands (ADR 0121)', () => {
  it.each(['automod dryrun', 'automod ready', 'automod signoff'])(
    '%s is not registered, so the dispatcher answers it as unknown',
    async (command) => {
      expect(OPERATOR_COMMANDS.map((c) => c.name)).not.toContain(command);
      const res = await createDispatcher({
        commands: OPERATOR_COMMANDS,
        guildIds: [FIXTURE_GUILD_ID],
        contextFor: () => ({
          guildId: FIXTURE_GUILD_ID,
          now: () => NOW,
          ports: fakeOpsPorts({}),
        }),
        instance: fakeOpsInstance(),
      }).dispatch({ v: 1, command, args: { ruleId: 'r1' }, confirm: true });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('unknown-command');
    },
  );
});

describe('automod review', () => {
  it('is registered as a read, so it needs no --confirm and writes no audit row', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod review');
    expect(automodReviewCommand.write).toBe(false);
  });

  it('lists unreviewed matches with the message and the rendered trace', async () => {
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [reviewableMatch({ eventId: 'e1' })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('e1');
    expect(res.text).toContain('hello [badword] everyone');
    expect(res.text).toContain('bananasaurs automod verdict e1');
  });

  it('shows the message and the matched snippet as their own lines, unconditionally', async () => {
    // CRITICAL-2: before this fix, `matchedSnippet`/`matchedCategory` were
    // fetched and projected into `data` but never printed in `text` at all —
    // the excerpt inside `renderTrace` was the only route to the message, and
    // that route is gated on a span existing.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [
        reviewableMatch({
          eventId: 'e1',
          fixtureContent: 'hello badword everyone',
          matchedSnippet: 'badword',
          matchedCategory: 'profanity',
        }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('message');
    expect(res.text).toContain('hello badword everyone');
    expect(res.text).toContain('matched');
    expect(res.text).toContain('"badword"');
    expect(res.text).toContain('profanity');
  });

  it('shows the message even when the trace has no span', async () => {
    // `span` is `.optional()` on `MatchTrace`. `keyword_filter` always sets
    // one; Slices 3-5 land predicates during this same observe window
    // (`rapid_spam`, `duplicate_message`, `mention_spam`, `attachment_type`)
    // that judge the whole message rather than a substring of it and so have
    // no span. Before this fix, a spanless trace meant `renderTrace` never
    // printed the excerpt line, and nothing else printed the message either
    // — the review queue would show no message at all.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [
        reviewableMatch({
          eventId: 'e1',
          trace: '{"kind":"keyword_filter","matchedOn":"badword","normalisations":[],"detail":{}}',
          fixtureContent: 'hello badword everyone',
        }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('hello badword everyone');
  });

  it('renders a match whose trace is malformed without hiding the message or the snippet', async () => {
    // A trace read back from the database is untrusted (CLAUDE.md rule 3).
    // A row this build cannot parse is still a match a human must rule on,
    // so the trace is replaced by a reason — but the message and the
    // snippet, which do not come from the trace, must still appear. Before
    // this fix `match.fixtureContent` sat in scope, unprinted, whenever the
    // trace failed to parse: an event id, a rule id, a member id, a
    // timestamp, an error, and then a command inviting a verdict.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [
        reviewableMatch({
          eventId: 'e1',
          trace: 'not json',
          fixtureContent: 'hello badword everyone',
          matchedSnippet: 'badword',
          matchedCategory: 'profanity',
        }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('e1');
    expect(res.text).toContain('trace could not be read');
    expect(res.text).toContain('hello badword everyone');
    expect(res.text).toContain('"badword"');
    expect(res.text).toContain('profanity');
  });

  it('renders a match whose fixture has been forgotten, still showing the matched snippet', async () => {
    // /forgetme removed the message. The match is still reviewable from the
    // trace and the snippet — worse evidence, honestly labelled, and never
    // printed as though the snippet were the whole message.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [
        reviewableMatch({
          eventId: 'e1',
          fixtureContent: undefined,
          matchedSnippet: 'badword',
          matchedCategory: 'profanity',
        }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('message no longer stored');
    expect(res.text).toContain('"badword"');
    expect(res.text).toContain('profanity');
  });

  it('says so when there is nothing to review', async () => {
    const res = await drive(automodReviewCommand, { listUnreviewedMatches: () => [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('nothing to review');
  });

  it('threads --rule and --limit through to the query, so the dry-run forward reference resolves', async () => {
    let seen: { ruleId?: string; limit: number } | undefined;
    const res = await drive(
      automodReviewCommand,
      {
        listUnreviewedMatches: (query) => {
          seen = query;
          return [];
        },
      },
      { rule: 'r5', limit: 7 },
    );
    expect(res.ok).toBe(true);
    expect(seen).toEqual({ ruleId: 'r5', limit: 7 });
  });

  it('defaults the limit to 20 when --limit is not given', async () => {
    let seen: { ruleId?: string; limit: number } | undefined;
    await drive(automodReviewCommand, {
      listUnreviewedMatches: (query) => {
        seen = query;
        return [];
      },
    });
    expect(seen).toEqual({ limit: 20 });
  });
});

describe('automod verdict', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod verdict');
    expect(automodVerdictCommand.write).toBe(true);
  });

  it('refuses without --confirm', async () => {
    const res = await driveWrite(
      automodVerdictCommand,
      { recordMatchVerdict: () => 'recorded' },
      { eventId: 'e1', verdict: 'false_positive' },
      { confirm: false },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('needs-confirm');
  });

  it('tells the reviewer when their verdict cost the corpus its label', async () => {
    // IMPORTANT-1: one message matching two rules shares one fixture, and a
    // fixture's label has no rule dimension — so when a second rule's verdict
    // disagrees, the label resets to unlabelled rather than one verdict
    // silently overwriting the other. From the reviewer's side that is
    // invisible: they ruled on a match and moved on. If the command does not
    // say so, the regression corpus quietly stops growing and nobody knows
    // why. The verdict itself is still recorded — this is a success line.
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: () => 'recorded-with-label-conflict',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { eventId: 'e1', verdict: 'true_positive' },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('recorded true_positive for e1');
    expect(res.text).toContain('another rule');
    expect(res.text).toContain('reset to unlabelled');
    // The verdict still counts toward the gate — say so, or a reviewer reads
    // this as "my verdict was thrown away".
    expect(res.text).toContain('your verdict still counts');
    expect(res.data).toMatchObject({ ok: true, fixtureLabelConflict: true });
    // The corpus lost a label as a side effect of this command, so the audit
    // trail has to show where it went.
    expect(audit).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({ fixtureLabelConflict: true }),
      }),
    ]);
  });

  it('says nothing about conflicts on an ordinary verdict', async () => {
    const res = await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: () => 'recorded',
        recordAudit: () => {
          /* a write command's audit row is written by the dispatcher */
        },
      },
      { eventId: 'e1', verdict: 'true_positive' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).not.toContain('another rule');
    expect(res.data).toMatchObject({ fixtureLabelConflict: false });
  });

  it('records a verdict and returns an audit record naming the event', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: () => 'recorded',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { eventId: 'e1', verdict: 'false_positive', note: 'ordinary club chat' },
    );
    expect(res.ok).toBe(true);
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.verdict_recorded',
        subjectType: 'mod_case_event',
        subjectId: 'e1',
        // `fixtureLabelConflict` is part of the audited `after` because a
        // conflict removes a label from the corpus as a side effect of this
        // command, and a trail recording only the verdict would not show
        // where the label went.
        after: { verdict: 'false_positive', fixtureLabelConflict: false },
      }),
    ]);
  });

  it('attributes the verdict to the Unix user the invocation claimed', async () => {
    // Provenance, not authorisation (plan ruling PR-9, ADR 0024): the
    // socket's group permissions are the control, and the dispatcher's audit
    // row is the authoritative record of who ran this.
    let seen: string | undefined;
    await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: (input) => {
          seen = input.reviewedBy;
          return 'recorded';
        },
        recordAudit: () => {},
      },
      { eventId: 'e1', verdict: 'true_positive' },
      { unixUserClaimed: 'bryan' },
    );
    expect(seen).toBe('cli:bryan');
  });

  it('refuses an event id that is not there, but still writes an audit row', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: () => 'no-such-event',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { eventId: 'nope', verdict: 'unclear' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('no match');
    // An audit row is owed even for a refusal: "an operator tried to rule
    // on a match that does not exist" is a fact worth having.
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.verdict_recorded',
        subjectType: 'mod_case_event',
        subjectId: 'nope',
        after: { outcome: 'no-such-event' },
      }),
    ]);
  });

  it('refuses a verdict outside the vocabulary at the validator', async () => {
    // Untrusted input meets Zod here, same as a form submission.
    const res = await driveWrite(
      automodVerdictCommand,
      { recordMatchVerdict: () => 'recorded' },
      { eventId: 'e1', verdict: 'maybe' },
    );
    expect(res.ok).toBe(false);
  });
});

/**
 * These four suites drive `fakeOpsPorts` with canned outcomes and assert on
 * rendered text — they test the renderer, not the repository, so they
 * cannot by themselves catch IMPORTANT-1 (the wrong `listType` printed),
 * IMPORTANT-2 (canonicalisation asymmetry between add and remove) or
 * IMPORTANT-7 (no kind check) — the fake never disagrees with what the
 * command asks it to say (decorative guard 1, review of Slices 3+5). Real
 * round-trip coverage against a migrated database and the real repository
 * lives in `packages/storage/src/repos/automod-rule-lists.test.ts`, which is
 * the one place that can reach both (`core` may not import `@bananasaurs/
 * storage`, ADR 0014).
 */

describe('automod invite-allow', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod invite-allow');
    expect(automodInviteAllowCommand.write).toBe(true);
  });

  it('adds an invite allowlist entry and audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteAllowCommand,
      {
        addInviteAllowlistEntry: () => 'added',
        listInviteAllowlist: () => [{ code: 'clubhouse', label: 'our own server' }],
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'invite-rule', code: 'clubhouse', label: 'our own server' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, code: 'clubhouse', alreadyPresent: false });
    expect(res.text).toContain('added clubhouse');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.invite_allowlist_added',
        subjectType: 'mod_rule',
        subjectId: 'invite-rule',
      }),
    ]);
  });

  it('says a code is already allowed rather than erroring on a repeat add', async () => {
    const res = await driveWrite(
      automodInviteAllowCommand,
      {
        addInviteAllowlistEntry: () => 'already-present',
        listInviteAllowlist: () => [{ code: 'clubhouse', label: 'our own server' }],
        recordAudit: () => {},
      },
      { ruleId: 'invite-rule', code: 'clubhouse', label: 'our own server' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, alreadyPresent: true });
    expect(res.text).toContain('already on');
  });

  it('refuses to add an entry to a rule that does not exist, but still audits it', async () => {
    // A usage answer, not a fault — the same treatment `automod verdict`
    // gives a mistyped event id, and for the same reason: an operator at a
    // terminal will mistype a rule id. An audit row is still owed.
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteAllowCommand,
      {
        addInviteAllowlistEntry: () => 'no-such-rule',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'no-such-rule', code: 'x', label: 'y' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'no-such-rule' });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.invite_allowlist_added',
        subjectType: 'mod_rule',
        subjectId: 'no-such-rule',
        after: expect.objectContaining({ outcome: 'no-such-rule' }),
      }),
    ]);
  });

  it('refuses a rule id that names a rule of the wrong kind, but still audits it (IMPORTANT-7)', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteAllowCommand,
      {
        addInviteAllowlistEntry: () => 'wrong-kind',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'default-word-filter', code: 'clubhouse', label: 'our own server' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'wrong-kind' });
    expect(res.text).toContain('not an invite rule');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.invite_allowlist_added',
        after: expect.objectContaining({ outcome: 'wrong-kind' }),
      }),
    ]);
  });

  it('refuses without --confirm', async () => {
    const res = await driveWrite(
      automodInviteAllowCommand,
      { addInviteAllowlistEntry: () => 'added', listInviteAllowlist: () => [] },
      { ruleId: 'r1', code: 'x', label: 'y' },
      { confirm: false },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('needs-confirm');
  });
});

describe('automod invite-deny', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod invite-deny');
    expect(automodInviteDenyCommand.write).toBe(true);
  });

  it('removes an invite allowlist entry', async () => {
    const res = await driveWrite(
      automodInviteDenyCommand,
      {
        removeInviteAllowlistEntry: () => 'removed',
        listInviteAllowlist: () => [],
        recordAudit: () => {},
      },
      { ruleId: 'invite-rule', code: 'clubhouse' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, removed: true });
    expect(res.text).toContain('removed clubhouse');
  });

  it('says a code was not on the list rather than erroring', async () => {
    const res = await driveWrite(
      automodInviteDenyCommand,
      {
        removeInviteAllowlistEntry: () => 'not-present',
        listInviteAllowlist: () => [],
        recordAudit: () => {},
      },
      { ruleId: 'invite-rule', code: 'ghost' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, removed: false });
    expect(res.text).toContain('was not on');
  });

  it('refuses a rule that does not exist, but still audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteDenyCommand,
      {
        removeInviteAllowlistEntry: () => 'no-such-rule',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'no-such-rule', code: 'x' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'no-such-rule' });
    expect(audit).toEqual([
      expect.objectContaining({ action: 'automod.invite_allowlist_removed' }),
    ]);
  });

  it('refuses a rule id that names a rule of the wrong kind, but still audits it (IMPORTANT-7)', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteDenyCommand,
      {
        removeInviteAllowlistEntry: () => 'wrong-kind',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'default-word-filter', code: 'clubhouse' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'wrong-kind' });
    expect(res.text).toContain('not an invite rule');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.invite_allowlist_removed',
        after: expect.objectContaining({ outcome: 'wrong-kind' }),
      }),
    ]);
  });
});

describe('automod domain-add', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod domain-add');
    expect(automodDomainAddCommand.write).toBe(true);
  });

  it('adds a domain and audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'added', mode: 'deny' }),
        listLinkDomains: () => [{ domain: 'example.com', listType: 'deny' }],
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'domain-rule', domain: 'example.com', listType: 'deny' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, domain: 'example.com', listType: 'deny' });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.link_domain_added',
        subjectType: 'mod_rule',
        subjectId: 'domain-rule',
      }),
    ]);
  });

  it("names the domain's stored listType, not the operator's requested one, on a repeat add under the other list (IMPORTANT-1)", async () => {
    // The primary key is (guild, rule, domain), so re-adding under the
    // *other* listType is a no-op the port reports as `already-present`
    // with the listType actually stored — here, `allow`, even though the
    // operator asked for `deny`.
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'already-present', listType: 'allow', mode: 'allow' }),
        listLinkDomains: () => [{ domain: 'example.com', listType: 'allow' }],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'example.com', listType: 'deny' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, alreadyPresent: true, listType: 'allow' });
    expect(res.text).toContain("already on rule domain-rule's allow list");
    expect(res.text).not.toContain("already on rule domain-rule's deny list");
    expect(res.text).toContain('move it to deny');
  });

  it('warns when the add leaves the rule matching every link — an allow-mode rule with nothing on its allow list (CRITICAL-2)', async () => {
    // Adding a deny-listType domain to an allow-mode rule does not touch the
    // active (allow) list, so it can still be empty after the write.
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'added', mode: 'allow' }),
        listLinkDomains: () => [{ domain: 'example.com', listType: 'deny' }],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'example.com', listType: 'deny' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('matches every link');
  });

  it('refuses a listType outside allow|deny at the validator', async () => {
    const res = await driveWrite(
      automodDomainAddCommand,
      { addLinkDomain: () => ({ outcome: 'added', mode: 'allow' }), listLinkDomains: () => [] },
      { ruleId: 'r1', domain: 'example.com', listType: 'block' },
    );
    expect(res.ok).toBe(false);
  });

  it('refuses a rule that does not exist, but still audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'no-such-rule' }),
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'no-such-rule', domain: 'example.com', listType: 'allow' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'no-such-rule' });
    expect(audit).toEqual([expect.objectContaining({ action: 'automod.link_domain_added' })]);
  });

  it('refuses a rule id that names a rule of the wrong kind, but still audits it (IMPORTANT-7)', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'wrong-kind' }),
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'default-word-filter', domain: 'example.com', listType: 'allow' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'wrong-kind' });
    expect(res.text).toContain('not a link_domain rule');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.link_domain_added',
        after: expect.objectContaining({ outcome: 'wrong-kind' }),
      }),
    ]);
  });
});

describe('automod domain-rm', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod domain-rm');
    expect(automodDomainRmCommand.write).toBe(true);
  });

  it('removes a domain', async () => {
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'removed', mode: 'deny' }),
        listLinkDomains: () => [{ domain: 'other.example', listType: 'deny' }],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'example.com' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, removed: true });
  });

  it('says a domain was not on the list rather than erroring', async () => {
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'not-present', mode: 'deny' }),
        listLinkDomains: () => [{ domain: 'other.example', listType: 'deny' }],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'ghost.example' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, removed: false });
  });

  it('warns that the rule is now inert when the last deny row is removed (CRITICAL-2)', async () => {
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'removed', mode: 'deny' }),
        listLinkDomains: () => [],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'example.com' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('can never match');
  });

  it('warns that the rule now matches every link when the last allow row is removed (CRITICAL-2)', async () => {
    // The dangerous direction, not just the inert one: "the domain lists are
    // now empty" used to read as a tidy-up regardless of which one this is.
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'removed', mode: 'allow' }),
        listLinkDomains: () => [],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'club.org' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('matches every link');
    expect(res.text).toContain('add a domain or disable the rule');
  });

  it('refuses a rule that does not exist, but still audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'no-such-rule' }),
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'no-such-rule', domain: 'example.com' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'no-such-rule' });
    expect(audit).toEqual([expect.objectContaining({ action: 'automod.link_domain_removed' })]);
  });

  it('refuses a rule id that names a rule of the wrong kind, but still audits it (IMPORTANT-7)', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'wrong-kind' }),
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'default-word-filter', domain: 'example.com' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'wrong-kind' });
    expect(res.text).toContain('not a link_domain rule');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.link_domain_removed',
        after: expect.objectContaining({ outcome: 'wrong-kind' }),
      }),
    ]);
  });
});
