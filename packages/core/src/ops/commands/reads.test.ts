import { describe, expect, it } from 'vitest';
import { createDispatcher, type RegisteredCommand } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditRow, OpsInstance, OpsJobRow, OpsPorts } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import {
  auditTailCommand,
  configGetCommand,
  doctorCommand,
  jobsListCommand,
  logRoutingListCommand,
  panelListCommand,
  panelShowCommand,
  parseDuration,
} from './reads.js';

const NOW = 1_700_000_000_000;

const drive = (
  command: RegisteredCommand,
  ports: Partial<OpsPorts>,
  args: Record<string, unknown> = {},
  instance: Partial<OpsInstance> = {},
) =>
  createDispatcher({
    commands: [command],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts(ports),
    }),
    instance: fakeOpsInstance(instance),
  }).dispatch({ v: 1, command: command.name, args });

const auditRow = (over: Partial<OpsAuditRow> = {}): OpsAuditRow => ({
  auditId: 1,
  at: NOW,
  actorType: 'operator_cli',
  actorId: null,
  actorUnixUserClaimed: 'bryan',
  via: 'ssh',
  action: 'killswitch.enabled',
  subjectType: 'guild',
  subjectId: FIXTURE_GUILD_ID,
  batchId: null,
  dryRun: false,
  inferred: false,
  ...over,
});

const job = (over: Partial<OpsJobRow> = {}): OpsJobRow => ({
  jobId: 7,
  kind: 'reconcile_guild',
  state: 'queued',
  attempts: 0,
  maxAttempts: 5,
  runAfter: NOW,
  lastError: null,
  dedupeKey: 'reconcile:x',
  ...over,
});

