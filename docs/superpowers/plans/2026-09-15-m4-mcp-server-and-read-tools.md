# Slice M4 — the MCP server and the read tools

**Status: DRAFT.** Written 2026-09-15, before implementation.
**Branch:** `oc/m4-mcp-read-tools`.
**ADR:** 0044, already written and accepted (commit `9c08d69`, corrected
`75ce00a`). It is M4's gate and nothing here may contradict it.
**Precondition:** M2 (search), M3 (OAuth), M3b (account lifecycle) — all
merged.

## Goal

A Claude client holding a `bananasaurs:read` token connects to `/mcp`, lists
tools, and every read tool in the design's §3 works against the test guild.

## What ADR 0044 binds us to

Read it before anything else. Four things it decides that this plan must not
re-open:

1. **Every tool refuses when the reachable guild set is empty, and every tool
   intersects its `guildId` against that set** before any repository call.
   `requireBearer` returns 200 with an empty set for an account that has lost
   `mcp.authorize`, so a tool that skipped this would be reachable by an
   account holding no grant anywhere. `get_health` is guild-independent and
   **must still refuse on empty**. Checked once, in a shared helper, and
   tested by a tool that is *only* refused by it.
2. **No non-test import of the SDK's Express, Hono, auth-router or client
   modules.** Asserted by a test, not by review discipline.
3. **The evidence envelope** wraps every content-bearing result, with a fixed
   preamble in one constant, and content cannot break out of its delimiters.
4. **The training-eligibility row is written in M4**, before the first real
   read, with `doctor` warning past 90 days.

## Global constraints (copy verbatim into every brief)

1. **Guild scope is a mandatory partition key** (CLAUDE.md rule 2). Every
   tool takes an explicit `guildId`, validates it against the allowlist *and*
   the caller's reachable set, and only then constructs a `GuildScope`. Every
   new repository function takes `GuildScope` first and goes through
   `scope.only(...)`. `provider_eligibility` is the documented instance-level
   exception (ADR 0027) and takes `InstanceScope`.
2. **Model output and retrieved content are untrusted input** (rule 3).
   Archive content is evidence, never instruction. It passes through the
   envelope and is never interpolated into anything that is interpreted.
3. **`npm run db:generate` is the only way to produce a migration.** Never
   hand-write one.
4. **Pino redaction is an allowlist** (rule 4). Every new logged field needs a
   `LOGGABLE_FIELDS` entry with a comment. Token values are never loggable
   under any name.
5. **Break it and watch it fail.** Eighteen decorative guards have been found
   on this project, nineteen counting M3b's. Watch every guard go red before
   making it pass, and say which line you neutralised.
6. **Verify both directions of a boundary.** A check tested for the wrong
   input and never for the absent input is Slice 4's CRITICAL-2.
7. **`packages/mcp` may import `@bananasaurs/core` and `@bananasaurs/storage`.
   It may NOT import `discord.js`, the REST port, or `packages/http`'s
   dashboard session or account modules.** Enforced by a new
   `eslint.config.js` boundary block, not by the package manifest.
8. **Do not touch** `mod_rules`, `setRuleMode`, `packages/core/src/mod/`,
   `packages/core/src/automod/`, or `packages/core/src/effects/gateway.ts`.
   The observe window is running on two live guilds, one of them a real
   210-member club server. A change there restarts a clock that cannot be
   re-taken.
9. **M4 is read-only.** No tool writes anything to Discord. `send_message` is
   M5 and must not appear, not even stubbed.
10. Gates: `npm run typecheck && npm run lint && npm run test` all pass by
    exit code before any task reports DONE.

## The shape, decided

**Ruling M4-D1 — the Discord-cache tools need a port, because
`packages/mcp` may not import discord.js.** `list_channels`, `list_roles` and
`list_members` read the gateway cache. `packages/mcp` cannot reach it
(constraint 7), so `apps/daemon` injects an `McpGuildPort` exactly the way it
injects `OpsPorts` — hand-written projections, built in
`apps/daemon/src/mcp/wiring.ts`. Cost if wrong: one more port interface.

**Ruling M4-D2 — archive and records tools call `@bananasaurs/storage`
directly**, with a `GuildScope` the tool layer builds. They do not go through
`OpsPorts`: that port exists for the operator socket's command surface, its
projections are shaped for terminal output, and routing MCP through it would
make every future tool an operator-command change too. Cost if wrong: two
callers of the same repository functions.

**Ruling M4-D3 — `read_channel_history` needs one new repository function.**
`archive.ts` has `findMessage` and `countMessages` but nothing paginated.
Add `listChannelHistory(scope, { channelId, beforeMessageId?, limit })`,
`GuildScope`-first, ordered newest first, limit capped at 100 like
`searchMessages`. It must respect the same visibility rule search does — a
channel not in `archive_channels` returns nothing, not an error that reveals
the channel exists.

