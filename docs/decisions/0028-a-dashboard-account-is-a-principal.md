# 0028 — A dashboard session is authorized by a capability grant to its account

Status: accepted
Date: 2026-08-30
Refines: ADR 0012 (dashboard auth), ADR 0024 (the operator socket). Extends the
five-layer permission model in `docs/19` §5.

## Context

ADR 0012 says the owner provisions each account with "username, password, **and
a capability set**". Nothing in Release 1 could hold that capability set.

`authorize()` in `packages/core/src/authz.ts` is the single implementation of
"does this actor hold this capability", and it reaches a decision three ways:

1. `SYSTEM_ACTORS` (`system`, `doctor`) — authorized by being wired into the
   daemon.
2. `CHANNEL_AUTHORIZED_ACTORS` (`operator_cli`) — authorized by the admin
   socket's filesystem permissions (ADR 0024).
3. Everyone else — `principalsOf(actor)` then `store.hasGrant(...)`.

A `dashboard` actor falls to (3) and is **always denied**. `principalsOf` maps
`actor.id` to a principal only when `isSnowflakeId(actor.id)` holds, and a
dashboard account id is not a snowflake — so the principal list is empty and the
denial is `actor-has-no-identity`. A logged-in owner could not toggle the kill
switch on the page whose whole job is the kill switch.

`authz.ts` already forecloses the easy repair, in a comment: `dashboard` is not
in `CHANNEL_AUTHORIZED_ACTORS` **and must not be added**. The operator socket's
authorization is a filesystem permission the kernel enforces on a local socket.
A dashboard session is a bearer credential arriving over a TCP port. Treating
the two as the same kind of thing would mean a stolen cookie carries every
capability, which is precisely what ADR 0012 exists to prevent.

So the dashboard must go through `capability_grants`-style grants like every
other principal. The question is what a dashboard account's principal *is*.

## The option that was tried and rejected

**Make `account` a third `principal_type` in `principals`, so account grants
live in `capability_grants` beside user and role grants.**

One table, one query, one hot path. It fails on the key type.
`principals.principal_id` is declared with the `snowflake()` custom column type,
whose `toDriver` **throws** on anything that is not 17–20 digits, and it carries
a `NOT GLOB` CHECK that says the same thing to SQLite. Storing `acct_…` in that
column means relaxing both — dropping the runtime guard and weakening the CHECK
on the most security-critical table in the schema — so that the two rows a
dashboard uses can share a column with the rows that name Discord members.

That is the shape of change this project has already decided not to make: a
guard relaxed to accommodate a new caller no longer catches the case it exists
for. The reason `principals.principal_id` is guarded is `docs/19`'s corrupted-
snowflake failure, where a nineteen-digit string that passes every format check
is the wrong user. Making the guard conditional on a sibling column is how that
protection stops being a protection.

## Decision

**A dashboard account is a principal of type `account`, and its grants live in
their own table.**

### Storage: `account_capabilities`

```
account_capabilities(guild_id, account_id, capability, granted_at, granted_by)
  PRIMARY KEY (guild_id, account_id, capability)
  FOREIGN KEY (guild_id, account_id)
    REFERENCES account_guild_access(guild_id, account_id) ON DELETE CASCADE
```

Guild-partitioned, leading with the partition key, needing no entry in
`INSTANCE_LEVEL` and none in `UNIQUE_BY_DESIGN`. `account_id` is correctly typed
as our own identifier rather than as a snowflake, and the snowflake guard on
`principals` is untouched.

The composite foreign key is the load-bearing part. **Capability in a guild the
account cannot reach is not representable**, and revoking an account's access to
a guild cascades its capabilities away rather than leaving them dormant for the
next time access is granted. Reachability (`account_guild_access`) and
capability (`account_capabilities`) stay two separate grants, as ADR 0012 has
them, and the database enforces the order between them.

### Core: one `authorize()`, one `AuthzStore`, three principal kinds

`PrincipalRef` becomes a discriminated union:

```ts
type PrincipalRef =
  | { principalType: 'user' | 'role'; principalId: SnowflakeId }
  | { principalType: 'account';       principalId: AccountId };
```

`AccountId` is a branded id in `core/ids.ts` beside `SnowflakeId`, shaped
`acct_` + 32 lowercase hex. The prefix means an account id can never be mistaken
for a snowflake by a format check, in either direction, so `principalsOf` keeps
narrowing with a type predicate — `isAccountId` beside `isSnowflakeId` — and
still contains no cast.

`authorize()` is unchanged. `AuthzStore.hasGrant` is unchanged. The storage
implementation of `hasGrant` answers `account` refs from `account_capabilities`
and `user`/`role` refs from `capability_grants`, so there is still exactly one
function anything calls to ask the question, and exactly one place a divergence
between the two key spaces could appear.

### `principalsOf` ignores a dashboard actor's Discord roles

A `dashboard` actor presents **only** its account principal. `roleIds` are not
consulted, whatever they contain.

This is a control, not tidiness. ADR 0012's decision is that Discord
Administrator — and Discord role membership generally — grants nothing in
Bananasaurs, because other members of the club server hold it. If a dashboard
actor's `roleIds` reached `hasGrant`, then a future account-linking feature
(ADR 0012's "optional, later") that populated them from Discord would silently
turn every Discord role grant into a dashboard capability. Dropping them in
`principalsOf` means that feature cannot cause it by omission, and the test
naming this is the one to read before changing it.

## Consequences

- Capability lives in two tables keyed by two id types, joined by one `hasGrant`.
  The alternative was one table keyed by a type that is wrong for half its rows.
- The bootstrap owner account gets an explicit row per capability, not an
  `is_owner` superuser branch in `authorize()`. `is_owner` marks who may not be
  deleted and who may provision others; it grants nothing by itself, for the
  same reason Discord Administrator does not.
- `account_guild_access` must exist before any capability can be granted, which
  makes "which guilds can this account see" the first question account
  provisioning answers rather than an afterthought.
- Linking a Discord identity to an account later (ADR 0012) remains possible and
  remains incapable of granting anything: it would populate a field, not a
  principal.
