# 0026 — Operator commands that reach Discord enqueue work rather than awaiting it

Status: accepted
Date: 2026-08-30
Refines: ADR 0013 (the operator CLI), ADR 0016 (the job table), ADR 0024.

## Context

Slice 13e adds the three Release 1 commands that cause Discord side effects:
`panel sync`, `undo`, and `adoption allow`. Every earlier command answers from
the database in microseconds. These do not, and two of them are unbounded.

Three facts collide.

1. **The CLI gives up after 30 seconds.** `packages/cli/src/client.ts:58` —
   `socket.setTimeout(30_000)`, so that a hung daemon cannot hang the terminal.
   That is the right default and it is not going to change for one command.
2. **Role effects go through a per-source rate cap, sequentially and on
   purpose.** `undoBatch` says so in its own comment: firing a batch
   concurrently would exhaust the cap in a burst and trip the breaker on work
   the owner explicitly asked for. At the default 20 changes per minute, a
   thirty-effect batch takes ninety seconds and a 250-reactor panel takes
   twelve minutes.
3. **A timed-out request does not stop the daemon.** The socket handler keeps
   running after the client hangs up. So a synchronous `undo` on a real batch
   would print "the daemon did not answer within 30000ms" while continuing to
   reverse role grants in the background.

That third outcome is the one that decides this. The operator is left unable to
say whether the command ran, on the command whose entire purpose is to repair
state during an incident. A command that plainly says "not done" would be
better; a command that says "queued as job 12" is better still.

## Decision

**`undo` and the reconciliation half of `panel sync` enqueue a durable job and
return its id. They do not await the work.**

The command still does, synchronously, everything that is bounded:

- validates the request and refuses at the terminal — no such batch, a batch
  already undone, a panel that does not exist;
- reads and reports the size of what it is about to do, so the operator sees
  "42 effects, 39 reversible" before deciding;
- for `panel sync`, posts or edits the panel message and seeds its reactions.
  One message and at most twenty reactions, none of it through the role rate
  cap — bounded work that must be immediate to be useful.

**`adoption allow` is deliberately not a job.** It grants an allowance against
`RateLimiter`, which is in-memory and per-process
(`packages/core/src/effects/rate-limit.ts`). Only the live daemon can reach it,
which is precisely the reason ADR 0013 puts the CLI on a socket instead of
letting it write the database — a CLI that opened SQLite could not do this at
all. It is immediate, it is bounded, and it is **lost on restart**. The command
says so in its own output rather than leaving that to be discovered.

## What this deliberately does not do

**It does not serialise operator effects against gateway events.**

`daemon.ts` keeps one in-order chain per guild for dispatches, because two
concurrent handlers can both read "the member does not have this role" and both
grant it. Operator work does not join that chain, and neither does the job
worker — `drainJobs` has always run outside it. What makes double execution
impossible is `claimEffect` and its unique constraint (`CLAUDE.md` rule 6), not
ordering.

Putting operator commands on the guild's event chain was considered and
rejected: it would make a command's latency depend on how busy the guild is,
and an operator runs these commands exactly when the guild is busy and
something is wrong. Queueing an emergency `undo` behind a burst of member
clicks — and then timing out at the terminal because of it — trades a race the
gateway already handles for a failure it does not.

## Consequences

- Both commands survive a restart mid-way, which a synchronous version could
  not: the job is a row, and `requeueStranded` returns it to the queue.
- Running one twice is collapsed by the dedupe key, over `queued` and `running`
  rows only (ADR 0016). A second `undo` of a batch already reversed is refused
  outright by `batches.undone_at`.
- The command cannot report the outcome, so it reports the job id and names the
  two commands that show it: `jobs list` and `audit tail`. An operator who
  wants a synchronous answer has one — `audit tail` after the job runs — and it
  is the same trail everything else is recorded in.
- `reconcile_guild` gains an optional `panelId`, so `panel sync <id>` really is
  about that panel. Without it the command would name one panel and reconcile
  every panel in the guild, which is the kind of quiet over-reach an operator
  discovers only from the audit trail afterwards.
- A new job kind, `undo_batch`. Its handler holds the two witnesses `undoBatch`
  requires, obtained honestly in the composition root under `operator_cli`
  (ADR 0024) and never cast.
