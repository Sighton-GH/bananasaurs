# Building Bananasaurs with Claude Code

How to set this repository up so an agent can build it, what you personally have to do, and the exact prompts to use.

Read `REVIEW.md` first for the reasoning, then `docs/08_ROADMAP.md` for the three-release plan and `docs/decisions/0008`–`0013` for the decisions those releases assume. `docs/17` covers operating the running instance once Release 1 ships.

---

## Part 1 — What only you can do

Claude Code cannot do any of these. Do them before the first coding session; several are blocking.

### 1.1 Discord setup (~30 minutes)

1. Create the application and bot at <https://discord.com/developers/applications>.
2. **Bot → Privileged Gateway Intents:** enable `SERVER MEMBERS INTENT` and `MESSAGE CONTENT INTENT`. Confirm you can toggle them without review — at your size you should be able to. If the portal demands an application, stop and tell Claude Code, because the design changes.
3. Copy the bot token into a password manager. It is the single most dangerous string in this project.
4. Create a **separate test guild** (Discord sidebar → **+** → Create My Own). Never develop against the club server.
5. **Invite the bot** with exactly the Release 1 permission set from `docs/18` — View Channels, Read Message History, Add Reactions, Manage Roles, Send Messages, Embed Links, Use Application Commands, View Audit Log. Nothing else, and never Administrator. Replace the ID and open in a browser:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=2416004288
   ```

   You must have Manage Server on the target guild to complete the invite. Afterwards, drag the bot's role in Server Settings → Roles so it sits **above** every role it needs to hand out and below everything else.
6. Record: application ID, public key, test guild ID, club guild ID, your user ID (Developer Mode → right-click → Copy ID).
7. Register slash commands **guild-scoped** during development. Guild commands update instantly; global commands take up to an hour.

### 1.2 Sketch the Release 1 configuration

Fill in `docs/RELEASE1_CONFIG.md`. Blank slate — you are designing the panels and logging you want, not reconstructing Carl-bot's.

It does not block the first coding session: the schema and panel engine are identical whether you end up with two panels or ten. But sketching it early makes the design concrete, and it has to exist before cutover.

Worth knowing: **members keep the roles they already have.** Roles live on Discord, not in Carl-bot. Switching Carl-bot off strips nothing, so there is no migration to get wrong — new panels only change how roles get chosen from then on.

### 1.3 Repo

Host is profiled and recorded in `docs/15` — i7-6700, 19 GB RAM, 45 GB free, Mint 22.3. Comfortably more capable than the plan originally assumed.

Git is already set up. Get the planning docs committed and pushed to a private repo before any code lands, because that is how you review what an agent wrote and undo a session that went sideways.

Create `.gitignore` before the first coding session:

```
node_modules/
dist/
build/
*.db
*.db-wal
*.db-shm
.env
.env.*
!.env.example
data/
backups/
coverage/
.DS_Store
```

### 1.4 Operator access — mostly done

SSH, git, and Claude Code are already set up on the Mint box, and you are working through VS Code Remote. `docs/17` covers the operator CLI and the ops workspace, which become useful once Release 1 is deployed. Tailscale is optional and only needed to reach the box from outside the LAN.

**One thing to get right up front:** the Mint box is both your development machine and the eventual production host. Keep them separated — different data directories, different config, different socket paths, and a dev guild allowlist containing only the test guild ID. `docs/15` has the specifics. The allowlist is the backstop that stops a dev run from ever touching the club server.

### 1.5 Provider accounts

Nothing is needed until Release 3 — Releases 1 and 2 have no AI at all.

- **Development (confirmed):** an NVIDIA NIM key from build.nvidia.com. Free, and reportedly does not train on prompts. Before relying on it, read NVIDIA's current terms yourself and record the URL — the free tier appears to be limited to development, testing, research, and evaluation, which is why it is restricted to the test guild in ADR 0010.
- **Production:** a paid API key under commercial terms, needed only at Release 3. At this scale the monthly cost is small.
- **Not a provider:** your Claude subscription. It builds Bananasaurs, and it operates the running instance through the CLI over SSH (`docs/17`). It never serves a Discord request. Anthropic's Consumer Terms restrict automated access to API keys, and this was enforced against third-party harnesses in 2026. ADRs 0010 and 0013 have the detail. Your original `CLAUDE.md` flagged exactly this risk — it turned out to be real.

### 1.6 Decisions already made

- **License: Apache-2.0** (ADR 0011). Add `LICENSE` at the root before the first code commit.
- **Stack** (ADR 0008), **archive scope** (ADR 0009), **provider gate** (ADR 0010), **dashboard auth** (ADR 0012).

Still yours to decide: monthly AI spend ceiling (a number, not "cheap"), and backup destination.

### 1.7 Ongoing, every session

Only you can: run the bot against a real Discord server, look at whether a reply is actually good, notice that a moderation action felt wrong, and decide whether to ship. Budget review time roughly equal to the time you spend prompting. An agent that writes faster than you review produces a codebase you do not understand, which is worse than no codebase.

---

## Part 2 — Repository setup for the agent

### 2.1 CLAUDE.md — already swapped

The original 12-line `CLAUDE.md` is preserved at `docs/archive/CLAUDE.original.md`. The current one carries the stack decision, the build commands, and nine hard rules, which is what keeps an agent on track across sessions. Its warning about subscription-backed access was correct and is now resolved in ADRs 0010 and 0013.

### 2.2 `.claude/settings.json`

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(npm install *)",
      "Bash(npx drizzle-kit *)",
      "Bash(git status)",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git add *)",
      "Bash(git commit *)"
    ],
    "deny": [
      "Bash(git push*)",
      "Bash(rm -rf *)",
      "Read(./.env)",
      "Read(./data/**)",
      "Read(./backups/**)"
    ]
  }
}
```

