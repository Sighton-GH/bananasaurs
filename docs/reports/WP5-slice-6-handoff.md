# Handoff prompt — WP5 slice 6, the real Discord adapter

**Why this comes before WP4.** The WP3 boundary report §6 records that the fake
harness was wrong about Discord twice in one package, both found by accident
rather than by reading. Every conclusion from WP1–WP3 is conditional on the fake
being right. Bryan decided at the WP3 boundary (2026-08-23) to pull slice 6
forward so the harness is validated against real Discord before another package
rests on it.

`docs/19` §7 already flags the risk this reverses: _"the adapter is the
least-tested-in-anger component and it arrives late. Flagged rather than
silently reordered."_ This is the un-reordering.

WP4 (logging) follows, using the prompt in `docs/reports/WP3.md` §8.

## Why not simply wait for the CLI and dashboard

Bryan asked the obvious question: slice 6 needs a throwaway seed script to be
testable at all, so why not run WP4 and WP5 in order and test everything once
the real configuration surfaces exist? Two things settle it.

**Panel configuration is slice 14, not slice 13.** `docs/19` §6.10 puts panel
config on the dashboard page; the CLI's `panel sync` (slice 13) pushes existing
configuration to Discord rather than authoring it. So "wait for the tooling"
means waiting until the second-to-last slice of the release, with WP4 and the
whole operator CLI built and never once exercised against real Discord. That is
the failure mode the slice-and-demonstrable structure exists to prevent. The
seed script is not bridging a short wait; it is the difference between
validating at slice 6 and validating at slice 14.

**WP4 is the package most exposed to the fake being wrong, and in the least
modelled place.** `FakeDiscord.fetchAuditLog` is a hand-populated array with a
filter over it. It models none of the real audit log's behaviour: entries appear
with a lag, self-deletions produce no entry at all, and — the one most likely to
break the design — Discord **coalesces** `MESSAGE_DELETE` entries, updating a
single entry's `count` when several messages by the same author in the same
channel are deleted, rather than emitting one entry per message. `AuditLogEntry`
in `packages/core/src/discord/port.ts` has no `count` field, because nothing has
ever needed one.

WP4's hardest requirement is inferred deletion attribution, fuzzy-matched on
target and timestamp. Building that against a fixture that makes the problem
look easy is how you ship a bot that confidently names the wrong moderator.
Correcting the audit-log model is therefore explicitly part of this slice — see
"THE THINGS MOST LIKELY TO GO WRONG" item 7.

---

