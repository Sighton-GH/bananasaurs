# ADR 0024: The operator socket is the authorization boundary, and the claimed identity is audit metadata

Status: accepted (2026-08-29)

Extends ADR 0013 (which decided *that* there is a socket) and amendment 2 of
`docs/19_RELEASE_0_1_PLAN.md` (which corrected the claim that the invoking Unix
user is kernel-verified). Does not modify ADR 0012.

## Context

ADR 0013 §4 lists the CLI's guardrails — guild scope, `--confirm` on writes, an
audit row, secret redaction, `BANANASAURS_READONLY`, the kill switch — and does
not say where the CLI's *capability* comes from. Slice 13 cannot avoid
answering, because `applyRoleEffect` takes an `Authorized<'roles.mutate'>`
witness and re-verifies it at runtime (`packages/core/src/authz.ts:1-40`), so
`undo` and `panel sync` over the socket must produce a real witness or not run
at all.

The obvious answer — check `capability_grants` like everything else — does not
survive contact with the schema or with amendment 2.

**The schema cannot hold the actor.** `capability_grants` is keyed by
`(guild_id, principal_type, principal_id)` with
`principal_type IN ('user','role')` and a snowflake `CHECK` on `principal_id`
(`packages/storage/src/schema.ts:704-745`). A Unix username is neither a
Discord user nor a Discord role, and it is not a snowflake.

**The identity is not verifiable.** Amendment 2 settled this: Node exposes no
`SO_PEERCRED`, so the username the CLI sends is an assertion. The column is
`actor_unix_user_claimed` for that reason.

**And there is a bootstrap trap.** A fresh install has zero rows in
`capability_grants`. The CLI is the only surface that could create the first
one. A CLI gated on holding a grant can never issue the first grant, and the
recovery path in ADR 0012 — "re-armed from the host by someone with shell
access" — assumes exactly the opposite.

## Decision

### 1. Reaching the socket *is* the authorization

An `operator_cli` actor that arrives over the admin socket is authorized for
every capability. `authorize()` returns a witness without consulting
`capability_grants`.

The real access control is the one `docs/17` §2.1 already describes and the
systemd unit already has to get right: the socket is owned
`bananasaurs:bananasaurs-ops`, mode `0660`, and **group membership is what
grants access**. That is a filesystem permission enforced by the kernel, which
is more than the alternative offers.

### 2. The claimed identity is audit metadata, never a control

Every write over the socket records `actor_type='operator_cli'`, `via='ssh'`,
and the caller-supplied `actor_unix_user_claimed`. `audit tail` renders it as
claimed, the same discipline WP4 applied to inferred deletion attribution.

**It is never consulted to decide anything.** A field that decided access would
be a control built on an assertion — worse than no control, because it reads as
one in review and in a security write-up. The name answers "who says they did
this", which is genuinely useful when there is one operator and a shared group,
and it answers nothing else.

### 3. `operator_cli` gets its own branch, not membership in `SYSTEM_ACTORS`

`SYSTEM_ACTORS` exists for a different reason — "authorized by being wired into
the daemon, not by a grant someone could revoke by accident". Adding
`operator_cli` to that set would reach the same outcome by inheriting a
justification that does not apply, and the next person to change either rule
would silently change the other. It gets its own named set and its own comment.

### 4. What actually limits the CLI, stated plainly

**The operator CLI is a root-equivalent surface over that socket.** Anyone in
`bananasaurs-ops` can do anything the application can do. What remains is not
authorization; it is friction and forensics:

- `--confirm` on every write, enforced **server-side** in the daemon, not by
  the CLI's argument parser. A client is not a control.
- `BANANASAURS_READONLY=1` makes `write()` itself throw
  (`packages/storage/src/write.ts:64`), so a readonly daemon refuses in storage
  rather than per command.
- Secrets return `<redacted>` unconditionally, with no override flag.
- Every write leaves an audit row.
- The kill switch, breaker, hierarchy check, rate cap and dry-run still apply,
  because `undo` and `panel sync` go through the same effect gateway as a member
  clicking a button. There is no second path to Discord (ADR 0014).

### 5. ADR 0012 is untouched

"Discord Administrator grants nothing" governs Discord identities and the
dashboard. A dashboard account still holds an explicit capability set, still
gets no capability from a Discord permission bit, and slice 14 enforces that
separately. This ADR is about a Unix socket behind a `0660` group, which no
club administrator can reach without a shell account on the host.

## Consequences

- Slice 13 can create the first `capability_grants` row, which is what makes
  the dashboard and the member-facing tiers reachable at all.
- The security posture is now stated where someone will find it: the answer to
  "what stops a club member using the CLI" is "they have no shell account and
  are not in `bananasaurs-ops`", not "a capability check".
- If host access is ever shared more widely than one operator, this decision is
  the one to revisit, and the fix is a real authenticated identity — not a
  stricter reading of a field the caller controls.
- A test asserts that `authorize()` grants an `operator_cli` actor a witness
  with **no** grant rows present, and that the same actor over any other
  channel does not, so the boundary cannot be widened by accident.