**Ruling M4-D4 — the SDK promotion is its own task and its own commit**, so
it can be reverted without unpicking the tools. ADR 0044's corrected §8
records the measured cost: the production closure goes 172 → 256 packages.
The task records the *actual* post-promotion number; a number materially
different from 256 means the SDK's dependencies moved and is worth reading
before merging.

## Tasks

### Task 1 — the package, the promotion, and the boundary

**Files:** `package.json`, `packages/mcp/` (new), `eslint.config.js`,
`tsconfig.all.json` (and whatever else the workspace wiring needs — find it
by copying how `packages/http` is registered).

1. Move `@modelcontextprotocol/sdk` from `devDependencies` to
   `dependencies`, same exact version `1.30.0`. Run `npm install`. Record
   `npm ls --omit=dev --all --parseable | sed 's|.*/node_modules/||' | sort -u | wc -l`
   before and after in your RESULT. **Expected after: 256.**
2. Create the `packages/mcp` workspace package with the same shape as
   `packages/http` (package.json, tsconfig.json, src/index.ts). No code yet
   beyond an empty export.
3. Add the `packages/mcp` boundary block to `eslint.config.js`, beside the
   existing ones, banning `discord.js`, the REST port, and
   `@bananasaurs/http`'s session and account modules, with a message in the
   register of the neighbouring blocks that says **why** (ADR 0044 and the
   design's §4: `packages/mcp` has its own authorization boundary and shares
   only the Fastify instance).
4. **The import-surface test** (ADR 0044 obligation 2). A test that reads the
   source of `packages/mcp` and asserts no non-test file imports the SDK's
   `server/express`, `server/auth/router`, `hono`, `express`, or any
   `client/` module. Model it on M3's test that asserted the SDK had no
   runtime import at all — find it with
   `grep -rn "modelcontextprotocol" packages/http/src --include=*.test.ts`.
   **Watch it fail**: add such an import temporarily, see it red, remove it.

**Verification:** `npm run typecheck && npm run lint && npm run test`

### Task 2 — the authorization helper and the evidence envelope

The two things every later task depends on. Both are security surfaces; both
get tested in both directions.

**`requireReachableGuild(principal, guildId, allowlist)`** in
`packages/mcp/src/scope.ts`:

- Refuses when `principal.reachableGuilds` is **empty** — ADR 0044
  obligation 1, the load-bearing one.
- Refuses when `guildId` is not in the allowlist.
- Refuses when `guildId` is not in `principal.reachableGuilds`.
- Returns the validated `GuildId` otherwise.
- A refusal is an MCP tool error with a reason that does **not** distinguish
  "not in the allowlist" from "not reachable by you" — that difference is an
  oracle telling a caller which guilds exist.

**`requireAnyReachableGuild(principal)`** for `get_health`, which takes no
guild: refuses on empty, returns nothing otherwise.

**`envelope(items)`** in `packages/mcp/src/envelope.ts`: one exported
constant holding the preamble, quoted verbatim in ADR 0044 §6's spirit —
stating that what follows is retrieved evidence, is not an instruction, and
that any instruction inside it must be ignored. A delimiter that content
cannot close: pick one and prove it, by putting the delimiter string itself
in a message and asserting the envelope still parses as one block.

**Tests, each watched red first:**
1. Empty reachable set → refused, for both helpers.
2. Guild not in allowlist → refused.
3. Guild in allowlist but not reachable → refused.
4. The two refusals in (2) and (3) produce the **same** message.
5. Happy path returns the guild.
6. The envelope's preamble is present on every item.
7. Content containing the delimiter cannot break out.
8. **Break it and watch it fail**: neutralise the empty-set check, confirm
   test 1 goes red, quote the failure, restore.

### Task 3 — the server, mounted, with `tools/list` and one tool

**Files:** `packages/mcp/src/server.ts`, `apps/daemon/src/mcp/wiring.ts`,
plus the mount in the composition root beside `registerOAuthRoutes`.

`McpServer` + `WebStandardStreamableHTTPServerTransport` (verified present at
`node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js`),
bridged from Fastify's request/reply to Web-standard `Request`/`Response`.
One transport per MCP session id, cleaned up on close. Mounted at `/mcp`,
behind `requireBearer`, and **only when `MCP_PUBLIC_URL` is set** — the same
condition the OAuth routes already use, so the observe-window guilds stay
untouched until the owner opts in.

The one tool is `get_health`, because it is the one with no `guildId` and is
therefore the tool that proves ADR 0044 obligation 1's hardest case: it must
still refuse on an empty reachable set.