describe('parseDuration', () => {
  it.each([
    ['90s', 90_000],
    ['45m', 2_700_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
    [' 2h ', 7_200_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['2', 'h', '2 weeks', '-2h', '2.5h', ''])('refuses %s rather than guessing', (input) => {
    expect(parseDuration(input)).toBeUndefined();
  });
});

describe('every read command', () => {
  it('is a read, so none of them needs --confirm or writes an audit row', () => {
    const reads = [
      doctorCommand,
      auditTailCommand,
      jobsListCommand,
      configGetCommand,
      panelListCommand,
      panelShowCommand,
      logRoutingListCommand,
    ];
    for (const command of reads) expect(command.write, command.name).toBe(false);
  });

  it('is registered, so the CLI can reach it', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    for (const name of [
      'doctor',
      'audit tail',
      'jobs list',
      'config get',
      'panel list',
      'panel show',
      'log routing list',
    ]) {
      expect(names, `${name} is missing from OPERATOR_COMMANDS`).toContain(name);
    }
  });
});

describe('bananasaurs audit tail', () => {
  it('renders the unix user as a claim, never as an established identity', async () => {
    // Amendment 2 and `docs/19` §6.9. The column is named
    // `actor_unix_user_claimed` precisely so this cannot quietly become "by".
    const res = await drive(auditTailCommand, { tailAudit: () => [auditRow()] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('claimed unix user bryan');
    expect(res.text).not.toMatch(/\bby bryan\b/);
  });

  it('carries the claim under its caveated name in --json too', async () => {
    const res = await drive(auditTailCommand, { tailAudit: () => [auditRow()] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.stringify(res.data)).toContain('actorUnixUserClaimed');
    expect(res.data).toMatchObject([{ actorId: null }]);
  });

  it('labels an inferred row as inferred, the same as WP4 does', async () => {
    const res = await drive(auditTailCommand, {
      tailAudit: () => [auditRow({ inferred: true, actorUnixUserClaimed: null })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('inferred');
  });

  it('labels a dry run, so a no-op is not mistaken for an action', async () => {
    const res = await drive(auditTailCommand, { tailAudit: () => [auditRow({ dryRun: true })] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('dry-run');
  });

  it('turns --since into an absolute timestamp against the context clock', async () => {
    const seen: unknown[] = [];
    await drive(
      auditTailCommand,
      {
        tailAudit: (query) => {
          seen.push(query);
          return [];
        },
      },
      { since: '2h' },
    );
    expect(seen).toEqual([{ limit: 50, sinceMs: NOW - 7_200_000 }]);
  });

  it('refuses an unparseable --since rather than silently ignoring it', async () => {
    const res = await drive(auditTailCommand, { tailAudit: () => [] }, { since: 'yesterday' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('yesterday');
  });

  it('passes -n through, and caps it', async () => {
    const seen: unknown[] = [];
    await drive(
      auditTailCommand,
      {
        tailAudit: (query) => {
          seen.push(query.limit);
          return [];
        },
      },
      { n: 5 },
    );
    expect(seen).toEqual([5]);

    const refused = await drive(auditTailCommand, { tailAudit: () => [] }, { n: 100_000 });
    expect(refused.ok).toBe(false);
  });

  it('says so plainly when there is nothing in the window', async () => {
    const res = await drive(auditTailCommand, { tailAudit: () => [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toMatch(/no audit events/);
  });
});

describe('bananasaurs config get', () => {
  it('returns a plain value', async () => {
    const res = await drive(configGetCommand, {}, { key: 'BANANASAURS_DRY_RUN' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('BANANASAURS_DRY_RUN=false');
    expect(res.text).toContain('environment');
  });

  it('returns <redacted> for a secret, because it never had the value', async () => {
    // ADR 0013 §4: "there is no override flag". The redaction happens in
    // `redactedConfig()` before the command sees anything, so there is no
    // branch here that could be inverted to leak one.
    const res = await drive(configGetCommand, {}, { key: 'DISCORD_BOT_TOKEN' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('DISCORD_BOT_TOKEN=<redacted>');
    // Labelled with its namespace, so an operator cannot mistake a process
    // value for the guild's own setting (ADR 0025).
    expect(res.text).toContain('environment');
  });

  it('cannot be made to print a secret by any argument', async () => {
    const attempts = [
      { key: 'DISCORD_BOT_TOKEN', reveal: true },
      { key: 'DISCORD_BOT_TOKEN', raw: '1' },
      { key: 'DISCORD_BOT_TOKEN', '--no-redact': true },
    ];
    for (const args of attempts) {
      const res = await drive(configGetCommand, {}, args);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(JSON.stringify(res)).not.toContain('hunter2');
      expect(res.text).toContain('<redacted>');
    }
  });

  it('names the known keys when asked for one that does not exist', async () => {
    const res = await drive(configGetCommand, {}, { key: 'NOPE' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('BANANASAURS_DRY_RUN');
  });
});

describe('bananasaurs jobs list', () => {
  it('shows how overdue a queued job is', async () => {
    const res = await drive(jobsListCommand, {
      listJobs: () => [job({ runAfter: NOW - 5_000 })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('due 5s ago');
  });

  it('shows a future job as not yet due, rather than as lateness', async () => {
    const res = await drive(jobsListCommand, { listJobs: () => [job({ runAfter: NOW + 60_000 })] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('due in 1m');
  });

  it('shows the last error on a failed job, which is the reason to look', async () => {
    const res = await drive(jobsListCommand, {
      listJobs: () => [job({ state: 'failed', attempts: 5, lastError: 'Missing Permissions' })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Missing Permissions');
  });

  it('passes --failed through to the query', async () => {
    const seen: unknown[] = [];
    await drive(
      jobsListCommand,
      {
        listJobs: (query) => {
          seen.push(query.failedOnly);
          return [];
        },
      },
      { failed: true },
    );
    expect(seen).toEqual([true]);
  });

  it('distinguishes an empty queue from no failures', async () => {
    const all = await drive(jobsListCommand, { listJobs: () => [] });
    const failed = await drive(jobsListCommand, { listJobs: () => [] }, { failed: true });
    expect(all.ok && all.text).toMatch(/queue is empty/);
    expect(failed.ok && failed.text).toMatch(/no failed jobs/);
  });
});

describe('bananasaurs log routing list', () => {
  const noRoutes = { listRoutes: () => [], listExcludedChannels: () => [] };

  const route = (over: Record<string, unknown> = {}) => ({
    routeId: '123e4567-e89b-12d3-a456-426614174000',
    name: '→ 999',
    channelId: '999999999999999999',
    enabled: true,
    includeContent: true,
    createdAtMs: NOW,
    eventKinds: ['member_join'],
    excludedChannelIds: [],
    ...over,
  });

  it('says outright that nothing is being logged when no route exists', async () => {
    // WP4's logging module is fully built and inert without a route. An empty
    // table would look identical to "working but quiet".
    const res = await drive(logRoutingListCommand, noRoutes);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toMatch(/nothing is being logged/i);
    expect(res.text).toContain('log routing create');
  });

  it('lists a route with its name, channel, events and excludes', async () => {
    const res = await drive(logRoutingListCommand, {
      listRoutes: () => [
        route({
          name: 'mod log',
          channelId: '999999999999999999',
          eventKinds: ['member_join', 'member_leave'],
          excludedChannelIds: ['555555555555555555'],
        }),
      ],
      listExcludedChannels: () => [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('123e4567');
    expect(res.text).toContain('mod log');
    expect(res.text).toContain('<#999999999999999999>');
    expect(res.text).toContain('member_join, member_leave');
    expect(res.text).toContain('<#555555555555555555>');
  });

  it('says excludes none when the route excludes nothing', async () => {
    const res = await drive(logRoutingListCommand, {
      listRoutes: () => [route()],
      listExcludedChannels: () => [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('excludes: none');
  });

  it('marks a disabled route, which otherwise reads as working', async () => {
    const res = await drive(logRoutingListCommand, {
      listRoutes: () => [route({ enabled: false })],
      listExcludedChannels: () => [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('DISABLED');
  });

  it('marks a metadata-only route', async () => {
    const res = await drive(logRoutingListCommand, {
      listRoutes: () => [route({ includeContent: false })],
      listExcludedChannels: () => [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('metadata only');
  });

  it('lists the guild-wide exclusion list, or none', async () => {
    const excluded = await drive(logRoutingListCommand, {
      listRoutes: () => [],
      listExcludedChannels: () => ['555555555555555555'],
    });
    expect(excluded.ok).toBe(true);
    if (!excluded.ok) return;
    expect(excluded.text).toContain('555555555555555555');
    expect(excluded.text).toContain('No access');

    const none = await drive(logRoutingListCommand, noRoutes);
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.text).toContain('none');
  });
});

describe('bananasaurs panel list and panel show', () => {
  const summary = {
    panelId: 'roles-main',
    kind: 'adopted',
    component: 'reaction',
    behaviour: 'toggle',
    status: 'enabled',
    messageId: '123',
    optionCount: 2,
  };

  it('lists panels', async () => {
    const res = await drive(panelListCommand, { listPanels: () => [summary] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('roles-main');
    expect(res.text).toContain('2 option(s)');
  });

  it('marks a panel that has never been posted', async () => {
    const res = await drive(panelListCommand, {
      listPanels: () => [{ ...summary, messageId: undefined }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('not posted');
  });

  it('says so when there are no panels', async () => {
    const res = await drive(panelListCommand, { listPanels: () => [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toMatch(/no panels/);
  });

  it('shows one panel in full, including a blocked adoption backlog', async () => {
    const res = await drive(
      panelShowCommand,
      {
        findPanel: () => ({
          ...summary,
          channelId: '456',
          maxRoles: 2,
          requiredRoleId: undefined,
          blockedRoleIds: ['789'],
          adoptionPassState: 'refused',
          adoptionBlockedCount: 41,
          options: [{ optionId: 'a', roleId: '111', emojiKey: 'u:1f9e0', label: undefined }],
        }),
      },
      { panelId: 'roles-main' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('at most 2 role(s)');
    expect(res.text).toContain('41 change(s) waiting on an allowance');
    expect(res.text).toContain('u:1f9e0 -> role 111');
  });

  it('refuses a panel id that does not exist, naming the guild', async () => {
    const res = await drive(panelShowCommand, { findPanel: () => undefined }, { panelId: 'nope' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('nope');
    expect(res.message).toContain(FIXTURE_GUILD_ID);
  });
});

describe('bananasaurs doctor', () => {
  const healthy = {
    listPanels: () => [],
    listUnassignableRoles: () => [],
    listKeywordFilterRulesMissingManageMessages: () => [],
    listUnusableAutomodRules: () => [],
    listAutomodRulesEnforcingWithBadCutoverState: () => [],
    listAutomodRulesObservingPastWindowWithBacklog: () => [],
    listUnreadableArchiveChannels: () => [],
    archiveIndexHealth: () => ({ indexed: 0, rows: 0 }),
  };

  it('reports ok when the gateway half is ok and nothing is stale', async () => {
    const res = await drive(doctorCommand, healthy);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('doctor: ok');
    expect(res.data).toMatchObject({ ok: true });
  });

  it('reports every provider verified when no eligibility warning is due', async () => {
    const res = await drive(doctorCommand, healthy, {}, { providerEligibilityWarnings: () => [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('training eligibility: every provider verified');
    expect(res.data).toMatchObject({ ok: true });
  });

  it('fails doctor on a not-production eligibility warning', async () => {
    const reviewedAt = NOW - 24 * 60 * 60 * 1000;
    const res = await drive(
      doctorCommand,
      healthy,
      {},
      {
        providerEligibilityWarnings: () => [
          {
            provider: 'anthropic-consumer-mcp',
            reason: 'not-production',
            trainsOnInput: 'no',
            reviewedAt,
          },
        ],
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('anthropic-consumer-mcp');
    expect(res.text).toContain('not allowed for production use');
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({ ok: false });
  });

  it('names each warned provider with its reason and ISO review date, and fails the check', async () => {
    const reviewedAt = NOW - 91 * 24 * 60 * 60 * 1000;
    const res = await drive(
      doctorCommand,
      healthy,
      {},
      {
        providerEligibilityWarnings: () => [
          {
            provider: 'anthropic-consumer-mcp',
            reason: 'stale',
            trainsOnInput: 'no',
            reviewedAt,
          },
        ],
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('anthropic-consumer-mcp');
    expect(res.text).toContain('stale');
    expect(res.text).toContain(new Date(reviewedAt).toISOString().slice(0, 10));
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({ ok: false });
  });

  it('fails when the gateway half fails, and says so', async () => {
    const res = await drive(
      doctorCommand,
      healthy,
      {},
      {
        doctor: () => ({ ok: false, text: 'intents: MessageContent NOT granted', data: null }),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('PROBLEMS FOUND');
    expect(res.text).toContain('MessageContent');
  });

  it('counts a disabled panel as a problem, not as a footnote', async () => {
    // `disabled_by_doctor` means the panel message was deleted. A green header
    // above that line would be the exact confusion `doctor` exists to prevent.
    const res = await drive(doctorCommand, {
      ...healthy,
      listPanels: () => [
        {
          panelId: 'p1',
          kind: 'adopted',
          component: 'reaction',
          behaviour: 'toggle',
          status: 'disabled_by_doctor',
          messageId: undefined,
          optionCount: 1,
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('PROBLEMS FOUND');
    expect(res.text).toContain('disabled_by_doctor');
    expect(res.data).toMatchObject({ ok: false });
  });

  it('counts an unassignable role as a problem, and names the diagnosis', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listUnassignableRoles: () => [{ roleId: '222', reason: 'above_bot' }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('above_bot');
    expect(res.data).toMatchObject({ ok: false });
  });

  it('flags an enforce-mode keyword_filter rule where the bot lacks Manage Messages', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listKeywordFilterRulesMissingManageMessages: () => [
        { ruleId: 'profanity-filter', channelId: '333' },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('automod');
    expect(res.text).toContain('profanity-filter');
    expect(res.data).toMatchObject({ ok: false });
  });

  it('reports clean when every enforce-mode rule has Manage Messages', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listKeywordFilterRulesMissingManageMessages: () => [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('automod');
    expect(res.data).toMatchObject({ ok: true });
  });

  it('reports a rule whose config cannot be compiled, and fails the check', async () => {
    // This drives a fake `OpsPorts.listUnusableAutomodRules` directly (its
    // `kind` field is a plain `string`, `ports.ts`'s
    // `OpsUnusableAutomodRule`), so the value never reaches the real
    // predicate registry — this test exercises `doctor`'s rendering of a
    // `no-predicate` row, not the registry's own classification of one. The
    // kind used to be a real-but-unshipped RuleKind ('caps', then
    // 'mention_spam', then 'rapid_spam') and was repointed three times as each
    // shipped, even though nothing here required a real kind at all.
    // 'unshipped_example' is deliberately not a `RuleKind`, so it can never be
    // invalidated by a future predicate shipping (obligation 3, Task 5a).
    const res = await drive(doctorCommand, {
      ...healthy,
      listUnusableAutomodRules: () => [
        {
          ruleId: 'shouting',
          kind: 'unshipped_example',
          reason: 'no-predicate',
          detail: 'unshipped_example',
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('shouting');
    expect(res.text).toContain('no-predicate');
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({
      ok: false,
      unusableAutomodRules: [
        {
          ruleId: 'shouting',
          kind: 'unshipped_example',
          reason: 'no-predicate',
          detail: 'unshipped_example',
        },
      ],
    });
  });

  it('says so plainly when every rule compiles', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listUnusableAutomodRules: () => [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('every enabled automod rule compiles');
  });

  it('flags a rule enforcing with a cutover_state that does not permit it', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listAutomodRulesEnforcingWithBadCutoverState: () => [
        { ruleId: 'hand-edited', cutoverState: 'observing' },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('hand-edited');
    expect(res.text).toContain('cutover_state=observing');
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({
      ok: false,
      automodEnforceModeBadCutoverState: [{ ruleId: 'hand-edited', cutoverState: 'observing' }],
    });
  });

  it('reports clean when every enforcing rule is in a cutover_state that permits it', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listAutomodRulesEnforcingWithBadCutoverState: () => [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('every enforcing rule is in a cutover state that permits it');
  });

  it('flags an observing rule past its window with an unreviewed backlog', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listAutomodRulesObservingPastWindowWithBacklog: () => [
        {
          ruleId: 'overdue-rule',
          observeStartedAt: NOW - 20 * 24 * 60 * 60 * 1000,
          unreviewedCount: 3,
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('overdue-rule');
    expect(res.text).toContain('3 unreviewed match(es)');
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({
      ok: false,
      automodObservePastWindowWithBacklog: [{ ruleId: 'overdue-rule', unreviewedCount: 3 }],
    });
  });

  it('passes ctx.now() through to the observe-window-backlog port', async () => {
    const seen: unknown[] = [];
    await drive(doctorCommand, {
      ...healthy,
      listAutomodRulesObservingPastWindowWithBacklog: (nowMs) => {
        seen.push(nowMs);
        return [];
      },
    });
    expect(seen).toEqual([NOW]);
  });

  it('reports clean when no observing rule is both overdue and backlogged', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listAutomodRulesObservingPastWindowWithBacklog: () => [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain(
      'no observing rule is both past its window and carrying an unreviewed backlog',
    );
  });

  it('flags an unreadable archive channel, and fails the check', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listUnreadableArchiveChannels: () => [{ channelId: '777', reason: 'no-view' }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Archive channel 777 is unreadable');
    expect(res.text).toContain('View Channel');
    expect(res.text).toContain('no-view');
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({
      ok: false,
      unreadableArchiveChannels: [{ channelId: '777', reason: 'no-view' }],
    });
  });

  it('reports clean when every enabled archive channel is readable', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      listUnreadableArchiveChannels: () => [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('every enabled archive channel is readable');
    expect(res.data).toMatchObject({ ok: true });
  });

  it('flags a stale archive index, and fails the check', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      archiveIndexHealth: () => ({ indexed: 1, rows: 3 }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('The archive search index is behind');
    expect(res.text).toContain('archive reindex --confirm');
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({
      ok: false,
      archiveIndexHealth: { indexed: 1, rows: 3 },
    });
  });

  it('reports clean when every archived message is indexed', async () => {
    const res = await drive(doctorCommand, {
      ...healthy,
      archiveIndexHealth: () => ({ indexed: 2, rows: 2 }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('every archived message is indexed');
    expect(res.data).toMatchObject({ ok: true });
  });

  it('survives a doctor report that could not be built', async () => {
    const res = await drive(
      doctorCommand,
      healthy,
      {},
      {
        doctor: () => ({ ok: false, text: 'doctor could not read the client: boom', data: null }),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('could not read the client');
  });

  it('turns a green doctor into PROBLEMS FOUND on an exposed dashboard row alone', async () => {
    // Ruling M6-D1: an exposed dashboard is a silent breach of the exposure
    // decision, not decoration under a green header — so the probe's `ok`
    // joins the conjunction, and one exposed row fails the whole command even
    // when every other half is clean.
    const res = await drive(
      doctorCommand,
      healthy,
      {},
      {
        probePublicSurface: () =>
          Promise.resolve({
            probed: true,
            ok: false,
            text: 'public surface    /: expected Access, observed status 200, text/html — exposed\npublic surface    1 problem(s)',
            data: [
              {
                path: '/',
                expects: 'access',
                outcome: 'exposed',
                observed: { status: 200, contentType: 'text/html', locationHost: null },
              },
            ],
          }),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('exposed');
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({ ok: false });
  });

  it('reports the public surface as not probed when MCP_PUBLIC_URL is unset', async () => {
    const res = await drive(doctorCommand, healthy);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('public surface    not probed (MCP_PUBLIC_URL unset)');
    expect(res.data).toMatchObject({ ok: true });
  });
});

describe('bananasaurs doctor dashboard access (S13-D5)', () => {
  const healthy = {
    listPanels: () => [],
    listUnassignableRoles: () => [],
    listKeywordFilterRulesMissingManageMessages: () => [],
    listUnusableAutomodRules: () => [],
    listAutomodRulesEnforcingWithBadCutoverState: () => [],
    listAutomodRulesObservingPastWindowWithBacklog: () => [],
    listUnreadableArchiveChannels: () => [],
    archiveIndexHealth: () => ({ indexed: 0, rows: 0 }),
  };

  // The gateway-half report carries the dashboard-access data the daemon's
  // wiring computed over the account tables; the command renders the
  // `dashboard access    …` lines from it and folds the verdict into `ok`.
  const withDashboardAccess = (
    dashboardAccess: {
      enabledAccounts: number;
      unreachableGuilds: string[];
      liveBootstrapTokens: number;
    },
    reportOk: boolean,
    reportText = 'gateway: ok',
  ) =>
    drive(
      doctorCommand,
      healthy,
      {},
      {
        doctor: () => ({ ok: reportOk, text: reportText, data: { dashboardAccess } }),
      },
    );

  it('reports ok when an enabled account reaches every allowlisted guild', async () => {
    const res = await withDashboardAccess(
      { enabledAccounts: 1, unreachableGuilds: [], liveBootstrapTokens: 0 },
      true,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('dashboard access: ok');
    expect(res.data).toMatchObject({ ok: true });
  });

  it('names an allowlisted guild no enabled account can reach, and fails the check', async () => {
    const res = await withDashboardAccess(
      { enabledAccounts: 1, unreachableGuilds: ['999000111222333444'], liveBootstrapTokens: 0 },
      false,
      'gateway: ok',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('999000111222333444');
    expect(res.text).toContain('account grant-guild');
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({ ok: false });
  });

  it('treats zero accounts with a live bootstrap token as setup pending, not broken', async () => {
    const res = await withDashboardAccess(
      { enabledAccounts: 0, unreachableGuilds: [], liveBootstrapTokens: 1 },
      true,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Dashboard setup is pending');
    expect(res.text).toContain('bootstrap token');
    expect(res.text).not.toContain('PROBLEMS FOUND');
    expect(res.data).toMatchObject({ ok: true });
  });

  it('fails when nobody can sign in: zero accounts and no live bootstrap token', async () => {
    const res = await withDashboardAccess(
      { enabledAccounts: 0, unreachableGuilds: [], liveBootstrapTokens: 0 },
      false,
      'gateway: ok',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Nobody can sign in to the dashboard');
    expect(res.text).toContain('Restart the daemon to mint a new bootstrap token');
    expect(res.text).toContain('doctor: PROBLEMS FOUND');
    expect(res.data).toMatchObject({ ok: false });
  });

  it('says nothing about dashboard access when the report predates the finding', async () => {
    // Older or stubbed `doctor()` ports return data without the section
    // (including `data: null`); the command skips the finding rather than
    // failing a state it did not assess.
    const res = await drive(doctorCommand, healthy);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).not.toContain('dashboard access');
    expect(res.data).toMatchObject({ ok: true });
  });
});
