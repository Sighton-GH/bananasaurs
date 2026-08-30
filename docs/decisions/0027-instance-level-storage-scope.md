# 0027 — Instance-level tables reach the database through their own scope

Status: accepted
Date: 2026-08-30
Refines: ADR 0004 (guild isolation), `CLAUDE.md` rule 2.

## Context

`CLAUDE.md` rule 2 says every query carries an explicit guild id and that the
rule is enforced in signatures, not in caller discipline. `packages/storage`
implements that literally: the database handle is not reachable outside the
package, the only way to obtain one is `GuildScope`, and `scope.only(table)`
accepts only tables that carry a `guild_id` column, so an instance-level table
is a **compile error** rather than a silently unscoped query.

Two Release 1 tables are legitimately not guild-partitioned, and
`schema-invariants.test.ts` already records why in `INSTANCE_LEVEL`:

- `dashboard_accounts` — an account exists before a guild is chosen (ADR 0012).
- `bootstrap_tokens` — the first-run token is issued before any account, let
  alone any guild.

Neither has a `GuildScope` to be reached through. The obvious shortcut is to
pass a `GuildScope` anyway and simply not call `.only()`. That is the wrong
answer, and it is wrong in the specific way rule 2 names: it makes "did this
query forget its guild predicate?" a question you answer by *reading the body*
rather than by *reading the signature*. Every instance-level repository
function would then be indistinguishable, at the call site and in review, from
a guild-scoped one with a missing `where`.

## Decision

**A second scope type, `InstanceScope`, produced by the same factory.**

- `ScopeFactory` gains `instance(): InstanceScope`. It carries the database
  handle out of band through the same `WeakMap`, so `core`, `http` and `cli`
  still cannot reach a handle.
- `InstanceScope` deliberately has **no `only()`**. There is no guild predicate
  to build, so there is nothing to forget.
- `write.ts` gains `readInstance(scope, fn)` and `writeInstance(scope, fn)`,
  with the same `NotPromise<T>` transaction rule and the same `ReadonlyError`
  refusal as `write()`. `BANANASAURS_READONLY` is a property of the process, not
  of a guild, so it applies identically.
- A repository function's **first parameter answers the question**: a
  `GuildScope` means the query is partitioned, an `InstanceScope` means it is
  deliberately not. A function cannot take either.

### It is not only for instance-level *tables*

One guild-partitioned table needs it too, and the reason is already recorded in
`schema.ts` and in `UNIQUE_BY_DESIGN`: **a session is looked up by its token
before the guild is known.** `dashboard_sessions` carries `guild_id` and every
query that reads guild data through a session checks it — but the lookup that
turns a cookie into a session cannot, because guild-scoping it would mean
trusting a client-supplied guild in order to authenticate the session.

So `findSessionByToken` takes an `InstanceScope` and returns the row *including*
its `guild_id`; the caller then builds a `GuildScope` from what the database
said, and everything after that point is ordinarily scoped. The split is visible
in the signatures: exactly one session function is instance-scoped, and it is
the one that authenticates. `createSession`, `revokeSession` and the
re-authentication touch are all `GuildScope`.

`ReadonlyError`'s message names a guild id. `writeInstance` passes the literal
string `instance`, so the refusal reads `refusing a write for guild instance`,
which is slightly odd English and unambiguous about what was refused. A second
error class would have meant two things for `dispatch.ts`'s `isReadonlyRefusal`
to recognise across the ADR 0014 boundary, where it can only match on `name`.

## Consequences

- Adding an instance-level table now costs three deliberate steps: the table, an
  entry in `INSTANCE_LEVEL` with a reason, and a repository that takes an
  `InstanceScope`. All three are visible in a diff.
- `openDatabase()` returns a `ScopeFactory` already, so the composition root
  needs no new plumbing — `opened.scopes.instance()` is available everywhere
  `opened.scopes.forGuild()` is.
- The readonly guard stays a single interception point. "Is readonly
  respected?" remains two tests against two functions in one file, rather than
  an audit of call sites.