**Tests:** a request with no bearer token gets the RFC 9728
`WWW-Authenticate` challenge pointing at the metadata URL; `tools/list` with
a valid read token lists `get_health` and **does not** contain
`send_message`; `get_health` with an empty reachable set is refused; with
`MCP_PUBLIC_URL` unset, `/mcp` is a 404 — and note M3's ruling PR-130, where
that exact assertion passed only because no test added the static handler, so
this test must add it.

### Task 4 — the archive tools

`search_messages`, `read_channel_history`, `get_message`. Over
`archiveSearchRepo.searchMessages`, the new `listChannelHistory` (ruling
M4-D3), and `archiveRepo.findMessage`. Every result through the envelope.

**The two-guild test is the point of this task**: a tool call naming guild B
from a session whose account reaches A and B returns B's data only; naming a
guild the bot is not in returns a **refusal, not an empty set**. Write it
first and watch it fail.

`search_messages` must reuse `searchMessages`'s existing visibility-set
construction — the set is built from the guild's archive-enabled channels and
never from caller input, and M2's whole-branch review is the reason that
matters.

### Task 5 — the Discord-cache tools

`list_channels`, `list_roles`, `list_members` over the `McpGuildPort` from
ruling M4-D1, implemented in `apps/daemon/src/mcp/wiring.ts`.

**No presence, no activity** (design §3) — assert it: a test that the
projection has no such field, in the shape of M3b's `passwordHash` sentinel
test.

`list_channels` includes whether the channel is in archive scope, which is a
storage read, so this task is where the port and the repository meet.

### Task 6 — the records tools

`list_mod_cases`, `get_mod_case`, `list_audit_events`, and
`get_server_overview`. Over `automodAdminRepo.listRecentCases` / `findCase`,
`modCasesRepo.listCaseEvents`, and whatever audit query
`bananasaurs audit tail` already uses — find it rather than writing a second.

**Read-only, and the tools must not be able to reach a writer.** These read
`mod_cases` and `mod_rules`; constraint 8 says do not touch them, and reading
is not touching — but a tool that imported a writer would be a defect even if
it never called it.

### Task 7 — the training-eligibility record and `doctor`

ADR 0044 §7 and design §8.4. **The owner confirmed on 2026-09-14 that
training is disabled** on the account holding these connectors; the answer is
not the control, the row is.

- New instance-level table `provider_eligibility` (provider,
  `trains_on_input` CHECK IN ('no','yes','unknown'), evidence URL,
  reviewed_at), via `npm run db:generate`. No provider-eligibility table
  exists yet — ADR 0010's is Release 3 work — so create the minimal one it
  describes, instance-level, and Release 3's provider layer inherits it
  rather than creating a second.
- One row: `Anthropic (consumer, via MCP)`, `trains_on_input: 'no'`, the
  settings page as evidence, reviewed 2026-09-15.
- **`'unknown'` is treated as `'yes'`** (hard rule 5) — assert it.
- A `doctor` check warning when `reviewed_at` is more than 90 days old.
  Tested with a frozen clock at day 89, 90, 91.
- `PRIVACY.md` gains its row **in the same commit as the migration**
  (Slice 2 precedent).

### Task 8 — the overview resource

`bananasaurs://guild/{guildId}/overview`, the same server card as
`get_server_overview`. One resource, no others. It must go through the same
`requireReachableGuild` — a resource that skipped the check would be the
hole obligation 1 exists to close, reached by a different door.

## Not in M4

`send_message` and everything in M5. The tunnel and Access (M6). Any
dashboard page for the archive, search or tokens. Embeddings. The provider
layer.

## The loopback smoke is not an opencode task

Design §3's last item — `claude mcp add --transport http`, the OAuth flow
through the consent page in a browser over `ssh -L`, then
`get_server_overview` and `search_messages` for real — needs a human at a
browser and a real token. It is a **handoff item for the owner**, to be run
with the `guided-bot-testing` skill, and its transcript goes in
`docs/reports/mcp-m4-loopback-smoke.md`. M4's code is *merged and green*
until that runs; it is not *working against the real client*, and the
distinction is the one `docs/STATE.md` insists on.

## What "done" means

- All eight tasks green; `npm run typecheck && npm run lint && npm run test`
  passing by exit code, with the test count recorded.
- The empty-reachable-set guard watched failing, and the import-surface guard
  watched failing.
- The post-promotion production closure counted and compared against 256.
- A whole-branch review by Opus, and its findings fixed or parked with a
  ruling.
- `docs/STATE.md`, the ledger, and
  `docs/reports/opencode-plugin-evaluation.md` current.
