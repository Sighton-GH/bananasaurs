// Writes one role panel straight into the database, so the bot can be tested.
//
// **A development fixture, not a feature.** `docs/21` exercises 2 to 5 all begin
// "seed a panel", and at slice 6 nothing member-facing or operator-facing can
// create one: the operator CLI is slice 13 and the dashboard is slice 14. This
// exists to unblock those exercises and is replaced by `panel create` when the
// CLI arrives. It refuses to run in production, and it validates through the
// same Zod schema and the same repository the real thing will use — so a panel
// it writes is a panel the daemon would have written, not a hand-made row.
//
//   npm run build && node scripts/seed-test-panel.mjs \
//     --channel <id> --message <id> --roles <roleA>,<roleB>
//
// The daemon must be stopped: SQLite has one writer and the lock is enforced.
import process from 'node:process';

const USAGE = `
seed-test-panel — writes one role panel into the database (development only)

  node scripts/seed-test-panel.mjs --channel <id> --message <id> --roles <a>,<b>

Required
  --channel <id>        the channel the panel message is in
  --message <id>        the message members react to
  --roles <a>,<b>       role ids, one per option, in order

Optional
  --guild <id>          defaults to the first BANANASAURS_GUILD_ALLOWLIST entry
  --panel-id <name>     defaults to "test-panel"
  --emoji <a>,<b>       one per role; defaults to 🅰️ 🅱️ 🅲 🅳 ...
  --behaviour <name>    toggle (default) | add_only | remove_only
  --replace             overwrite a panel with the same id
  --adopt               also queue an adoption pass for the panel

Notes
  Run "npm run build && npm run db:migrate" first. Stop the daemon: SQLite has
  one writer, and this refuses rather than corrupting anything.

  The roles are added to the role allowlist, because the effect gateway refuses
  to touch a role that is not on it — that refusal is layer 2 working, and
  seeding a panel without it produces a panel that silently does nothing.

  Put the emoji on the message yourself. Nothing in the daemon calls
  seedPanelReactions yet — its trigger is "panel sync" in the operator CLI,
  which is slice 13. An adopted panel usually has its reactions already, which
  is what makes it adoptable.
`;

const DEFAULT_EMOJI = ['🅰️', '🅱️', '🅲', '🅳', '🅴', '🅵'];

function fail(message) {
  process.stderr.write(`\n${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'replace' || key === 'adopt') {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${key} needs a value`);
    args[key] = value;
    i += 1;
  }
  return args;
}

const isSnowflake = (value) => /^\d{17,20}$/.test(value);

// ── the two refusals, before anything is imported or opened ────────────────

// A fixture that writes panels nobody reviewed has no business anywhere near a
// live guild. `BANANASAURS_ENV` is the same switch the rest of the system reads.
if (process.env.BANANASAURS_ENV === 'production') {
  process.stderr.write(
    '\nseed-test-panel refuses to run with BANANASAURS_ENV=production.\n' +
      'It is a development fixture; use the operator CLI (slice 13) instead.\n\n',
  );
  process.exit(3);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}

const args = parseArgs(argv);

const channelId = args.channel;
const messageId = args.message;
const roleIds = (args.roles ?? '').split(',').filter(Boolean);

if (!channelId || !isSnowflake(channelId)) fail('--channel must be a Discord snowflake');
if (!messageId || !isSnowflake(messageId)) fail('--message must be a Discord snowflake');
if (roleIds.length === 0) fail('--roles must list at least one role id');
for (const roleId of roleIds) {
  if (!isSnowflake(roleId)) fail(`--roles contains something that is not a snowflake: ${roleId}`);
}

const guildId = args.guild ?? (process.env.BANANASAURS_GUILD_ALLOWLIST ?? '').split(',')[0]?.trim();
if (!guildId || !isSnowflake(guildId)) {
  fail('--guild is required when BANANASAURS_GUILD_ALLOWLIST is not set');
}

const emoji = args.emoji ? args.emoji.split(',') : DEFAULT_EMOJI.slice(0, roleIds.length);
if (emoji.length < roleIds.length) fail('--emoji must give one emoji per role');

// ── the database, imported only once the arguments are known good ──────────
// Dynamic, so that the refusals above work on a checkout that has not been
// built. Imports are hoisted; these are not.
const { unicodeEmojiKey, panelDefinitionSchema, parseGuildId, JOB_KINDS, adoptDedupeKey } =
  await import('../packages/core/dist/index.js');
const { openDatabase, guildRepo, jobRepo, panelRepo, roleRepo } =
  await import('../packages/storage/dist/index.js');

const definition = panelDefinitionSchema.parse({
  panelId: args['panel-id'] ?? 'test-panel',
  kind: 'adopted',
  channelId,
  messageId,
  behaviour: args.behaviour ?? 'toggle',
  component: 'reaction',
  options: roleIds.map((roleId, index) => ({
    optionId: `opt-${index + 1}`,
    roleId,
    emojiKey: unicodeEmojiKey(emoji[index]),
    position: index,
  })),
});

const dbPath = process.env.BANANASAURS_DB_PATH ?? './data/bananasaurs.db';
let opened;
try {
  opened = openDatabase({ dbPath });
} catch (err) {
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(4);
}

try {
  const scope = opened.scopes.forGuild(parseGuildId(guildId));
  const now = Date.now();

  // The guild row is the parent of every guild-scoped foreign key. The daemon
  // creates it at startup; seeding before the first run has to do the same.
  guildRepo.upsertGuild(scope, { name: guildId, enabled: true, now });

  if (panelRepo.findPanel(scope, definition.panelId)) {
    if (!args.replace) {
      process.stderr.write(
        `\nA panel called "${definition.panelId}" already exists.` +
          ' Pass --replace to overwrite it, or --panel-id to add another.\n\n',
      );
      process.exit(5);
    }
    panelRepo.deletePanel(scope, definition.panelId);
  }

  // Layer 2. Without this the effect gateway refuses every role this panel
  // offers, correctly, and the panel appears to do nothing at all.
  for (const roleId of roleIds) roleRepo.allowlistRole(scope, roleId);

  panelRepo.createPanel(scope, definition, now);

  // The adoption pass has no producer in the daemon either — the CLI's
  // "panel adopt" is slice 13. Enqueueing the job is a plain database write, so
  // the script can do it and a running daemon will pick it up within a second.
  // Expect it to REFUSE and report a change count: an adoption pass that would
  // move more members than the standing allowance needs an owner to approve it,
  // and granting that allowance is also slice 13.
  if (args.adopt) {
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.adoptPanel,
      payload: JSON.stringify({ panelId: definition.panelId }),
      dedupeKey: adoptDedupeKey(definition.panelId),
      now,
    });
  }

  const dryRun = guildRepo.readSafetyState(scope)?.dryRun !== false;
  process.stdout.write(
    `\nSeeded panel "${definition.panelId}" in guild ${guildId}.\n\n` +
      definition.options
        .map((o) => `  ${emoji[o.position]}  -> role ${o.roleId}  (${o.emojiKey})`)
        .join('\n') +
      `\n\n  message:   ${channelId}/${messageId}\n` +
      `  behaviour: ${definition.behaviour}\n` +
      `  dry run:   ${dryRun ? 'ON — no role will actually change' : 'OFF — roles will change'}\n\n` +
      `  adoption:  ${args.adopt ? 'queued — the daemon runs it within a second' : 'not queued (pass --adopt)'}\n\n` +
      '  Add the emoji above to the message yourself, then react with it.\n' +
      '  Nothing seeds them yet: that is "panel sync" in the CLI, slice 13.\n\n',
  );
} finally {
  opened.close();
}
