// Posts one of every task card to a test channel, for a visual check on
// desktop and mobile, light and dark (ADR 0140, docs/SMOKE_TESTS.md).
//
//   npm run build && npm run smoke:cards -- --channel <channel id>
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
console.log(
  'Done. The buttons on these cards point at sample tasks, so pressing them gives a "closed" reply.',
);
