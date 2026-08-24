# Testing the bot against a real Discord server

**Written 2026-08-23, at the WP3 boundary.** This is step 1 of the rollout
sequence in [`docs/18`](18_SAFETY_AND_BLAST_RADIUS.md#rollout-sequence): _test
guild, dry-run off, prove the mechanics, break things deliberately._

> **Nothing in this document can be run yet.** There is no discord.js
> dependency, no adapter, and no `npm run smoke` target — `CLAUDE.md` lists that
> command aspirationally. WP5 slice 6 builds the adapter. This document is
> written first so the slice has something to be checked against, and so the
> agent building it cannot quietly redefine "working".

---

## The one rule

**The `.env` guild allowlist is the backstop, and it is the only thing standing
between a development run and the club server.** Get it wrong and every other
control is downstream of a mistake you already made.

For every exercise in this document, `BANANASAURS_GUILD_ALLOWLIST` contains
**exactly one id: your test guild.** Not the club server. Not both. One.

A guild not on that list gets logged and left — that is the
`GUILD_CREATE` → leave behaviour slice 6 must demonstrate — but do not rely on
it. It is a backstop, not a plan.

---

## Before you start

### 1. The `.env` file

```bash
cp .env.example .env
chmod 600 .env
```

Fill in, from the [Discord Developer Portal](https://discord.com/developers/applications):

| Field | Where |
|---|---|
| `DISCORD_BOT_TOKEN` | Your app → Bot → **Reset Token**. The most dangerous string in the project. |
| `DISCORD_APPLICATION_ID` | General Information → Application ID |
| `BANANASAURS_GUILD_ALLOWLIST` | **Your test guild id only.** Right-click the server → Copy Server ID (needs Developer Mode on: User Settings → Advanced → Developer Mode). |
| `BANANASAURS_OWNER_USER_ID` | Right-click yourself → Copy User ID |
| `DASHBOARD_SESSION_SECRET` | `openssl rand -base64 48` |

Leave `BANANASAURS_DRY_RUN=1` for now. You will turn it off deliberately, in
exercise 3, and not before.

Claude Code is configured to refuse to read `.env`, so your token cannot end up
in a transcript. Keep it that way — never paste it into a chat to "check the
format".

### 2. Both privileged intents

Developer Portal → your app → Bot → Privileged Gateway Intents:

- **Server Members Intent** — ON
- **Message Content Intent** — ON

Both are already enabled per `docs/STATE.md`, but check anyway: a toggle that
silently reverted is the kind of thing that produces a bot which connects fine
and then never sees a member join. Slice 6's `doctor` must assert both are
granted **at runtime**, not merely that the code configured them.

### 3. The invite, and what it grants

The bot is invited with permission integer **2416004288**, which decodes to
exactly:

| | |
|---|---|
| Add Reactions | seeding panel emoji |
| View Audit Log | inferred deletion attribution (WP4) |
| View Channel, Read Message History | seeing panels and messages |
| Send Messages, Embed Links | posting managed panels |
| Manage Roles | the only dangerous one |
| Use Application Commands | slash commands |

**What it deliberately does not include:** Manage Messages, Kick, Ban, Moderate
Members, Administrator. That absence is a design decision, not an oversight —
`docs/18` Layer 1 excludes Manage Messages, and that exclusion is exactly why
`single_choice` cannot work on a reaction panel (`docs/19` §6.3, collision 1).
If someone "fixes" a panel problem by granting Manage Messages, they have
removed a wall, not fixed a bug.

### 4. A safe test guild

Make a throwaway server. In it:

- Create three or four junk roles the bot can assign — call them `test-a`,
  `test-b`, `test-c`. **Position them below the bot's own role.** Server
  Settings → Roles, drag the bot's integration role above them.
- Create one role **above** the bot's role, called `above-bot`. You will use it
  to prove hierarchy refusal.
- Do not test with a role that grants any real permission. A junk role that
  grants nothing is enough to prove the mechanics, and it means a bug cannot
  give anyone anything.
- Invite a second account, or a friend, so you can test that a member who is not
  the owner gets the same behaviour. Owner-only testing hides authorization bugs.

---

## Running it

```bash
npm install
npm run build
npm run db:migrate      # creates ./data/bananasaurs.db
npm run dev             # reads .env, watches for changes
```

`npm run dev` currently prints the WP1 skeleton banner and stops, because
nothing is wired up. After slice 6 it will connect. If it exits with code 78 it
is a config problem and the message says which field.

**To stop it: Ctrl-C.** That is your emergency brake until the operator CLI
lands in slice 13. There is a per-guild kill switch in the database
(`guilds.killswitch`, checked as layer 2 of 12 in the effect gateway) but
nothing exposes it yet, so the process is the control. If something is going
wrong and you cannot stop the process, remove the bot's **Manage Roles**
permission in Discord, or kick the bot — Discord's own permission check is the
outermost wall and it does not care what our code believes.

---

## The exercises

Do them in order. Each one is written so that the **failure** is visible, not
just the success — a bot that does nothing passes a badly written test.

### Exercise 1 — it connects, and it leaves what it should not touch

Dry run **on**.

1. Start it. It should log a connection and name your test guild.
2. **Invite it to a second, unlisted server.** It must log the guild id and
   leave, within seconds, without touching anything. This is slice 6's
   `GUILD_CREATE` → leave demonstrable, and it is the single most important
   behaviour in this document.
3. Run `doctor` (slice 6 v1). It must report: partials configured, both
   privileged intents granted **at runtime**, the bot's own highest role
   position, and which of the allowlisted guilds it is actually in.

**What failure looks like:** it stays in the unlisted guild. Stop immediately;
that is not a bug to work around.

### Exercise 2 — dry run really is dry

Still dry run **on**.

> **You need a way to create a panel first, and there isn't one yet.** The
> operator CLI is slice 13 and the dashboard is slice 14, so nothing
> member-facing or operator-facing can define a panel at slice 6. Slice 6
> therefore ships a **dev-only seed script** — `scripts/seed-test-panel.mjs` —
> that writes one panel straight into the database through the repository, so
> exercises 2–5 are performable. It is a development fixture, not a feature: it
> refuses to run when `BANANASAURS_ENV=production`, and it is replaced by the
> CLI in slice 13. This is called out as a deliverable in the slice 6 handoff
> prompt.

1. Seed an adopted panel on a message, with two junk roles:
   `node scripts/seed-test-panel.mjs --message <id> --channel <id> --roles <a>,<b>`
   (the script prints its own usage; the exact flags are slice 6's to choose).
2. React to it.
3. **Nothing should happen to your roles.** The database should show a
   `role_effects` row with `state = 'dry_run'`, and the log should say
   `dry run: no Discord call was made`.

```bash
sqlite3 data/bananasaurs.db \
  "SELECT state, action, user_id, role_id FROM role_effects ORDER BY effect_id DESC LIMIT 10;"
```

**What failure looks like:** you get the role. Dry run is layer 10 of the
gateway's twelve and it is the control that makes every later exercise safe to
attempt. If it leaks, stop.

### Exercise 3 — turn dry run off, and prove the mechanics

Set `BANANASAURS_DRY_RUN=0`. Restart.

1. **React → the role appears.** Un-react → it goes away.
2. **`add_only`:** un-reacting leaves the role. Check the logs — there should be
   **no** `removeRole` REST call at all, not a call that was refused.
3. **`remove_only`:** reacting grants nothing.
4. **`max_roles: 2`:** react to three options; the third is declined and the
   member is told which two they have.
5. **Managed panel:** post one, click a button, get an ephemeral reply that
   matches what actually happened to your roles.

### Exercise 4 — break it on purpose

This is the exercise that matters. `docs/18` step 1 says _break things
deliberately_, and none of these has ever been tried against real Discord.

| Break it | What must happen |
|---|---|
| **Reorder roles** so a panel's role is now **above** the bot | The next attempt is refused with a hierarchy reason, and the refusal names the role. The bot must not retry in a loop. |
| **Delete a panel's message** | The next reconciliation disables the panel with `disabled_by_doctor` and the reason "the panel message was deleted", and keeps the configuration. |
| **Delete a role a panel offers** | `managed_roles.unassignable_reason` becomes `deleted`. The panel's other options keep working. |
| **Take the bot offline mid-reaction** — Ctrl-C, react and un-react while it is down, restart | This is the 30-minute-outage demonstrable at real scale. On reconnect it must record a gap, run reconciliation, and land on the state the reactions describe — **including the reaction you withdrew while it was down.** That path (ADR 0017) has never run against real Discord. |
| **React 30 times in 10 seconds** | The rate cap refuses the excess rather than queueing it, and repeated failures trip the circuit breaker. Check `guilds.breaker_tripped_at`. |
| **Remove a role by hand** that the bot just granted | It must be repaired promptly (the `GUILD_MEMBER_UPDATE` handler), and the repair must **not** bounce. If you see the role flicker repeatedly, that is amendment 5's feedback loop and it is a stop-everything bug. |
| **Grant a role by hand** that the bot just granted, then remove it a second later | The removal must still be seen as external. This is the direction bug WP3 found; it is fixed, but it is fixed against a fake. |

### Exercise 5 — the adoption pass

1. Get five or six people (or alt accounts) to react to a message **before** you
   configure a panel on it.
2. Configure the panel and run adoption.
3. **It must refuse**, saying how many changes it wants to make and that no
   allowance covers them. That refusal is the finished behaviour — the CLI that
   sizes and grants an allowance is slice 13.

**What failure looks like:** it grants everyone their role without asking. That
is a mass role change nobody approved.

### Exercise 6 — memory

Leave it running for a day. `docs/ADR 0008` says Node plus discord.js fits in
512 MB **only with** the mandated cache configuration, and that this "must be
verified, not assumed".

```bash
ps -o rss=,cmd= -p "$(pgrep -f 'apps/daemon')"
```

RSS should settle well under 512 MB and stay there. A number that climbs all day
means a cache limit did not take — several discord.js managers throw when
limited and the set has changed across minors, which is why slice 6 pins the
`ClientOptions` in an assertion test.

---

## What to check afterwards, every time

**`sqlite3` is not installed on this box.** Either install it —

```bash
sudo apt install sqlite3
```

— or use the query helper, which needs nothing new because `better-sqlite3` is
already a dependency:

```bash
node -e "
const db = require('better-sqlite3')('data/bananasaurs.db', { readonly: true });
console.table(db.prepare(process.argv[1]).all());
" "SELECT state, action, user_id, role_id FROM role_effects ORDER BY effect_id DESC LIMIT 10"
```

Open it **readonly**. The daemon holds a single-writer lock and a second writer
is exactly the thing `docs/19` §6.2's guards exist to prevent; a readonly handle
is safe alongside a running daemon, a read-write one is not.

The queries below are written for `sqlite3`; pass the same SQL string to the
helper above if you did not install it.

```bash
# Every effect, and what happened to it
sqlite3 data/bananasaurs.db \
  "SELECT state, action, user_id, role_id, error_code FROM role_effects
   ORDER BY effect_id DESC LIMIT 20;"

# The audit trail, which is what an undo would name
sqlite3 data/bananasaurs.db \
  "SELECT at, actor_type, action, subject_id, batch_id, dry_run FROM audit_events
   ORDER BY at DESC LIMIT 20;"

# Connection gaps, and whether reconciliation cleared them
sqlite3 data/bananasaurs.db \
  "SELECT gap_id, disconnected_at, reconnected_at, resumed, reconciled_at FROM gateway_gaps;"

# Safety state
sqlite3 data/bananasaurs.db \
  "SELECT guild_id, dry_run, killswitch, breaker_tripped_at, reconcile_budget FROM guilds;"
```

A gap with `reconciled_at` still null after a reconnect means reconciliation
refused — most likely over budget. That is the intended behaviour and it is also
your signal to look at why the drift was so large.

---

## When to stop and not push on

- The bot stayed in an unlisted guild.
- Dry run performed a real role change.
- A role flickered on and off repeatedly.
- Memory climbed steadily for an hour.
- Anything happened on the club server.

None of these are "log it and continue". Each one means a control that the whole
design rests on did not hold.

---

## What comes after this

Only when exercises 1–6 have all passed does the rollout move on:

3. **Real server, dry-run ON, Carl-bot still running.** One week minimum,
   comparing decisions daily.
4. Real server, dry-run off, Carl-bot's role module off, **one panel first.**
5. Remaining panels, one at a time.
6. Logging cutover once role panels have been stable for a week.

`docs/RELEASE1_CONFIG.md` — which panels, which roles, which log events, which
destinations — must exist before step 4. It is still blank.
