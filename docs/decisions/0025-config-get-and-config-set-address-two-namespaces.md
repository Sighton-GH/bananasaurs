# 0025 — `config get` and `config set` address two different namespaces

Status: accepted
Date: 2026-08-29
Supersedes: nothing. Refines `docs/17` §1 and ADR 0013 §4.

## Context

`docs/17` §1 lists both halves of a matched pair:

```bash
bananasaurs config get <key>                # secrets return <redacted>, always
bananasaurs config set <key> <value> --confirm
```

They read as one key space with a getter and a setter. They are not.

`config get` was implemented in slice 13c against `instance.redactedConfig()` —
`redactConfig(config)`, where `config` is the Zod-validated environment loaded
once at start (`apps/daemon/src/index.ts`). **Nothing in the process can write
that object**, and nothing should: it is read from `/etc/bananasaurs/env`, which
is root-owned and `0640`, and a daemon that could rewrite its own environment
file would be a privilege escalation from the ops group to root's file.

The values an operator actually needs to change at runtime are not there at all.
They are columns on the guild's row in `guilds`: `dry_run`, `role_rate_per_min`,
`reconcile_budget`, `breaker_threshold`, `breaker_state`. Those are per-guild,
mutable, and already read live by the effect gateway.

So a literal reading of `docs/17` — one namespace, get and set — cannot be
implemented. Three candidates:

1. **`config set` writes the environment file.** Rejected: see above, and a
   setting that needs a restart to take effect is not a setting an operator can
   use in an incident.
2. **Two command families**: `config get/set` for the environment,
   `guild get/set` for the row. Rejected: it adds a command pair `docs/17` does
   not have, and it makes the operator learn which namespace a name lives in
   before they can ask a question about it.
3. **One key space to the operator, two sources underneath.** Chosen.

## Decision

**`config get <key>` resolves both namespaces; `config set <key> <value>` writes
only the guild one, and names the other explicitly when refusing it.**

- Guild settings are spelled `lower_snake` (`dry_run`, `role_rate_per_min`,
  `reconcile_budget`, `breaker_threshold`, `breaker`). Process configuration
  keeps its environment spelling (`BANANASAURS_DRY_RUN`). The spelling is the
  namespace, so an operator can see which one they are holding.
- `config get` labels every answer with its source: `guild` or `environment`.
  An unlabelled value would let an operator read `BANANASAURS_DRY_RUN=false`
  and conclude the guild is live when the guild's own row says otherwise.
- `config set` on an environment key is refused — exit 1, not a silent no-op —
  with a message naming the file it actually lives in, that it takes effect on
  restart, and the guild setting with the same effect where one exists.
- The set of settable keys is closed and enumerated in `core`. It is not
  "every column on `guilds`": `killswitch` has its own command, and `enabled`,
  `name` and the timestamps are not settings.

## The consequence that has to be said out loud

**`BANANASAURS_DRY_RUN` overwrites `guilds.dry_run` on every start.**

`applyConfiguredDryRun` in `apps/daemon/src/runtime/daemon.ts` does this
deliberately — `docs/21` exercise 3 tells the operator to turn dry run off by
setting the environment variable and restarting, and without the overwrite that
instruction does nothing. But it means `config set dry_run off` is durable only
until the next restart, unless the environment agrees.

That is a genuinely surprising interaction and the kind of thing an operator
discovers at the worst moment. So `config set dry_run` **prints the environment
value alongside the change whenever the two disagree**, and says which one wins
at the next start. The command does not resolve the conflict — the environment
is the more explicit statement of intent and it is a safety control, not a
tuning knob — it makes the conflict visible.

## `breaker` is a settable key rather than its own command

Layer 5 trips `guilds.breaker_state` to `open`, and every Discord side effect
stops until something sets it back. `guildRepo.resetBreaker` has existed since
WP2 and, before this slice, **had no caller outside a test**: the breaker could
trip and nothing in the shipped product could clear it short of editing the
database by hand, which `docs/17` §1 exists to prevent.

`config set breaker closed` is where the reset goes. It is not a natural
"setting", but the alternative is a `breaker reset` command that `docs/17` does
not list, and the Release 1 surface being exactly the documented list is worth
more than the taxonomy. `open` is not an accepted value: manually stopping the
bot is what `killswitch on` is for, and two commands that halt effects would
mean two states to check when it will not act.

## Consequences

- One documented command pair, implementable as documented.
- Redaction is unaffected: `config get` still reads
  `instance.redactedConfig()` for the environment half, so a secret's real
  value remains unreachable from `packages/core` (ADR 0013 §4). No guild
  setting is a secret.
- Every `config set` writes an audit row with a real `before` and `after`, so
  a limit that was widened during an incident is visible afterwards.
- Adding a guild setting later means adding it to one enumerated list in
  `core` and one exhaustive `switch` in the composition root, and the compiler
  fails the build if the second is not updated.
