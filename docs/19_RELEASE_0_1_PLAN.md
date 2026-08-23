# Release 0 + 1 implementation plan

> ## ⚠ STATUS: DRAFT — awaiting owner review
>
> Nothing in this document is agreed. It is the Phase 2 output of the kickoff
> prompt in `docs/KICKOFF_PROMPT.md`, written to be argued with. No application
> code exists and none will be written until this is marked accepted.

**Status:** DRAFT
**Written:** 2026-08-22
**Scope:** Release 0 and Release 1 only, per `docs/08_ROADMAP.md`. No AI, no archive, no automod, no memory, no provider integration. One dashboard page.
**Stack:** fixed by ADR 0008, not reconsidered here.
**Supersedes:** nothing. **Depends on:** ADRs 0001–0013, `REVIEW.md`, `docs/01`–`docs/18`.

---

## Contents

- [Decisions I need from you](#decisions-i-need-from-you)
- [The ADR 0013 rule, in my own words](#the-adr-0013-rule-in-my-own-words)
- [1. Repository layout](#1-repository-layout)
- [2. Database schema — Release 1 only](#2-database-schema--release-1-only)
- [3. The fake Discord harness](#3-the-fake-discord-harness)
- [4. Event pipeline and deduplication](#4-event-pipeline-and-deduplication)
- [5. Permission model](#5-permission-model)
- [6. The named constraints, each addressed](#6-the-named-constraints-each-addressed)
- [7. Ordered work plan](#7-ordered-work-plan)
- [8. Forks worth naming](#8-forks-worth-naming)
- [9. What I think is wrong in the planning documents](#9-what-i-think-is-wrong-in-the-planning-documents)
- [10. What I expect to be harder than it looks](#10-what-i-expect-to-be-harder-than-it-looks)

---

## Decisions I need from you

Four blocking, in the order they bite. Everything else in this plan I can decide and document myself.

| # | Decision | Why it is yours | My recommendation |
|---|---|---|---|
| 1 | **`single_choice` on adopted panels** | Removing another member's reaction needs Manage Messages, which `docs/18` Layer 1 deliberately withholds. Without it, single-choice adopted panels enter a grant/revoke flap loop. Granting the permission weakens the one wall Discord enforces rather than our code. | Restrict `single_choice` to managed (button) panels; refuse the combination in the dashboard and CLI. See [§6.3](#63-role-panels--two-kinds). |
| 2 | **Adoption allowance vs. the rate cap** | Adopting a panel with more than 20 existing reactors trips the circuit breaker mid-pass and halts the module with roles half-applied. Fixing it changes `docs/18` Layer 3, not just an implementation detail. | Per-source rate budgets; adoption spends an owner-previewed, owner-confirmed allowance sized to the exact change list. See [§6.4](#64-adoption-pass). |
| 3 | **Do deleted-message logs include the original content?** | It is a privacy default, it belongs in `PRIVACY.md`, and it decides whether we need the `MESSAGE_CONTENT` privileged intent at all. | Metadata-only. It is the reversible direction: content can be switched on later, but content already posted to a Discord log channel cannot be unlogged. |
| 4 | **Backup destination** | `docs/12` still-needed item 2. An off-host target sends server content somewhere new, which `CLAUDE.md` says is your call. | Local path only in Release 1, with an encrypted off-host target documented but not implemented. See [§6.12](#612-backup-and-restore). |

---

## The ADR 0013 rule, in my own words

No code that runs as part of Bananasaurs ever executes the `claude` binary or reads Claude subscription credentials. Not a slash-command handler, not a gateway event handler, not a scheduled job, not a queue consumer, not an HTTP route, not a shell-out buried three layers down. It does not matter that a human approves each step, and it does not matter how many hops sit between the Discord message and the process spawn — if a club member's action can cause `claude` to run, the design is wrong and I stop and say so.

The permitted shape is the exact inverse: **the owner types something into a terminal, and the answer comes back to that terminal.** He SSHes to the box, runs Claude Code in the ops workspace, and asks it to read `bananasaurs status`, tail the audit log, or draft a config change. His keystroke starts it, his eyes receive it, and he applies any change himself as himself. The subscription builds and operates the bot; it never serves it. Discord-facing AI, when it exists at Release 3, goes through the provider layer and nothing else.

The reason is credentials and beneficiaries, not automation. `claude -p` in a cron job the owner wrote for himself is fine. A `/ask` that shells out to the CLI is prohibited permanently — and it is prohibited precisely *because* it would be useful, which is what makes it the shortcut an agent reaches for.

---

## 1. Repository layout

Single npm workspace, one process, one SQLite file.

```
bananasaurs/
  package.json                 # workspaces: ["packages/*", "apps/*"]
  apps/
    daemon/                    # composition root + Unix socket server
  packages/
    core/                      # domain logic + port interfaces. No I/O deps.
    storage/                   # Drizzle schema, migrations, guild-scoped repos, the writer
    discord/                   # discord.js adapter: client construction, event translation
    http/                      # Fastify: auth, dashboard API, static serving
    dashboard/                 # React + Vite -> static assets
    cli/                       # `bananasaurs` operator CLI (socket client only)
    testkit/                   # fake Discord harness + fixtures
  docs/  drizzle/  scripts/
```

### Boundary justifications — one sentence each

| Boundary | Why it exists |
|---|---|
| `core` <-> `discord` | The fake harness needs a seam, and this is the seam: `core` depends on port *interfaces*, so every test runs with no network and no discord.js. |
| `core` <-> `storage` | Not swappability — we will never leave SQLite. It exists so `core` cannot reach the raw database handle or open a transaction, which is what makes single-writer discipline and guild scoping structural rather than remembered. |
| `core` <-> `http` | Untrusted HTTP input must cross a Zod validator to become a domain type, and the dashboard API must be unable to reach Discord except through the same effect gateway everything else uses. |
| `dashboard` separate | Different toolchain (Vite), different output (static files), and it must not be able to import server code. |
| `cli` separate | ADR 0013 requires the CLI to reach the daemon only over the socket; a separate package with no dependency on `storage` makes "the CLI cannot open the database" a build error rather than a code-review note. |
| `apps/daemon` | Somewhere has to know every concrete implementation; isolating it keeps dependency cycles impossible everywhere else. |
| `testkit` separate | It is a `devDependency` of the others, so shipping a fake into production is a packaging error, not a subtle bug. |

### The boundary I am deleting

**The module runtime.** `docs/02` lists it as a core responsibility and `docs/06` gives it a whole dashboard area — enablement, dependencies, configuration versions, health, migrations. Release 1 has exactly two modules, panels and logging. A registry holding two entries, with a dependency graph that can only ever be empty, is a speculative abstraction, and `CLAUDE.md` tells me to avoid exactly that.

Panels and logging will be two plain objects that subscribe to the event pipeline. If a third module arrives in Release 2 and the shape repeats, the runtime can be extracted from three working examples instead of guessed at from zero.

Boundaries are enforced mechanically, not by convention: `core/package.json` lists neither `discord.js` nor `better-sqlite3`, so importing them fails typecheck, and `dependency-cruiser` runs in `npm run lint` with the layering rules encoded.

---

## 2. Database schema — Release 1 only

Conventions: every table is `STRICT`; every Discord snowflake is `TEXT` because snowflakes exceed 2^53 and a JS number would silently corrupt them; every timestamp is `INTEGER` epoch-millis.

### Guild scope — enforced by composite foreign keys

The rule is "a query that *can* omit guild scope is a bug." Passing `guild_id` everywhere is discipline, and discipline decays. The structural backstop is that **every foreign key includes `guild_id`**, so a child row physically cannot reference a parent in another guild.

```sql
CREATE TABLE guilds (
  guild_id          TEXT    NOT NULL PRIMARY KEY,
  name              TEXT    NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 0,
  killswitch        INTEGER NOT NULL DEFAULT 0,
  dry_run           INTEGER NOT NULL DEFAULT 1,
  role_rate_per_min INTEGER NOT NULL DEFAULT 20,
  reconcile_budget  INTEGER NOT NULL DEFAULT 25,
  breaker_threshold INTEGER NOT NULL DEFAULT 5,
  breaker_state     TEXT    NOT NULL DEFAULT 'closed'
                            CHECK (breaker_state IN ('closed','open')),
  breaker_tripped_at INTEGER,
  breaker_reason    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;

-- The role allowlist (docs/18 Layer 2) is a TABLE, not a code check.
CREATE TABLE managed_roles (
  guild_id            TEXT    NOT NULL,
  role_id             TEXT    NOT NULL,
  assignable          INTEGER NOT NULL DEFAULT 1,   -- doctor self-check writes this
  unassignable_reason TEXT,                         -- 'above_bot'|'managed'|'deleted'|NULL
  last_checked_at     INTEGER,
  PRIMARY KEY (guild_id, role_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE panels (
  guild_id      TEXT    NOT NULL,
  panel_id      TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('adopted','managed')),
  channel_id    TEXT    NOT NULL,
  message_id    TEXT,                            -- NULL until a managed panel is posted
  behaviour     TEXT    NOT NULL
                        CHECK (behaviour IN ('toggle','add_only','remove_only','single_choice')),
  component     TEXT    NOT NULL
                        CHECK (component IN ('reaction','button','select')),
  max_roles     INTEGER,                         -- per-panel limit; NULL = unlimited
  required_role_id TEXT,
  status        TEXT    NOT NULL DEFAULT 'enabled'
                        CHECK (status IN ('enabled','disabled_by_doctor','disabled_by_owner')),
  disabled_reason TEXT,
  adopted_at    INTEGER,
  adoption_pass_state TEXT NOT NULL DEFAULT 'pending'
                        CHECK (adoption_pass_state IN ('pending','running','done','refused')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (guild_id, panel_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  -- an adopted panel is reaction-driven and can never carry components
  CHECK (kind <> 'adopted' OR component = 'reaction'),
  -- a message can host at most one panel
  UNIQUE (guild_id, channel_id, message_id)
) STRICT;

CREATE TABLE panel_options (
  guild_id   TEXT    NOT NULL,
  panel_id   TEXT    NOT NULL,
  option_id  TEXT    NOT NULL,
  role_id    TEXT    NOT NULL,
  emoji_key  TEXT,        -- canonical: 'u:1f9e0' or 'c:123456789012345678'
  label      TEXT,        -- button/select label
  position   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, panel_id, option_id),
  -- composite FK: an option can never attach to a panel in a different guild
  FOREIGN KEY (guild_id, panel_id) REFERENCES panels(guild_id, panel_id) ON DELETE CASCADE,
  -- composite FK: an option can never offer a role outside the allowlist
  FOREIGN KEY (guild_id, role_id) REFERENCES managed_roles(guild_id, role_id) ON DELETE RESTRICT,
  UNIQUE (guild_id, panel_id, role_id),
  UNIQUE (guild_id, panel_id, emoji_key)
) STRICT;

CREATE TABLE panel_blocked_roles (
  guild_id TEXT NOT NULL, panel_id TEXT NOT NULL, role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, panel_id, role_id),
  FOREIGN KEY (guild_id, panel_id) REFERENCES panels(guild_id, panel_id) ON DELETE CASCADE
) STRICT;
```

That `panel_options -> managed_roles` foreign key **is** the role allowlist. It is not a guard clause anyone can forget; inserting an option for an unregistered role raises `SQLITE_CONSTRAINT_FOREIGNKEY`.

### Idempotency — a unique constraint that makes double execution impossible

```sql
CREATE TABLE effect_batches (
  guild_id   TEXT NOT NULL,
  batch_id   TEXT NOT NULL,
  source     TEXT NOT NULL
             CHECK (source IN ('interaction','reaction','adoption','reconcile','cli','dashboard')),
  actor_type TEXT NOT NULL,
  actor_id   TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  undone_at  INTEGER,
  PRIMARY KEY (guild_id, batch_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE role_effects (
  guild_id     TEXT    NOT NULL,
  effect_id    TEXT    NOT NULL,
  batch_id     TEXT    NOT NULL,
  dedupe_key   TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  role_id      TEXT    NOT NULL,
  action       TEXT    NOT NULL CHECK (action IN ('grant','revoke')),
  state        TEXT    NOT NULL DEFAULT 'planned'
                       CHECK (state IN ('planned','applied','skipped','failed','dry_run')),
  had_role_before INTEGER NOT NULL,        -- the before-state that makes undo possible
  panel_id     TEXT,
  attempted_at INTEGER,
  completed_at INTEGER,
  error_code   TEXT,
  PRIMARY KEY (guild_id, effect_id),
  FOREIGN KEY (guild_id, batch_id) REFERENCES effect_batches(guild_id, batch_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, role_id)  REFERENCES managed_roles(guild_id, role_id) ON DELETE RESTRICT
) STRICT;

-- THE idempotency constraint. Insert-or-ignore before the REST call;
-- a zero-row insert means the effect already happened, so we skip it.
CREATE UNIQUE INDEX role_effects_dedupe
  ON role_effects (guild_id, dedupe_key);

-- Durable record of managed state. Also makes a double grant a no-op.
CREATE TABLE managed_role_assignments (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  role_id    TEXT    NOT NULL,
  panel_id   TEXT    NOT NULL,
  granted_at INTEGER NOT NULL,
  granted_by_effect TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, panel_id) REFERENCES panels(guild_id, panel_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, role_id)  REFERENCES managed_roles(guild_id, role_id) ON DELETE RESTRICT
) STRICT;
```

### Gateway dedupe, jobs, audit

```sql
CREATE TABLE event_dedupe (
  guild_id      TEXT    NOT NULL,
  event_kind    TEXT    NOT NULL,
  fingerprint   TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_kind, fingerprint)
) STRICT;
CREATE INDEX event_dedupe_sweep ON event_dedupe (first_seen_at);

CREATE TABLE gateway_gaps (
  guild_id        TEXT    NOT NULL,
  gap_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  disconnected_at INTEGER NOT NULL,
  reconnected_at  INTEGER NOT NULL,
  resumed         INTEGER NOT NULL,   -- 1 = RESUMED (no gap), 0 = fresh IDENTIFY (gap)
  reconciled_at   INTEGER
) STRICT;

CREATE TABLE jobs (
  job_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  payload       TEXT    NOT NULL,            -- JSON, Zod-validated on read
  dedupe_key    TEXT    NOT NULL,
  state         TEXT    NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('queued','running','done','failed','cancelled')),
  run_after     INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  cursor        TEXT,                        -- resumable work
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX jobs_dedupe ON jobs (guild_id, dedupe_key);
CREATE INDEX jobs_claim ON jobs (state, run_after) WHERE state = 'queued';

CREATE TABLE audit_events (
  audit_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT    NOT NULL,
  at           INTEGER NOT NULL,
  actor_type   TEXT    NOT NULL
               CHECK (actor_type IN ('member','owner','operator_cli','dashboard','system','doctor')),
  actor_id     TEXT,
  actor_unix_user TEXT,                      -- ADR 0013: CLI writes the invoking Unix user
  via          TEXT,                         -- 'ssh' | 'http' | 'gateway'
  action       TEXT    NOT NULL,
  subject_type TEXT    NOT NULL,
  subject_id   TEXT,
  batch_id     TEXT,
  before       TEXT,                         -- JSON
  after        TEXT,                         -- JSON
  dry_run      INTEGER NOT NULL DEFAULT 0,
  inferred     INTEGER NOT NULL DEFAULT 0,   -- REVIEW C4: audit-log attribution is a guess
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX audit_tail ON audit_events (guild_id, at DESC);
```

### Log routing

```sql
CREATE TABLE log_routes (
  guild_id        TEXT    NOT NULL,
  event_kind      TEXT    NOT NULL,   -- 'message_edit'|'message_delete'|'member_join'|...
  channel_id      TEXT    NOT NULL,
  include_content INTEGER NOT NULL DEFAULT 0,   -- privacy-relevant default; decision 3
  enabled         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guild_id, event_kind),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE log_excluded_channels (
  guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
) STRICT;
```

### Dashboard accounts, sessions, principals, capabilities

```sql
CREATE TABLE dashboard_accounts (
  account_id      TEXT    NOT NULL PRIMARY KEY,
  username        TEXT    NOT NULL UNIQUE,
  password_hash   TEXT    NOT NULL,            -- Argon2id
  totp_secret_enc TEXT,
  totp_enrolled   INTEGER NOT NULL DEFAULT 0,
  is_owner        INTEGER NOT NULL DEFAULT 0,
  disabled        INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,
  created_at      INTEGER NOT NULL
) STRICT;

-- Accounts are instance-level; ACCESS is per guild. Nothing reaches guild data ungated.
CREATE TABLE account_guild_access (
  account_id TEXT NOT NULL,
  guild_id   TEXT NOT NULL,
  PRIMARY KEY (account_id, guild_id),
  FOREIGN KEY (account_id) REFERENCES dashboard_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id)   REFERENCES guilds(guild_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE dashboard_sessions (
  session_id TEXT    NOT NULL PRIMARY KEY,   -- random 256-bit, hashed at rest
  account_id TEXT    NOT NULL,
  guild_id   TEXT    NOT NULL,               -- ADR 0012: sessions are guild-scoped
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  reauth_at  INTEGER,                        -- destructive actions require freshness
  ip         TEXT,
  FOREIGN KEY (account_id) REFERENCES dashboard_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id)   REFERENCES guilds(guild_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE bootstrap_tokens (
  token_hash  TEXT    NOT NULL PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;

-- A principal is a Discord identity that can hold capability. Discord Administrator
-- grants nothing (ADR 0012); capability comes only from a row here.
CREATE TABLE principals (
  guild_id       TEXT NOT NULL,
  principal_id   TEXT NOT NULL,        -- the Discord user or role snowflake
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','role')),
  protected      INTEGER NOT NULL DEFAULT 0,   -- docs/18 Layer 2 protected principals
  PRIMARY KEY (guild_id, principal_type, principal_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE capability_grants (
  guild_id       TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id   TEXT NOT NULL,
  capability     TEXT NOT NULL,
  granted_at     INTEGER NOT NULL,
  granted_by     TEXT NOT NULL,
  PRIMARY KEY (guild_id, principal_type, principal_id, capability),
  FOREIGN KEY (guild_id, principal_type, principal_id)
    REFERENCES principals(guild_id, principal_type, principal_id) ON DELETE CASCADE
) STRICT;
```

### The invariant test

A test reads the live schema and fails the build on any violation — so the *next* table anyone adds is covered without anyone remembering.

```ts
test('every guild-partitioned table is structurally guild-scoped', () => {
  for (const table of tablesExcept(INSTANCE_LEVEL)) {
    expect(columns(table)).toContainEqual({ name: 'guild_id', notnull: 1, type: 'TEXT' });
    for (const fk of foreignKeys(table)) {
      if (referencesGuildPartitioned(fk)) {
        expect(fk.columns, `${table}.${fk.id} must carry guild_id`).toContain('guild_id');
      }
    }
    for (const idx of uniqueIndexes(table)) {
      expect(idx.columns[0], `${table}.${idx.name} must lead with guild_id`).toBe('guild_id');
    }
  }
});
```

`INSTANCE_LEVEL` is a short explicit allowlist — `dashboard_accounts`, `bootstrap_tokens` — and adding to it requires editing the test, which is the point.

---

## 3. The fake Discord harness

Built in Release 0, slice 3, before any feature that uses it.

### The fork I had to resolve

Two credible designs, and the choice matters more than it looks.

**Wire-level fidelity** — construct a real discord.js `Client`, feed it raw gateway JSON through a fake WebSocket, and intercept REST with undici's `MockAgent`. This genuinely exercises discord.js: caching, partials, the lot. It also depends on discord.js internals that are not public API, so a minor version bump can break the whole suite, and it is slow to write.

**Port-level fidelity** — define a narrow `DiscordPort` interface covering only what Bananasaurs uses, implement it twice (real adapter over discord.js, and a fake), and point tests at the port. Fast, readable, stable across upgrades. But it tests *nothing* about discord.js — and the specific fear here, panels silently dead because partials are misconfigured, lives exactly there.

**I chose port-level as the primary, with three targeted compensations**, because a suite that breaks on every discord.js patch release stops being run, and an unrun test suite is worth less than no test suite.

1. A **unit assertion on the constructed `ClientOptions` object** — that it contains all the partials and the intended cache limits. Cheap, and it catches the regression where someone "cleans up" the client construction.
2. **Partial-handling tests against the real code path.** The adapter's `onReactionAdd` is called with a synthetic object where `partial === true` and `fetch()` is controlled by the test. That proves *our* `if (reaction.partial) await reaction.fetch()` branch works, including when the fetch throws `Unknown Message`. That branch is the part we own and the part most likely to be wrong.
3. A **`doctor` runtime check** plus a line in `docs/SMOKE_TESTS.md`.

Residual gap, stated plainly: **no offline test can prove that Discord actually delivers a reaction event for an uncached message on the real gateway.** That is a live smoke test in the test guild, and it stays a manual step. Anyone who claims otherwise is testing their own mock.

### What the fake simulates

| Surface | Coverage |
|---|---|
| Gateway events | `READY`, `RESUMED`, `GUILD_CREATE`, `GUILD_DELETE`, `MESSAGE_REACTION_ADD/REMOVE`, `MESSAGE_REACTION_REMOVE_ALL`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_DELETE_BULK`, `GUILD_MEMBER_ADD/REMOVE/UPDATE`, `GUILD_ROLE_CREATE/UPDATE/DELETE`, `CHANNEL_CREATE/UPDATE/DELETE`, `INTERACTION_CREATE` |
| Interactions | Button click, string-select submit, ephemeral reply, deferred update |
| REST | `addRole`, `removeRole`, `fetchMember`, `fetchMessage`, `fetchReactionUsers` (paginated), `createReaction`, `sendMessage`, `editMessage`, `fetchAuditLog`, `fetchGuildRoles` |
| State | An in-memory guild: roles with positions and `managed` flags, members with role sets, messages with reaction->user-set maps |

### How a test triggers each required condition

```ts
const h = new FakeDiscord({ guildId: G });

// 1. Duplicate event — the same reaction delivered twice, as a reconnect replay does
h.emitReactionAdd({ messageId: M, userId: U, emoji: '🧠' });
h.emitReactionAdd({ messageId: M, userId: U, emoji: '🧠' });   // byte-identical
expect(h.restCalls('addRole')).toHaveLength(1);
expect(await audit.count({ guildId: G, action: 'role.grant' })).toBe(1);

// 2. Reconnect gap — events happen while disconnected, then a FRESH identify (no replay)
h.disconnect();
h.offlineReactionAdd({ messageId: M, userId: U2, emoji: '🧠' }); // mutates state, emits nothing
await h.reconnect({ resumed: false });
// asserts a gateway_gaps row is written and a reconciliation job is enqueued

// 3. 429
h.failNext('addRole', { status: 429, retry_after: 1.5, global: false });

// 4. Missing permission
h.failNext('addRole', { status: 403, code: 50013 });   // Missing Permissions

// 5. Role-hierarchy failure — declarative, so the check is exercised, not the error string
h.setRolePosition({ roleId: R, position: 12 });
h.setBotHighestRolePosition(5);

// 6. Reaction on an uncached message
h.setMessageCached(M, false);   // adapter receives partial:true, must fetch()
```

Every failure injector is one-shot by default (`failNext`) with a `failAlways` variant, so a test asserting circuit-breaker behaviour reads as five consecutive failures rather than as mock plumbing.

---

## 4. Event pipeline and deduplication

```
discord.js Client
   -> adapter: hydrate partials, normalise to a DomainEvent, attach guild_id
   -> guild allowlist gate  (not allowlisted -> log + leave, no further processing)
   -> dedupe gate           (INSERT OR IGNORE into event_dedupe; 0 rows -> drop)
   -> subscribers: panels, logging   (isolated: one throwing does not stop the other)
   -> effect gateway        (the only path to a Discord write)
```

### The dedupe mechanism, and where the docs are wrong

`docs/02`, `docs/08`, and `REVIEW.md` C8 all prescribe **"a unique index on `(guild_id, discord_event_id)`."** That cannot be implemented as written: **Discord gateway dispatches do not carry an event ID.** `MESSAGE_REACTION_ADD` has no ID field. The `s` sequence number is per-session and resets on every reconnect, so it is not a stable identifier either. This is the single most load-bearing error found in the plan documents, because six documents build on it.

What gets built instead is a **derived fingerprint per event kind**:

| Event | Fingerprint |
|---|---|
| `INTERACTION_CREATE` | `interaction.id` — a real snowflake, genuinely unique |
| `MESSAGE_UPDATE` | `sha256(message_id ‖ edited_timestamp)` |
| `MESSAGE_DELETE` | `sha256(message_id)` — deletion is terminal |
| `GUILD_MEMBER_ADD/REMOVE` | `sha256(user_id ‖ joined_at | now_bucket)` |
| `MESSAGE_REACTION_ADD/REMOVE` | *not deduplicated at this layer — see below* |

Reactions are the hard case, because `(message, user, emoji, action)` is not unique over time — a member may legitimately add, remove, and add again. A time bucket would be a guess.

**So reactions are not deduplicated at the event layer at all. They are treated as level-triggered, not edge-triggered.** A reaction event is a hint that a message's reaction state may have changed; the handler recomputes the member's desired role set from panel configuration plus live reaction state and converges toward it. Convergence is naturally idempotent — running it twice produces the same state, and the second run issues no REST call because the state already matches.

This is a better design than event dedupe anyway: it is the *same code path* that handles reconciliation after downtime, so drift repair in Release 1 is not a separate feature with its own bugs.

Idempotency for the audit trail and the outbound call is then enforced one layer down, at the effect gateway, by `role_effects.dedupe_key`:

```
dedupe_key = sha256(guild_id ‖ panel_id ‖ user_id ‖ role_id ‖ action ‖ trigger_ref)
```

where `trigger_ref` is the interaction ID for buttons, and the convergence pass ID for reactions.

---

## 5. Permission model

Three layers. The reason a new caller cannot bypass the check is that **the check produces a value the executor requires as an argument.**

```ts
// packages/core/src/authz.ts
declare const brand: unique symbol;

/** Proof that `capability` was checked for a principal in a guild.
 *  Constructible only by `authorize()`. The brand symbol is not exported,
 *  so this cannot be structurally faked with an object literal. */
export interface Authorized<C extends Capability> {
  readonly [brand]: C;
  readonly guildId: GuildId;
  readonly actor: Actor;
}

export function authorize<C extends Capability>(
  scope: GuildScope, actor: Actor, capability: C,
): Result<Authorized<C>, Denied> { /* single implementation, queries capability_grants */ }
```

and the executor's signature:

```ts
// packages/core/src/effects/gateway.ts
export async function applyRoleEffect(
  auth: Authorized<'roles.mutate'>,     // <- cannot be forged, cannot be omitted
  intent: RoleIntent,
): Promise<EffectOutcome>
```

Three enforcement points, in order:

1. **Type level** — you cannot call the executor without the witness. There is no overload without `auth`, `Authorized` has no public constructor, and the branded symbol is not exported.
2. **Query level** — `authorize()` resolves the actor's Discord roles against `capability_grants` for that guild. Discord permission bits are never consulted, so Administrator grants nothing (ADR 0012). Protected principals are refused here regardless of grants.
3. **Module level** — the Discord REST port is not exported from `packages/discord`'s public entrypoint. Only `core/effects` can import it, enforced by `dependency-cruiser` in `npm run lint`. Even code that somehow obtained a witness cannot reach Discord except through the gateway.

Capabilities for Release 1: `roles.mutate`, `panels.manage`, `logging.manage`, `config.read`, `config.write`, `audit.read`, `killswitch.toggle`, `undo.execute`.

---

## 6. The named constraints, each addressed

### 6.1 Client construction

```ts
// packages/discord/src/client.ts
import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';

/** Exported separately so a test can assert on it without connecting. */
export function buildClientOptions(botUserId: () => string | undefined) {
  return {
    intents: [
      GatewayIntentBits.Guilds,               // roles, channels, guild lifecycle
      GatewayIntentBits.GuildMembers,         // PRIVILEGED — joins/leaves, member fetch
      GatewayIntentBits.GuildMessages,        // message edit/delete events
      GatewayIntentBits.MessageContent,       // PRIVILEGED — only if content logging is on
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildModeration,      // audit-log-backed delete attribution
    ],

    // Without these, reactions on messages outside the (deliberately tiny) cache
    // are dropped silently. This is the single most likely cause of
    // "the panel looks dead".
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
      Partials.User,
      Partials.GuildMember,   // added: hierarchy checks need the bot's own member
    ],

    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 25,
      ReactionManager: 0,
      ReactionUserManager: 0,
      PresenceManager: 0,
      VoiceStateManager: 0,
      GuildStickerManager: 0,
      GuildScheduledEventManager: 0,
      ThreadMemberManager: 0,
      GuildMemberManager: {
        maxSize: 50,
        // keep our own member resident: every hierarchy check needs it
        keepOverLimit: (m) => m.id === botUserId(),
      },
    }),

    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 900 },
      users:    { interval: 3600, filter: () => (u) => u.id !== botUserId() },
    },
  } satisfies ClientOptions;
}
```

Two deliberate departures from ADR 0008, both flagged rather than slipped in:

- **`DirectMessages` dropped.** ADR 0008 lists it; Release 1 has no DM behaviour at all, and `docs/09` says enable intents only where the design requires them. Adding it later is one line.
- **`Partials.GuildMember` added** beyond the four named in the kickoff prompt. Hierarchy checks need the bot's own member object, and with a 50-entry member cache it will not always be resident.

`botUserId()` is a thunk rather than a value because `client.user` does not exist until `READY`, and the naive `m.id === client.user.id` closure is a well-known crash-on-startup footgun.

The exact set of limitable managers gets verified against discord.js **14.27.0** in slice 6 — a few managers throw when limited, and the set has changed across minors. The `ClientOptions` assertion test is what makes that verification permanent rather than a one-time check.

### 6.2 SQLite, WAL, and one writer

Three distinct threats. The planning documents treat them as one.

**Threat A — a second process.** The operator CLI is already handled by ADR 0013's socket design, but `drizzle-kit`, a stray `sqlite3` shell, or a dev instance pointed at the production path are all real. Handled at startup with an OS-level exclusive lock held for the process lifetime.

```ts
export function openDatabase(path: string, opts: { readonly: boolean }): Db {
  if (handle) throw new Error('database already open in this process');
  lockFd = fs.openSync(`${path}.lock`, 'w');
  try {
    flockSync(lockFd, LOCK_EX | LOCK_NB);        // fails immediately if held
  } catch {
    throw new Error(
      `another Bananasaurs process already owns ${path}. ` +
      `Check: systemctl status bananasaurs`);
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');       // composite FKs are load-bearing; not optional
  handle = db;
  return db;
}
```

**Threat B — interleaved transactions.** This is the one that actually bites, and neither ADR 0008 nor `docs/02` mentions it. better-sqlite3 is synchronous and Node is single-threaded, so two `.run()` calls *cannot* interleave — the background worker and interactive reads sharing the process is not, by itself, a problem. The problem is `await` **inside** a transaction:

```ts
// The bug this design makes impossible:
db.exec('BEGIN');
const panel = readPanel();
await discord.addRole(...);   // <- event loop yields; another task writes INSIDE our txn
db.exec('COMMIT');
```

Enforced away at compile time. The write function's callback is typed so an `async` function is not assignable:

```ts
type NotPromise<T> = T extends Promise<unknown> ? never : T;

export function write<T>(scope: GuildScope, fn: (tx: WriteTx) => NotPromise<T>): T {
  if (readonlyMode) throw new ReadonlyError();          // BANANASAURS_READONLY
  return rawDb.transaction(fn)(makeTx(scope));
}
```

Verified against `tsc` 5.9.3 before proposing it. The async case is rejected:

```
error TS2345: Argument of type '() => Promise<number>' is not assignable
              to parameter of type '() => never'.
```

and the synchronous case compiles clean. You physically cannot `await` inside a transaction.

The architectural consequence, which shapes every module: **every unit of work is `plan -> decide -> execute -> record`.** Reads and Discord I/O are async and happen *outside* transactions; the decision and the recording are synchronous and happen *inside* them. That is what "single-writer discipline" means concretely, and it is a constraint on module design from day one exactly as ADR 0008 says.

**Threat C — `SQLITE_BUSY`.** WAL lets readers proceed during a write, so this reduces to checkpoint contention, covered by `busy_timeout = 5000`.

### 6.3 Role panels — two kinds

Shared: behaviour (`toggle` / `add_only` / `remove_only` / `single_choice`), `max_roles`, `required_role_id`, blocked roles. Both resolve to the same `RoleIntent` and the same effect gateway; only intake differs.

| | Adopted | Managed |
|---|---|---|
| Message owner | Anyone, including the owner | The bot |
| Attach by | Message ID | Bot posts it |
| Input | Reactions the bot seeds | Buttons or select menu |
| Bot may edit text | No — a bot can only edit its own messages | Yes |
| Confirmation | None possible | Ephemeral reply |
| Missed events | Yes, when offline | No — interactions are request/response |
| Needs reconciliation | Yes, periodically | Only for role drift |

#### Collision 1 — `single_choice` on adopted panels does not work

Picking role B must clear role A — but clearing the member's stale *reaction* on A requires **Manage Messages** (bit 8192), which `docs/18` Layer 1 deliberately excludes. So the reaction stays. The next reconciliation reads live reaction state, sees both reactions present, and re-grants A. Then the next click revokes it again.

**That is a flap loop, not a cosmetic wart.**

Three ways out:

1. Grant Manage Messages — weakens the outer wall that Layer 1 exists to provide, and it is the one wall Discord enforces rather than our code. Recommended against.
2. **Restrict `single_choice` to managed panels**, and have the dashboard and CLI refuse the combination with a clear message. Buttons have no residue, so the problem disappears entirely. The `CHECK` constraint in the `panels` DDL is a natural extension of this.
3. Accept the drift and document it — a flap loop is not documentable.

**Recommendation: option 2.** But it trades away a feature explicitly requested on the panel type described as "the primary thing I want," so it is the owner's call. Toggle, add-only, and remove-only all work correctly on adopted panels.

### 6.4 Adoption pass

On adopt: enqueue a job that pages `fetchReactionUsers` (100 per page) for each mapped emoji, computes the full desired role set, and converges. Existing reaction state is the intended role state.

#### Collision 2 — the adoption pass and the rate cap contradict each other

A panel with 30 existing reactors needs 30 grants; `docs/18` Layer 3 caps role mutations at 20/minute, and tripping it opens the circuit breaker, which "does not resume on its own — a human clears it." So adopting any well-used panel would trip the breaker and halt the module partway through, leaving roles half-applied.

The same conflict hits the reconciliation budget: a first reconciliation after adoption is *legitimately* large, and `BANANASAURS_RECONCILE_BUDGET=25` would refuse it.

The fix is to distinguish **expected** bulk from **unexpected** bulk, which the current design cannot express:

- Adoption computes its full change list first and shows it to the owner: *"This will grant 47 roles to 31 members. Proceed?"* Confirmation comes from the CLI (`--confirm`) or the dashboard, and it writes an `adoption_allowance` sized to that exact change list.
- The pass then spends that allowance instead of the standing rate cap, at a throttled pace, as a resumable job.
- Anything beyond the allowance — one more role than the owner approved — trips the breaker normally.

So the cap becomes per-source rather than global, and the only source that may exceed it is one a human sized and approved. Unexpected bulk still trips. **This is a change to `docs/18`, not an implementation detail.**

### 6.5 Reaction drift

`gateway_gaps` records every reconnect and whether it was `RESUMED` or a fresh `IDENTIFY`. A fresh identify means events were lost, and a reconciliation job is enqueued per adopted panel. A periodic reconciliation also runs on a timer regardless.

Both use the same convergence function as live events (section 4), so drift repair is not separate code. Each pass computes the full change list first and refuses if it exceeds `reconcile_budget`, per Layer 3.

### 6.6 Hierarchy

Checked **immediately before** every mutation, inside the effect gateway, against live role positions — not against cached config, because the whole failure mode is someone reordering roles months later.

The check is: target role position < bot's highest role position, **and `role.managed === false`**.

That second clause is missing from every planning document, and it matters — an integration role, a Nitro booster role, or another bot's role cannot be assigned no matter where it sits in the hierarchy. Without it, `doctor` reports a role as healthy and the grant fails at runtime with a confusing 403.

The periodic self-check writes `managed_roles.assignable` and `unassignable_reason`, surfacing in `status`, `doctor`, and the dashboard.

### 6.7 Logging module

Subscribes to the pipeline; routes per `log_routes`. Deletion actor comes from the guild audit log, fuzzy-matched on target and timestamp, and every such record carries `audit_events.inferred = 1` and renders as **"deleted by X (inferred)"** — never as plain attribution. Self-deletions produce no audit entry at all, so those render as "actor unknown," not as a guess.

#### A gate that is unachievable as written

`docs/08` Release 1 says a 30-minute outage must leave role state correct **and "miss no log events."**

Role state is recoverable because reactions are durable state on a message. Log events are not: a message edited or deleted while the bot is disconnected produces no event, is not replayed after a fresh `IDENTIFY`, and **there is no API that enumerates "messages deleted while I was away."** The audit log recovers *some* moderator deletions; self-deletions and all edits are gone permanently.

Proposed restatement of the gate: *role state is correct after reconciliation, and every gap is detected and posted to the log channel as an explicit gap marker* —

> ⚠ Bananasaurs was disconnected 14:02–14:31. Edits and deletions in that window were not captured.

Honest and achievable. Silently missing log lines is worse than a visible gap marker.

### 6.8 Safety controls — where each one lives

Not guard clauses. **One chokepoint, layered.** `packages/discord`'s REST port is not exported publicly, so `core/effects/gateway.ts` is the only code in the system that can mutate a role, and lint enforces it.

```ts
export async function applyRoleEffect(
  auth: Authorized<'roles.mutate'>, intent: RoleIntent,
): Promise<EffectOutcome> {
  //  1. kill switch          guilds.killswitch                     -> refuse
  //  2. circuit breaker      guilds.breaker_state = 'open'         -> refuse
  //  3. panel status         panels.status <> 'enabled'            -> refuse  (doctor)
  //  4. role allowlist       FK to managed_roles                   -> constraint
  //  5. protected principal  principals.protected                  -> refuse
  //  6. hierarchy + managed  live check, immediately before        -> refuse + mark
  //  7. rate cap             per-source token bucket; overflow     -> trip breaker
  //  8. idempotency          INSERT OR IGNORE role_effects         -> 0 rows = skip
  //  9. dry run              guilds.dry_run -> log, state='dry_run', no REST call
  // 10. execute              the single REST call
  // 11. record               outcome + before/after + batch_id + audit row
}
```

| Control | Enforced at | Mechanism |
|---|---|---|
| Role allowlist | Schema | `panel_options`/`role_effects` -> `managed_roles` FK. Not a check — a constraint |
| Rate cap + breaker | Gateway, step 7 | Per-source token bucket; overflow writes `breaker_state='open'`, which is durable and survives restart |
| Reconciliation budget | Reconciler, before the gateway | Full change list computed first; oversized set refuses without acting |
| `BANANASAURS_DRY_RUN` | Gateway, step 9 | Single interception point; audit rows still written with `dry_run=1` |
| Batch-ID undo | Gateway, step 11 | Every effect stores `had_role_before` and a `batch_id`; undo replays the inverse through the same gateway |
| Kill switch | Gateway, step 1 | `guilds.killswitch`; reachable from CLI and dashboard; process keeps running |
| Doctor disables a panel | Intake, step 3 | Writes `panels.status`; the bot stays up and the other panels keep working |

Because every control is in one function, "is dry-run respected?" is one test against one function, not an audit of every call site.

### 6.9 Operator CLI

Unix socket at `BANANASAURS_SOCKET_PATH`, newline-delimited JSON, request/response. Never opens the database — the socket reuses the daemon's validation, authorization, and audit path, which is what keeps the single writer single.

- Every command is guild-scoped (`--guild`, or the sole allowlisted guild).
- `--json` on everything.
- Writes require `--confirm` and emit an audit row with `actor_type='operator_cli'`, `actor_unix_user` from `SO_PEERCRED` on the socket — read from the kernel, not from a flag the caller could lie about — and `via='ssh'`.
- `config get` on any key in the secret allowlist returns `<redacted>` unconditionally; there is no override flag.
- `BANANASAURS_READONLY=1` makes `write()` itself throw, so it is enforced in storage rather than per-command.

Release 1 surface is exactly the list in `docs/17`.

### 6.10 Dashboard — one page

Health · log routing · panel config · audit table · kill switch. React + Vite, static, served by Fastify, bound to `127.0.0.1` by default.

**First-account bootstrap:**

1. First start with zero rows in `dashboard_accounts` -> generate a 32-byte random token, store **only its hash** in `bootstrap_tokens` with a 15-minute expiry, print the plaintext once to stdout/journal:

   ```
   ══ Bananasaurs first-run setup ══
   Open http://127.0.0.1:8787/bootstrap?token=<TOKEN>
   Expires in 15 minutes. Not shown again; restart to reissue.
   ```

2. `/bootstrap` is registered **only** when the account table is empty and an unconsumed token exists. Otherwise the route does not exist — a 404, not a 403, so its absence leaks nothing.
3. The form takes username + password (Argon2id, length-checked), creates one account with `is_owner=1` and every capability, marks the token consumed, and issues a session.
4. Consumed or expired -> route unregistered. Re-arming requires shell access on the host: `bananasaurs bootstrap reissue --confirm`, which is the documented ADR 0012 recovery path and gets tested once.

No self-registration, no invite link, no default password, and **no Discord OAuth** — other club administrators hold Discord Administrator, and it grants nothing here. Sessions are DB-backed rather than stateless-signed specifically so revocation is immediate; a signed cookie you cannot revoke is the wrong trade for a control plane with a kill switch on it.

### 6.11 `/privacy`

Renders `PRIVACY.md` with live settings substituted. **But rendering it as-is in Release 1 would tell members something untrue** — see finding 4 in section 9. The renderer is feature-state-aware: sections describing capabilities that do not exist render as *"Not enabled in this server"* rather than as descriptions of active behaviour. A `/privacy` test asserts that no section describing a disabled subsystem renders as active.

### 6.12 Backup and restore

Backup: `VACUUM INTO '<dest>'` on a timer. Chosen over a file copy because it is safe while the daemon holds the database open in WAL mode, and it produces one consistent file with no `-wal`/`-shm` companions to forget. Written to a local path, checksummed, retained N deep.

Restore is a script plus a documented drill: stop the service, move the current DB aside (never delete), copy the backup in, start, run `bananasaurs doctor`. **Rehearsed in Release 1 against a real backup** — an untested restore is not a restore.

Open decision 4: local-path is safe and is the default. An off-host or encrypted-remote target sends server content somewhere new, which `CLAUDE.md` reserves for the owner.

---

## 7. Ordered work plan

Each slice ends compiling, tested, and demonstrable.

### Release 0 — skeleton

| # | Slice | Demonstrable |
|---|---|---|
| 1 | Workspace, TS strict, ESLint + dependency-cruiser, Vitest, Pino with redaction allowlist, Zod config loader, `docs/PROVENANCE.md` | `npm run typecheck && lint && test` green; app refuses to start on a bad `.env` and says which field |
| 2 | Storage: better-sqlite3, WAL, process lock, Drizzle + migrations, `write()` guard, guild-scoped repo factory, **schema invariant test** | Migrate up; a second process refuses to start; an `async` transaction fails to compile |
| 3 | **Fake Discord harness** + `DiscordPort` | A test drives all six conditions: duplicate, gap, 429, 403, hierarchy, uncached reaction |
| 4 | Event pipeline, dedupe fingerprints, job table, worker, `gateway_gaps` | Duplicate event -> one effect, one audit row; a fresh reconnect writes a gap and enqueues reconciliation |

**Release 0 gate:** the harness can drive a test that fails when the implementation is broken.

### Release 1

| # | Slice | Demonstrable |
|---|---|---|
| 5 | Effect gateway + all seven safety layers + audit + batches + undo, tested against a synthetic effect before any real feature | Breaker trips on abuse; dry-run writes zero REST calls; undo restores prior state |
| 6 | Discord adapter: real client construction, `ClientOptions` assertion, allowlist, `GUILD_CREATE` -> leave, `doctor` v1 | Bot connects to test guild; leaves an unlisted guild; `doctor` reports partials and intents |
| 7 | Adopted panels: config, emoji canonicalisation, seed reactions, add/remove -> converge | React on a real message in the test guild -> role appears |
| 8 | Adoption pass with owner-confirmed allowance | Pre-reacted message -> everyone gets their role; the count is previewed first |
| 9 | Managed panels: post, buttons, select, ephemeral confirm, edit | Click a button -> role + "You now have @X" |
| 10 | Behaviours: toggle / add-only / remove-only / single-choice, limits, required + blocked | Each behaviour tested including its refusal path |
| 11 | Reconciliation: timer + post-gap, budget refusal, deleted panel message, deleted role | 30-minute outage with offline reactions -> state correct on return |
| 12 | Logging module + inferred deletion attribution + gap markers | Edits and deletes appear in the log channel, correctly labelled |
| 13 | Operator CLI + socket + `SO_PEERCRED` + `--json` + readonly | `bananasaurs status`, `audit tail`, `panel sync`, `killswitch` over SSH |
| 14 | Dashboard: bootstrap, login, sessions, the one page | Bootstrap from a printed token; a second admin cannot reach it |
| 15 | `/privacy` with feature-state-aware substitution | Command renders live settings, claims nothing untrue |
| 16 | Backup, restore drill, systemd unit, `docs/SMOKE_TESTS.md` | Restore performed from a real backup |

---

## 8. Forks worth naming

Beyond the harness fork in section 3 and the single-choice fork in 6.3:

- **Guild scope: scoped-repository object vs. `guildId` parameter.** Doing both, plus composite FKs. The parameter alone relies on callers; the scoped object alone can be bypassed by anyone who reaches the raw handle. The FKs are the layer that survives both mistakes, and the part worth defending hardest.
- **Job worker: polling vs. event-driven.** Polling with backoff. Event-driven saves latency that does not matter at this scale and loses the restart-safety that comes free from re-reading the table.
- **Sessions: DB-backed vs. signed stateless cookie.** DB-backed, for immediate revocation.
- **Backup: `VACUUM INTO` vs. file copy vs. `restic`.** `VACUUM INTO` for correctness under WAL. `restic` is a fine *destination* layer on top, once a destination is picked.
- **Keeping the `core`/`storage` split.** Nearly collapsed — in-memory SQLite is a perfectly good test double, so the usual justification is weak here. Kept for a different reason: it is what stops `core` from opening a transaction.

---

## 9. What I think is wrong in the planning documents

Ordered by how much damage each would do if discovered during implementation.

1. **`(guild_id, discord_event_id)` describes a field Discord does not send.** `docs/02`, `docs/08`, `REVIEW` C8. Gateway dispatches carry no event ID; `s` is per-session. Six documents build on it. Section 4 has the replacement.
2. **`docs/08`'s "misses no log events" gate is unachievable.** Events during a disconnect are not replayed after a fresh `IDENTIFY` and cannot be recovered. Section 6.7 proposes gap markers instead.
3. **The adoption pass and the rate cap contradict each other.** Adopting any panel with more than 20 existing reactors trips the breaker mid-pass. `docs/18` needs the per-source allowance from 6.4.
4. **`/privacy` in Release 1 would publish a policy that is materially false.** `PRIVACY.md` describes an archive, an AI provider, tiered deletion retention, `/mydata`, and `/forgetme`. In Release 1 none of those exist. It also still contains `<SERVER NAME>` and `<OWNER NAME / CONTACT>`. Rendering it verbatim tells members their messages go to an AI provider when they do not — worse for trust than posting nothing.
5. **`single_choice` on adopted panels flaps.** Section 6.3. Needs a decision.
6. **`role.managed` is missing from every hierarchy discussion.** Booster roles, integration roles, and bot roles are unassignable regardless of position. Without the check, `doctor` reports healthy and the grant 403s.
7. **ADR 0008's dashboard-auth row still says Discord OAuth2**, contradicting ADR 0012. So do `REVIEW` C15 and `REVIEW` E's Release 1 bullet. The Addendum overrides all three, but three documents still read wrong — the same in-place marking already applied to the other two rows would fix it.
8. **`docs/09_OWNER_SETUP.md` is stale throughout.** It still says archive scope defaults to "all channels the bot can view" (ADR 0009 reversed this to default-deny), that indefinite retention is the default (ADR 0009 replaced it with tiers), and records the superseded ADR 0007 position as "current decision." It was not in `REVIEW` G's fix list, so nothing updated it.
9. **`REVIEW` E puts logging in Release 2**; `docs/08` and the Addendum put it in Release 1. Addendum wins; the E body is stale.
10. **ADR 0008 is still `Status: proposed`** while every downstream document treats it as binding.
11. **`docs/RELEASE1_CONFIG.md` is entirely blank**, yet the Release 1 gate reads "the panels in `docs/RELEASE1_CONFIG.md` are live." Not blocking — the engine is generic — but the gate cannot be evaluated. See open decision 3 for the one answer actually needed before slice 12.
12. **`docs/PROVENANCE.md` does not exist**, though ADR 0011 requires it before the first commit of application code. Slice 1.
13. **Backup destination undecided** (`docs/12` item 2) while Release 1 requires backup and restore. Open decision 4.
14. **Privileged intents unverified.** `docs/16` 1.1 says to confirm `SERVER MEMBERS` and `MESSAGE CONTENT` toggle without review. If `MESSAGE CONTENT` needs an application, open decision 3 collapses to metadata-only and slice 12 shrinks. Worth checking in the portal before slice 6.

**Verified correct:** `docs/18`'s permission total. All eight bits sum to exactly `2416004288`.

---

## 10. What I expect to be harder than it looks

- **Emoji identity.** `✔️` (U+2714 U+FE0F) and `✔` (U+2714) are different reaction keys, and members' clients send whichever their platform produces. Skin-tone modifiers compound it. Canonicalising to `u:<codepoints>` / `c:<id>` at config time and again at event time is a small function with an outsized capacity to make a panel look dead for exactly one person. Expect to get this wrong once.
- **Hierarchy checks under a reaction storm.** A 50-entry member cache means fetching members on demand; thirty reactions in ten seconds is thirty fetches against a rate limit. Needs a short-TTL role-position cache invalidated on `GUILD_ROLE_UPDATE` — a cache with an invalidation rule, which is its own bug surface.
- **Undo's conflict policy is unspecified.** If a member changed roles manually after a batch, does undo clobber them? `docs/18` does not say. Leaning toward refusing per-effect where current state no longer matches `had_role_before`, and reporting what was skipped — but that is a decision, not a detail.
- **`SO_PEERCRED` plus systemd socket permissions.** `RuntimeDirectoryMode=0750`, `UMask=0007`, group `bananasaurs-ops`. Every piece is simple; getting all of them right on the first try is not, and the failure mode is a socket nobody can reach.
- **Native modules.** `better-sqlite3` and Argon2 both compile against the Node ABI. A Node upgrade breaks them silently until something calls them. Pin Node 22 in the systemd unit and CI.
- **The restore drill while the daemon holds the file.** The stop/move/copy/start ordering has to be exactly right, and the one time it matters is the one time nobody wants to be improvising.
- **discord.js cache limiting.** A few managers throw when limited and the set shifts across minor versions. The `ClientOptions` test makes it a build failure rather than a runtime surprise, but expect the first attempt at slice 6 to hit it.

---

## Review log

| Date | Reviewer | Outcome |
|---|---|---|
| 2026-08-22 | — | Draft written, awaiting owner review |
