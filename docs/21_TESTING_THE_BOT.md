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
| `ASSISTANT_PROVIDER_SECRET_KEY` | `openssl rand -base64 48` (required only for write-only provider-key setup in the WebUI; keep stable across restarts) |

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

**Where this integer actually goes.** The current Developer Portal has no box
where you type "2416004288" — that number is what Discord *computes* from
checkboxes, and it only ever shows up baked into an invite URL. Go to your app
→ **Installation** → **Default Install Settings** → **Guild Install**, and
under **Scopes** add `bot` and `applications.commands`. Under **Permissions**,
add exactly these eight, by name (this is the same list as the table above):

- Add Reactions
- View Audit Log
- View Channel
- Send Messages
- Embed Links
- Read Message History
- Manage Roles
- Use Application Commands

Then use the **Install Link** on that same page to invite the bot — Discord
builds `permissions=2416004288` into that URL from your checkboxes; you never
type the number yourself.

If you already invited the bot with a smaller set (for example, only Manage
Roles and View Audit Log), you do not need to redo the invite: open your test
server → **Server Settings → Roles → (the bot's own role)** and turn the
missing permissions on there directly. Re-inviting with a corrected link also
updates permissions for a bot already in the server, but editing the role is
faster.

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
npm run doctor          # connects, reports, exits. Does NOT open the database
npm run start           # the real thing
```

All three read `.env` through `node --env-file=.env`, not dotenv — so a bare
`node apps/daemon/dist/index.js` will not see it. Exit code **78** is a config
problem and the message says which field. Exit **69** is something an operator
has to look at: the database is held by another process, or Discord refused the
connection.

`npm run dev` runs the same daemon from TypeScript source with `--watch`. Use
`npm run start` for real testing, so you are running what you built.

**To stop it: Ctrl-C.** That is your emergency brake until the operator CLI
lands in slice 13. There is a per-guild kill switch in the database
(`guilds.killswitch`, checked as layer 2 of 12 in the effect gateway) but
nothing exposes it yet, so the process is the control. If something is going
wrong and you cannot stop the process, remove the bot's **Manage Roles**
permission in Discord, or kick the bot — Discord's own permission check is the
outermost wall and it does not care what our code believes.

---

## Today's run — the short version

**Written 2026-08-24, after WP5 slice 6.** This is the whole session as a
checklist. The exercises further down give the reasoning; this gives the
keystrokes. Do it in one sitting, in order, and stop at the first **STOP** you
hit.

### Step 0 — before you touch Discord

```bash
cd /home/bryan/projects/bananasaurs
npm install && npm run build && npm run db:migrate
```

Open `.env` and confirm two things with your own eyes:

- [ ] `BANANASAURS_DRY_RUN=1`
- [ ] `BANANASAURS_GUILD_ALLOWLIST` contains **only your test guild id**

**Steps 1 to 4 depend on both.** Step 5 is where dry run comes off, deliberately
and not before. Do not skip this check.

### Step 1 — doctor

```bash
npm run doctor
```

It connects, prints a report, and exits — 0 healthy, 1 problems. It does not
open the database, so it is safe to run at any time, including while the daemon
is running. You want all five of these:

- [ ] `partials configured: Message, Channel, Reaction, User, GuildMember`
- [ ] `gateway session: established`
- [ ] `privileged intent GuildMembers: granted`
- [ ] `privileged intent MessageContent: granted`
- [ ] your test guild listed as present, with a member count, a highest role
      position, and **no** `MISSING PERMISSIONS` line

> **STOP** if any line says `MISSING`, `NOT REQUESTED`, `NOT ESTABLISHED` or
> `NOT PRESENT`. Nothing further can work, and doctor has just told you which of
> the four it is.

### Step 2 — start it, and keep the log

```bash
npm run start 2>&1 | tee /tmp/bananasaurs.log
```

Keeping the log matters: if anything goes wrong later, that file is what you
send. Look for `bananasaurs starting`, then `doctor: ok`, then your guild's real
name.

### Step 3 — Exercise 1: it leaves what it should not touch

In Discord: **create a brand-new throwaway server** and invite the bot to it
with the same invite URL.

- [ ] Within seconds the log says `event from a guild outside the allowlist;
      leaving`, with that guild's id
- [ ] The bot is gone from the throwaway server's member list
- [ ] It did nothing else there — no messages, no role changes

> **STOP** if it stays. This is the single most important behaviour in this
> document and it is not a bug to work around.

Delete the throwaway server afterwards.

### Step 4 — Exercise 2: dry run really is dry

Pick a message in your test guild — right-click → **Copy Message Link** gives
you `.../<guild>/<channel>/<message>` — and **two junk roles**, created for this
and held by nobody.

In a second terminal, from the repo root:

```bash
cd /home/bryan/projects/bananasaurs
node scripts/seed-test-panel.mjs \
  --channel CHANNEL_ID --message MESSAGE_ID \
  --roles ROLE_ID_A,ROLE_ID_B
```

Replace `CHANNEL_ID`, `MESSAGE_ID`, `ROLE_ID_A`, and `ROLE_ID_B` with the plain
numeric ids you copied from Discord. **Do not wrap them in `<` and `>`.** Those
angle brackets are just this document's way of marking "fill this in" — bash
reads `<` and `>` as redirection operators, not as bracket punctuation, so
`--channel <1540816151137878028>` fails with `syntax error near unexpected
token`. A correctly filled-in command looks like this (fake ids below):

```bash
node scripts/seed-test-panel.mjs \
  --channel 1540816151137878028 --message 1543352717022601348 \
  --roles 1543350960577974323,1543350986360225912
```

It prints the two emoji it assigned (🅰️ and 🅱️ by default).

- [ ] **Add those two emoji to the message yourself.** Nothing seeds them yet —
      that is `panel sync` in the operator CLI, slice 13
- [ ] React with 🅰️
- [ ] **Your roles do not change**
- [ ] The log says a dry run was recorded and no Discord call was made

```bash
sqlite3 data/bananasaurs.db \
  "SELECT state, action, user_id, role_id FROM role_effects ORDER BY effect_id DESC LIMIT 5;"
```

- [ ] The newest row has `state = 'dry_run'`

> **STOP** if you actually got the role. Dry run is the control that makes every
> later step safe to attempt.

### Step 5 — Exercise 3: turn it on

Ctrl-C the daemon. Set `BANANASAURS_DRY_RUN=0` in `.env`. Start it again.

- [ ] The log says **"dry run turned OFF by configuration; Discord side effects
      are live"**. If it does not, the change did not take — check you edited the
      right file

Then:

- [ ] React 🅰️ → the role appears. Un-react → it goes away
- [ ] Re-seed with `--behaviour add_only --replace`, restart, react then
      un-react → the role **stays**, and there is **no** `removeRole` call in the
      log at all (not a refused one — none)
- [ ] Re-seed with `--behaviour remove_only --replace`, restart → reacting grants
      nothing

### Step 6 — Exercise 4: break it on purpose

One at a time. Restart the daemon where the line says to.

- [ ] **Hierarchy.** Drag a panel role **above** the bot's role in Server
      Settings → Roles, then react. Refused, with a reason naming the role, and
      **no retry loop**. Put it back afterwards
- [ ] **Deleted message.** Delete the panel's message, restart the daemon.
      Reconciliation disables the panel with the reason "the panel message was
      deleted" and keeps the configuration
- [ ] **Deleted role.** Delete one of the two junk roles, restart. Check
      `managed_roles.unassignable_reason` is `deleted`, and the other option
      still works
- [ ] **The outage.** Ctrl-C the daemon. While it is down, react to one option
      and un-react from another. Start it again. It records a gap, runs
      reconciliation, and lands on what the reactions say — **including the one
      you withdrew while it was down**
- [ ] **The rate cap.** React and un-react about 30 times in 10 seconds. The
      excess is refused rather than queued, and repeated failures trip the
      breaker. Check `guilds.breaker_tripped_at`

      **30 in 10 seconds is not achievable by hand.** The default cap
      (`BANANASAURS_ROLE_RATE_LIMIT_PER_MIN=20`) gives a burst of 20 actions
      before anything is refused, and Discord's own reaction UI has enough
      friction that a human cannot exceed that in 10 seconds — clicking every
      few seconds just lets the bucket refill as fast as you spend it. Instead,
      temporarily set `BANANASAURS_ROLE_RATE_LIMIT_PER_MIN=1` in `.env`, restart,
      then react → un-react → react again in quick succession: the first action
      succeeds, the very next one should be refused with `reason: "rate-cap"`
      and trip the breaker. Put the value back afterward (delete the line, or
      set it to `20`) and clear the breaker (below) before continuing.
- [ ] **Manual removal.** Remove a role by hand that the bot just granted. It is
      repaired promptly and **does not bounce**

      **This only fires promptly if the member is in the bot's small member
      cache.** Check `doctor`'s member line — it reports a cached count
      alongside the total, e.g. `members: 4 (1 cached)`. `GUILD_MEMBER_UPDATE`
      needs discord.js's cached "before" member to compute which role vanished;
      for anyone outside that cache the event arrives with no prior role list,
      and `packages/discord/src/events.ts` reports that as `previousRoleIds:
      undefined` on purpose rather than guess and risk repairing a change nobody
      made. The reconciler (`packages/core/src/panels/reconcile.ts`) returns
      early on `undefined`, so nothing happens until the *next* thing that
      reconciles that guild — restarting the daemon (a gateway-gap pass, which
      does not depend on the member cache) rather than a bounce-free live
      repair. The periodic timer pass that would repair this promptly for any
      member regardless of cache state is real, tested, and deliberately
      unscheduled at this slice — it is slice 11's job
      (`docs/reports/WP5-slice-6.md`, "not testable yet"). If your test account
      isn't the cached one, expect this item to sit until a restart; that is the
      documented gap, not a new bug.

> **STOP** if a role flickers on and off repeatedly. That is a feedback loop and
> it burns the rate cap.
>
> One known false alarm: if you used a **super-reaction** (burst), the role will
> appear and then vanish on the next reconciliation. `GET /reactions` does not
> return burst reactors, so reconciliation cannot see them. That is a known gap
> awaiting a port change, not the feedback-loop bug — but it looks identical, so
> check whether you super-reacted before reporting it.

To clear a tripped breaker until the CLI exists:

```bash
sqlite3 data/bananasaurs.db \
  "UPDATE guilds SET breaker_state='closed', breaker_tripped_at=NULL, breaker_reason=NULL;"
```

### Step 7 — Exercise 5: the adoption refusal

```bash
node scripts/seed-test-panel.mjs ... --adopt --replace
```

- [ ] The adoption pass runs and **refuses**, reporting how many changes it
      wanted to make

That refusal is the demonstrable. Approving it so the pass can proceed needs the
CLI's allowance grant, which is slice 13.

### Step 8 — Exercise 6: memory

- [ ] Leave it running an hour with the panel in use. RSS is flat, not climbing

### Step 9 — finish

- [ ] Put `BANANASAURS_DRY_RUN=1` back in `.env` before you walk away
- [ ] Delete the junk roles and the test panel if you are done with them

---

## Not testable yet at slice 6

Three things are built and fully tested against the fake harness, but nothing in
the running daemon triggers them — their trigger is the operator CLI, slice 13.
They are not broken; they are unreachable.

| Not runnable | Why | What it affects |
|---|---|---|
| Putting a panel's emoji on a message | `seedPanelReactions` has no caller — `panel sync` is slice 13 | add the emoji by hand |
| Posting a managed (button/select) panel | `postManagedPanel` has no caller | Exercise 3 item 5, and the managed-panel rows of Exercise 4 |
| Approving an adoption pass | granting the allowance is slice 13 | Exercise 5 step 4 — the refusal still works |

---

## If something fails — what to send Claude

Do not describe it from memory. Collect this first, then paste the prompt below
into a **new** Claude Code session with the gaps filled in.

```bash
cd /home/bryan/projects/bananasaurs
git log --oneline -1
node --version
npm run doctor
tail -n 100 /tmp/bananasaurs.log
sqlite3 data/bananasaurs.db "SELECT state, action, user_id, role_id, error_code, created_at FROM role_effects ORDER BY effect_id DESC LIMIT 20;"
sqlite3 data/bananasaurs.db "SELECT killswitch, dry_run, breaker_state, breaker_reason FROM guilds;"
sqlite3 data/bananasaurs.db "SELECT gap_id, disconnected_at, reconnected_at, resumed, reconciled_at FROM gateway_gaps ORDER BY gap_id DESC LIMIT 5;"
sqlite3 data/bananasaurs.db "SELECT job_id, kind, state, attempts, last_error FROM jobs ORDER BY job_id DESC LIMIT 10;"
```

**Never paste `.env`, a bot token, or any log line containing `token`.** Pino
redacts tokens, but look before you paste. Guild, channel, role and user ids are
fine — they are not secrets.

### The prompt

```
A live test of Bananasaurs against the real test guild failed. Diagnose it.
Do not start new feature work.

WHAT I WAS DOING
  docs/21_TESTING_THE_BOT.md, "Today's run", step << N >> —
  << one sentence: what you did, e.g. "invited the bot to a throwaway
     server to check that it leaves" >>

WHAT I EXPECTED
  << the checklist line that did not tick >>

WHAT ACTUALLY HAPPENED
  << what you saw, in Discord and in the log >>

HOW REPRODUCIBLE
  << every time / once / intermittent — and how many times you tried >>

REPO STATE
  commit: << git log --oneline -1 >>
  node:   << node --version >>
  BANANASAURS_DRY_RUN was << 0 or 1 >>

DOCTOR OUTPUT
  << full output of npm run doctor >>

LOG, LAST 100 LINES
  << tail -n 100 /tmp/bananasaurs.log >>

DATABASE
  << output of the four sqlite3 queries in docs/21, "If something fails" >>

READ FIRST
  1. docs/reports/WP5-slice-6.md, sections 5 and 6 — what is least trusted and
     what is deferred. The failure may already be a known gap; check before
     diagnosing.
  2. docs/SESSION_LOG.md, the last five entries — every place the fake harness
     was found to be lying about real Discord, numbered 4 to 15.
  3. docs/21_TESTING_THE_BOT.md, for what the step was supposed to prove.

RULES
  You cannot connect to Discord and must not attempt to. Never read, print or
  copy .env. Work in a fresh worktree — call EnterWorktree and name it
  `fix-<short-description>`; never work on main and never on
  worktree-wp3-role-panels. Commit, never push.

  Before proposing a fix, reproduce the failure as a failing test against
  FakeDiscord. If it cannot be reproduced there, that is itself the finding: it
  means the fake and real Discord disagree, and the fake is what needs
  correcting first. That has happened seven times on this project already, so
  assume it before assuming the feature is wrong.

  Report what you find before changing anything beyond the failing test.
```

---

## The exercises

Do them in order. Each one is written so that the **failure** is visible, not
just the success — a bot that does nothing passes a badly written test.

**"Today's run" above is the same thing as a checklist.** These sections say why
each step matters; that one says which keys to press. Use both: the checklist to
work through, this to understand what you are looking at.

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
   `node scripts/seed-test-panel.mjs --channel CHANNEL_ID --message MESSAGE_ID --roles ROLE_ID_A,ROLE_ID_B`
   — swap in your own plain numeric ids for those four placeholders, with no
   angle brackets (see Step 4 above for why that matters) — (the script prints
   its own usage). **Then add the emoji it names to the
   message yourself** — nothing in the daemon seeds them, because that is
   `panel sync` in the CLI, slice 13. An adopted panel normally already has its
   reactions, which is what makes it adoptable in the first place.
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
   **Not runnable at slice 6** — nothing in the daemon calls `postManagedPanel`,
   so there is no button to click. The behaviour is built and tested against the
   fake; its trigger is the CLI, slice 13.

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
2. Configure the panel and run adoption:
   `node scripts/seed-test-panel.mjs ... --adopt --replace`. The flag enqueues
   the adoption job, which is a plain database write, so a running daemon picks
   it up within a second.
3. **It must refuse**, saying how many changes it wants to make and that no
   allowance covers them. That refusal is the finished behaviour — the CLI that
   sizes and grants an allowance is slice 13, so approving it and watching the
   pass proceed is not runnable yet.

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
- A role flickered on and off repeatedly — **unless you super-reacted**, which
  has a known and different cause. See step 6 above.
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