```
Begin WP5 SLICE 6 of the Bananasaurs project — the REAL DISCORD ADAPTER. This
slice is being taken OUT OF ORDER, ahead of WP4, deliberately. Read the "why"
below before you start; it changes what success means for this slice.

FIRST, BEFORE ANYTHING ELSE
  `npm install && npm run build && npm run db:migrate`. If you have a dev
  database from before WP3, delete it first: `rm -rf data/`.
  Confirm the baseline is green before you change anything:
  `npm run typecheck && npm run lint && npm run test` — expect 696 tests.

WHY THIS SLICE IS OUT OF ORDER, AND WHAT THAT MEANS FOR YOU

  Everything built so far runs against an in-memory fake
  (packages/testkit/src/fake-discord.ts). During WP3 the fake was found to be
  WRONG ABOUT DISCORD TWICE, both times discovered by a mutation that passed
  when it should have failed:

    - `fetchReactionUsers` filtered out the bot's own user id, and a WP1 test
      asserted it should. Discord's GET /reactions returns every user who
      reacted, bot accounts included.
    - The fake did not dispatch GUILD_MEMBER_UPDATE for role changes the bot
      itself made. Discord does. That is the single fact amendment 5 exists to
      handle, and a fake that only echoed human changes would have agreed with
      a broken implementation.

  So your job is NOT only "write the adapter". It is also: **find out where else
  the fake is lying.** Every difference you discover between discord.js's real
  behaviour and the fake's is a finding worth more than the code you wrote that
  day. When you find one, fix BOTH the fake and any test that asserted the wrong
  behaviour, and record it in docs/SESSION_LOG.md as a finding, not a footnote.

  You cannot connect to Discord yourself and must not try — there is no token
  available to you and `.claude/settings.json` denies reading `.env`. What you
  CAN do is read discord.js 14.x's actual types and source in node_modules,
  which is the authority on shapes, event payloads, and which cache managers
  accept limits. Where the real library and the fake disagree, the library wins.

READ, IN THIS ORDER
  1. CLAUDE.md — nine hard rules. Rule 4 (no secrets in logs; Pino redaction is
     an ALLOWLIST) and rule 8 (no new outbound network destinations without an
     explicit instruction) are the ones this slice lives inside. Discord is the
     one destination this slice is authorised to add.
  2. docs/reports/WP3.md — §6 is why you are here.
  3. docs/19_RELEASE_0_1_PLAN.md §6.1 (client construction — it contains the
     code you are implementing, including two deliberate departures from ADR
     0008 that are already reasoned about), §1 (repository layout), §5 boundary
     rule 5 (the REST port subpath), and §7 slice 6's row.
  4. docs/decisions/0008-stack-selection.md §"Mandatory discord.js
     configuration" — the cache limits are a memory-budget requirement, not a
     preference.
  5. docs/decisions/0014-package-boundary-enforcement.md — the lint rules for
     `packages/discord` ALREADY EXIST in eslint.config.js and are waiting for
     the package. So does packages/core/src/boundaries.test.ts, which already
     names `packages/discord/src/adapter.ts` as the expected path.
  6. docs/21_TESTING_THE_BOT.md — what Bryan will actually do with what you
     build. Your `doctor` output has to answer the questions in exercise 1.
  7. docs/20_AUTONOMOUS_EXECUTION.md — the protocol you work under.

WHAT SLICE 6 IS

  From docs/19 §7: "Discord adapter: real client construction, ClientOptions
  assertion, allowlist, GUILD_CREATE -> leave, doctor v1."

  Demonstrable: "Bot connects to test guild; leaves an unlisted guild; doctor
  reports partials and asserts both privileged intents are actually granted at
  runtime, not merely configured."

  SIZE WARNING. As written this is well over the ~400-line limit docs/20 sets
  for one slice, because apps/daemon/src/index.ts is STILL THE WP1 SKELETON —
  it parses config, logs a banner, and says "no modules are wired up yet".
  Nothing is connected: not the database, not the pipeline, not the effect
  gateway, not the panel subscribers, not the job worker. Split it:

    6a — packages/discord: the package, client construction
         (`buildClientOptions`), and the ClientOptions assertion test. No
         connection, no event translation. Exported separately from the client
         precisely so a test can assert on it without a network.
    6b — the DiscordPort implementation (REST) and gateway event translation
         into the DomainEvent shapes in packages/core/src/discord/events.ts.
    6c — the composition root: apps/daemon wires database, pipeline,
         subscribers, effect gateway, job worker and the client together, plus
         the guild allowlist and GUILD_CREATE -> leave.
    6d — doctor v1, and a dev-only seed script.

  THE SEED SCRIPT IS NOT OPTIONAL. Nothing can create a panel at slice 6: the
  operator CLI is slice 13 and the dashboard is slice 14. Without a way to
  define one, exercises 2 through 5 of docs/21_TESTING_THE_BOT.md cannot be
  performed at all, and the whole point of taking this slice early is lost.
  Ship `scripts/seed-test-panel.mjs`, which writes one panel through
  `panelRepo.createPanel` (so it goes through the same Zod validator and the
  same foreign keys as any other panel) and allowlists its roles. It is a
  DEVELOPMENT FIXTURE, not a feature: it must refuse to run when
  `BANANASAURS_ENV=production`, it must print its own usage, and slice 13
  replaces it. Do not grow it into a configuration interface.

  If 6c is still too large, split it again by subsystem. A slice you cannot
  review is not a slice.

WHAT ALREADY EXISTS — DO NOT REBUILD ANY OF IT

  The port you are implementing. packages/core/src/discord/port.ts defines
  `DiscordPort` — 14 methods, deliberately narrow. Implement exactly it. Do NOT
  widen it because discord.js offers more; a port that mirrors discord.js would
  be as hard to fake as discord.js itself, which is the whole point of the seam.
  packages/testkit/src/fake-discord.ts `implements DiscordPort` and is your
  reference for the semantics each method must have.

  The event shapes. packages/core/src/discord/events.ts. Every event carries
  `guildId` explicitly; an event that cannot be attributed to a guild is dropped
  AT THE ADAPTER rather than travelling with an optional scope. Note
  `ReactionEvent.wasPartial` — that flag exists to make "the panel looks dead"
  diagnosable, so set it honestly.

  Error mapping. packages/core/src/discord/errors.ts already has
  `DiscordApiError`, the Discord error codes the system knows
  (UnknownMember, UnknownRole, UnknownMessage, UnknownInteraction 10062,
  MissingPermissions 50013...), `isGone`, and `isExpiredInteraction`. Map
  discord.js's DiscordAPIError onto these; do not invent a second vocabulary.

  Emoji canonicalisation. packages/core/src/discord/emoji.ts — `u:<codepoints>`
  for unicode, `c:<id>` for custom. The adapter converts in both directions;
  everything above the adapter speaks only EmojiKey.

  The pipeline, the effect gateway, the job worker, panels, reconciliation. All
  built and tested. apps/daemon/src/panels/wiring.ts is the shape to copy for
  binding a GuildScope into port objects at the composition root.

  The lint boundary. eslint.config.js already bans `@bananasaurs/discord/rest`
  everywhere except core/effects and apps/daemon, and already has a
  `packages/discord/**` block. packages/core/src/boundaries.test.ts asserts the
  rules actually FIRE rather than merely resolve. Your package.json `exports`
  must make `/rest` the only reachable path into the REST port.

THE THINGS MOST LIKELY TO GO WRONG

  1. PARTIALS. Without Partials.Message, Channel, Reaction, User and
     GuildMember, reactions on messages outside the (deliberately tiny) cache
     produce NO EVENT AT ALL. docs/REVIEWING_AGENT_OUTPUT.md names this as the
     single most likely cause of "the panel looks dead". `doctor` must report
     the configured partials, and the ClientOptions assertion test must fail if
     one is dropped.

  2. `client.user` DOES NOT EXIST UNTIL READY. docs/19 §6.1 passes `botUserId`
     as a THUNK for this reason — the naive `m.id === client.user.id` closure
     inside `makeCache` is a well-known crash-on-startup footgun. Keep the thunk.

  3. CACHE LIMITS THAT THROW. §6.1 says the exact set of limitable managers must
     be verified against the discord.js version actually installed, because
     "a few managers throw when limited, and the set has changed across minors".
     Verify against node_modules, not against the doc. The assertion test is what
     makes that verification permanent instead of a one-time check.

  4. PRIVILEGED INTENTS. Configuring them is not the same as being granted them.
     A bot with the intent in code but the toggle off in the Developer Portal
     connects fine and then never sees a member join. `doctor` must assert what
     was actually GRANTED at runtime. Find out how discord.js surfaces this
     (READY payload / application fetch) rather than assuming.

  5. THE INTERACTION TOKEN IS A CREDENTIAL. It is absent from LOGGABLE_FIELDS
     and pino redacts `token`. It travels between the adapter and the port and
     nowhere else. A token in a log file is a token anyone reading that log can
     act with for fifteen minutes.

  6. RATE LIMITS. discord.js queues internally; our rate limiter and circuit
     breaker sit ABOVE it. Do not let the adapter silently retry — a refusal
     the gateway can see is worth more than a retry it cannot.

  7. THE AUDIT LOG IS THE LEAST-MODELLED PART OF THE FAKE, AND WP4 IS BUILT
     ENTIRELY ON IT. `FakeDiscord.fetchAuditLog` is a hand-populated array with
     a filter. Real Discord differs in at least three ways that change the
     design of the thing WP4 has to build:
       - Entries appear with a LAG. The delete event arrives before the audit
         entry exists, so correlation cannot be synchronous.
       - Self-deletions produce NO ENTRY AT ALL. "Actor unknown" is a real and
         common outcome, not an edge case.
       - MESSAGE_DELETE entries COALESCE. Deleting several messages by the same
         author in the same channel updates ONE entry's `count` field rather
         than creating one entry per message. `AuditLogEntry` in
         packages/core/src/discord/port.ts has no `count` field today.
     Read discord.js's `GuildAuditLogsEntry` types and check each of these
     against the fake. Whatever you find, fix the fake and say so in the session
     log — this is the single highest-value thing this slice can hand to WP4.
     If the port's `AuditLogEntry` needs a new field, that is a finding worth
     more than the adapter code, and it belongs in an ADR.

SETTLED — DO NOT RE-LITIGATE
  1. `DirectMessages` intent is deliberately NOT included. Release 1 has no DM
     behaviour. docs/19 §6.1 flags this as a departure from ADR 0008 with its
     reasoning.
  2. `Partials.GuildMember` IS included, beyond the four in the original
     kickoff, because hierarchy checks need the bot's own member and a 50-entry
     member cache will not always have it.
  3. Manage Messages is NOT in the bot's permission set and must not be added.
     Its absence is why single_choice cannot work on a reaction panel
     (docs/19 §6.3 collision 1). If a panel problem looks solvable by granting
     it, you have found the wrong solution.
  4. Reconciliation covers adopted panels only (docs/19 §6.3 as amended,
     approved 2026-08-23).
  5. `protected` means the bot will not mutate that member or role. It does not
     deny capability to an actor (ADR 0015).
  6. One process. Do not split into services (ADR 0006).
  7. AI is nowhere in this slice.

DEPENDENCIES
  This slice adds `discord.js` — the one dependency ADR 0008 already names, so
  it needs no new justification. Add nothing else without one. Record anything
  copied from a permissively licensed source in docs/PROVENANCE.md; you may not
  copy from Red-DiscordBot (GPL-3.0) or Zeppelin (Elastic License 2.0).

PROTOCOL
  Work slice by slice (6a, 6b, 6c, 6d). For each: write the tests first for
  anything touching permissions, hierarchy, idempotency, guild scope or the
  allowlist; then implement; then run
  `npm run typecheck && npm run lint && npm run test` and PASTE THE REAL OUTPUT.
  Do not report completion on the basis of code you have not run.

  Then BREAK the implementation deliberately to prove the tests catch it, record
  what you broke and what failed, and restore it. Restore with a FILE COPY, not
  `git checkout <file>` — that also discards the slice's own edits, which
  happened in WP3. WP3's mutations are numbered up to 45; continue from 46.

  Append to docs/SESSION_LOG.md: package, slice, what changed, what you broke,
  anything deferred and why — and separately, ANY DIVERGENCE YOU FOUND BETWEEN
  THE FAKE AND REAL DISCORD. Commit after each slice. DO NOT PUSH.

  Record consequential choices as short ADRs in docs/decisions/ BEFORE
  implementing them. The next free number is 0018.

  You cannot connect to Discord and must not attempt to. Never read, print or
  copy `.env`. Never spawn the `claude` binary from application code.

  Stop at the end of slice 6d and produce a short report: what was built, the
  verification evidence, the four questions from docs/20 answered with real
  file:line evidence, every fake-vs-real divergence you found, and an explicit
  checklist for Bryan mapping each item in docs/21_TESTING_THE_BOT.md exercise 1
  to the thing in your code that satisfies it. Then stop; WP4 is a separate
  session using the prompt in docs/reports/WP3.md §8.
```