The denies matter. `git push` stays manual so nothing reaches GitHub without your eyes on it. `.env` stays unreadable so a token cannot end up in a transcript, a commit, or a log line.

### 2.3 A test hook

`.claude/settings.json` can run tests after every edit, which catches breakage inside the session rather than at review time:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{ "type": "command", "command": "npm run typecheck --silent 2>&1 | tail -20" }]
    }]
  }
}
```

Add this only after the project compiles; before that it produces noise.

### 2.4 The test harness is the thing that makes this work

Claude Code cannot connect to Discord, cannot see your server, and cannot tell whether a role panel behaves correctly. If the only way to know something works is for you to try it manually, you become the test suite and progress stops.

So the **first feature-adjacent thing built must be a fake Discord layer**: an in-memory implementation of the gateway event stream, button interactions, and the REST calls the project uses, capable of emitting duplicate events, connection drops, rate-limit responses, permission errors, and hierarchy failures on demand.

Everything else is then testable without a network, and Claude Code can verify its own work. Make this explicit in the kickoff prompt — it is in the prompt below.

Alongside it, keep `docs/SMOKE_TESTS.md`: a numbered manual checklist you run in the test guild before each release. Twenty lines, updated as features land.

---

## Part 3 — Session workflow

**One release phase per session. `/clear` between them.** A long session degrades: the agent loses the thread, starts contradicting earlier decisions, and burns context re-reading files. Short sessions with a clean start and a written plan are much better.

**Use plan mode for anything non-trivial** (Shift+Tab twice in Claude Code). Ask for the plan, read it, argue with it, then let it build. The plan is where you catch a wrong approach for the cost of thirty seconds instead of an afternoon.

**Commit at every green checkpoint,** with a message you wrote or approved. Small commits are how you bisect an agent-introduced bug.

**Run `/security-review` before every release cutover**, and specifically before the first time the bot touches the real club server.

**When something goes wrong, prefer reverting to arguing.** `git checkout .` and a better prompt beats five rounds of "no, not like that." Agents anchor on their earlier attempt.

**Review these four things in every diff, because they are where generated code goes wrong:**

1. Did every new query take a guild ID? (Rule 2)
2. Did every new Discord side effect get an idempotency key and a unique constraint? (Rule 6)
3. Did any model output reach an execution path without passing a Zod validator? (Rule 3)
4. Are the new tests actually asserting behaviour, or asserting that a mock was called?

Point 4 is the most common failure mode of agent-written tests, and it produces a suite that passes while the feature is broken.

---

## Part 4 — The kickoff prompt

The current version lives in **`docs/KICKOFF_PROMPT.md`** — it adds a setup-verification phase and self-validation requirements, and it is the one to use. What follows is the earlier, shorter version, kept for reference.

Start Claude Code in the repository root and paste this verbatim.

---

> Read `README.md`, `IMPLEMENTATION_BRIEF.md`, `CLAUDE.md`, `REVIEW.md`, everything in `docs/`, and every ADR in `docs/decisions/`. Where `REVIEW.md` contradicts an older document, `REVIEW.md` is correct.
>
> We are building Release 1 only, as defined in `docs/08_ROADMAP.md`: Bananasaurs replaces Carl-bot's **logging** and **reaction roles**. No AI, no archive, no automod, no memory, no provider integration. One dashboard page.
>
> The stack is decided in `docs/decisions/0008-stack-selection.md`. Do not reconsider it.
>
> Before writing any application code, produce a plan covering:
>
> 1. Repository layout — a single npm workspace, packages or directories, and where the boundary lives between the Discord adapter, the application core, the module runtime, and storage. Justify each boundary in one sentence; delete any boundary you cannot justify.
> 2. The database schema for Release 1 only: guild config, dashboard accounts and sessions, principals and capability grants, log routing config, role panels and their components, managed role assignments, the job table, and the audit event table. Show me the guild-scope constraints and the idempotency constraints explicitly.
> 3. The fake Discord test harness: which gateway events and REST calls it simulates, and how a test triggers a duplicate event, a reconnect gap, a 429, a missing-permission error, and a role-hierarchy failure. This is built before the features it tests.
> 4. The event pipeline and its deduplication mechanism.
> 5. The permission model: how a capability grant is checked, where the check happens, and why it cannot be bypassed by adding a new caller.
> 6. The order of work as a numbered checklist of slices, each of which ends with the project compiling, tests passing, and something demonstrable.
>
> Constraints to honour in the plan:
>
> - The discord.js client must be configured with restricted caches per ADR 0008. Show me that configuration in the plan.
> - SQLite runs in WAL mode with a single writer. Say how you enforce that.
> - Role hierarchy is checked immediately before every role mutation, and a periodic self-check verifies each managed role is still assignable.
> - Reconciliation after downtime: missed reaction events, deleted panel messages, renamed and deleted roles.
> - Every role mutation writes an audit event with before and after state.
> - **Role panels in two kinds.** *Adopted* panels attach an emoji-to-role mapping to any existing message by ID, including messages I posted — this is the Carl-bot behaviour and it is the primary thing I want. The bot seeds the mapped reactions and watches reaction add/remove on that message; it cannot edit the message or attach buttons to it, since a bot may only do that to its own messages. *Managed* panels are posted by the bot, so buttons, select menus, editable text, and ephemeral confirmations are available. Both support toggle, add-only, remove-only, and single-choice, with per-panel limits and required/blocked role checks.
> - **On adopting a panel**, fetch everyone who already reacted with each mapped emoji and grant the roles — the existing reaction state is the intended role state.
> - **Enable discord.js `partials` for Message, Channel, Reaction, and User**, or reactions on uncached older messages are dropped silently, and have `doctor` verify it. Reactions added while the bot is offline generate no event on reconnect, so adopted panels also need periodic reconciliation against live reaction state, bounded by the reconciliation budget.
> - **Every safety control in `docs/18`**, in Release 1 rather than deferred: minimum Discord permissions, a role allowlist so only panel-registered roles are ever mutated, a global rate cap with a circuit breaker that halts and alerts instead of retrying, a reconciliation budget that refuses oversized change sets, `BANANASAURS_DRY_RUN=1` turning all side effects into log lines, batch-ID undo, a kill switch, and a `doctor` that disables a failing panel rather than the whole bot. Show me in the plan where each one is enforced — I want them in the architecture, not sprinkled as guard clauses.
> - The **operator CLI** (`bananasaurs`), per ADR 0013 and `docs/17`: it talks to the running daemon over a Unix domain socket, never to the database file, because SQLite is single-writer. Guild-scoped, `--json` output, `--confirm` required on writes, an audit row for every write, secrets never printed, and `BANANASAURS_READONLY` honoured. Release 1 commands: status, doctor, config get/set, panel list/show/sync, log routing, audit tail, jobs, killswitch.
> - The **logging module**: message edits and deletions, member joins and leaves, role and channel changes, routed to owner-configured log channels. Deletion actor is inferred from the audit log and must be labelled inferred, since `MESSAGE_DELETE` does not carry it. This is server-wide by configuration and is *not* the archive.
> - The dashboard is one page. Health, log routing, panel config, audit table, kill switch. **Authentication is owner-provisioned local accounts per ADR 0012 — not Discord OAuth.** Other members of my server hold Discord Administrator and must not be able to reach this. Show me the bootstrap flow for creating the first account.
> - `/privacy` renders `PRIVACY.md` with live settings substituted.
> - Backup and a restore procedure I can actually run.
>
> Hard constraint from ADR 0013, which I want you to state back to me in the plan: **no application code ever spawns the `claude` binary or touches Claude subscription credentials.** Not from a Discord handler, not from a job, not through a queue. The operator CLI is run by me over SSH and its output comes back to my terminal. Discord-facing AI goes through the provider layer only, and there is none in Release 1.
>
> Do not write code yet. Give me the plan, and flag anything in the planning documents you think is wrong or underspecified. I would rather argue about the plan than about the code.

---

## Part 5 — Prompt template for later phases

```
Read CLAUDE.md and REVIEW.md §E.

