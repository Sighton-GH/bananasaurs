// Posts one of every task card to a test channel, for a visual check on
// desktop and mobile, light and dark (ADR 0140, docs/SMOKE_TESTS.md).
//
//   npm run build && npm run smoke:cards -- --channel <channel id> [--p2]
//
// With --p2, after the P1 cards it posts one of each P2 log, moderation,
// history, panel and error card (ADR 0141).
//
// Owner-run only. Needs DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID and
// TEST_GUILD_ID in .env. Refuses any channel outside TEST_GUILD_ID. Pings
// nobody: every sample is a whole-team task with no role.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const channelId = args[args.indexOf('--channel') + 1];
if (!args.includes('--channel') || !/^\d{17,20}$/.test(channelId ?? '')) {
  console.error('Usage: npm run smoke:cards -- --channel <channel id>');
  process.exit(2);
}
for (const name of ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'TEST_GUILD_ID']) {
  if (!process.env[name]) {
    console.error(`${name} is not set in .env.`);
    process.exit(2);
  }
}

const core = await import('../packages/core/dist/index.js');
const { createDiscordRestPort } = await import('../packages/discord/dist/rest/index.js');
const { REST, Routes } = await import('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
const channel = await rest.get(Routes.channel(channelId));
if (channel.guild_id !== process.env.TEST_GUILD_ID) {
  console.error('That channel is not in TEST_GUILD_ID. Refusing.');
  process.exit(2);
}
const port = createDiscordRestPort({
  rest,
  applicationId: process.env.DISCORD_APPLICATION_ID,
  botUserId: () => process.env.DISCORD_APPLICATION_ID,
});

const ASSETS = new URL('../apps/daemon/assets/cards/', import.meta.url);
const loadArt = (key) => ({
  name: core.ART[key].file,
  contentType: 'image/png',
  data: new Uint8Array(readFileSync(new URL(core.ART[key].file, ASSETS))),
  description: core.ART[key].alt,
});
const send = async (label, card) => {
  const ref = await port.sendMessage(channel.guild_id, channelId, {
    ...core.toOutgoingMessage(card, loadArt),
    pingReplyAuthor: false,
  });
  console.log(`posted ${label}`);
  return ref;
};

const now = Date.now();
const DAY = 86_400_000;
const base = {
  taskId: randomUUID(),
  version: 1,
  title: 'Wire the brake light harness',
  description:
    'Run the harness from the rear bulkhead to both tail lights. Use 18 AWG and heat-shrink every splice.',
  teamName: 'Card gallery',
  status: 'not_started',
  priority: 'normal',
  dueAt: now + 7 * DAY,
  now,
  audience: { kind: 'team' },
  links: [
    { label: 'Wiring diagram', url: 'https://example.com/wiring' },
    { label: 'BOM sheet', url: 'https://example.com/bom' },
  ],
  updatedAt: now,
  variant: 'announce',
};

const first = await send('new task', core.renderTaskCard(base));
await send(
  'in progress',
  core.renderTaskCard({
    ...base,
    status: 'in_progress',
    variant: 'refresh',
    lastUpdate: {
      authorId: 'owner',
      at: now - 60_000,
      body: 'Left side done, right side tomorrow.',
    },
  }),
);
await send(
  'overdue',
  core.renderTaskCard({ ...base, status: 'in_progress', dueAt: now - 3 * DAY, variant: 'refresh' }),
);
await send(
  'waiting for review',
  core.renderTaskCard({ ...base, status: 'awaiting_approval', variant: 'refresh' }),
);
await send('done', core.renderTaskCard({ ...base, status: 'done', variant: 'refresh' }));
await send('urgent', core.renderTaskCard({ ...base, priority: 'urgent' }));
await send(
  'update',
  core.renderUpdateCard({
    taskTitle: base.title,
    teamName: base.teamName,
    authorId: 'owner',
    body: 'Left side done.\n\nBlocked: waiting on connectors',
    replyTo: first.messageId,
  }),
);
await send(
  'review request',
  core.renderReviewRequestCard({
    taskId: base.taskId,
    version: 1,
    taskTitle: base.title,
    teamName: base.teamName,
    requestedBy: 'owner',
    latestUpdate: 'Both lights work.',
  }),
);
await send(
  'approved',
  core.renderReviewDecisionCard({
    taskTitle: base.title,
    teamName: base.teamName,
    decision: 'approved',
    deciderId: 'owner',
    at: now,
  }),
);
await send(
  'sent back',
  core.renderReviewDecisionCard({
    taskTitle: base.title,
    teamName: base.teamName,
    decision: 'sent-back',
    deciderId: 'owner',
    at: now,
  }),
);
await send(
  'reminder',
  core.renderReminderCard({
    taskId: base.taskId,
    version: 1,
    taskTitle: base.title,
    teamName: base.teamName,
    dueAt: now + 2 * DAY,
    now,
    audience: { kind: 'team' },
    kind: 'pre_due',
    status: 'not_started',
  }),
);
await send(
  'check-in',
  core.renderCheckinCard({
    teamName: base.teamName,
    items: [
      { title: base.title, dueAt: now + DAY, who: 'whole team' },
      { title: 'Book the skid-pad slot', dueAt: now + 2 * DAY, who: 'whole team' },
    ],
    pingUsers: [],
    pingRoles: [],
  }),
);
await send(
  'digest',
  core.renderDigestCard({
    teamName: base.teamName,
    weekOf: now,
    overdue: [{ title: 'Order wheel bearings', dueAt: now - DAY, who: 'whole team' }],
    dueThisWeek: [{ title: base.title, dueAt: now + DAY, who: 'whole team' }],
    later: [],
    doneThisWeek: ['Seat mount welds', 'Pedal box CAD'],
  }),
);
await send(
  'pick',
  core.renderPickCard({
    choiceMessageId: first.messageId,
    candidates: [
      { taskId: randomUUID(), title: 'Harness' },
      { taskId: randomUUID(), title: 'Bearings' },
    ],
  }),
);
await send(
  'clarify',
  core.renderClarifyCard({
    question: 'Which side is finished, left or right?',
    replyTo: first.messageId,
  }),
);
await send(
  'task list',
  core.renderTaskListCard({
    rows: [
      { teamName: 'Car', title: base.title, status: 'in_progress', dueAt: now + DAY },
      { teamName: 'Aero', title: 'Upload CFD results', status: 'not_started', dueAt: now - DAY },
    ],
    now,
  }),
);
await send('error', core.errorCard('task.update-not-saved', { quote: 'Left side done.' }));
await send(
  'result',
  core.resultCard({
    icon: 'update',
    title: 'Update saved',
    detail: 'It shows on the task card and is posted in the channel.',
    tone: 'ok',
  }),
);

if (args.includes('--p2')) {
  // P2 cards (ADR 0141), from the built core. The log, mod and history
  // renderers are pure, so the gallery calls them directly; it never runs a
  // moderation action. Every mention below is the sample guild's own channel
  // id or the bot's application id: allowedMentions stops them pinging, and
  // the buttons point at nothing real, so pressing them gives a refusal or
  // an "already handled" reply.
  const { renderLogCard } = await import('../packages/core/dist/logging/cards.js');
  const { formatGapMarker } = await import('../packages/core/dist/logging/format.js');
  const {
    modOutcomeCard,
    warnOutcomeCard,
    banConfirmCard,
    purgeConfirmCard,
    deleteConfirmCard,
    historyCard,
  } = await import('../packages/core/dist/mod/cards.js');
  const { buildHistoryPage } = await import('../packages/core/dist/mod/history.js');

  const APP = process.env.DISCORD_APPLICATION_ID;
  const GUILD = process.env.TEST_GUILD_ID;
  const MSG = '123456789012345678';
  const IID = '1234567890123456789';

  await send(
    'log message edit',
    renderLogCard(
      {
        kind: 'message_edit',
        headline: `<@${APP}> edited a message in <#${channelId}>`,
        quote: { label: 'Now reads', text: 'Left side done, right side tomorrow.' },
        at: now,
        memberId: APP,
        message: { channelId, messageId: MSG, exists: true },
      },
      GUILD,
    ),
  );
  await send(
    'log message delete',
    renderLogCard(
      {
        kind: 'message_delete',
        headline: `Message by <@${APP}> deleted in <#${channelId}>`,
        details: [`Deleted by <@${APP}> (inferred)`],
        quote: { label: 'It read', text: 'Left side done.' },
        at: now,
        memberId: APP,
        message: { channelId, messageId: MSG, exists: false },
      },
      GUILD,
    ),
  );
  await send(
    'log member ban',
    renderLogCard(
      {
        kind: 'member_ban',
        headline: `Banned: <@${APP}> by <@${APP}>`,
        at: now,
      },
      GUILD,
    ),
  );
  await send('log gap', renderLogCard(formatGapMarker(now - 60_000, now, now), GUILD));
  await send(
    'log automod match',
    renderLogCard(
      core.formatAutomodMatch(
        {
          ruleId: 'sample-rule',
          ruleKind: 'keyword filter',
          memberId: APP,
          channelId,
          parentChannelId: undefined,
          categoryId: undefined,
          messageId: MSG,
          snippet: 'buy cheap followers now',
          actionTaken: 'would_delete',
          at: now,
        },
        true,
      ),
      GUILD,
    ),
  );

  await send(
    'mod timeout applied',
    modOutcomeCard({
      action: 'timeout',
      targetId: APP,
      outcome: { status: 'applied' },
      reason: 'Spam links in #general',
      durationMinutes: 10,
      interactionId: IID,
    }),
  );
  await send(
    'mod timeout dry run',
    modOutcomeCard({
      action: 'timeout',
      targetId: APP,
      outcome: { status: 'dry-run' },
      reason: 'Spam links in #general',
      durationMinutes: 10,
      interactionId: IID,
    }),
  );
  await send(
    'mod timeout refused',
    modOutcomeCard({
      action: 'timeout',
      targetId: APP,
      outcome: { status: 'refused', reason: 'role-above-bot' },
      reason: 'Spam links in #general',
      durationMinutes: 10,
      interactionId: IID,
    }),
  );
  await send(
    'mod warn refused escalation',
    warnOutcomeCard({
      targetId: APP,
      reason: 'Spam links in #general',
      caseId: randomUUID(),
      violationCount: 3,
      escalation: { status: 'refused', reason: 'killswitch' },
    }),
  );

  await send(
    'mod ban confirm',
    banConfirmCard({ targetId: APP, reason: 'Raid account', intentId: randomUUID() }),
  );
  await send(
    'mod purge confirm',
    purgeConfirmCard({
      channelId,
      total: 12,
      fresh: 9,
      old: 3,
      newestAtMs: now,
      reason: 'Spam flood',
      intentId: randomUUID(),
    }),
  );
  await send(
    'mod delete confirm',
    deleteConfirmCard({
      guildId: GUILD,
      channelId,
      messageId: MSG,
      authorId: APP,
      intentId: randomUUID(),
    }),
  );

  const historyCases = [
    {
      caseId: randomUUID(),
      memberId: APP,
      openedAt: now - 9 * DAY,
      violationCount: 4,
      escalationTier: 1,
      status: 'open',
    },
    {
      caseId: randomUUID(),
      memberId: APP,
      openedAt: now - 30 * DAY,
      violationCount: 1,
      escalationTier: 0,
      status: 'closed',
    },
  ];
  const historyKinds = [
    { actionTaken: 'warned', matchedCategory: 'spam', actorId: true },
    { actionTaken: 'warned', matchedCategory: 'spam', actorId: true },
    {
      actionTaken: 'manual_applied',
      matchedCategory: 'timeout',
      escalationAction: 'timeout',
      actorId: true,
    },
    { actionTaken: 'deleted', matchedCategory: 'spam' },
    { actionTaken: 'would_delete', matchedCategory: 'spam' },
    { actionTaken: 'note', matchedCategory: 'note', actorId: true },
    { actionTaken: 'evidence_added', matchedCategory: 'evidence', actorId: true },
    {
      actionTaken: 'escalation_refused',
      matchedCategory: 'timeout',
      escalationAction: 'timeout',
      actorId: true,
    },
    {
      actionTaken: 'escalation_dry_run',
      matchedCategory: 'kick',
      escalationAction: 'kick',
      actorId: true,
    },
    { actionTaken: 'native_blocked', matchedCategory: 'spam' },
    { actionTaken: 'purged', matchedCategory: 'purge', actorId: true },
    {
      actionTaken: 'manual_applied',
      matchedCategory: 'ban',
      escalationAction: 'ban',
      actorId: true,
    },
  ];
  const historyEvents = historyKinds.map((k, i) => ({
    eventId: `evt-${i}`,
    caseId: historyCases[i % 2].caseId,
    ruleId: 'manual',
    memberId: APP,
    at: now - i * DAY,
    matchedCategory: k.matchedCategory,
    matchedSnippet: `sample message ${i}`,
    actionTaken: k.actionTaken,
    escalationAction: k.escalationAction,
    refusalReason: k.actionTaken === 'escalation_refused' ? 'killswitch' : undefined,
    actorId: k.actorId === true ? APP : undefined,
  }));
  const historyByCase = new Map(
    historyCases.map((c) => [c.caseId, historyEvents.filter((e) => e.caseId === c.caseId)]),
  );
  // 12 events at 8 per page: two pages, so the card carries Older/Newer buttons.
  await send('mod history', historyCard(buildHistoryPage(APP, historyCases, historyByCase, 0)));

  await send(
    'role panel',
    core.renderPanelCard({
      panelId: 'gallery-roles',
      kind: 'managed',
      channelId,
      messageId: undefined,
      content: '**Gallery roles**',
      behaviour: 'toggle',
      component: 'button',
      maxRoles: undefined,
      requiredRoleId: undefined,
      blockedRoleIds: [],
      status: 'enabled',
      adoptionPassState: 'done',
      adoptionBlockedCount: 0,
      options: ['Mechanical', 'Electrical', 'Software', 'Aero', 'Media', 'Exec'].map(
        (label, i) => ({
          optionId: `opt-${i}`,
          roleId: String(100000000000000000n + BigInt(i + 1)),
          emojiKey: undefined,
          label,
          position: i,
        }),
      ),
    }),
  );

  await send('error mod not-allowed', core.errorCard('mod.not-allowed', { ref: '23456789' }));
  await send('error panel max-roles', core.errorCard('panel.max-roles'));
}
console.log(
  'Done. The buttons on these cards point at sample tasks, so pressing them gives a "closed" reply.',
);
