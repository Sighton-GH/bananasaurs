# 0031 — A dashboard action's audit row carries a verified `actor_id`; the CLI's does not, and both are correct

Status: accepted
Date: 2026-08-30
Extends ADR 0024 amendment 2 (why `operator_cli`'s `actor_id` is `undefined`).
Depends on ADR 0028 (a dashboard account is a principal) and ADR 0029 (session
identity). Implements `docs/19` §6.9's `via` vocabulary for the `http` case.

## Context

`OpsAuditWrite` in `packages/core/src/ops/ports.ts` is narrowed to exactly what
the operator CLI can produce:

```ts
readonly actorType: 'operator_cli';
readonly actorId: undefined;
readonly actorUnixUserClaimed: string | undefined;
readonly via: 'ssh';
```

Slice 14's second half adds two HTTP write routes — the kill switch and log
routing — that must each record an audit row, and neither goes through
`createDispatcher` (which builds its row in `auditWriteFor` and hard-codes
`actorType: 'operator_cli'` unconditionally — routing HTTP requests through it
to reuse that path would misattribute every one of them). The type has to widen
before either route can compile.

The question worth an ADR is not the mechanical widening — it is what value
`actorId` takes for a dashboard action, because the two actor types reach
opposite answers to the same question, and the reasoning is not obvious from
either code path read alone.

## Decision

### `actorType` becomes `'operator_cli' | 'dashboard'`

One field, two literals, both already valid `ActorType` values in
`packages/core/src/authz.ts`.

### `via` becomes `'ssh' | 'http'`

The column's vocabulary was always `'ssh' | 'http' | 'gateway'` (`docs/19`
§6.9); only `'ssh'` had a producer. `'http'` means "came in through the
dashboard API."

### `actorId` is filled for a dashboard action, and left `undefined` for the CLI — deliberately opposite

This is the actual decision. Naively, widening a type feels symmetric: both
actor types should either fill the field or not. They should not, because the
field means "a verified identity," and the two actors have different standing
with respect to that word.

**The CLI has no verified identity to put there.** ADR 0024 amendment 2:
`unixUserClaimed` arrives over the socket as an assertion — Node cannot read
`SO_PEERCRED`, so the CLI cannot prove which Unix user is really invoking it.
Laundering that claim into `actor_id`, the column every other actor type fills
with something verified, would make the trail read as stronger evidence than
it is. The claim goes in `actor_unix_user_claimed` instead, whose name carries
the caveat, and `actor_id` stays `undefined`. This ADR does not touch that.

**A dashboard session is the reverse case.** By the time a route handler has a
`SessionContext`, `authenticate()` in `packages/http/src/auth.ts` has already:
looked up the session by the SHA-256 of the cookie's raw token, confirmed it is
neither expired nor revoked, loaded the account behind it, and confirmed the
account still holds access to the session's guild. The `accountId` on that
session did not arrive as a claim in a request field — it is the primary key of
a row the server itself created, at a login where it verified an Argon2id
password hash. That is a verified identity by exactly the standard the column
otherwise requires, and refusing to fill it out of some borrowed caution from
the CLI's case would be applying a rule to a situation the rule was not written
for.

So: `actorId` is `session.accountId` for a dashboard action, and remains
`undefined` for the CLI. The two are not the same field defaulting differently
— they are the field doing its one job, which is to report a verified identity
when one exists and to say nothing when it does not.

### `actorUnixUserClaimed` stays `undefined` for a dashboard action

There is no Unix user anywhere in an HTTP request. Inventing one — say, from
the account's username — would be exactly the mistake amendment 2 exists to
prevent, aimed at a field whose caveat ("claimed, not verified") would then be
attached to a value that was never claimed by anyone. The field is `undefined`
for a dashboard row because the question it answers does not arise.

## Consequences

- `OpsAuditWrite.actorId` becomes `string | undefined` (previously the literal
  type `undefined`). Every existing producer (`dispatch.ts`'s `auditWriteFor`)
  still compiles unchanged, because `undefined` is still a valid value of the
  wider type.
- The two HTTP write routes construct `OpsAuditWrite` directly rather than
  through the dispatcher, and set `actorType: 'dashboard'`, `actorId:
  session.accountId`, `actorUnixUserClaimed: undefined`, `via: 'http'`.
- `audit tail` and the dashboard's audit table render the same row shape either
  way; a reader already has to know that `actor_id` is sometimes absent, and
  now knows precisely why, per row, from `actor_type`.
- No schema migration: `audit_events.actor_id` and `.via` were already
  nullable/open-vocabulary columns holding the CLI's `NULL` and `'ssh'`. This is
  a TypeScript-level widening of what the application is willing to construct,
  not a storage change.
