# 0030 — TOTP is deferred, and a test re-arms it

Status: accepted
Date: 2026-08-30
Refines: ADR 0012.

## Context

ADR 0012 requires TOTP "for any account holding provider-credential or purge
capability". The columns exist and are migrated: `dashboard_accounts.
totp_secret_enc` and `totp_enrolled`.

Neither triggering capability exists. `CAPABILITIES` in
`packages/core/src/authz.ts` is:

```
roles.mutate · panels.manage · logging.manage · config.read
config.write · audit.read · killswitch.toggle · undo.execute
```

There is no provider layer in Release 1 and no purge. So the requirement is
currently vacuous: there is no account that could hold a capability requiring
TOTP, because there is no such capability to hold.

Building it anyway would mean shipping an encrypted-secret store — the `_enc`
suffix is not decoration — a key to encrypt it with, an enrolment flow, a
recovery-code flow, and a lockout interaction, all to protect capabilities that
do not exist, and all untested against the case they exist for.

## Decision

**TOTP is not built in Release 1. The condition that re-arms it is a failing
test, not a note.**

`packages/core/src/authz.test.ts` asserts that `CAPABILITIES` contains none of
the capability names that would require it:

```
providers.manage · secrets.manage · data.purge · archive.export
```

Adding any of those to `CAPABILITIES` fails the suite, with a message naming
ADR 0012 and this ADR. Whoever adds the provider layer therefore cannot ship it
without either building TOTP or making an explicit, visible decision not to —
which is the whole difference between a deferral and an omission.

The list is the names those capabilities would plausibly take. It is a
heuristic, and the test says so: a capability named something else that grants
provider credentials or purge is still covered by ADR 0012, and the test's
message says to add it here rather than to route around it.

The columns stay. Dropping and re-adding them later would be a migration for
nothing, and their presence is a standing reminder of where the feature goes.

## Consequences

- Release 1 dashboard accounts are single-factor, on a `127.0.0.1`-bound port
  reached by SSH tunnel or Tailscale — both of which are themselves
  authenticated channels. The password is the inner gate, not the only one
  (ADR 0012).
- `totp_enrolled` is `0` for every account and nothing reads it. A future
  `enrolled` check therefore starts from a known state rather than from rows of
  unknown provenance.
- If the provider layer arrives before TOTP, the build fails. That is the
  intended outcome.