We are on Release <N>, slice <M>: <one-line description>.

Prior slices are committed and green. Do not modify <list of stable areas>
unless the change is required by this slice, and tell me first if it is.

Requirements:
- <specific, testable requirement>
- <specific, testable requirement>

Tests I expect to exist when this is done:
- <behaviour>, including the failure case where <X>
- <behaviour> is idempotent when the event is delivered twice

Plan first. Then implement. Then run typecheck, lint, and tests, and show me
the diff summary. Do not commit; I will review and commit.
```

Two habits inside that template do most of the work: naming the tests you expect (agents write the tests you ask for and skip the ones you don't), and forbidding the commit (so you actually read the diff).

---

## Part 6 — Realistic expectations

With the release plan in `REVIEW.md` §E, an agent writing most of the code, and you reviewing:

- **Release 1** is the hard one, because it builds the spine — event pipeline, permissions, storage, audit, jobs, test harness — while only shipping reaction roles. Expect it to feel disproportionate. It is; everything after is faster because of it.
- **Release 2** is the largest in surface area but reuses the spine entirely, plus a mandatory multi-week observe-only period that is wall-clock time, not work time.
- **Release 3** is where the project becomes the thing you actually wanted.

Two failure modes to watch for specifically:

**Building ahead.** An agent that reads `docs/06` and `docs/13` will happily start scaffolding the module runtime, the provider router, and eight dashboard pages during Release 1. Every one of those is a guess about requirements you have not discovered yet, and it will be wrong and hard to delete. The CLAUDE.md rule "work only on the current release" exists for this.

**A green suite that tests nothing.** Agent-written tests drift toward asserting that a mock was called with the right arguments. Those pass forever regardless of whether the feature works. When you review tests, ask: if I broke the implementation, would this fail? If you cannot answer yes, the test is decoration.
